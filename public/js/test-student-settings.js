(function () {
  const get=id=>document.getElementById('test-student-'+id);
  async function request(method,body) {
    const response=await fetch('/api/central/test-student',{method,headers:{Authorization:'Bearer '+localStorage.getItem('token'),'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {})});
    const data=await response.json();if (!response.ok) throw new Error(data.error || '設定を取得・保存できません');return data;
  }
  function addLesson(lesson={}) {
    if (get('lessons').children.length>=50) return;
    const row=document.createElement('div');row.className='test-lesson-row';row.style='display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;';
    for (const [key,type,label] of [['date','date','日付'],['time','time','時刻'],['tutorName','text','Tutor名（任意）']]) {
      const wrapper=document.createElement('label');wrapper.textContent=label;
      const input=document.createElement('input');input.type=type;input.className='form-input';input.dataset.field=key;input.value=lesson[key] || '';
      input.required=key!=='tutorName';input.maxLength=100;wrapper.append(input);row.append(wrapper);
    }
    const remove=document.createElement('button');remove.type='button';remove.className='btn btn-secondary';remove.textContent='削除';remove.onclick=()=>row.remove();row.append(remove);get('lessons').append(row);
  }
  window.openTestStudentSettings=async()=>{
    try {
      const data=await request('GET');get('name').value=data.name;get('number').value=data.student_number || '';
      get('plan').value=data.contract_plan || 'スタンダードプラン';get('status').value=data.status || 'アクティブ';
      get('text-type').value=data.text_type || '旧';
      get('start').value=data.lesson_start_date || '';get('lessons').replaceChildren();
      for(const lesson of data.lessons || []) addLesson(lesson);
      get('message').textContent='';get('dialog').showModal();
    } catch(error) {get('message').textContent=error.message;get('dialog').showModal();}
  };
  get('add').addEventListener('click',()=>addLesson());
  get('form').addEventListener('submit',async event=>{
    event.preventDefault();get('save').disabled=true;
    try {
      const lessons=[...get('lessons').children].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(input=>[input.dataset.field,input.value])));
      const data=await request('PUT',{name:get('name').value,studentNumber:get('number').value,contractPlan:get('plan').value,
        status:get('status').value,textType:get('text-type').value,lessonStartDate:get('start').value,lessons});
      get('message').textContent=data.message;
      if (typeof loadStudentUsers==='function') await loadStudentUsers();
    } catch(error) {get('message').textContent=error.message;} finally {get('save').disabled=false;}
  });
})();
