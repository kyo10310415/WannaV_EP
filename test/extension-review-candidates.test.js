const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const StudentProfile = require('../src/models/StudentProfile');

const root = path.join(__dirname, '..');

test('延長審査対象者はレッスン開始月を1か月目とした4か月目で抽出する', async () => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async sql => {
    capturedSql = sql;
    return { rows: [] };
  };

  try {
    await StudentProfile.getExtensionReviewCandidates();
    assert.match(capturedSql, /JOIN notion_students ns ON ns\.notion_page_id = sp\.notion_page_id/);
    assert.match(capturedSql, /ns\.contract_plan = 'エントリープラン'/);
    assert.match(capturedSql, /ns\.status = 'アクティブ'/);
    assert.match(capturedSql, /DATE_TRUNC\('month', ns\.lesson_start_month\) \+ INTERVAL '3 months'/);
    assert.match(capturedSql, /= DATE_TRUNC\('month', CURRENT_DATE\)/);
  } finally {
    db.query = originalQuery;
  }
});

test('延長審査ページは4か月目対象者APIを表示する', () => {
  const html = fs.readFileSync(path.join(root, 'views', 'admin-extensions.html'), 'utf8');

  assert.match(html, /4か月目対象者/);
  assert.match(html, /\/api\/students\/meta\/extension-review-candidates/);
  assert.doesNotMatch(html, /期限接近|expiring-days-filter/);
});
