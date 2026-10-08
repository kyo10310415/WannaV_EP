(function () {
  const number=value=>value.toLocaleString('ja-JP');
  const message='目指せ、Live2Dデビュー！ 5ヶ月目の目標達成で、1回目の延長審査でLive2D獲得のチャンス！';
  function render(data) {
    const panel=document.getElementById('growth-roadmap');
    if (!data.eligible) {panel.hidden=true;return;}
    panel.hidden=false;
    document.getElementById('growth-position').textContent=`📍 現在地：レッスン開始から${data.currentMonth}ヶ月目`;
    const comparisons=document.getElementById('growth-comparisons');comparisons.replaceChildren();
    const goal=data.goals.find(item=>item.month===data.currentMonth);
    for(const [platform,label] of [['x','X フォロワー'],['youtube','YouTube 登録者']]) {
      const metric=data.current[platform],target=goal[platform],card=document.createElement('div');card.className='growth-comparison';
      const heading=document.createElement('h3');heading.textContent=label;card.append(heading);
      const text=document.createElement('p');text.textContent=`最新取得：${metric.count===null ? '未取得' : number(metric.count)+'人'} ／ 今月の目標：${number(target)}人`;card.append(text);
      if (metric.count!==null && target>0) {
        const progress=document.createElement('progress');progress.max=target;progress.value=Math.min(metric.count,target);progress.setAttribute('aria-label',label+'の目標達成状況');card.append(progress);
        const remaining=document.createElement('p');remaining.textContent=metric.count>=target ? '🎉 今月の目標を達成しています！' : `目標まであと${number(target-metric.count)}人。一歩ずつ積み重ねよう！`;card.append(remaining);
      } else if (target===0) {const note=document.createElement('p');note.textContent='今月は準備期間。自分のペースで土台をつくろう！';card.append(note);}
      if(metric.fetchedAt) {const date=document.createElement('small');date.textContent='取得日時：'+new Date(metric.fetchedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});card.append(date);}
      comparisons.append(card);
    }
    const body=document.getElementById('growth-goals-body');body.replaceChildren();
    for(const item of data.goals) {
      const row=document.createElement('tr');
      if(item.month===data.currentMonth) {row.className='growth-current';row.setAttribute('aria-current','step');}
      for(const value of [`${item.month}ヶ月目${item.month===data.currentMonth ? ' 📍 現在地' : ''}`,number(item.x)+'人',number(item.youtube)+'人']) {
        const cell=document.createElement('td');cell.textContent=value;row.append(cell);
      }
      const note=document.createElement('td');if(item.month===5) note.textContent=message;row.append(note);body.append(row);
    }
  }
  async function load() {
    try {
      const response=await fetch('/api/central/my-growth',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}});
      if(!response.ok) throw new Error('unavailable');render(await response.json());
    } catch (_) {console.warn('成長指標を取得できません');}
  }
  window.GrowthRoadmap={load,render};
})();
