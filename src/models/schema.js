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
        role VARCHAR(50) NOT NULL CHECK (role IN ('管理者', 'クルー', 'セールス', '生徒')),
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
        sequential_unlock BOOLEAN NOT NULL DEFAULT FALSE,
        is_special_content BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // コースごとに「前の動画完了後に次を解禁」を切り替える
    await db.query(`
      ALTER TABLE courses ADD COLUMN IF NOT EXISTS sequential_unlock BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await db.query(`
      ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_special_content BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Lessons table (動画レッスン)
    await db.query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id SERIAL PRIMARY KEY,
        course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        video_filename VARCHAR(255),
        video_url TEXT,
        thumbnail_url TEXT,
        content_type VARCHAR(20) NOT NULL DEFAULT 'video'
          CHECK (content_type IN ('video', 'image', 'link')),
        image_filename VARCHAR(255),
        image_url TEXT,
        external_link_url TEXT,
        duration INTEGER,
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 動画・画像・外部リンクの教材形式に対応
    await db.query(`ALTER TABLE lessons ALTER COLUMN video_filename DROP NOT NULL`);
    await db.query(`
      ALTER TABLE lessons ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) NOT NULL DEFAULT 'video'
        CHECK (content_type IN ('video', 'image', 'link'))
    `);
    await db.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS image_filename VARCHAR(255)`);
    await db.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await db.query(`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS external_link_url TEXT`);

    // ダッシュボードの外部リンク設定
    await db.query(`
      CREATE TABLE IF NOT EXISTS portal_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value TEXT,
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
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quiz_questions_lesson ON quiz_questions(lesson_id)`);

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
        view_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, lesson_id)
      )
    `);

    // watch_percent カラムが既存テーブルに存在しない場合は追加（マイグレーション）
    await db.query(`
      ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS watch_percent INTEGER DEFAULT 0
    `);

    // 動画視聴回数（レッスン画面を開いた回数）
    await db.query(`
      ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0
    `);

    // 過去の手動完了で、小テスト未合格のまま完了になった記録を補正する。
    await db.query(`
      UPDATE user_progress up
      SET completed = false,
          completed_at = NULL
      WHERE up.completed = true
        AND COALESCE(up.quiz_passed, false) = false
        AND EXISTS (
          SELECT 1 FROM quiz_questions qq WHERE qq.lesson_id = up.lesson_id
        )
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

    // role の CHECK 制約にセールスを追加（マイグレーション）
    // 既存の users_role_check を DROP して '管理者','クルー','セールス','生徒' で再作成
    await db.query(`
      DO $$ BEGIN
        -- 古い制約が存在する場合は削除して再作成
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
        ) THEN
          ALTER TABLE users DROP CONSTRAINT users_role_check;
        END IF;
        ALTER TABLE users ADD CONSTRAINT users_role_check
          CHECK (role IN ('管理者', 'クルー', 'セールス', '生徒'));
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
        login_id VARCHAR(255),
        login_id_overridden BOOLEAN NOT NULL DEFAULT FALSE,
        raw_data JSONB,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`ALTER TABLE notion_students ADD COLUMN IF NOT EXISTS login_id VARCHAR(255)`);
    await db.query(`ALTER TABLE notion_students ADD COLUMN IF NOT EXISTS login_id_overridden BOOLEAN NOT NULL DEFAULT FALSE`);
    // 手動変更されていない既存キャッシュは、学籍番号をログインIDへ反映する。
    await db.query(`
      UPDATE notion_students
      SET login_id = NULLIF(TRIM(student_number), '')
      WHERE login_id_overridden = FALSE
        AND login_id IS DISTINCT FROM NULLIF(TRIM(student_number), '')
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notion_plan ON notion_students(contract_plan)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notion_login_id_lower ON notion_students(LOWER(login_id))`);

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

    // =====================================================
    // 生徒プロフィール拡張テーブル（ステータス・契約・引き継ぎ情報）
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS student_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        -- ステータス管理
        status VARCHAR(50) NOT NULL DEFAULT 'レッスン準備中'
          CHECK (status IN ('アクティブ', 'レッスン準備中', '休会', '退会', '強制退会')),
        status_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status_changed_by INTEGER REFERENCES users(id),
        status_note TEXT,
        -- 契約情報
        contract_plan VARCHAR(255),
        contract_start_date DATE,
        contract_end_date DATE,
        lesson_start_date DATE,
        -- 担当Tutor（クルー）
        assigned_tutor_id INTEGER REFERENCES users(id),
        -- 目標・特記事項
        goal TEXT,
        notes TEXT,
        -- 引き継ぎ完了フラグ
        handover_completed BOOLEAN DEFAULT FALSE,
        handover_completed_at TIMESTAMP,
        -- Notion連携
        notion_page_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // student_profiles マイグレーション（カラム追加）
    await db.query(`ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS status_note TEXT`);
    await db.query(`ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS goal TEXT`);
    await db.query(`ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS notes TEXT`);
    await db.query(`ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS handover_completed BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS handover_completed_at TIMESTAMP`);
    await db.query(`ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS notion_page_id VARCHAR(255)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_profiles_notion_page ON student_profiles(notion_page_id)`);
    // 学籍番号と既存のusername/emailが一意に一致する生徒を自動でNotionに紐づける。
    await db.query(`
      INSERT INTO student_profiles (user_id, notion_page_id, updated_at)
      SELECT u.id, ns.notion_page_id, CURRENT_TIMESTAMP
      FROM users u
      JOIN notion_students ns
        ON LOWER(ns.login_id) = LOWER(u.username)
        OR LOWER(ns.login_id) = LOWER(u.email)
      WHERE u.role = '生徒'
        AND ns.login_id IS NOT NULL
        AND ns.login_id <> ''
        AND (
          SELECT COUNT(*) FROM users duplicate_user
          WHERE duplicate_user.role = '生徒'
            AND (LOWER(duplicate_user.username) = LOWER(ns.login_id)
              OR LOWER(duplicate_user.email) = LOWER(ns.login_id))
        ) = 1
        AND (
          SELECT COUNT(*) FROM notion_students duplicate_ns
          WHERE LOWER(duplicate_ns.login_id) = LOWER(ns.login_id)
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM student_profiles linked
          WHERE linked.notion_page_id = ns.notion_page_id AND linked.user_id <> u.id
        )
      ON CONFLICT (user_id) DO UPDATE SET
        notion_page_id = EXCLUDED.notion_page_id,
        updated_at = CURRENT_TIMESTAMP
      WHERE student_profiles.notion_page_id IS NULL
    `);
    // Notionと紐づく既存アカウントにも、学籍番号（または管理画面の上書き値）を反映する。
    // 重複するログインIDがある場合は既存アカウントを優先して変更しない。
    await db.query(`
      UPDATE users u
      SET username = ns.login_id, updated_at = CURRENT_TIMESTAMP
      FROM student_profiles sp
      JOIN notion_students ns ON ns.notion_page_id = sp.notion_page_id
      WHERE sp.user_id = u.id
        AND ns.login_id IS NOT NULL
        AND ns.login_id <> ''
        AND u.username IS DISTINCT FROM ns.login_id
        AND (
          SELECT COUNT(*) FROM student_profiles duplicate_sp
          WHERE duplicate_sp.notion_page_id = sp.notion_page_id
        ) = 1
        AND (
          SELECT COUNT(*) FROM notion_students duplicate_ns
          WHERE LOWER(duplicate_ns.login_id) = LOWER(ns.login_id)
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM users other
          WHERE other.id <> u.id
            AND (LOWER(other.username) = LOWER(ns.login_id) OR LOWER(other.email) = LOWER(ns.login_id))
        )
    `);

    // =====================================================
    // 引き継ぎ情報テーブル（salesからTutorへ）
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS handover_info (
        id SERIAL PRIMARY KEY,
        student_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        -- 担当情報
        sales_user_id INTEGER REFERENCES users(id),
        tutor_user_id INTEGER REFERENCES users(id),
        -- 契約情報
        contract_plan VARCHAR(255),
        contract_start_date DATE,
        contract_end_date DATE,
        lesson_start_date DATE,
        first_session_date DATE,
        -- 目標・特記事項
        student_goal TEXT,
        student_background TEXT,
        special_notes TEXT,
        -- ステータス
        status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'confirmed')),
        submitted_at TIMESTAMP,
        confirmed_at TIMESTAMP,
        confirmed_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================================================
    // 延長審査テーブル
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS extension_reviews (
        id SERIAL PRIMARY KEY,
        student_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        -- 審査情報
        trigger_type VARCHAR(50) DEFAULT 'manual'
          CHECK (trigger_type IN ('auto', 'manual')),
        review_status VARCHAR(50) DEFAULT '審査中'
          CHECK (review_status IN ('審査中', '延長決定', '延長なし', '保留')),
        -- 審査結果
        result VARCHAR(50) CHECK (result IN ('承認', '否認', '保留', NULL)),
        result_reason TEXT,
        new_contract_end_date DATE,
        -- 担当者
        reviewer_id INTEGER REFERENCES users(id),
        -- 審査期間
        review_start_date DATE DEFAULT CURRENT_DATE,
        review_end_date DATE,
        -- 契約情報（審査時点）
        current_contract_end_date DATE,
        -- メモ
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================================================
    // 満足度テーブル
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS satisfaction_surveys (
        id SERIAL PRIMARY KEY,
        student_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        -- スコア（1〜5段階）
        overall_score INTEGER CHECK (overall_score >= 1 AND overall_score <= 5),
        lesson_score INTEGER CHECK (lesson_score >= 1 AND lesson_score <= 5),
        support_score INTEGER CHECK (support_score >= 1 AND support_score <= 5),
        -- フリーコメント
        good_points TEXT,
        improvement_points TEXT,
        free_comment TEXT,
        -- 登録情報
        survey_date DATE DEFAULT CURRENT_DATE,
        registered_by INTEGER REFERENCES users(id),
        -- 継続意向（延長審査との連携）
        wants_extension BOOLEAN,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================================================
    // 操作ログテーブル
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(50),
        target_id INTEGER,
        detail JSONB,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_user ON user_progress(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_lesson ON user_progress(lesson_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_completed ON user_progress(completed)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_progress_user_last_watched ON user_progress(user_id, last_watched_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_profiles_user ON student_profiles(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_profiles_status ON student_profiles(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_profiles_tutor ON student_profiles(assigned_tutor_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_extension_reviews_student ON extension_reviews(student_user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_extension_reviews_student_status ON extension_reviews(student_user_id, review_status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_satisfaction_student ON satisfaction_surveys(student_user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_satisfaction_student_created ON satisfaction_surveys(student_user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notion_status_plan ON notion_students(status, contract_plan)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_profiles_contract_end ON student_profiles(contract_end_date)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)`);

    // =====================================================
    // ステータスに「正規退会」「強制退会」を反映するマイグレーション
    // =====================================================
    await db.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_profiles_status_check') THEN
          ALTER TABLE student_profiles DROP CONSTRAINT student_profiles_status_check;
        END IF;
        ALTER TABLE student_profiles ADD CONSTRAINT student_profiles_status_check
          CHECK (status IN ('アクティブ', 'レッスン準備中', '休会', '正規退会', '強制退会'));
      END $$
    `);

    // =====================================================
    // 生徒目的・目標テーブル
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS student_goals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        -- 目的（大目標・長期）
        purpose TEXT,
        purpose_set_at TIMESTAMP,
        -- 目標（短中期・SMART目標）
        goal_title VARCHAR(255),
        goal_detail TEXT,
        goal_type VARCHAR(50) DEFAULT 'short' CHECK (goal_type IN ('short','mid','long')),
        target_date DATE,
        -- 進捗度（0〜100）
        progress_rate INTEGER DEFAULT 0 CHECK (progress_rate >= 0 AND progress_rate <= 100),
        progress_note TEXT,
        progress_updated_at TIMESTAMP,
        progress_updated_by INTEGER REFERENCES users(id),
        -- ステータス
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active','achieved','cancelled')),
        achieved_at TIMESTAMP,
        -- 担当Tutor設定
        set_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_goals_user ON student_goals(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_student_goals_status ON student_goals(status)`);

    // =====================================================
    // 受講スケジュールテーブル（個別最適化）
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS lesson_schedules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
        -- 予定日・期限
        scheduled_date DATE NOT NULL,
        due_date DATE,
        -- ステータス
        status VARCHAR(50) DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','completed','skipped','rescheduled')),
        -- 順序・優先度
        order_in_schedule INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0 CHECK (priority >= 0 AND priority <= 3),
        -- 完了情報
        completed_at TIMESTAMP,
        -- メモ
        tutor_note TEXT,
        -- 作成者
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, lesson_id, scheduled_date)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_schedules_user ON lesson_schedules(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_schedules_date ON lesson_schedules(scheduled_date)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_schedules_status ON lesson_schedules(status)`);

    // =====================================================
    // スケジュールテンプレート（Tutor/管理者が作成）
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS schedule_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        contract_plan VARCHAR(255),
        -- JSON配列: [{lessonId, dayOffset, dueOffset, priority, note}]
        items JSONB NOT NULL DEFAULT '[]',
        created_by INTEGER REFERENCES users(id),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================================================
    // 延長審査にメモ履歴を追加
    // =====================================================
    await db.query(`ALTER TABLE extension_reviews ADD COLUMN IF NOT EXISTS memo_history JSONB DEFAULT '[]'`);

    // =====================================================
    // 満足度サーベイにメタデータ追加
    // =====================================================
    await db.query(`ALTER TABLE satisfaction_surveys ADD COLUMN IF NOT EXISTS survey_round INTEGER DEFAULT 1`);
    await db.query(`ALTER TABLE satisfaction_surveys ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual'`);

    // =====================================================
    // 通知拡張（Discordだけでなく種別管理）
    // =====================================================
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_user_id INTEGER REFERENCES users(id)`);
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel VARCHAR(50) DEFAULT 'discord'`);
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMP`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_goals_user ON student_goals(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_schedules_user_date ON lesson_schedules(user_id, scheduled_date)`);

    // =====================================================
    // キャラクター選択（生徒ごと・画像ごとに1件のみ予約可能）
    // =====================================================
    await db.query(`
      CREATE TABLE IF NOT EXISTS character_selections (
        id SERIAL PRIMARY KEY,
        student_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        drive_file_id VARCHAR(255) NOT NULL UNIQUE,
        drive_file_name VARCHAR(255) NOT NULL,
        category VARCHAR(20) NOT NULL CHECK (category IN ('女性', '男性')),
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed')),
        selected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP,
        confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        stored_image_filename VARCHAR(255),
        stored_image_mime_type VARCHAR(100),
        stored_image_size BIGINT,
        stored_at TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`ALTER TABLE character_selections ADD COLUMN IF NOT EXISTS stored_image_filename VARCHAR(255)`);
    await db.query(`ALTER TABLE character_selections ADD COLUMN IF NOT EXISTS stored_image_mime_type VARCHAR(100)`);
    await db.query(`ALTER TABLE character_selections ADD COLUMN IF NOT EXISTS stored_image_size BIGINT`);
    await db.query(`ALTER TABLE character_selections ADD COLUMN IF NOT EXISTS stored_at TIMESTAMP`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_character_selections_status ON character_selections(status)`);
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_character_selections_stored_filename
      ON character_selections(stored_image_filename)
      WHERE stored_image_filename IS NOT NULL
    `);

    console.log('✅ All database tables created successfully');
  } catch (error) {
    console.error('❌ Error creating tables:', error);
    throw error;
  }
};

module.exports = { createTables };
