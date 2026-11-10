(() => {
  const guides={
    'obs-master':{steps:['OS・OBSのバージョン・困っている症状を入力します。','必要なら画面やログを添付して送信します。','案内された手順を試し、結果や該当する番号を同じ会話で返信します。'],examples:['WindowsでOBSを使っています。ゲーム画面が真っ黒です。何から確認すればいいですか？','配信ではマイクの声が聞こえますが、ゲーム音が入りません。YouTubeに配信しています。']},
    'vtube-studio':{steps:['PC・スマホのOS、VTube Studioのバージョンと症状を入力します。','接続状況やエラーの画面があれば添付します。','案内に沿って操作し、結果や番号を返信して切り分けを進めます。'],examples:['WindowsのVTube StudioにiPhoneが接続できません。同じWi-Fiを使っています。','モデルは読み込めますが、口が動きません。Webカメラを使っています。']},
    'streaming-gear':{steps:['配信内容・予算・今ある機材を入力します。','必要スペックと商品候補を比較します。','気になる候補や使い方を、同じ会話で追加相談します。'],examples:['Live2Dの雑談配信を始めたいです。PC込みで予算15万円です。必要な機材を教えてください。','USBマイクを使っています。キーボード音を減らすには、配置や設定をどうすればいいですか？']},
    'kanau':{steps:['最初に利用権限のある立ち絵を添付します。','用途・ポーズ・背景・入れたい文字と画像サイズを指定して送信します。','画像を確認してダウンロードします。修正は同じ会話で指示できます。'],examples:['添付する立ち絵でYouTubeの初配信サムネイルを作ってください。笑顔で手を振るポーズ、青い背景、文字は「初配信！」。','同じキャラクターのまま、背景を夜空に変更してください。衣装と髪色は維持してください。']},
    'youtube-analyst':{steps:['分析したい期間・目的・数値を入力し、必要ならCSVやサムネイルを添付します。','不足情報の質問に答え、良い点・改善点・次のアクションを確認します。','画像も作りたい場合は「改善サムネイルを作成」に切り替え、元画像と動画内容を指定します。'],examples:['直近28日の通常動画を分析したいです。登録者300人、投稿3本です。これから添付するCSVから、優先して改善する点を教えてください。','サムネイルを診断してください。動画はホラーゲームの初見配信です。初めて見る人に怖がるリアクションを伝えたいです。画像を添付します。']},
    'youtube-game-strategy':{steps:['①チャンネル詳細分析、または②新規ゲーム探索を選んで送信します。','YouTubeチャンネルURLとAnalyticsのCSV3種類を送ります。分けて送っても構いません。','データが揃うと計算・公開情報の調査を開始します。確認質問があれば答え、提案と根拠を確認します。'],examples:['①','②']}
  };
  const key=document.body.dataset.tool||'obs-master',guide=guides[key],layout=document.querySelector('.tools-layout');if(!guide||!layout)return;
  const el=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
  const section=el('section','');section.className='card tool-help';section.setAttribute('aria-labelledby','tool-help-title');
  const title=el('h2','使い方と使用例');title.id='tool-help-title';section.append(title);
  const steps=el('ol','');for(const step of guide.steps)steps.append(el('li',step));section.append(steps);
  section.append(el('p','入力欄からそのまま送信できます。初回の送信時に会話を自動作成します。同じ話題は続けて送信し、別の話題は「＋ 新しい相談」で分けてください。続きは自分の履歴から再開できます。'));
  section.append(el('h3','使用例（クリックで入力欄にコピー）'));
  for(const example of guide.examples){const button=el('button',example);button.type='button';button.className='btn btn-secondary tool-example';button.onclick=()=>{
    const input=document.getElementById('tool-text');if(input.value.trim()&&!confirm('入力中の文章を使用例に置き換えますか？'))return;input.value=example;input.focus();
  };section.append(button);}
  section.append(el('p','使用例は入力欄にコピーするだけで、自動送信しません。ご自身の情報に書き換えてから送信してください。'));
  layout.before(section);
})();
