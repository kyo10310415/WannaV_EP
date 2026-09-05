const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const Lesson = require('../src/models/Lesson');
const { getUpcomingPortalDates, nextNthWeekday, todayInJapan } = require('../src/utils/recurringDates');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('直近開催日は当日を含めて第一・第三金曜と第二・第四水曜から計算する', () => {
  assert.equal(nextNthWeekday('2026-09-18', 5, [1, 3]), '2026-09-18');
  assert.equal(nextNthWeekday('2026-09-19', 5, [1, 3]), '2026-10-02');
  assert.deepEqual(getUpcomingPortalDates(new Date('2026-09-05T03:00:00Z')), {
    bucchakeVtuber: '2026-09-18',
    classLesson: '2026-09-09',
  });
  assert.equal(todayInJapan(new Date('2026-09-05T15:30:00Z')), '2026-09-06');
});

test('通常ダッシュボードとスペシャルコンテンツをDBで分離して取得する', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };
  try {
    await Lesson.getWithProgress(8);
    await Lesson.getWithProgress(8, true);
    assert.match(calls[0].sql, /COALESCE\(c\.is_special_content, false\) = \$2/);
    assert.deepEqual(calls[0].params, [8, false]);
    assert.deepEqual(calls[1].params, [8, true]);
  } finally {
    db.query = originalQuery;
  }
});

test('スペシャルコース設定と全権限向け専用ページが定義されている', () => {
  const schema = read('src/models/schema.js');
  const adminPage = read('views/admin-contents.html');
  const dashboard = read('views/dashboard.html');
  const specialPage = read('views/special-contents.html');
  const lessonsRoute = read('src/routes/lessons.js');
  const server = read('server.js');

  assert.match(schema, /is_special_content BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(adminPage, /course-special-content/);
  assert.match(adminPage, /course-edit-special-content/);
  assert.match(adminPage, /isSpecialContent:/);
  assert.match(lessonsRoute, /router\.get\('\/special'/);
  assert.match(server, /app\.get\('\/special-contents'/);
  assert.match(specialPage, /スペシャルコンテンツ/);
  assert.match(specialPage, /\['管理者','クルー','セールス','生徒'\]/);
  assert.match(dashboard, /href: '\/special-contents'/);
});

test('画像・外部リンクのみのレッスンを作成・表示できる', () => {
  const schema = read('src/models/schema.js');
  const adminRoutes = read('src/routes/admin.js');
  const adminPage = read('views/admin-contents.html');
  const lessonPage = read('views/lesson.html');

  assert.match(schema, /content_type IN \('video', 'image', 'link'\)/);
  assert.match(schema, /external_link_url TEXT/);
  assert.match(adminRoutes, /mode === 'image'/);
  assert.match(adminRoutes, /mode === 'link'/);
  assert.match(adminPage, /value="image"/);
  assert.match(adminPage, /value="link"/);
  assert.match(lessonPage, /currentLesson\.content_type === 'image'/);
  assert.match(lessonPage, /openImageLightbox/);
  assert.match(lessonPage, /target="_blank" rel="noopener noreferrer"/);
});

test('画像教材に説明と任意の外部リンクを組み合わせて登録・編集できる', () => {
  const adminRoutes = read('src/routes/admin.js');
  const adminPage = read('views/admin-contents.html');
  const lessonPage = read('views/lesson.html');

  assert.match(adminPage, /画像＋説明・リンク/);
  assert.match(adminPage, /外部リンクURL（任意）/);
  assert.match(adminPage, /contentMode === 'image'[\s\S]*formData\.append\('externalLinkUrl'/);
  assert.match(adminRoutes, /mode === 'image'[\s\S]*validOptionalExternalUrl\(externalLinkUrl\)/);
  assert.match(adminRoutes, /lesson\.content_type === 'image' && lesson\.image_url/);
  assert.match(lessonPage, /class="resource-copy"/);
  assert.match(lessonPage, /currentLesson\.description/);
  assert.match(lessonPage, /currentLesson\.external_link_url/);
  assert.match(lessonPage, /class="resource-external-link"[\s\S]*target="_blank"/);
});

test('管理画面で外部リンクを編集しダッシュボードに予定と直近日を表示する', () => {
  const adminRoutes = read('src/routes/admin.js');
  const adminPage = read('views/admin-contents.html');
  const dashboard = read('views/dashboard.html');
  const portalRoute = read('src/routes/portal.js');

  assert.match(adminRoutes, /router\.put\('\/portal-links'/);
  assert.match(adminPage, /ぶっちゃけVtuber URL/);
  assert.match(adminPage, /クラスレッスン URL/);
  assert.match(dashboard, /portal-links-grid/);
  assert.match(dashboard, /次回：/);
  assert.match(portalRoute, /第一、第三金曜日の22時から/);
  assert.match(portalRoute, /第二、第四水曜日の22時から/);
});

test('スペシャルコンテンツは通常の進捗集計に含めない', () => {
  const progress = read('src/models/Progress.js');
  assert.match(progress, /getProgressStats[\s\S]*COALESCE\(c\.is_special_content, false\) = false/);
  assert.match(progress, /getCourseProgressStats[\s\S]*COALESCE\(c\.is_special_content, false\) = false/);
  assert.match(progress, /lesson_total[\s\S]*COALESCE\(c\.is_special_content, false\) = false/);
});
