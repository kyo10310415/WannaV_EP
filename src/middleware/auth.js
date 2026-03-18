const jwt = require('jsonwebtoken');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '') || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: '認証が必要です' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: '無効なトークンです' });
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
