function configured(){return !!process.env.RESEND_API_KEY&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(process.env.RECOVERY_EMAIL_FROM||'');}
async function send(to,code,id,transport=fetch){
 if(!configured())throw Error('RECOVERY_MAIL_NOT_CONFIGURED');
 const response=await transport('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'recovery-email-'+id},body:JSON.stringify({from:'WannaV ポータル <'+process.env.RECOVERY_EMAIL_FROM+'>',to:[to],subject:'【WannaV ポータル】パスワード再設定用メールの確認',text:'パスワード再設定用のメールアドレスを登録するための確認コードです。\n\n確認コード：'+code+'\n\n有効期限は10分です。ログイン済みの登録画面に入力してください。\nこのコードは、第三者やサポート担当者にも伝えないでください。\n心当たりがない場合は、このメールを破棄してください。'})});
 if(!response.ok)throw Error('RECOVERY_MAIL_DELIVERY_FAILED');
}
module.exports={configured,send};
