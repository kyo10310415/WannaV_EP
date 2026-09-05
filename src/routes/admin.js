const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { auth, checkRole } = require('../middleware/auth');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const Quiz = require('../models/Quiz');
const Progress = require('../models/Progress');
const PortalSetting = require('../models/PortalSetting');
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
const MAX_IMAGE_UPLOAD_MB = 20;
const MAX_IMAGE_UPLOAD_BYTES = MAX_IMAGE_UPLOAD_MB * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getUploadDir());
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const prefix = file.fieldname === 'image' ? 'lesson-image-' : 'video-';
    cb(null, prefix + uniqueSuffix + path.extname(file.originalname).toLowerCase());
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_VIDEO_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const videoExtensions = new Set(['.mp4', '.mov', '.avi', '.mkv']);
    const videoMimeTypes = new Set([
      'video/mp4',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
      'application/octet-stream',
    ]);
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const extension = path.extname(file.originalname).toLowerCase();

    if (file.fieldname === 'video' && videoExtensions.has(extension) && videoMimeTypes.has(file.mimetype)) {
      return cb(null, true);
    }
    if (file.fieldname === 'image' && imageExtensions.has(extension) && imageMimeTypes.has(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('対応していないファイル形式です'));
  }
});

const handleContentUpload = (req, res, next) => {
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `動画ファイルは最大${MAX_VIDEO_UPLOAD_MB}MBまでアップロードできます`,
      });
    }
    if (error.message === '対応していないファイル形式です') {
      return res.status(400).json({ error: error.message });
    }
    return next(error);
  });
};

const uploadedFile = (req, fieldName) => req.files?.[fieldName]?.[0] || null;

async function removeUploadedFile(file) {
  if (!file?.path) return;
  await fs.promises.unlink(file.path).catch(() => {});
}

function validExternalUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validOptionalExternalUrl(value) {
  return !String(value || '').trim() || validExternalUrl(value);
}

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
    const { title, description, orderIndex, sequentialUnlock, isSpecialContent } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'コース名を入力してください' });
    }
    const result = await db.query(
      `INSERT INTO courses (title, description, order_index, sequential_unlock, is_special_content)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [String(title).trim(), description || null, orderIndex || 0, sequentialUnlock === true, isSpecialContent === true]
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

// コース名・説明・動画の解禁方法を更新
router.patch('/courses/:id', auth, checkRole('管理者'), async (req, res) => {
  try {
    const courseId = Number(req.params.id);
    const { title, description, sequentialUnlock, isSpecialContent } = req.body;
    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'コースを正しく指定してください' });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'コース名を入力してください' });
    }
    if (typeof sequentialUnlock !== 'boolean') {
      return res.status(400).json({ error: '動画の解禁方法を正しく指定してください' });
    }
    if (typeof isSpecialContent !== 'boolean') {
      return res.status(400).json({ error: 'スペシャルコンテンツ設定を正しく指定してください' });
    }

    const result = await db.query(`
      UPDATE courses
      SET title = $1,
          description = $2,
          sequential_unlock = $3,
          is_special_content = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [String(title).trim(), description || null, sequentialUnlock, isSpecialContent, courseId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'コースが見つかりません' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update course error:', error);
    res.status(500).json({ error: 'コース設定の更新に失敗しました' });
  }
});

// ===== レッスン管理 =====

// ダッシュボードに表示する外部リンク設定
router.get('/portal-links', auth, checkRole('管理者'), async (req, res) => {
  try {
    res.json(await PortalSetting.getLinks());
  } catch (error) {
    console.error('Get portal links error:', error);
    res.status(500).json({ error: '外部リンク設定の取得に失敗しました' });
  }
});

router.put('/portal-links', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { bucchakeVtuberUrl = '', classLessonUrl = '' } = req.body;
    if (!validOptionalExternalUrl(bucchakeVtuberUrl) || !validOptionalExternalUrl(classLessonUrl)) {
      return res.status(400).json({ error: 'URLはhttp://またはhttps://から始まる形式で入力してください' });
    }
    const links = await PortalSetting.updateLinks({
      bucchakeVtuberUrl: String(bucchakeVtuberUrl).trim(),
      classLessonUrl: String(classLessonUrl).trim(),
    });
    res.json(links);
  } catch (error) {
    console.error('Update portal links error:', error);
    res.status(500).json({ error: '外部リンク設定の保存に失敗しました' });
  }
});

