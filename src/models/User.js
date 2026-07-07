const db = require('../config/database');
const bcrypt = require('bcrypt');

class User {
  // username ベースで作成（email は username@wannav.local として生成）
  static async create(email, password, name, role = '生徒') {
    const hashedPassword = await bcrypt.hash(password, 10);
    // email フィールドが username として渡されることを考慮
    // email に @ が含まれない場合はユーザー名として扱い、email を自動生成
    const isUsername = !email.includes('@');
    const actualEmail    = isUsername ? `${email}@wannav.local` : email;
    const actualUsername = isUsername ? email : email.split('@')[0];

    const result = await db.query(
      `INSERT INTO users (email, password, name, username, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, username, role, created_at`,
      [actualEmail, hashedPassword, name, actualUsername, role]
    );
    return result.rows[0];
  }

  static async findByEmail(email) {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0];
  }

  // username でログイン検索
  static async findByUsername(username) {
    const result = await db.query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [username]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await db.query(
      `SELECT id, email, name, username, role, created_at, last_login, password_changed_at
       FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0];
  }

  static async getAll() {
    const result = await db.query(
      `SELECT id, email, name, username, role, created_at, last_login, password_changed_at
       FROM users ORDER BY created_at DESC`
    );
    return result.rows;
  }

  static async updateLastLogin(id) {
    await db.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  }

  static async updateRole(id, role) {
    const result = await db.query(
      'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, name, username, role',
      [role, id]
    );
    return result.rows[0];
  }

  static async delete(id) {
    await db.query('DELETE FROM users WHERE id = $1', [id]);
  }

  static async verifyPassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
  }

  static async resetPassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query(
      `UPDATE users
       SET password = $1, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [hashedPassword, id]
    );
  }

  // 初回パスワード変更済みかどうか
  static async hasChangedPassword(id) {
    const result = await db.query(
      'SELECT password_changed_at FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0]?.password_changed_at != null;
  }

  static async getUsersWithoutProgressForDays(days = 3) {
    const result = await db.query(`
      SELECT DISTINCT u.id, u.email, u.name, u.username, MAX(up.last_watched_at) as last_activity
      FROM users u
      LEFT JOIN user_progress up ON u.id = up.user_id
      WHERE u.role = '生徒'
      GROUP BY u.id, u.email, u.name, u.username
      HAVING MAX(up.last_watched_at) < NOW() - INTERVAL '${days} days'
         OR MAX(up.last_watched_at) IS NULL
    `);
    return result.rows;
  }
}

module.exports = User;
