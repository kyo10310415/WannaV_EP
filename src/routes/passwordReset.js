const express = require('express');
const { body, validationResult } = require('express-validator');
const reset = require('../models/PasswordReset');
const router = express.Router();
const generic = '入力内容が登録情報と一致する場合、再設定メールを送信します。届かない場合は迷惑メールフォルダーをご確認ください。メール未登録の方は担当者へお問い合わせください。';
let sending = 0;
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(async (req, res, next) => {
 try {
  if (!reset.enabled()) return res.status(503).json({ error: '現在パスワードの再設定は利用できません。担当者へお問い合わせください。' });
  if (!await reset.allow('ip:' + req.path, req.ip || req.socket.remoteAddress || 'unknown', 100)) return res.status(429).json({ error: '操作が多くなっています。15分ほど待ってお試しください。' });
  next();
 } catch { res.status(503).json({ error: '時間をおいてお試しください。' }); }
});
router.post('/request',
 body('loginId').isString().bail().trim().isLength({ min: 1, max: 255 }).not().matches(/[\r\n]/),
 body('email').isString().bail().trim().isLength({ max: 254 }).isEmail({ allow_utf8_local_part: false, require_tld: true }),
 async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ログインIDと登録したメールアドレスを入力してください。' });
  try {
   const allowed = await reset.allow('identity', req.body.loginId.toLowerCase() + '\0' + req.body.email.toLowerCase(), 5);
   if (sending >= 5) return res.status(503).json({ error: 'ただいま混み合っています。少し待ってお試しください。' });
   // Respond before any account lookup or SMTP operation to prevent timing-based enumeration.
   res.status(202).json({ message: generic });
   if (allowed) {
    sending++;
    setImmediate(() => {
     reset.request(req.body.loginId, req.body.email)
      .catch(() => console.warn('Password reset request could not be completed'))
      .finally(() => { sending--; });
    });
   }
  } catch { if (!res.headersSent) res.status(503).json({ error: '時間をおいてお試しください。' }); }
 });
router.post('/complete',
 body('token').isString().bail().matches(/^[A-Za-z0-9_-]{43}$/),
 body('newPassword').isString().bail().isLength({ min: 8 }).custom(value => Buffer.byteLength(value, 'utf8') <= 72),
 body('confirmPassword').custom((value, { req }) => typeof value === 'string' && value === req.body.newPassword),
 async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'メールのリンクを開き、同じパスワードを2回入力してください。パスワードは8文字以上・UTF-8で72バイト以内で設定してください。' });
  try {
   const account = await reset.complete(req.body.token, req.body.newPassword);
   res.clearCookie('portal_media', { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
   res.json({ success: true, message: 'パスワードを再設定しました。新しいパスワードでログインしてください。' });
   setImmediate(() => { reset.notify(account).catch(() => console.warn('Password reset completion notice could not be sent')); });
  } catch (error) {
   res.status(error.status || 503).json({ error: error.status ? error.message : '時間をおいてお試しください。' });
  }
 });
module.exports = router;
