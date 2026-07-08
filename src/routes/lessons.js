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

    // 管理者は全レッスンに無条件アクセス可。それ以外はアンロック判定
    if (req.user.role !== '管理者') {
      const canAccess = await Progress.canAccessLesson(req.user.id, lessonId);
      if (!canAccess) {
        return res.status(403).json({ error: '前のレッスンを完了してください' });
      }
    }

    const lesson = await Lesson.findById(lessonId);
    if (!lesson) {
      return res.status(404).json({ error: 'レッスンが見つかりません' });
    }

    // ユーザー進捗情報を取得して lesson に統合
    const progressResult = await require('../config/database').query(`
      SELECT completed, watch_percent
      FROM user_progress
      WHERE user_id = $1 AND lesson_id = $2
    `, [req.user.id, lessonId]);
    if (progressResult.rows.length > 0) {
      lesson.completed   = progressResult.rows[0].completed   || false;
      lesson.watch_percent = progressResult.rows[0].watch_percent || 0;
    } else {
      lesson.completed   = false;
      lesson.watch_percent = 0;
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

// 視聴率更新（MP4用 - 定期的に呼び出す）
router.post('/:id/watch-progress', auth, async (req, res) => {
  try {
    const lessonId = req.params.id;
    const { percent } = req.body;
    if (typeof percent !== 'number') {
      return res.status(400).json({ error: 'percentが必要です' });
    }
    const result = await Progress.updateWatchPercent(req.user.id, lessonId, percent);

    // 95%以上視聴した場合
    if (percent >= 95) {
      const Quiz = require('../models/Quiz');
      const questions = await Quiz.getQuestionsByLesson(lessonId);
      if (questions.length === 0) {
        // クイズなし → 自動完了
        await Progress.completeByWatching(req.user.id, lessonId);
        return res.json({ success: true, watch_percent: 100, auto_completed: true });
      } else {
        // クイズあり → クイズへ誘導
        return res.json({ success: true, watch_percent: result.watch_percent, show_quiz: true });
      }
    }
    res.json({ success: true, watch_percent: result.watch_percent });
  } catch (error) {
    console.error('Watch progress error:', error);
    res.status(500).json({ error: '視聴率の保存に失敗しました' });
  }
});

// 手動完了（iframe動画用 - Google Drive / YouTube）
router.post('/:id/manual-complete', auth, async (req, res) => {
  try {
    const lessonId = req.params.id;
    await Progress.completeByWatching(req.user.id, lessonId);

    // 完了通知
    const User = require('../models/User');
    const user = await User.findById(req.user.id);
    const lesson = await Lesson.findById(lessonId);
    const NotificationService = require('../utils/notification');
    await NotificationService.celebrateCompletion(user.name, lesson.title);

    res.json({ success: true });
  } catch (error) {
    console.error('Manual complete error:', error);
    res.status(500).json({ error: '完了登録に失敗しました' });
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
