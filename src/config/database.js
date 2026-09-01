require('dotenv').config();
const { Pool } = require('pg');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // 小容量DBでリクエストが無制限に待機しないよう、上限とタイムアウトを明示する。
  max: positiveInteger(process.env.DB_POOL_MAX, 10),
  idleTimeoutMillis: positiveInteger(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: positiveInteger(process.env.DB_CONNECT_TIMEOUT_MS, 5000),
  statement_timeout: positiveInteger(process.env.DB_STATEMENT_TIMEOUT_MS, 60000),
  query_timeout: positiveInteger(process.env.DB_QUERY_TIMEOUT_MS, 65000),
  application_name: 'wannav-portal',
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
