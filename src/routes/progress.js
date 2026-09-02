const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Progress = require('../models/Progress');

// ユーザーの進捗取得
router.get('/', auth, async (req, res) => {
  try {
    const [progress, stats, courseStats] = await Promise.all([
      Progress.getUserProgress(req.user.id),
      Progress.getProgressStats(req.user.id),
      Progress.getCourseProgressStats(req.user.id),
    ]);
    res.json({ progress, stats, courseStats });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: '進捗の取得に失敗しました' });
  }
});

module.exports = router;
