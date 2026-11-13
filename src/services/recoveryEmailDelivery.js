const { createHash } = require('crypto');
const nodemailer = require('nodemailer');

const validEmail = value => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value || '');
const provider = () => (process.env.RECOVERY_EMAIL_PROVIDER || 'resend').trim().toLowerCase();
const appPassword = () => (process.env.GOOGLE_WORKSPACE_APP_PASSWORD || '').replace(/ /g, '');

function configured() {
 const from = process.env.RECOVERY_EMAIL_FROM || '';
 if (!validEmail(from)) return false;
 if (provider() === 'resend') return !!process.env.RESEND_API_KEY;
 if (provider() === 'google_workspace') {
  const user = process.env.GOOGLE_WORKSPACE_SMTP_USER || '';
  return validEmail(user) && user.toLowerCase() === from.toLowerCase() && /^[A-Za-z0-9]{16}$/.test(appPassword());
 }
 return false;
}

async function send(to, code, id, transport = fetch, createSmtpTransport = nodemailer.createTransport) {
 if (!configured()) throw Error('RECOVERY_MAIL_NOT_CONFIGURED');
 const message = {
  from: { name: 'WannaV ポータル', address: process.env.RECOVERY_EMAIL_FROM },
  to: [to],
  subject: '【WannaV ポータル】パスワード再設定用メールの確認',
  text: 'パスワード再設定用のメールアドレスを登録するための確認コードです。\n\n確認コード：' + code + '\n\n有効期限は10分です。ログイン済みの登録画面に入力してください。\nこのコードは、第三者やサポート担当者にも伝えないでください。\n心当たりがない場合は、このメールを破棄してください。'
 };
 if (provider() === 'google_workspace') {
  let smtp;
  try {
   smtp = createSmtpTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GOOGLE_WORKSPACE_SMTP_USER, pass: appPassword() },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.gmail.com' },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false
   });
   // Stable identifier for diagnostics; SMTP does not guarantee idempotent delivery.
   const messageId = '<recovery-' + createHash('sha256').update(String(id)).digest('hex') + '@' + process.env.RECOVERY_EMAIL_FROM.split('@')[1] + '>';
   const result = await smtp.sendMail({ ...message, messageId, disableFileAccess: true, disableUrlAccess: true });
   if (!result.accepted?.some(address => String(address).toLowerCase() === to.toLowerCase())) throw Error('RECIPIENT_NOT_ACCEPTED');
  } catch {
   // Never expose credentials, recipients, codes, or Google's error response.
   throw Error('RECOVERY_MAIL_DELIVERY_FAILED');
  } finally {
   if (smtp) smtp.close();
  }
  return;
 }
 const response = await transport('https://api.resend.com/emails', {
  method: 'POST', signal: AbortSignal.timeout(15000),
  headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'recovery-email-' + id },
  body: JSON.stringify({ ...message, from: 'WannaV ポータル <' + process.env.RECOVERY_EMAIL_FROM + '>' })
 });
 if (!response.ok) throw Error('RECOVERY_MAIL_DELIVERY_FAILED');
}
module.exports = { configured, send };
