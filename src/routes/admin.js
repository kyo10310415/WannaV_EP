const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { auth, checkRole } = require('../middleware/auth');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const Quiz = require('../models/Quiz');
const Progress = require('../models/Progress');
const db = require('../config/database');
const { generateThumbnail } = require('../utils/thumbnail');

// 動画アップロード設定
// UPLOAD_DIR は server.js で global に設定される（Render Disk 対応）
const getUploadDir = () => global.UPLOAD_DIR || require('path').join(__dirname, '../../uploads');
const configuredUploadLimitMb = Number.parseInt(process.env.MAX_VIDEO_UPLOAD_MB || '2048', 10);
const MAX_VIDEO_UPLOAD_MB = Number.isFinite(configuredUploadLimitMb) && configuredUploadLimitMb > 0
  ? configuredUploadLimitMb
  : 2048;
const MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_MB * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getUploadDir());
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'video-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_VIDEO_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = new Set(['.mp4', '.mov', '.avi', '.mkv']);
    const allowedMimeTypes = new Set([
      'video/mp4',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
      'application/octet-stream',
    ]);
    const extname = allowedExtensions.has(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMimeTypes.has(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('動画ファイルのみアップロード可能です'));
    }
  }
});

const handleVideoUpload = (req, res, next) => {
  upload.single('video')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `動画ファイルは最大${MAX_VIDEO_UPLOAD_MB}MBまでアップロードできます`,
      });
    }
    if (error.message === '動画ファイルのみアップロード可能です') {
      return res.status(400).json({ error: error.message });
    }
    return next(error);
  });
};

// ===== ユーザー管理 =====

// ユーザー取得（ページ用途に応じて生徒・生徒以外を分離）
router.get('/users', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const requestedScope = req.query.scope || 'all';
    if (!['all', 'staff', 'students'].includes(requestedScope)) {
      return res.status(400).json({ error: '無効なユーザー絞り込みです' });
    }
    // セールス権限には生徒アカウントだけを返す。
    const scope = req.user.role === 'セールス' ? 'students' : requestedScope;
    if (req.query.limit != null) {
      const page = await User.getPage(scope, {
        limit: req.query.limit,
        offset: req.query.offset,
        search: req.query.search,
      });
      return res.json(page);
    }
    const users = await User.getAll(scope);
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'ユーザーの取得に失敗しました' });
  }
});

// ★ 全ユーザーの進捗取得（/users/:id より前に定義する必要あり）
router.get('/users/progress', auth, checkRole('管理者', 'クルー', 'セールス'), async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const [users, summary] = await Promise.all([
      Progress.getAllUsersProgress({ limit, offset }),
      Progress.getAllUsersProgressSummary(),
    ]);
    const total = users[0]?.total_count || 0;
    res.json({
      users: users.map(({ total_count, ...user }) => user),
      summary,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + users.length < total,
      },
    });
  } catch (error) {
    console.error('Get all progress error:', error);
    res.status(500).json({ error: '進捗の取得に失敗しました' });
  }
});

// ユーザー作成（username + 初期PW=1111 固定）
// 管理者: 任意のロールで作成可
// セールス: 生徒ロール固定で作成可
router.post('/users', auth, checkRole('管理者', 'セールス'), async (req, res) => {
  try {
    const { username, name, role } = req.body;
    if (!username || !name) {
      return res.status(400).json({ error: 'ユーザー名と名前は必須です' });
    }
    // セールスは生徒固定（bodyのroleを無視）
    const actualRole = req.user.role === 'セールス' ? '生徒' : (role || '生徒');
    const user = await User.create(username, '1111', name, actualRole);
    res.status(201).json(user);
  } catch (error) {
    console.error('Create user error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'このユーザー名は既に使われています' });
    }
    res.status(500).json({ error: 'ユーザーの作成に失敗しました' });
  }
});

// ユーザー権限更新
router.patch('/users/:id/role', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { role } = req.body;
    const user = await User.updateRole(req.params.id, role);
    res.json(user);
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ error: '権限の更新に失敗しました' });
  }
});

// ユーザー削除
router.delete('/users/:id', auth, checkRole('管理者'), async (req, res) => {
  try {
    await User.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'ユーザーの削除に失敗しました' });
  }
});

// パスワードリセット（管理者が直接変更）
router.patch('/users/:id/password', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'パスワードは6文字以上で入力してください' });
    }
    await User.resetPassword(req.params.id, newPassword);
    res.json({ success: true, message: 'パスワードをリセットしました' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'パスワードのリセットに失敗しました' });
  }
});

// ===== コース管理 =====

