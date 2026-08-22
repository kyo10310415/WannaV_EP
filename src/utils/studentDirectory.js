function normalizeLoginId(value) {
  return String(value || '').trim().toLowerCase();
}

function accountLoginKeys(student) {
  return [student.student_username, student.student_email, student.student_login_id]
    .map(normalizeLoginId)
    .filter(Boolean);
}

/**
 * アプリ内アカウントとNotionキャッシュを、生徒管理画面向けの1一覧にまとめる。
 * notion_page_id を優先し、未設定の場合はログインID/メールアドレスで同一人物を判定する。
 */
function mergeStudentRecords(accountStudents = [], notionStudents = [], { includeUnlinkedNotion = true } = {}) {
  const merged = accountStudents.map(student => ({
    ...student,
    student_login_id: student.student_login_id || student.student_username || student.student_email || null,
    record_source: 'account',
    has_account: true,
  }));

  const accountByNotionId = new Map();
  const accountByLoginId = new Map();
  merged.forEach((student, index) => {
    if (student.notion_page_id) accountByNotionId.set(student.notion_page_id, index);
    accountLoginKeys(student).forEach(key => {
      if (!accountByLoginId.has(key)) accountByLoginId.set(key, index);
    });
  });

  const matchedAccounts = new Set();
  for (const notion of notionStudents) {
    const loginKey = normalizeLoginId(notion.login_id);
    let accountIndex = accountByNotionId.get(notion.notion_page_id);
    if (accountIndex == null && loginKey) accountIndex = accountByLoginId.get(loginKey);

    if (accountIndex != null && !matchedAccounts.has(accountIndex)) {
      const account = merged[accountIndex];
      merged[accountIndex] = {
        ...account,
        student_name: account.student_name || notion.student_name,
        student_login_id: notion.login_id || account.student_login_id,
        notion_page_id: notion.notion_page_id,
        notion_url: notion.notion_url,
        student_number: notion.student_number,
        name_furigana: notion.name_furigana,
        notion_status: notion.status,
        contract_plan: account.contract_plan || notion.contract_plan,
        lesson_start_date: account.lesson_start_date || notion.lesson_start_month,
        notion_login_id_overridden: notion.login_id_overridden,
        notion_synced_at: notion.synced_at,
        record_source: 'account+notion',
      };
      matchedAccounts.add(accountIndex);
      continue;
    }

    if (includeUnlinkedNotion) {
      merged.push({
        user_id: null,
        profile_id: null,
        student_name: notion.student_name,
        student_username: null,
        student_email: null,
        student_login_id: notion.login_id,
        status: notion.status,
        contract_plan: notion.contract_plan,
        lesson_start_date: notion.lesson_start_month,
        notion_page_id: notion.notion_page_id,
        notion_url: notion.notion_url,
        student_number: notion.student_number,
        name_furigana: notion.name_furigana,
        notion_login_id_overridden: notion.login_id_overridden,
        notion_synced_at: notion.synced_at,
        completed_lessons: 0,
        latest_satisfaction: null,
        under_review: false,
        record_source: 'notion',
        has_account: false,
      });
    }
  }

  return merged.sort((a, b) => {
    const numberA = a.student_number || '\uffff';
    const numberB = b.student_number || '\uffff';
    return numberA.localeCompare(numberB, 'ja')
      || String(a.student_name || '').localeCompare(String(b.student_name || ''), 'ja');
  });
}

module.exports = { mergeStudentRecords, normalizeLoginId };
