(() => {
  const token=localStorage.getItem('token');
  if(!token){window.location.href='/';return;}
  fetch('/api/auth/me',{headers:{Authorization:'Bearer '+token}}).then(async response=>{
    if(!response.ok) throw new Error('ログイン情報を確認できません。再度ログインしてください。');
    const user=await response.json();
    if(user.needsPasswordChange){window.location.href='/';return;}
    if(!['生徒','管理者','クルー','セールス'].includes(user.role)) throw new Error('アクセス権限がありません。');
    document.getElementById('catalog-status').textContent='';
    document.getElementById('tool-catalog').hidden=false;
  }).catch(error=>{document.getElementById('catalog-status').textContent=error.message;});
})();
