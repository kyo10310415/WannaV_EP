const { verifyToken, respondTokenError } = require('../utils/jwtAuth');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '') || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: '認証が必要です' });
    }

    const decoded = verifyToken(token);
    if (decoded.passwordChangeRequired) {
      return res.status(403).json({
        error: '初回ログイン時のパスワード変更が必要です',
        code: 'PASSWORD_CHANGE_REQUIRED'
      });
    }
    req.user = decoded;
    return require('./portalAccess').requirePortalAccess(req, res, next);
  } catch (error) {
    if (respondTokenError(error, res)) return;
    console.error('Authentication error:', error);
    res.status(500).json({ error: '認証処理に失敗しました' });
  }
};

const checkRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '認証が必要です' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'アクセス権限がありません' });
    }

    next();
  };
};

module.exports = { auth, checkRole };
