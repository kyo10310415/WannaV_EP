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

// 動画アップロード設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'video-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB制限
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mov|avi|mkv/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('動画ファイルのみアップロード可能です'));
    }
  }
});

// ===== ユーザー管理 =====

// 全ユーザー取得
router.get('/users', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const users = await User.getAll();
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'ユーザーの取得に失敗しました' });
  }
});

// ユーザー作成
router.post('/users', auth, checkRole('管理者'), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    const user = await User.create(email, password, name, role);
    res.status(201).json(user);
  } catch (error) {
    console.error('Create user error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'このメールアドレスは既に登録されています' });
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

// 全ユーザーの進捗取得
router.get('/users/progress', auth, checkRole('管理者', 'クルー'), async (req, res) => {
  try {
    const progress = await Progress.getAllUsersProgress();
    res.json(progress);
  } catch (error) {
    console.error('Get all progress error:', error);
    res.status(500).json({ error: '進捗の取得に失敗しました' });
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
    const result = await db.query('SELECT * FROM courses ORDER BY order_index');
    res.json(result.rows);
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({ error: 'コースの取得に失敗しました' });
  }
});

// ===== レッスン管理 =====

// レッスン作成
router.post('/lessons', auth, checkRole('管理者'), upload.single('video'), async (req, res) => {
  try {
    const { courseId, title, description, duration, orderIndex } = req.body;
    const videoFilename = req.file ? req.file.filename : null;
    const videoUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const lesson = await Lesson.create(
      courseId,
      title,
      description,
      videoFilename,
      videoUrl,
      duration,
      orderIndex || 0
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
router.patch('/lessons/:id', auth, checkRole('管理者'), upload.single('video'), async (req, res) => {
  try {
    const { title, description, duration, orderIndex } = req.body;
    const lesson = await Lesson.findById(req.params.id);
    
    if (!lesson) {
      return res.status(404).json({ error: 'レッスンが見つかりません' });
    }

    const videoFilename = req.file ? req.file.filename : lesson.video_filename;
    const videoUrl = req.file ? `/uploads/${req.file.filename}` : lesson.video_url;

    const updated = await Lesson.update(req.params.id, {
      title,
      description,
      videoFilename,
      videoUrl,
      duration,
      orderIndex
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
