const db=require('../config/database');
module.exports=async()=>{
 await db.query(`CREATE TABLE IF NOT EXISTS user_recovery_emails(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email VARCHAR(254) NOT NULL,verified_at TIMESTAMPTZ,code_hash TEXT,challenge_nonce UUID,session_nonce UUID,expires_at TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0,sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
 await db.query(`CREATE TABLE IF NOT EXISTS recovery_email_deliveries(id UUID PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
 await db.query('CREATE INDEX IF NOT EXISTS idx_recovery_deliveries_created ON recovery_email_deliveries(created_at)');
};
