const db = require('../config/database');
const axios = require('axios');
const { TARGET_CONTRACT_PLANS } = require('../config/contractPlans');

function japanDay(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
function weekStart(now = new Date()) {
  const date = new Date(japanDay(now) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function historyStart(now = new Date()) {
  const date = new Date(japanDay(now) + 'T00:00:00Z');
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 2);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}
function accountKey(platform, value) {
  const text = String(value || '').trim();
  return platform === 'x' ? text.replace(/^@/, '').toLowerCase() : text;
}
function validId(platform, value) {
  return platform === 'x' ? /^[a-zA-Z0-9_]{1,15}$/.test(value) : /^UC[a-zA-Z0-9_-]{22}$/.test(value);
}
function countValue(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}
function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

class SocialMetrics {
  static async forUser(userId, now = new Date()) {
    const student = (await db.query(`SELECT u.name AS student_name, a.* FROM users u
      JOIN test_student_social_accounts a ON a.user_id = u.id
      WHERE u.id = $1 AND u.username = 'test_seito' AND u.role = '生徒'
        AND NOT EXISTS (SELECT 1 FROM student_profiles sp WHERE sp.user_id = u.id AND sp.notion_page_id IS NOT NULL)`, [userId])).rows[0];
    return student ? this.forSource(student, 'test_student_social_snapshots', now) : null;
  }

  static async forPage(pageId, now = new Date()) {
    const student = (await db.query(`SELECT notion_page_id, student_name, x_username, youtube_channel_id
      FROM notion_students WHERE notion_page_id = $1`, [pageId])).rows[0];
    if (!student) return null;
    return this.forSource(student, 'student_social_snapshots', now);
  }

  static async forSource(student, table, now) {
    if (!['student_social_snapshots', 'test_student_social_snapshots'].includes(table)) throw new Error('Invalid snapshot source');
    const pageId = student.notion_page_id;
    const week = weekStart(now);
    const from = historyStart(now);
    const rows = (await db.query(`SELECT platform, account_key, week_start, count, status, fetched_at
      FROM ${table} WHERE notion_page_id = $1 AND week_start >= $2::date - INTERVAL '7 days'
      ORDER BY week_start`, [pageId, from])).rows;
    const platforms = {};
    for (const [platform, id] of [['x', student.x_username], ['youtube', student.youtube_channel_id]]) {
      const key = accountKey(platform, id);
      const matching = rows.filter(row => row.platform === platform && row.account_key === key);
      const current = matching.find(row => dateOnly(row.week_start) === week);
      // Public YouTube API statistics may only be stored for 30 days without owner authorization.
      const cutoff = platform === 'youtube'
        ? new Date(now.getTime() - 30 * 86400000).toISOString() : from + 'T00:00:00+09:00';
      platforms[platform] = {
        fromDate: platform === 'youtube' ? japanDay(new Date(now.getTime() - 30 * 86400000)) : from,
        accountId: id || null,
        status: !key ? 'not_configured' : !validId(platform, key) ? 'invalid_id' : current?.status || 'pending',
        count: current?.status === 'ok' ? Number(current.count) : null,
        fetchedAt: current?.fetched_at || null,
        history: matching.filter(row => row.status === 'ok' && new Date(row.fetched_at) >= new Date(cutoff))
          .map(row => ({ weekStart: dateOnly(row.week_start), count: Number(row.count), fetchedAt: row.fetched_at })),
      };
    }
    return { studentName: student.student_name, weekStart: week, fromDate: from, platforms };
  }

  static async save(records, queryable = db) {
    if (!records.length) return;
    for (const table of ['student_social_snapshots', 'test_student_social_snapshots']) {
      const selected = records.filter(record => record.notion_page_id.startsWith('manual:') === (table === 'test_student_social_snapshots'));
      if (!selected.length) continue;
      await queryable.query(`INSERT INTO ${table}
        (notion_page_id, platform, account_key, week_start, count, status)
        SELECT notion_page_id, platform, account_key, week_start, count, status
        FROM jsonb_to_recordset($1::jsonb) AS r(notion_page_id varchar, platform text,
          account_key text, week_start date, count bigint, status text)
        ON CONFLICT (notion_page_id, platform, account_key, week_start) DO UPDATE SET
          count = EXCLUDED.count, status = EXCLUDED.status, fetched_at = CURRENT_TIMESTAMP
        WHERE ${table}.status <> 'ok'`, [JSON.stringify(selected)]);
    }
  }

  static async synchronize(now = new Date()) {
    const client = await db.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(78234, 2) AS locked')).rows[0].locked;
      if (!locked) return { skipped: true };
      await client.query("DELETE FROM student_social_snapshots WHERE platform = 'youtube' AND fetched_at < CURRENT_TIMESTAMP - INTERVAL '30 days'");
      await client.query("DELETE FROM student_social_snapshots WHERE platform = 'x' AND week_start < $1::date - INTERVAL '7 days'", [historyStart(now)]);
      await client.query("DELETE FROM test_student_social_snapshots WHERE platform = 'youtube' AND fetched_at < CURRENT_TIMESTAMP - INTERVAL '30 days'");
      await client.query("DELETE FROM test_student_social_snapshots WHERE platform = 'x' AND week_start < $1::date - INTERVAL '7 days'", [historyStart(now)]);
      const students = (await client.query(`SELECT notion_page_id, x_username, youtube_channel_id
        FROM notion_students WHERE contract_plan = ANY($1::text[])
        UNION ALL SELECT a.notion_page_id, a.x_username, a.youtube_channel_id
        FROM test_student_social_accounts a JOIN users u ON u.id = a.user_id
        WHERE u.username = 'test_seito' AND u.role = '生徒'
          AND NOT EXISTS (SELECT 1 FROM student_profiles sp WHERE sp.user_id = u.id AND sp.notion_page_id IS NOT NULL)`, [TARGET_CONTRACT_PLANS])).rows;
      const week = weekStart(now);
      const completed = new Set((await client.query(`SELECT notion_page_id, platform, account_key
        FROM (SELECT * FROM student_social_snapshots UNION ALL SELECT * FROM test_student_social_snapshots) snapshots WHERE week_start = $1 AND
          (status IN ('ok','hidden','invalid_id') OR fetched_at > CURRENT_TIMESTAMP - INTERVAL '6 hours')`, [week]))
        .rows.map(row => JSON.stringify([row.notion_page_id, row.platform, row.account_key])));
      const summary = { saved: 0, failed: 0 };
      for (const platform of ['x', 'youtube']) {
        const credential = platform === 'x' ? process.env.X_BEARER_TOKEN : process.env.YOUTUBE_API_KEY;
        if (!credential) continue;
        const accounts = new Map();
        const invalid = [];
        for (const student of students) {
          const key = accountKey(platform, platform === 'x' ? student.x_username : student.youtube_channel_id);
          if (!key || completed.has(JSON.stringify([student.notion_page_id, platform, key]))) continue;
          if (!validId(platform, key)) {
            invalid.push({ notion_page_id: student.notion_page_id, platform, account_key: key,
              week_start: week, count: null, status: 'invalid_id' });
            continue;
          }
          if (!accounts.has(key)) accounts.set(key, []);
          accounts.get(key).push(student.notion_page_id);
        }
        await this.save(invalid, client);
        const keys = [...accounts.keys()];
        const size = platform === 'x' ? 100 : 50;
        for (let start = 0; start < keys.length; start += size) {
          const batch = keys.slice(start, start + size);
          const results = new Map();
          let apiFailed = false;
          try {
            if (platform === 'x') {
              const response = await axios.get('https://api.x.com/2/users/by', {
                params: { usernames: batch.join(','), 'user.fields': 'public_metrics' },
                headers: { Authorization: `Bearer ${credential}` }, timeout: 20000,
              });
              for (const user of response.data.data || []) {
                const count = countValue(user.public_metrics?.followers_count);
                results.set(accountKey('x', user.username), { count, status: count === null ? 'api_error' : 'ok' });
              }
            } else {
              const response = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                params: { id: batch.join(','), part: 'statistics', maxResults: 50, key: credential }, timeout: 20000,
              });
              for (const channel of response.data.items || []) {
                const count = countValue(channel.statistics?.subscriberCount);
                results.set(channel.id, { count, status: channel.statistics?.hiddenSubscriberCount
                  ? 'hidden' : count === null ? 'api_error' : 'ok' });
              }
            }
          } catch (error) {
            // Never log axios error objects: request configuration contains API credentials.
            console.error(`Social metrics ${platform} request failed (HTTP ${error.response?.status || 'network'})`);
            apiFailed = true;
          }
          const records = batch.flatMap(key => accounts.get(key).map(pageId => ({
            notion_page_id: pageId, platform, account_key: key, week_start: week,
            ...(results.get(key) || { count: null, status: apiFailed ? 'api_error' : 'not_found' }),
          })));
          await this.save(records, client);
          summary.saved += records.filter(record => record.status === 'ok').length;
          summary.failed += records.filter(record => record.status !== 'ok').length;
          // Stop this platform on quota/auth/network failure. The next scheduled attempt retries missing data.
          if (apiFailed) break;
        }
      }
      return summary;
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(78234, 2)').catch(() => {});
      client.release();
    }
  }
}

module.exports = { SocialMetrics, weekStart, historyStart, accountKey, validId, countValue };
