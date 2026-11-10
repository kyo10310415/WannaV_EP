const db=require('../config/database');
module.exports=async function createToolTables(){
  await db.query(`CREATE TABLE IF NOT EXISTS tool_threads (
    id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    busy_until TIMESTAMPTZ, deleted_at TIMESTAMPTZ)`);
  await db.query(`CREATE TABLE IF NOT EXISTS tool_messages (
    id UUID PRIMARY KEY, thread_id UUID NOT NULL REFERENCES tool_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await db.query(`CREATE TABLE IF NOT EXISTS tool_attachments (
    id UUID PRIMARY KEY, message_id UUID NOT NULL REFERENCES tool_messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS tool_usage (
    id UUID PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    thread_id UUID, status TEXT NOT NULL DEFAULT 'pending', model TEXT,
    input_tokens BIGINT, cached_tokens BIGINT, output_tokens BIGINT, searches INTEGER,
    estimated_usd NUMERIC(18,8), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_tool_threads_user ON tool_threads(user_id,created_at)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_tool_messages_thread ON tool_messages(thread_id,created_at)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_tool_usage_user_date ON tool_usage(user_id,created_at)');
};