// コース作成
router.post('/courses', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { title, description, orderIndex } = req.body;
    const result = await db.query(
      'INSERT INTO courses (title, description, order_index) VALUES ($1, $2, $3) RETURNING *',
      [title, description, orderIndex || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create course error:', error);
    res.status(500).json({ error: 'コースの作成に失敗しました' });
  }
});

// 全コース取得
router.get('/courses', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM courses ORDER BY order_index, id');
    res.json(result.rows);
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({ error: 'コースの取得に失敗しました' });
  }
});

// ダッシュボードに表示するコースセクションの順序を一括更新
router.patch('/courses/order', auth, checkRole('管理者'), async (req, res) => {
  const courseIds = Array.isArray(req.body.courseIds)
    ? req.body.courseIds.map(Number)
    : [];
  const isValid = courseIds.length > 0
    && courseIds.every(Number.isInteger)
    && courseIds.every(id => id > 0)
    && new Set(courseIds).size === courseIds.length;

  if (!isValid) {
    return res.status(400).json({ error: '並べ替えるコースを正しく指定してください' });
  }

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM courses ORDER BY order_index, id FOR UPDATE');
    const existingIds = existing.rows.map(row => Number(row.id));
    if (existingIds.length !== courseIds.length
      || existingIds.some(id => !courseIds.includes(id))) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'コース一覧が更新されています。再読み込みしてやり直してください' });
    }

    await client.query(`
      UPDATE courses AS c
      SET order_index = ordered.position,
          updated_at = CURRENT_TIMESTAMP
      FROM (
        SELECT id, (position - 1)::integer AS position
        FROM UNNEST($1::integer[]) WITH ORDINALITY AS item(id, position)
      ) AS ordered
      WHERE c.id = ordered.id
    `, [courseIds]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Update course order error:', error);
    res.status(500).json({ error: 'コースの表示順更新に失敗しました' });
  } finally {
    if (client) client.release();
  }
});

// ===== レッスン管理 =====

// 現在の動画アップロード上限
router.get('/upload-config', auth, checkRole('管理者'), (req, res) => {
  res.json({ maxVideoUploadMb: MAX_VIDEO_UPLOAD_MB });
});

// 自由科目の動画別・生徒別視聴回数
router.get('/lessons/free-subject/view-analytics', auth, checkRole('管理者'), async (req, res) => {
  try {
    const lessons = await Progress.getFreeSubjectViewAnalytics();
    res.json({ lessons });
  } catch (error) {
    console.error('Get free subject view analytics error:', error);
    res.status(500).json({ error: '自由科目の視聴回数取得に失敗しました' });
  }
});

// レッスン作成
router.post('/lessons', auth, checkRole('管理者'), handleVideoUpload, async (req, res) => {
  try {
    const { courseId, title, description, duration, orderIndex, externalVideoUrl } = req.body;

    let videoFilename = null;
    let videoUrl = null;
    let thumbnailUrl = null;

    if (req.file) {
      // ファイルアップロード優先
      videoFilename = req.file.filename;
      videoUrl = `/uploads/${req.file.filename}`;
      // MP4サムネイル自動生成（非同期・失敗しても続行）
      thumbnailUrl = await generateThumbnail(req.file.path, req.file.filename);
    } else if (externalVideoUrl && externalVideoUrl.trim()) {
      // 外部URL（YouTube等）
      videoFilename = 'external';
      videoUrl = externalVideoUrl.trim();
    }

    if (!videoUrl) {
      return res.status(400).json({ error: '動画ファイルまたは動画URLを指定してください' });
    }

    const lesson = await Lesson.create(
      courseId,
      title,
      description,
      videoFilename,
      videoUrl,
      duration,
      orderIndex || 0,
      thumbnailUrl
    );

    res.status(201).json(lesson);
  } catch (error) {
    console.error('Create lesson error:', error);
    res.status(500).json({ error: 'レッスンの作成に失敗しました' });
  }
});

// 全レッスン取得
router.get('/lessons', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const lessons = await Lesson.getAll();
    res.json(lessons);
  } catch (error) {
    console.error('Get lessons error:', error);
    res.status(500).json({ error: 'レッスンの取得に失敗しました' });
  }
});

