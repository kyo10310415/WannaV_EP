(() => {
  let current=null,busy=false,enabled=false;const token=localStorage.getItem('token');
  const $=id=>document.getElementById(id),status=text=>{$('tool-status').textContent=text;};
  async function api(path,options={}) {
    const response=await fetch('/api'+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
    const data=await response.json();if(!response.ok) throw new Error(data.error||'処理に失敗しました');return data;
  }
  function element(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
  function controls(){ $('send').disabled=busy||!current||!enabled;$('new-thread').disabled=busy;$('delete-thread').disabled=busy; }
  async function history(){const rows=await api('/tools/threads');$('threads').replaceChildren();
    if(!rows.length) $('threads').append(element('p','まだ相談はありません。新しい相談から始めましょう。'));
    for(const t of rows){const b=element('button',t.title);b.className='btn btn-secondary';b.onclick=()=>{if(!busy) open(t.id).catch(e=>status(e.message));};$('threads').append(b);}
  }
  async function download(id,name){try{const res=await fetch('/api/tools/attachments/'+id,{headers:{Authorization:'Bearer '+token}});if(!res.ok)throw new Error('添付の取得に失敗しました');const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}}
  async function open(id){const data=await api('/tools/threads/'+id);current=id;$('thread-title').textContent=data.thread.title;$('delete-thread').hidden=false;$('messages').replaceChildren();
    for(const m of data.messages){const box=element('article','');box.className='tool-message '+m.role;box.append(element('strong',m.role==='user'?'あなた':'OBSマスター'),element('p',m.text));
      for(const a of m.attachments||[]){const b=element('button','添付を保存：'+a.name);b.className='btn btn-secondary';b.onclick=()=>download(a.id,a.name);box.append(b);}
      if(m.citations?.length)box.append(element('strong','参照した情報のソース'));
      for(const c of m.citations||[]){try{const u=new URL(c.url);if(u.protocol!=='https:'||u.username||u.password)continue;const a=element('a',c.title+' — '+u.hostname);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}catch(_){}}
      $('messages').append(box);
    }controls();
  }
  $('new-thread').onclick=async()=>{if(busy)return;busy=true;controls();try{const t=await api('/tools/threads',{method:'POST'});await history();await open(t.id);status('OS・OBSバージョン・困っていることを教えてください。');}catch(e){status(e.message);}finally{busy=false;controls();}};
  $('delete-thread').onclick=async()=>{if(busy||!current||!confirm('この会話と添付を削除します。元に戻せません。削除しますか？'))return;busy=true;controls();try{await api('/tools/threads/'+current,{method:'DELETE'});current=null;$('messages').replaceChildren();$('thread-title').textContent='相談を選んでください';$('delete-thread').hidden=true;await history();status('会話と添付を削除しました。利用量の集計記録は残ります。');}catch(e){status(e.message);}finally{busy=false;controls();}};
  $('chat-form').onsubmit=async e=>{e.preventDefault();if(busy||!current||!enabled)return;const files=[...$('tool-files').files],text=$('tool-text').value.trim();if((!text&&!files.length)||files.length>2||files.some(f=>f.size>2*1024*1024)){status('相談を入力してください。添付は各2MB・2件までです。');return;}
    busy=true;controls();status('最新情報を確認しながら回答しています。最大90秒ほどかかる場合があります。');
    const form=new FormData();form.set('text',text);form.set('requestId',crypto.randomUUID());for(const f of files)form.append('attachments',f);
    try{await api('/tools/threads/'+current+'/messages',{method:'POST',body:form});$('tool-text').value='';$('tool-files').value='';status('回答しました。該当する番号でも返信できます。');}
    catch(e){status(e.message+' 自動再送はしません。送信済みの内容は履歴で確認してください。');}
    finally{try{await history();await open(current);}catch(e){status(e.message);}busy=false;controls();}
  };
  $('usage-button').onclick=async()=>{try{const data=await api('/tools/usage');$('usage-panel').hidden=false;$('usage-notice').textContent=data.notice;$('usage-rows').replaceChildren();for(const row of data.rows){const tr=document.createElement('tr');for(const val of [String(row.day).slice(0,10),row.model,row.status,row.requests,row.input_tokens,row.cached_tokens,row.output_tokens,row.searches,Number(row.unpriced)>0?(row.estimated_usd===null?'未算出':'一部未算出：'+row.estimated_usd):row.estimated_usd])tr.append(element('td',val??'不明'));$('usage-rows').append(tr);}}catch(e){status(e.message);}};
  (async()=>{if(!token){location.href='/';return;}try{const me=await api('/auth/me');if(me.needsPasswordChange){location.href='/';return;}$('usage-button').hidden=me.role!=='管理者';enabled=(await api('/tools/config')).enabled;status(enabled?'新しい相談、または履歴を選んでください。':'OBSマスターは準備中です。履歴は閲覧できます。');await history();controls();}catch(e){status(e.message);}})();
})();
