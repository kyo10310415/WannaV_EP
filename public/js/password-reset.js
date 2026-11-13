(() => {
 'use strict';
 const requestForm = document.getElementById('reset-request-form');
 const passwordForm = document.getElementById('reset-password-form');
 const status = document.getElementById('recovery-status');
 const again = document.getElementById('request-another');
 let token = new URLSearchParams(location.hash.slice(1)).get('token');
 // Keep the secret only in memory, out of history, storage, referrers, and request URLs.
 if (location.hash || location.search) history.replaceState(null, '', location.pathname);
 if (location.pathname === '/reset-password' && /^[A-Za-z0-9_-]{43}$/.test(token || '')) {
  passwordForm.hidden = false;
  document.getElementById('reset-heading').textContent = '新しいパスワードを設定';
  document.getElementById('reset-description').textContent = 'メールのリンクは15分間有効です。再設定すると、すべての端末で以前のログイン状態が無効になります。';
  again.hidden = false;
 } else {
  token = null; requestForm.hidden = false;
  if (location.pathname === '/reset-password') status.textContent = 'メールのリンクを開き直すか、再設定メールをもう一度お申し込みください。';
 }
 async function submit(form, path, payload) {
  const button = form.querySelector('button');
  if (button.disabled) return false;
  button.disabled = true; form.setAttribute('aria-busy', 'true');
  status.textContent = path === 'request' ? '再設定メールを申し込んでいます…' : 'パスワードを再設定しています…';
  try {
   const response = await fetch('/api/auth/password-reset/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'omit', body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
   });
   const data = await response.json();
   if (!response.ok) throw Error(data.error || '時間をおいてお試しください。');
   status.textContent = data.message; status.focus(); return true;
  } catch (error) {
   status.textContent = error.name === 'TimeoutError' || error.name === 'TypeError'
    ? '通信を確認できませんでした。申し込み後はメールをご確認ください。再設定後はログインをお試しください。'
    : error.message;
   status.focus(); return false;
  } finally { button.disabled = false; form.removeAttribute('aria-busy'); }
 }
 requestForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (await submit(requestForm, 'request', {
   loginId: document.getElementById('reset-login-id').value.trim(), email: document.getElementById('reset-email').value.trim()
  })) { requestForm.hidden = true; again.hidden = false; }
 });
 passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const password = document.getElementById('reset-new-password').value;
  const confirmation = document.getElementById('reset-confirm-password').value;
  if (password !== confirmation) { status.textContent = '同じパスワードを2回入力してください。'; status.focus(); return; }
  if (new TextEncoder().encode(password).length > 72) { status.textContent = 'パスワードを72バイト以内に短くしてください。'; status.focus(); return; }
  if (await submit(passwordForm, 'complete', { token, newPassword: password, confirmPassword: confirmation })) {
   token = null; passwordForm.reset(); passwordForm.hidden = true; again.hidden = true;
  }
 });
})();
