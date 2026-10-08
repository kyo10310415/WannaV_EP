const test=require('node:test');
const assert=require('node:assert/strict');
const {identityDiagnostics,mapStudents,partitionStudents}=require('../src/services/centralStudentSync');

test('重複生徒だけ保留し、全候補を保護する。元データ重複は隠さない',()=>{
  const rows=[{student_id:'DUP',name:'重複'},{student_id:'OK',name:'正常'}];
  const existing=[{student_number:'dup',notion_page_id:'one'},{student_number:'DUP',notion_page_id:'two'}];
  const result=partitionStudents(rows,existing);
  assert.deepEqual(result.heldNumbers,['DUP']);assert.deepEqual(result.heldPages,['one','two']);
  assert.deepEqual(result.entries.map(e=>e.studentNumber),['OK']);
  assert.throws(()=>partitionStudents([...rows,rows[0]],existing),e=>e.code==='INVALID_STUDENT');
  assert.throws(()=>partitionStudents([rows[0],{student_id:'OK',notion_page_id:'one',name:'正常'}],existing),e=>e.code==='AMBIGUOUS_STUDENT');
});

test('生徒照合診断は重複キーと別レコードへの一致を区別し識別子を出さない',()=>{
  const rows=[{student_id:'NUMBER-A',notion_page_id:'page-a',name:'private-person'},
    {student_id:'NUMBER-B',notion_page_id:'page-b',name:'private-person'},
    {student_id:'NUMBER-C',notion_page_id:'page-c',name:'private-person'},
    {student_id:'NUMBER-D',notion_page_id:'page-d',name:'private-person'}];
  const existing=[{student_number:'other',notion_page_id:'PAGE-A'},
    {student_number:'NUMBER-A',notion_page_id:'different'},
    {student_number:'NUMBER-B',notion_page_id:'page-b'},
    {student_number:'number-b',notion_page_id:'other-b'},
    {student_number:'other-c',notion_page_id:'PAGE-C'},
    {student_number:'another-c',notion_page_id:'page-c'},
    {student_number:'NUMBER-D',notion_page_id:'page-d'},
    {student_number:'number-d',notion_page_id:'PAGE-D'}];
  const before=JSON.stringify({rows,existing});
  const result=identityDiagnostics(rows,existing);
  assert.deepEqual(result,{affectedStudents:4,types:{NOTION_NUMBER_CONFLICT:1,STUDENT_NUMBER_DUPLICATE:2,NOTION_ID_DUPLICATE:2}});
  assert.doesNotMatch(JSON.stringify(result),/NUMBER-A|page-a|private-person/);
  assert.equal(JSON.stringify({rows,existing}),before);
  for(const row of rows) assert.throws(()=>mapStudents([row],existing),error=>error.code==='AMBIGUOUS_STUDENT');
});

test('単一レコードへの両キー一致と未登録は重複扱いしない',()=>{
  const row={student_id:'S001',notion_page_id:'abcdef',name:'生徒'};
  const existing=[{student_number:'s001',notion_page_id:'abc-def'}];
  assert.deepEqual(identityDiagnostics([row,{student_id:'NEW',name:'新規'}],existing),{affectedStudents:0,types:{}});
  assert.equal(mapStudents([row],existing)[0].notionPageId,'abc-def');
});
