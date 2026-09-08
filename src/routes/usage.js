const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');
const AppUsage = require('../models/AppUsage');

router.post('/open', auth, checkRole('生徒'), async (req, res) => {
  try {
    const usage = await AppUsage.recordOpen(req.user.id);
    if (!usage) {
      return res.status(403).json({ error: '生徒アカウントのみ利用回数を記録できます' });
    }
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Record app usage error:', error);
    res.status(500).json({ error: '利用回数の記録に失敗しました' });
  }
});

module.exports = router;
