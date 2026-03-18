const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const Lesson = require('../models/Lesson');
const Progress = require('../models/Progress');
const Quiz = require('../models/Quiz');

// 全レッスン取得（進捗付き）
router.get('/', auth, async (req, res) => {
  try {
    const lessons = await Lesson.getWithProgress(req.user.id);
    res.json(lessons);
  } catch (error) {
    console.error('Get lessons error:', error);
    res.status(500).json({ error: 'レッスンの取得に失敗しました' });
  }
});

// レッスン詳細取得
router.get('/:id', auth, async (req, res) => {
  try {
    const lessonId = req.params.id;
    
    // アクセス権限チェック
    const canAccess = await Progress.canAccessLesson(req.user.id, lessonId);
    if (!canAccess) {
      return res.status(403).json({ error: '前のレッスンを完了してください' });
    }

    const lesson = await Lesson.findById(lessonId);
    if (!lesson) {
      return res.status(404).json({ error: 'レッスンが見つかりません' });
    }

    const questions = await Quiz.getQuestionsByLesson(lessonId);

    res.json({ lesson, questions });
  } catch (error) {
    console.error('Get lesson error:', error);
    res.status(500).json({ error: 'レッスンの取得に失敗しました' });
  }
});

// 視聴記録
router.post('/:id/view', auth, async (req, res) => {
  try {
    const lessonId = req.params.id;
    await Progress.recordView(req.user.id, lessonId);
    res.json({ success: true });
  } catch (error) {
    console.error('Record view error:', error);
    res.status(500).json({ error: '視聴記録に失敗しました' });
  }
});

// クイズ提出
router.post('/:id/quiz', auth, async (req, res) => {
  try {
    const lessonId = req.params.id;
    const { answers } = req.body;

    const result = await Quiz.verifyAnswers(lessonId, answers);
    await Progress.completeQuiz(req.user.id, lessonId, result.passed);

    if (result.passed) {
      const User = require('../models/User');
      const user = await User.findById(req.user.id);
      const lesson = await Lesson.findById(lessonId);
      
      const NotificationService = require('../utils/notification');
      await NotificationService.celebrateCompletion(user.name, lesson.title);
    }

    res.json(result);
  } catch (error) {
    console.error('Submit quiz error:', error);
    res.status(500).json({ error: 'クイズの提出に失敗しました' });
  }
});

module.exports = router;