// 現在の動画アップロード上限
router.get('/upload-config', auth, checkRole('管理者'), (req, res) => {
  res.json({
    maxVideoUploadMb: MAX_VIDEO_UPLOAD_MB,
    maxImageUploadMb: MAX_IMAGE_UPLOAD_MB,
  });
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
router.post('/lessons', auth, checkRole('管理者'), handleContentUpload, async (req, res) => {
  try {
    const {
      courseId, title, description, duration, orderIndex,
      contentMode, externalVideoUrl, externalLinkUrl,
    } = req.body;
    const videoFile = uploadedFile(req, 'video');
    const imageFile = uploadedFile(req, 'image');
    const mode = contentMode || (videoFile ? 'video-file' : 'video-url');

    let contentType = 'video';
    let videoFilename = null;
    let videoUrl = null;
    let thumbnailUrl = null;
    let imageFilename = null;
    let imageUrl = null;
    let linkUrl = null;

    if (imageFile && imageFile.size > MAX_IMAGE_UPLOAD_BYTES) {
      await Promise.all([removeUploadedFile(imageFile), removeUploadedFile(videoFile)]);
      return res.status(413).json({ error: `画像ファイルは最大${MAX_IMAGE_UPLOAD_MB}MBまでアップロードできます` });
    }

    if (mode === 'video-file' && videoFile) {
      videoFilename = videoFile.filename;
      videoUrl = `/uploads/${videoFile.filename}`;
      // MP4サムネイル自動生成（非同期・失敗しても続行）
      thumbnailUrl = await generateThumbnail(videoFile.path, videoFile.filename);
      await removeUploadedFile(imageFile);
    } else if (mode === 'video-url' && validExternalUrl(externalVideoUrl)) {
      videoFilename = 'external';
      videoUrl = externalVideoUrl.trim();
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
    } else if (mode === 'image' && imageFile) {
      contentType = 'image';
      imageFilename = imageFile.filename;
      imageUrl = `/uploads/${imageFile.filename}`;
      thumbnailUrl = imageUrl;
      await removeUploadedFile(videoFile);
    } else if (mode === 'link' && validExternalUrl(externalLinkUrl)) {
      contentType = 'link';
      linkUrl = externalLinkUrl.trim();
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
    } else {
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
      return res.status(400).json({ error: '選択した教材形式に必要なファイルまたはURLを指定してください' });
    }

    const lesson = await Lesson.create({
      courseId,
      title,
      description,
      contentType,
      videoFilename,
      videoUrl,
      imageFilename,
      imageUrl,
      externalLinkUrl: linkUrl,
      duration,
      orderIndex: orderIndex || 0,
      thumbnailUrl,
    });

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
router.patch('/lessons/:id', auth, checkRole('管理者'), handleContentUpload, async (req, res) => {
  try {
    const {
      title, description, duration, orderIndex, externalVideoUrl,
      externalLinkUrl, courseId, contentMode = 'keep',
    } = req.body;
    const lesson = await Lesson.findById(req.params.id);
    const videoFile = uploadedFile(req, 'video');
    const imageFile = uploadedFile(req, 'image');
    
    if (!lesson) {
      return res.status(404).json({ error: 'レッスンが見つかりません' });
    }

    let contentType   = lesson.content_type || 'video';
    let videoFilename = lesson.video_filename;
    let videoUrl      = lesson.video_url;
    let thumbnailUrl  = lesson.thumbnail_url || null;
    let imageFilename = lesson.image_filename || null;
    let imageUrl      = lesson.image_url || null;
    let linkUrl       = lesson.external_link_url || null;

    if (imageFile && imageFile.size > MAX_IMAGE_UPLOAD_BYTES) {
      await Promise.all([removeUploadedFile(imageFile), removeUploadedFile(videoFile)]);
      return res.status(413).json({ error: `画像ファイルは最大${MAX_IMAGE_UPLOAD_MB}MBまでアップロードできます` });
    }

    if (contentMode === 'video-file' && videoFile) {
      contentType = 'video';
      videoFilename = videoFile.filename;
      videoUrl      = `/uploads/${videoFile.filename}`;
      thumbnailUrl  = await generateThumbnail(videoFile.path, videoFile.filename);
      imageFilename = null;
      imageUrl = null;
      linkUrl = null;
      await removeUploadedFile(imageFile);
    } else if (contentMode === 'video-url' && validExternalUrl(externalVideoUrl)) {
      contentType = 'video';
      videoFilename = 'external';
      videoUrl      = externalVideoUrl.trim();
      thumbnailUrl  = null;
      imageFilename = null;
      imageUrl = null;
      linkUrl = null;
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
    } else if (contentMode === 'image' && imageFile) {
      contentType = 'image';
      videoFilename = null;
      videoUrl = null;
      imageFilename = imageFile.filename;
      imageUrl = `/uploads/${imageFile.filename}`;
      thumbnailUrl = imageUrl;
      linkUrl = null;
      await removeUploadedFile(videoFile);
    } else if (contentMode === 'link' && validExternalUrl(externalLinkUrl)) {
      contentType = 'link';
      videoFilename = null;
      videoUrl = null;
      imageFilename = null;
      imageUrl = null;
      thumbnailUrl = null;
      linkUrl = externalLinkUrl.trim();
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
    } else if (contentMode !== 'keep') {
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
      return res.status(400).json({ error: '選択した教材形式に必要なファイルまたはURLを指定してください' });
    } else {
      await Promise.all([removeUploadedFile(videoFile), removeUploadedFile(imageFile)]);
    }

    const updated = await Lesson.update(req.params.id, {
      title,
      description,
      contentType,
      videoFilename,
      videoUrl,
      imageFilename,
      imageUrl,
      externalLinkUrl: linkUrl,
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
