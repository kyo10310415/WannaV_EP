(() => {
  const isVts=document.body.dataset.tool==='vtube-studio';
  const isGear=document.body.dataset.tool==='streaming-gear';
  const isKanau=document.body.dataset.tool==='kanau';
  const isYoutube=document.body.dataset.tool==='youtube-analyst';
  const isGame=document.body.dataset.tool==='youtube-game-strategy';
  const toolName=isGame?'YouTubeゲーム配信 戦略分析官':isYoutube?'YouTubeアナリティクス分析官':isKanau?'かなうさん':isGear?'配信機材コンシェルジュ':isVts?'VTube Studioマスター':'OBSマスター';
  const base=isGame?'/tools/youtube-game-strategy':isYoutube?'/tools/youtube-analyst':isKanau?'/tools/kanau':isGear?'/tools/streaming-gear':isVts?'/tools/vtube-studio':'/tools';
  let renderVersion=0;const previews=[];
  function clearPreviews(){renderVersion++;for(const url of previews.splice(0))URL.revokeObjectURL(url);}
  let current=null,busy=false,generating=false,enabled=false,imageEnabled=false,initialMessage='',availabilityMessage='利用状況を確認しています。しばらくお待ちください。',refreshingAvailability=null,nextAvailabilityCheck=0;const token=localStorage.getItem('token');
  const $=id=>document.getElementById(id),status=text=>{$('tool-status').textContent=text;};
  const sendLabel=$('send').textContent;
  async function api(path,options={}) {
    if(path.startsWith('/tools/'))path=base+path.slice(6);
    if(!options.signal&&(!options.method||options.method==='GET')&&typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function')options={...options,signal:AbortSignal.timeout(15000)};
    const response=await fetch('/api'+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
    const data=await response.json();if(!response.ok) throw new Error(data.error||'処理に失敗しました');return data;
  }
  function element(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
  function costAmount(row,currency){const partial=Number(row.unpriced)>0,value=partial?row[currency==='USD'?'known_usd':'known_jpy']:row[currency==='USD'?'estimated_usd':'estimated_jpy'];if(value===null||value===undefined)return '未算出';return (partial?'一部未算出：':'')+(currency==='USD'?'$':'¥')+Number(value).toLocaleString('ja-JP',{minimumFractionDigits:currency==='USD'?6:2,maximumFractionDigits:currency==='USD'?6:2});}
  function controls(){
    $('send').disabled=busy||!enabled;$('new-thread').disabled=busy;$('delete-thread').disabled=busy;
    $('send').textContent=generating?'処理中…':sendLabel;
    $('chat-form').setAttribute?.('aria-busy',String(generating));
    if($('tool-processing'))$('tool-processing').hidden=!generating;
    if($('tool-availability')){$('tool-availability').hidden=enabled;$('tool-availability-message').textContent=busy?'処理中です。完了までお待ちください。':availabilityMessage;$('refresh-availability').disabled=busy||!!refreshingAvailability;}
  }
  async function refreshAvailability(){
    if(refreshingAvailability)return refreshingAvailability;
    refreshingAvailability=(async()=>{try{
      const previousMessage=availabilityMessage;const config=await api('/tools/config');enabled=config.enabled===true;imageEnabled=config.imageEnabled===true;initialMessage=config.initialMessage||'';
      availabilityMessage=enabled?'利用できます。':config.unavailableMessage||toolName+'は準備中です。管理者へお問い合わせください。';
      if(enabled&&$('tool-status').textContent===previousMessage)status('利用できるようになりました。入力内容を確認して送信してください。');
      nextAvailabilityCheck=Date.now()+Math.min(86400,Math.max(5,Number(config.retryAfterSeconds)||30))*1000;
      if(isYoutube)$('thumbnail-option').disabled=!imageEnabled;
      return config;
    }catch(_){enabled=false;availabilityMessage='利用状況を確認できませんでした。通信状態を確認し、「利用状況を再確認」を押してください。入力内容はそのまま残ります。';nextAvailabilityCheck=Date.now()+30000;return null;
    }})();controls();try{return await refreshingAvailability;}finally{refreshingAvailability=null;controls();}
  }
  if($('refresh-availability'))$('refresh-availability').onclick=()=>{if(!busy)return refreshAvailability();};
  if(typeof setInterval==='function')setInterval(()=>{if(!busy&&!enabled&&!document.hidden&&Date.now()>=nextAvailabilityCheck)void refreshAvailability();},10000);
  document.addEventListener?.('visibilitychange',()=>{if(!document.hidden&&!busy&&!enabled)void refreshAvailability();});
  function showInitialMessage(){if(initialMessage){const box=element('article','');box.className='tool-message assistant';box.append(element('strong',toolName),element('p',initialMessage));$('messages').append(box);}}
  async function history(){const rows=await api('/tools/threads');$('threads').replaceChildren();
    if(!rows.length) $('threads').append(element('p','まだ相談はありません。入力欄からそのまま送信できます。'));
    for(const t of rows){const b=element('button',t.title);b.className='btn btn-secondary';b.onclick=async()=>{if(busy)return;busy=true;controls();try{await open(t.id);}catch(e){status(e.message);}finally{busy=false;controls();}};$('threads').append(b);}
  }
  async function download(id,name){try{const res=await fetch('/api'+base+'/attachments/'+id,{headers:{Authorization:'Bearer '+token}});if(!res.ok)throw new Error('添付の取得に失敗しました');const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}}
  async function previewImage(a,box,version){try{const res=await fetch('/api'+base+'/attachments/'+a.id,{headers:{Authorization:'Bearer '+token}});if(!res.ok)throw new Error();const blob=await res.blob();if(version!==renderVersion)return;
    const url=URL.createObjectURL(blob);previews.push(url);const img=element('img','');img.src=url;img.alt=isYoutube?'改善後のサムネイル':'かなうさんが生成したイラスト';img.className='tool-generated-image';box.append(img);
  }catch(_){if(version===renderVersion)box.append(element('p','プレビューを表示できません。添付を保存ボタンからダウンロードできます。'));}}
  async function open(id){const data=await api('/tools/threads/'+id);const version=++renderVersion;for(const url of previews.splice(0))URL.revokeObjectURL(url);current=id;$('thread-title').textContent=data.thread.title;$('delete-thread').hidden=false;$('messages').replaceChildren();
    for(const m of data.messages){const box=element('article','');box.className='tool-message '+m.role;box.append(element('strong',m.role==='user'?'あなた':toolName));
      if(m.role==='assistant' && window.ToolMarkdown)box.append(window.ToolMarkdown.render(m.text));else box.append(element('p',m.text));
      for(const a of m.attachments||[]){const b=element('button',(a.kind==='generated'?'画像をダウンロード：':'添付を保存：')+a.name);b.className='btn btn-secondary';b.onclick=()=>download(a.id,a.name);box.append(b);if((isKanau||isYoutube)&&a.kind==='generated')previewImage(a,box,version);}
      if(m.citations?.length)box.append(element('strong','参照した情報のソース'));
      for(const c of m.citations||[]){try{const u=new URL(c.url);if(u.protocol!=='https:'||u.username||u.password)continue;const a=element('a',c.title+' — '+u.hostname);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}catch(_){}}
      $('messages').append(box);
    }controls();
  }
  $('new-thread').onclick=async()=>{if(busy)return;busy=true;controls();try{const t=await api('/tools/threads',{method:'POST'});await history();await open(t.id);status(isGame?'':isYoutube?'分析したい期間・目的と数値を教えてください。CSVやサムネイルも添付できます。':isKanau?'最初に立ち絵を添付し、用途・希望のデザイン・入れたい文字を教えてください。':isGear?'配信内容・予算・今お持ちの機材を教えてください。写真を添えても相談できます。':isVts?'PC・スマホのOS、VTube Studioバージョン、困っていることを教えてください。':'OS・OBSバージョン・困っていることを教えてください。');}catch(e){status(e.message);}finally{busy=false;controls();}};
  $('delete-thread').onclick=async()=>{if(busy||!current||!confirm('この会話と添付を削除します。元に戻せません。削除しますか？'))return;busy=true;controls();try{await api('/tools/threads/'+current,{method:'DELETE'});current=null;clearPreviews();$('messages').replaceChildren();showInitialMessage();$('thread-title').textContent='相談を入力してください';$('delete-thread').hidden=true;await history();status('会話と添付を削除しました。利用量の集計記録は残ります。');}catch(e){status(e.message);}finally{busy=false;controls();}};
  $('chat-form').onsubmit=async e=>{e.preventDefault();if(busy||!enabled)return;const files=[...$('tool-files').files],text=$('tool-text').value.trim(),limit=isYoutube||isGame?3:2;const imageMode=isKanau||(isYoutube&&$('analysis-mode').value==='thumbnail');if((!text&&!files.length)||files.length>limit||files.some(f=>f.size>2*1024*1024)){status(`相談を入力してください。添付は各2MB・${limit}件までです。`);return;}
    if(isYoutube&&imageMode&&!imageEnabled){status('画像生成は準備中です。分析モードは利用できます。');return;}
    if(isYoutube&&imageMode&&!text){status('動画タイトル・内容・希望する改善を入力してください。');return;}
    if(isKanau&&!text){status('希望のイラストについて入力してください。');return;}
    generating=true;busy=true;if($('tool-processing-title'))$('tool-processing-title').textContent=imageMode?'ただいま画像を生成中…':isGame||isYoutube?'ただいまデータを確認・分析中…':'ただいま回答を準備中…';controls();status(isGame?'入力を確認しています。データが揃っている場合は、CSV計算・公開情報の調査・分析を行います。最大8分ほどかかる場合があります。画面を閉じずにお待ちください。':imageMode?'画像とご希望を確認しています。生成には最大4分ほどかかります。画面を閉じずにお待ちください。':isYoutube?'いただいたデータを確認しています。最大90秒ほどかかる場合があります。':'最新情報を確認しながら回答しています。最大90秒ほどかかる場合があります。');
    const form=new FormData();form.set('text',text);form.set('requestId',crypto.randomUUID());if(isKanau)form.set('size',$('tool-size').value||'1536x864');if(isYoutube)form.set('mode',$('analysis-mode').value||'analyze');for(const f of files)form.append('attachments',f);
    try{if(!current){const thread=await api('/tools/threads',{method:'POST'});current=thread.id;}await api('/tools/threads/'+current+'/messages',{method:'POST',body:form});$('tool-text').value='';$('tool-files').value='';status(isYoutube||isGame?'回答を確認してください。不足情報の確認がある場合は、同じ会話で返信できます。':isKanau?'画像を作成しました。仕上がりを確認し、画像をダウンロードできます。':'回答しました。該当する番号でも返信できます。');}
    catch(e){status(e.message+' 自動再送はしません。送信済みの内容は履歴で確認してください。');}
    finally{try{await history();if(current)await open(current);}catch(e){status(e.message);}generating=false;busy=false;await refreshAvailability();controls();}
  };
  $('usage-button').onclick=async()=>{try{const data=await api('/tools/usage');$('usage-panel').hidden=false;$('usage-notice').textContent=data.notice+'\n本日の円換算レート：'+(data.exchangeRate?'1 USD = '+data.exchangeRate+'円':'未設定')+(data.exchangeInfo?'（適用日 '+data.exchangeInfo.day+'／公表日 '+data.exchangeInfo.sourceDate+'／'+data.exchangeInfo.source+'）':'')+(data.budget?.limit!==null&&data.budget?.limit!==undefined?'\n本日の上限：'+data.budget.limit+'円／算出済み '+(data.budget.spent??'不明')+'円／処理中・料金不明の確保額 '+(data.budget.held??'不明')+'円':'')+((data.missingPrices||[]).length?'\n未設定の単価：'+data.missingPrices.join('、'):'');$('usage-rows').replaceChildren();for(const row of data.rows){const tr=document.createElement('tr');for(const val of [String(row.day).slice(0,10),row.tool_key==='youtube-game-strategy'?'YouTubeゲーム配信 戦略分析官':row.tool_key==='youtube-analyst'?'YouTubeアナリティクス分析官':row.tool_key==='kanau'?'かなうさん':row.tool_key==='streaming-gear'?'配信機材コンシェルジュ':row.tool_key==='vtube-studio'?'VTube Studioマスター':'OBSマスター',row.model,row.status,row.requests,row.input_tokens,row.cached_tokens,row.output_tokens,row.searches,costAmount(row,'USD'),costAmount(row,'JPY'),Number(row.image_estimates)>0?'画像分は設定平均単価':row.tool_key==='youtube-game-strategy'?'使用量×設定単価／再利用：コンテナ'+Number(row.reused_containers||0)+'回・計算'+Number(row.reused_audits||0)+'回・調査'+Number(row.reused_researches||0)+'回':'使用量×設定単価',row.image_calls??(row.image_model||row.tool_key==='kanau'?'不明':'—'),row.image_model||'—'])tr.append(element('td',val??'不明'));$('usage-rows').append(tr);}}catch(e){status(e.message);}};
  (async()=>{if(!token){location.href='/';return;}try{const me=await api('/auth/me');if(me.needsPasswordChange){location.href='/';return;}$('usage-button').hidden=me.role!=='管理者';await refreshAvailability();showInitialMessage();status(enabled?'相談を入力して送信してください。続きは履歴から再開できます。':availabilityMessage);await history();}catch(e){status(e.message);if(!enabled)availabilityMessage='利用状況を確認できませんでした。画面を再読み込みするか、「利用状況を再確認」を押してください。';}finally{controls();}})();
})();