// レッスン更新
router.patch('/lessons/:id', auth, checkRole('管理者'), handleVideoUpload, async (req, res) => {
  try {
    const { title, description, duration, orderIndex, externalVideoUrl, courseId } = req.body;
    const lesson = await Lesson.findById(req.params.id);
    
    if (!lesson) {
      return res.status(404).json({ error: 'レッスンが見つかりません' });
    }

    let videoFilename = lesson.video_filename;
    let videoUrl      = lesson.video_url;
    let thumbnailUrl  = lesson.thumbnail_url || null;

    if (req.file) {
      videoFilename = req.file.filename;
      videoUrl      = `/uploads/${req.file.filename}`;
      thumbnailUrl  = await generateThumbnail(req.file.path, req.file.filename);
    } else if (externalVideoUrl && externalVideoUrl.trim()) {
      videoFilename = 'external';
      videoUrl      = externalVideoUrl.trim();
      thumbnailUrl  = null;
    }

    const updated = await Lesson.update(req.params.id, {
      title,
      description,
      videoFilename,
      videoUrl,
      thumbnailUrl,
      duration,
      orderIndex,
      courseId: courseId || lesson.course_id  // コース変更対応
    });

    res.json(updated);
  } catch (error) {
    console.error('Update lesson error:', error);
    res.status(500).json({ error: 'レッスンの更新に失敗しました' });
  }
});

// レッスン削除
router.delete('/lessons/:id', auth, checkRole('管理者'), async (req, res) => {
  try {
    await Lesson.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete lesson error:', error);
    res.status(500).json({ error: 'レッスンの削除に失敗しました' });
  }
});

// サムネイル再生成（既存MP4レッスン用）
router.post('/lessons/:id/regenerate-thumbnail', auth, checkRole('管理者'), async (req, res) => {
  try {
    const lesson = await Lesson.findById(req.params.id);
    if (!lesson) return res.status(404).json({ error: 'レッスンが見つかりません' });
    if (!lesson.video_filename || lesson.video_filename === 'external') {
      return res.status(400).json({ error: 'MP4ファイルのレッスンのみ対象です' });
    }

    const videoPath = require('path').join(getUploadDir(), lesson.video_filename);
    const fs = require('fs');
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: '動画ファイルが見つかりません' });
    }

    const thumbnailUrl = await generateThumbnail(videoPath, lesson.video_filename);
    if (!thumbnailUrl) return res.status(500).json({ error: 'サムネイル生成に失敗しました' });

    // DBに保存
    await db.query('UPDATE lessons SET thumbnail_url = $1 WHERE id = $2', [thumbnailUrl, lesson.id]);
    res.json({ success: true, thumbnail_url: thumbnailUrl });
  } catch (error) {
    console.error('Regenerate thumbnail error:', error);
    res.status(500).json({ error: 'サムネイル再生成に失敗しました' });
  }
});

// 全MP4レッスンのサムネイルを一括再生成
router.post('/lessons/bulk-regenerate-thumbnails', auth, checkRole('管理者'), async (req, res) => {
  try {
    const lessons = await Lesson.getAll();
    const path = require('path');
    const fs = require('fs');
    const results = [];

    for (const lesson of lessons) {
      if (!lesson.video_filename || lesson.video_filename === 'external') continue;
      if (lesson.thumbnail_url) continue; // 既に生成済みはスキップ

      const videoPath = path.join(getUploadDir(), lesson.video_filename);
      if (!fs.existsSync(videoPath)) continue;

      const thumbnailUrl = await generateThumbnail(videoPath, lesson.video_filename);
      if (thumbnailUrl) {
        await db.query('UPDATE lessons SET thumbnail_url = $1 WHERE id = $2', [thumbnailUrl, lesson.id]);
        results.push({ id: lesson.id, title: lesson.title, thumbnail_url: thumbnailUrl });
      }
    }
    res.json({ success: true, generated: results.length, results });
  } catch (error) {
    console.error('Bulk thumbnail error:', error);
    res.status(500).json({ error: '一括サムネイル生成に失敗しました' });
  }
});

// ===== クイズ管理 =====

// クイズ作成
router.post('/lessons/:lessonId/quiz', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { questions } = req.body; // [{question, options: [], correctAnswer, orderIndex}]
    const lessonId = req.params.lessonId;

    // 既存のクイズを削除
    await Quiz.deleteByLesson(lessonId);

    // 新しいクイズを作成
    const created = [];
    for (const q of questions) {
      const question = await Quiz.createQuestion(
        lessonId,
        q.question,
        q.options,
        q.correctAnswer,
        q.orderIndex || 0
      );
      created.push(question);
    }

    res.status(201).json(created);
  } catch (error) {
    console.error('Create quiz error:', error);
    res.status(500).json({ error: 'クイズの作成に失敗しました' });
  }
});

// クイズ取得
router.get('/lessons/:lessonId/quiz', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const questions = await Quiz.getQuestionsByLesson(req.params.lessonId);
    res.json(questions);
  } catch (error) {
    console.error('Get quiz error:', error);
    res.status(500).json({ error: 'クイズの取得に失敗しました' });
  }
});

module.exports = router;
