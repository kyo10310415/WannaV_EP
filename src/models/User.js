const db = require('../config/database');
const bcrypt = require('bcrypt');

class User {
  static async create(email, password, name, role = '生徒') {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, created_at',
      [email, hashedPassword, name, role]
    );
    return result.rows[0];
  }

  static async findByEmail(email) {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0];
  }

  static async findById(id) {
    const result = await db.query(
      'SELECT id, email, name, role, created_at, last_login FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  static async getAll() {
    const result = await db.query(
      'SELECT id, email, name, role, created_at, last_login FROM users ORDER BY created_at DESC'
    );
    return result.rows;
  }

  static async updateLastLogin(id) {
    await db.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  }

  static async updateRole(id, role) {
    const result = await db.query(
      'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, name, role',
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

  static async getUsersWithoutProgressForDays(days = 3) {
    const result = await db.query(`
      SELECT DISTINCT u.id, u.email, u.name, MAX(up.last_watched_at) as last_activity
      FROM users u
      LEFT JOIN user_progress up ON u.id = up.user_id
      WHERE u.role = '生徒'
      GROUP BY u.id, u.email, u.name
      HAVING MAX(up.last_watched_at) < NOW() - INTERVAL '${days} days'
         OR MAX(up.last_watched_at) IS NULL
    `);
    return result.rows;
  }
}

module.exports = User;
