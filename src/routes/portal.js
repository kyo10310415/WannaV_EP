const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const PortalSetting = require('../models/PortalSetting');
const { getUpcomingPortalDates } = require('../utils/recurringDates');

router.get('/links', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const links = await PortalSetting.getLinks();
    const dates = getUpcomingPortalDates();
    res.json({
      bucchakeVtuber: {
        title: 'ぶっちゃけVtuber',
        url: links.bucchakeVtuberUrl,
        schedule: '第一、第三金曜日の22時から',
        nextDate: dates.bucchakeVtuber,
      },
      classLesson: {
        title: 'クラスレッスン',
        url: links.classLessonUrl,
        schedule: '第二、第四水曜日の22時から',
        nextDate: dates.classLesson,
      },
    });
  } catch (error) {
    console.error('Get portal links error:', error);
    res.status(500).json({ error: '案内リンクの取得に失敗しました' });
  }
});

module.exports = router;
