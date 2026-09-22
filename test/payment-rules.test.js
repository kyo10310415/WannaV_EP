const test = require('node:test');
const assert = require('node:assert/strict');
const sheet = require('../src/utils/paymentSheet');
const { decideAccess } = require('../src/models/StudentPayment');
const { buildAnalytics } = require('../src/models/LearningAnalytics');

test('支払い同期は標準60分で、未設定や無効な設定でも60分になる', () => {
  const { paymentIntervalMinutes } = require('../src/config/portal');
  const previous = process.env.PAYMENT_SYNC_INTERVAL_MINUTES;
  try {
    delete process.env.PAYMENT_SYNC_INTERVAL_MINUTES;
    assert.equal(paymentIntervalMinutes(), 60);
    for (const value of ['', '0', '-1', 'invalid']) {
      process.env.PAYMENT_SYNC_INTERVAL_MINUTES = value;
      assert.equal(paymentIntervalMinutes(), 60);
    }
    process.env.PAYMENT_SYNC_INTERVAL_MINUTES = '120';
    assert.equal(paymentIntervalMinutes(), 120);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_SYNC_INTERVAL_MINUTES;
    else process.env.PAYMENT_SYNC_INTERVAL_MINUTES = previous;
  }
});

test('前月計算は日本時間、年跨ぎ、月境界に対応', () => {
  assert.equal(sheet.previousMonth(new Date('2026-09-22T00:00:00Z')), '2026-08-01');
  assert.equal(sheet.previousMonth(new Date('2027-01-01T00:00:00Z')), '2026-12-01');
  assert.equal(sheet.previousMonth(new Date('2026-08-31T15:00:00Z')), '2026-08-01');
  assert.equal(sheet.previousMonth(new Date('2026-08-31T14:59:59Z')), '2026-07-01');
});

test('月ヘッダーは文字列と日付シリアルに対応', () => {
  assert.equal(sheet.normalizeMonth('2026/8'), '2026-08-01');
  assert.equal(sheet.normalizeMonth('2026/08/01'), '2026-08-01');
  const serial = (Date.UTC(2026, 7, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(sheet.normalizeMonth(serial), '2026-08-01');
  assert.equal(sheet.normalizeMonth('2026/13'), null);
});

function rows(status, number = ' ST-01 ') {
  const header = Array(22).fill('');
  header[21] = '2026/8'; // Deliberately unrelated to today's production column.
  const row = Array(22).fill('');
  row[3] = number;
  row[21] = status;
  return [header, row];
}

for (const [status, expected] of [
  ['支払い完了', true], [' 支払い完了 ', true], ['なし', false],
  ['未払い（連絡なし）', false], ['未払い（期限切れ）', false],
  ['未払い（遅れ）', false], ['休会', false], ['契約終了', false],
  ['', false], ['支払い完了予定', false]
]) test('支払いセル完全一致：' + (status || '空欄'), () => {
  const parsed = sheet.parsePaymentRows(rows(status), '2026-08-01');
  assert.equal(parsed.records.get('ST-01').is_paid, expected);
  assert.equal(parsed.records.get('ST-01').source_row, 14);
});

test('前月列なし・二重月列・空シートはエラー', () => {
  assert.throws(() => sheet.parsePaymentRows(rows('支払い完了'), '2026-07-01'), /missing_month_header/);
  const duplicate = rows('支払い完了');
  duplicate[0][14] = '2026/8';
  assert.throws(() => sheet.parsePaymentRows(duplicate, '2026-08-01'), /duplicate_month_header/);
  assert.throws(() => sheet.parsePaymentRows([rows('')[0]], '2026-08-01'), /empty_payment_sheet/);
});

test('D列以外の氏名を照合せず、重複番号を除外する', () => {
  const input = rows('支払い完了');
  input[1][2] = '名前';
  input.push([...input[1]]);
  input[2][3] = 'ST-01';
  const result = sheet.parsePaymentRows(input, '2026-08-01');
  assert.equal(result.records.size, 0);
  assert.deepEqual([...result.duplicates], ['ST-01']);
});

const access = {
  enabled: true, role: '生徒', today: '2026-09-22', month: '2026-08-01',
  student: { student_number: 'ST-01', lesson_start_date: '2026-09-22' },
  state: { last_success_at: new Date(), payment_month: '2026-08-01' },
  payment: { student_number: 'ST-01', is_paid: false }
};
test('開始日前は許可、開始日当日から支払い完了だけ許可', () => {
  assert.equal(decideAccess({ ...access, today: '2026-09-21' }).allowed, true);
  assert.equal(decideAccess(access).allowed, false);
  assert.equal(decideAccess({ ...access, payment: { ...access.payment, is_paid: true } }).allowed, true);
});
for (const role of ['管理者', 'クルー', 'セールス']) test(role + 'は支払い制御対象外', () => {
  assert.equal(decideAccess({ ...access, role }).allowed, true);
});
test('フラグ無効、初回未同期、月跨ぎ未同期、番号・日付不明は誤拒否しない', () => {
  for (const change of [{ enabled: false }, { state: null }, { month: '2026-09-01' },
    { student: {} }, { student: { ...access.student, lesson_start_date: null } },
    { payment: { student_number: 'OTHER', is_paid: false } }, { payment: null }]) {
    assert.equal(decideAccess({ ...access, ...change }).allowed, true);
  }
});

test('学習KPIは視聴・合格を分離し、未履歴の失敗回数を推測しない', () => {
  const lesson = { course_id: 1, course_title: '科目', sequential_unlock: true,
    content_type: 'video', view_count: 1, watch_percent: 100, quiz_attempts: 2,
    quiz_failed_attempts: null, quiz_passed: false, completed: false, has_quiz: true };
  const result = buildAnalytics([{ ...lesson, id: 1 }, { ...lesson, id: 2,
    view_count: 0, watch_percent: 0, quiz_attempts: 0 }], [1]);
  assert.equal(result.required.videos_watched, 1);
  assert.equal(result.required.quiz_passed, 0);
  assert.equal(result.required.quiz_attempt_rate, 50);
  assert.equal(result.required.average_attempts, 2);
  assert.equal(result.required.average_retries, 1);
  assert.equal(result.required.quiz_failed_attempts, null);
  assert.equal(result.required.quiz_attempt_pass_rate, null);
  assert.equal(result.courses[0].lessons[1].can_access, false);
  assert.equal(result.courses[0].next_locked_lesson, 2);
  const passed = buildAnalytics([{ ...lesson, id: 1, quiz_failed_attempts: 1,
    quiz_passed: true, completed: true }], [1]);
  assert.equal(passed.required.quiz_attempt_pass_rate, 50);
  assert.equal(buildAnalytics([], []).required_configured, false);
});
