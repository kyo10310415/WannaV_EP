const storage = require('../services/objectStorage');
const db = require('../config/database');
const { protectMedia } = require('./portalAccess');
const Progress = require('../models/Progress');

// Old bookmarks and cached lesson URLs must not keep streaming migrated videos through Render.
module.exports = async (req,res,next) => {
  if (!storage.enabled() || req.method !== 'GET') return next();
  const filename = req.path.slice(1);
  if (!/^(video-|lesson-image-)[a-zA-Z0-9.-]+$/.test(filename)) return next();
  try {
    const result = await db.query(`SELECT id,video_filename,video_storage_key,image_filename,image_storage_key
      FROM lessons WHERE (video_filename = $1 AND video_storage_key IS NOT NULL)
        OR (image_filename = $1 AND image_storage_key IS NOT NULL)`,[filename]);
    if (!result.rows.length) return next();
    req.forceMediaAuth = true;
    return protectMedia(req,res,async () => {
      try {
        for (const lesson of result.rows) {
          if (req.user.role !== '管理者' && !await Progress.canAccessLesson(req.user.id,lesson.id)) continue;
          const key = lesson.video_filename === filename ? lesson.video_storage_key : lesson.image_storage_key;
          res.set('Cache-Control','private, no-store');
          return res.redirect(302,(await storage.signedGet(key)).url);
        }
        res.status(403).end();
      } catch (_) { res.status(503).end(); }
    });
  } catch (_) { res.status(503).end(); }
};
