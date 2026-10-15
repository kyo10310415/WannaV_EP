const jwt = require('jsonwebtoken');

function verifyToken(token) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.verify(token, process.env.JWT_SECRET);
}
async function verifyPasswordReset(decoded) {
  if (!['管理者','クルー','セールス','生徒'].includes(decoded.role)) return;
  const row=(await require('../config/database').query('SELECT staff_password_reset_nonce FROM users WHERE id=$1',[decoded.id])).rows[0];
  if (row?.staff_password_reset_nonce && row.staff_password_reset_nonce!==decoded.staffResetNonce)
    throw new jwt.JsonWebTokenError('Session invalidated by password reset');
}

function respondTokenError(error, res) {
  const expired = error instanceof jwt.TokenExpiredError;
  if (!expired && !(error instanceof jwt.JsonWebTokenError) && !(error instanceof jwt.NotBeforeError)) return false;
  res.clearCookie('portal_media', { path: '/', httpOnly: true, sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' });
  res.status(401).json(expired
    ? { error: 'セッションの有効期限が切れました。再度ログインしてください。', code: 'TOKEN_EXPIRED' }
    : { error: '認証に失敗しました', code: 'INVALID_TOKEN' });
  return true;
}

module.exports = { verifyToken, verifyPasswordReset, respondTokenError };
