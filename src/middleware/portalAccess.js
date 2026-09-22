const StudentPayment = require('../models/StudentPayment');
const { paymentEnabled } = require('../config/portal');

async function requirePortalAccess(req, res, next) {
  if (!paymentEnabled() || req.user.role !== '生徒') return next();
  try {
    const access = await StudentPayment.getAccess(req.user.id, req.user.role);
    if (!access?.allowed) {
      return res.status(403).json({ error: '現在ポータルをご利用いただけません。お支払い状況をご確認ください。',
        code: 'PAYMENT_REQUIRED' });
    }
    next();
  } catch (_) {
    // A DB outage is not an unpaid verdict.
    res.status(503).json({ error: '利用状況を確認できません。時間をおいて再度お試しください。',
      code: 'PORTAL_ACCESS_UNAVAILABLE' });
  }
}

function protectMedia(req, res, next) {
  if (!paymentEnabled()) return next();
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith('portal_media='));
  if (cookie) {
    try { req.cookies = { token: decodeURIComponent(cookie.slice('portal_media='.length)) }; }
    catch (_) { return res.status(401).end(); }
  }
  res.set('Cache-Control', 'private, no-store');
  return require('./auth').auth(req, res, next);
}

module.exports = { requirePortalAccess, protectMedia };
