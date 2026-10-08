(function () {
  function line(lesson) {
    return `${lesson.date.replace(/-/g,'/')} ${lesson.time}${lesson.tutorName ? ' ／ '+lesson.tutorName : ''}`.trim();
  }
  async function load() {
    const panel=document.getElementById('student-lessons-panel');
    const content=document.getElementById('student-lessons-content');
    try {
      const response=await fetch('/api/central/my-lessons',{headers:{Authorization:`Bearer ${localStorage.getItem('token')}`}});
      if (!response.ok) throw new Error('unavailable');
      const data=await response.json();
      if (!data.eligible) return;
      panel.hidden=false;content.replaceChildren();
      if (!data.available) {content.textContent='予約情報を確認できません。同期完了後に再度ご確認ください。';return;}
      const status=document.createElement('p');
      status.className=data.count===0 ? 'lesson-booking-zero' : data.count===1 ? 'lesson-booking-one' : '';
      status.textContent=`${data.month.replace('-','年')}月の予約：${data.count}回`;
      if (data.count===1) status.textContent+='\n今月の予約が1回しか入っていません。もう一日予約をお取りください';
      if (data.count===0) status.textContent+='\n今月の予約が入っていません。2回分のご予約をお願いします';
      content.append(status);
      const list=document.createElement('ul');
      for (const lesson of data.lessons) {const item=document.createElement('li');item.textContent=line(lesson);list.append(item);}
      content.append(list);
      const note=document.createElement('p');note.className='lesson-sync-note';
      note.textContent='予約情報は毎時同期されます。最終同期：'+new Date(data.lastSyncedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});content.append(note);
      if (!data.tomorrowLessons.length) return;
      await window.ImportantMessageReady;
      const dialog=document.getElementById('lesson-reminder-dialog');
      document.getElementById('lesson-reminder-body').textContent=data.tomorrowLessons.map(line).join('\n');
      const show=()=>{
        if (document.visibilityState==='hidden' || document.querySelector('dialog[open]')) {setTimeout(show,500);return;}
        dialog.showModal();
      };
      show();
    } catch (_) {
      // Do not mistake an unavailable response for zero bookings or expose excluded plans.
      console.warn('レッスン予約を取得できません');
    }
  }
  window.StudentReservations={load};
})();
