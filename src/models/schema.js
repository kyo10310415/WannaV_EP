const db = require('../config/database');

const createTables = async () => {
  try {
    // Users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE,
        role VARCHAR(50) NOT NULL CHECK (role IN ('管理者', 'クルー', '生徒')),
        password_changed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Courses table (コース/カテゴリ)
    await db.query(`
      CREATE TABLE IF NOT EXISTS courses (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Lessons table (動画レッスン)
    await db.query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id SERIAL PRIMARY KEY,
        course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        video_filename VARCHAR(255) NOT NULL,
        video_url TEXT,
        thumbnail_url TEXT,
        duration INTEGER,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Quiz questions table
    await db.query(`
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id SERIAL PRIMARY KEY,
        lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_answer INTEGER NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // User progress table
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
        completed BOOLEAN DEFAULT FALSE,
        quiz_passed BOOLEAN DEFAULT FALSE,
        last_watched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        quiz_attempts INTEGER DEFAULT 0,
        watch_percent INTEGER DEFAULT 0,
        UNIQUE(user_id, lesson_id)
      )
    `);

    // watch_percent カラムが既存テーブルに存在しない場合は追加（マイグレーション）
    await db.query(`
      ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS watch_percent INTEGER DEFAULT 0
    `);

    // thumbnail_url カラムが既存テーブルに存在しない場合は追加（マイグレーション）
    await db.query(`
      ALTER TABLE lessons ADD COLUMN IF NOT EXISTS thumbnail_url TEXT
    `);

    // username / password_changed_at マイグレーション
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP`);
    // 既存ユーザーの username が未設定なら email の @ 前を初期値に設定
    await db.query(`
      UPDATE users SET username = SPLIT_PART(email, '@', 1)
      WHERE username IS NULL
    `);
    // username に UNIQUE 制約（存在しない場合のみ）
    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key'
        ) THEN
          ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
        END IF;
      END $$
    `);

    // Notion students cache table
    await db.query(`
      CREATE TABLE IF NOT EXISTS notion_students (
        id SERIAL PRIMARY KEY,
        notion_page_id VARCHAR(255) UNIQUE NOT NULL,
        student_name VARCHAR(255),
        name_furigana VARCHAR(255),
        student_number VARCHAR(255),
        notion_url TEXT,
        lesson_start_month DATE,
        status VARCHAR(255),
        contract_plan VARCHAR(255),
        raw_data JSONB,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notion_plan ON notion_students(contract_plan)`);

    // Notifications log table
    await db.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type VARCHAR(50) DEFAULT 'reminder'
      )
    `);

    // Create indexes for better performance
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_user ON user_progress(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_lesson ON user_progress(lesson_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_completed ON user_progress(completed)`);

    console.log('✅ All database tables created successfully');
  } catch (error) {
    console.error('❌ Error creating tables:', error);
    throw error;
  }
};

module.exports = { createTables };
