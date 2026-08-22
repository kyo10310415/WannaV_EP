const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const User = require('../src/models/User');

const root = path.join(__dirname, '..');

test('ユーザー一覧を生徒と生徒以外の権限でDB絞り込みできる', async () => {
  const originalQuery = db.query;
  const capturedSql = [];
  db.query = async sql => {
    capturedSql.push(sql);
    return { rows: [] };
  };

  try {
    await User.getAll('staff');
    await User.getAll('students');
    assert.match(capturedSql[0], /WHERE role <> '生徒'/);
    assert.match(capturedSql[1], /WHERE role = '生徒'/);
    await assert.rejects(() => User.getAll('invalid'), /Invalid user scope/);
  } finally {
    db.query = originalQuery;
  }
});

test('管理者用と生徒用のアカウントページが異なる権限範囲を取得する', () => {
  const adminPage = fs.readFileSync(path.join(root, 'views', 'admin-accounts.html'), 'utf8');
  const studentPage = fs.readFileSync(path.join(root, 'views', 'admin-students-accounts.html'), 'utf8');
  const adminRoutes = fs.readFileSync(path.join(root, 'src', 'routes', 'admin.js'), 'utf8');

  assert.match(adminPage, /admin\/users\?scope=staff/);
  assert.match(adminPage, /user\.role !== '生徒'/);
  assert.match(studentPage, /admin\/users\?scope=students/);
  assert.match(studentPage, /u\.role === '生徒'/);
  assert.match(adminRoutes, /req\.user\.role === 'セールス' \? 'students'/);
});

test('生徒用アカウントページとナビゲーションの名称が管理に統一されている', () => {
  const viewFiles = fs.readdirSync(path.join(root, 'views')).filter(file => file.endsWith('.html'));
  const allViews = viewFiles
    .map(file => fs.readFileSync(path.join(root, 'views', file), 'utf8'))
    .join('\n');
  const studentPage = fs.readFileSync(path.join(root, 'views', 'admin-students-accounts.html'), 'utf8');

  assert.doesNotMatch(allViews, /生徒用アカウント作成/);
  assert.match(studentPage, /<title>生徒用アカウント管理/);
  assert.match(studentPage, /<h2>🎓 生徒用アカウント管理<\/h2>/);
  assert.match(allViews, /🎓 生徒用アカウント管理/);
});
