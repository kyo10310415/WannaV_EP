/**
 * notionSync.js
 * Notion REST API v1 を axios で直接呼び出す実装。
 * @notionhq/client のバージョン差異（v2 vs v5）に依存しないため安定。
 *
 * 使用環境変数:
 *   NOTION_TOKEN        - Notion Integration Token (secret_xxxx)
 *   NOTION_DATABASE_ID  - 対象 Notion データベースの ID
 */

const axios = require('axios');
const NotionStudent = require('../models/NotionStudent');
const { TARGET_CONTRACT_PLANS } = require('../config/contractPlans');

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION  = '2022-06-28';

// ===== Notion プロパティ名の定義（実際の DB に合わせて変更可） =====
const PROP = {
  STUDENT_NAME:   '生徒名',
  NAME_FURIGANA:  '本名ふりがな',
  STUDENT_NUMBER: '学籍番号',
  LESSON_START:   'レッスン開始月',
  STATUS:         'ステータス',
  CONTRACT_PLAN:  '契約プラン',
};

// ===== axios インスタンスを token 付きで生成 =====
function createNotionAxios(token) {
  return axios.create({
    baseURL: NOTION_API_BASE,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

// ===== プロパティ値をテキストに変換 =====
function getTextValue(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') || null;
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') || null;
    case 'select':
      return prop.select?.name || null;
    case 'status':
      return prop.status?.name || null;
    case 'multi_select':
      return prop.multi_select?.map(s => s.name).join(', ') || null;
    case 'date':
      return prop.date?.start || null;
    case 'number':
      return prop.number != null ? String(prop.number) : null;
    case 'url':
      return prop.url || null;
    case 'email':
      return prop.email || null;
    case 'phone_number':
      return prop.phone_number || null;
    case 'checkbox':
      return prop.checkbox ? 'true' : 'false';
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string;
      if (prop.formula?.type === 'number') return String(prop.formula.number);
      return null;
    default:
      return null;
  }
}

// ===== Notion ページを内部形式に変換 =====
function parsePage(page) {
  const props = page.properties || {};

  // ページタイトルは type: "title" プロパティとして存在する。
  // プロパティ名はDB依存（「名前」「Name」「生徒名」など）のため、
  // PROP.STUDENT_NAME での名前一致より type: "title" の自動検出を優先する。
  const titleProp   = Object.values(props).find(p => p.type === 'title');
  const studentName = titleProp
    ? getTextValue(titleProp)
    : getTextValue(props[PROP.STUDENT_NAME]); // フォールバック

  const nameFurigana     = getTextValue(props[PROP.NAME_FURIGANA]);
  const studentNumber    = getTextValue(props[PROP.STUDENT_NUMBER]);
  const lessonStartMonth = getTextValue(props[PROP.LESSON_START]);
  const status           = getTextValue(props[PROP.STATUS]);
  const contractPlan     = getTextValue(props[PROP.CONTRACT_PLAN]);

  // Notion ページ URL
  const notionUrl = page.url || `https://www.notion.so/${page.id.replace(/-/g, '')}`;

  return {
    notionPageId: page.id,
    studentName,
    nameFurigana,
    studentNumber,
    notionUrl,
    lessonStartMonth,
    status,
    contractPlan,
    // Notion連携生徒の初期ログインIDは学籍番号を使用する。
    loginId: studentNumber?.trim() || null,
    rawData: page,
  };
}

/**
 * 対象契約プランを Notion API の OR 条件へ変換する。
 */
function buildContractPlanFilter() {
  return {
    or: TARGET_CONTRACT_PLANS.map(plan => ({
      property: PROP.CONTRACT_PLAN,
      select: { equals: plan },
    })),
  };
}

/**
 * Notion DB をページネーション対応で全件取得（対象6プランのみフィルタ）
 */
async function fetchTargetPlanStudents() {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    throw new Error('NOTION_TOKEN または NOTION_DATABASE_ID が設定されていません');
  }

  const api = createNotionAxios(token);
  const students = [];
  let startCursor = undefined;
  let hasMore = true;

  const filter = buildContractPlanFilter();

  while (hasMore) {
    const body = {
      filter,
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const res = await api.post(`/databases/${dbId}/query`, body);
    const data = res.data;

    for (const page of data.results || []) {
      const parsed = parsePage(page);

      // ---- デバッグログ（1件目のみ）----
      if (students.length === 0) {
        const props = page.properties || {};
        const titleEntry = Object.entries(props).find(([, v]) => v.type === 'title');
        console.log('🔍 [DEBUG] 1件目のページID:', page.id);
        console.log('🔍 [DEBUG] type:title プロパティ:', titleEntry
          ? `name="${titleEntry[0]}" value="${titleEntry[1].title?.map(t=>t.plain_text).join('')}"`
          : '見つからない');
        console.log('🔍 [DEBUG] 全プロパティ名:', Object.keys(props).join(', '));
        console.log('🔍 [DEBUG] studentName取得結果:', parsed.studentName);
        console.log('🔍 [DEBUG] contractPlan取得結果:', parsed.contractPlan);
      }
      // ------------------------------------

      // フィルタが効いているが念のため再チェック
      if (TARGET_CONTRACT_PLANS.includes(parsed.contractPlan)) {
        students.push(parsed);
      }
    }

    hasMore = data.has_more === true;
    startCursor = data.next_cursor || undefined;
  }

  return students;
}

/**
 * メイン同期関数
 * 1. Notion から対象6プランの生徒を全件取得
 * 2. PostgreSQL へ UPSERT
 * 3. 学籍番号をログインID、初期PW「1111」として生徒アカウントを作成・連携
 * @returns {{ synced: number, accountsCreated: number, accountsLinked: number, accountsSkipped: number, timestamp: Date }}
 */
async function runNotionStudentSync() {
  console.log('🔄 Notion 生徒データ同期開始...');

  try {
    const students = await fetchTargetPlanStudents();
    console.log(`📋 Notion から ${students.length} 件取得（対象プラン: ${TARGET_CONTRACT_PLANS.join('、')}）`);

    if (students.length === 0) {
      console.log('⚠️ 取得データが 0 件です（対象プランに該当するデータがないか、プロパティ名を確認してください）');
      return { synced: 0, accountsCreated: 0, accountsLinked: 0, accountsSkipped: 0, timestamp: new Date() };
    }

    const summary = await NotionStudent.upsertMany(students);
    console.log(`✅ Notion 同期完了: ${summary.upserted} 件を DB に保存`);
    console.log(`👤 アカウント: ${summary.accountsCreated} 件作成 / ${summary.accountsLinked} 件連携 / ${summary.accountsSkipped} 件スキップ`);

    return { synced: summary.upserted, ...summary, timestamp: new Date() };
  } catch (error) {
    console.error('❌ Notion 同期エラー:', error.message);
    // axios のエラーレスポンスがあれば詳細を出力
    if (error.response) {
      console.error('  Notion API status:', error.response.status);
      console.error('  Notion API body:', JSON.stringify(error.response.data));
    }
    throw error;
  }
}

let activeSyncPromise = null;

function syncNotionStudents() {
  if (activeSyncPromise) {
    console.log('⏳ Notion 同期は既に実行中のため、同じ処理の完了を待ちます');
    return activeSyncPromise;
  }
  activeSyncPromise = runNotionStudentSync()
    .finally(() => {
      activeSyncPromise = null;
    });
  return activeSyncPromise;
}

/**
 * デバッグ用: Notion DB の全プロパティ名・型・サンプル値を取得
 * 生徒一覧の1件目を取得して properties のキー名を返す
 */
async function fetchDatabaseProperties() {
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    throw new Error('NOTION_TOKEN または NOTION_DATABASE_ID が設定されていません');
  }

  const api = createNotionAxios(token);

  // 1. DB のスキーマ取得（プロパティ名と型の一覧）
  const dbRes = await api.get(`/databases/${dbId}`);
  const dbProps = dbRes.data.properties || {};

  const schema = Object.entries(dbProps).map(([name, prop]) => ({
    name,
    type: prop.type,
    // select/multi_select の場合は選択肢も返す
    options: prop.select?.options?.map(o => o.name)
          || prop.multi_select?.options?.map(o => o.name)
          || null,
  }));

  // 2. 1件だけサンプルページを取得してプロパティ値の実例を返す
  const sampleRes = await api.post(`/databases/${dbId}/query`, { page_size: 1 });
  const samplePage = sampleRes.data.results?.[0];
  let sampleValues = null;

  if (samplePage) {
    sampleValues = {};
    for (const [key, val] of Object.entries(samplePage.properties || {})) {
      sampleValues[key] = {
        type: val.type,
        value: getTextValue(val),
      };
    }
  }

  return { schema, sampleValues, dbTitle: dbRes.data.title?.[0]?.plain_text || '' };
}

// 既存の呼び出し元との互換性を維持するため、旧関数名もエイリアスとして残す。
const fetchEntryPlanStudents = fetchTargetPlanStudents;

module.exports = {
  syncNotionStudents,
  fetchTargetPlanStudents,
  fetchEntryPlanStudents,
  fetchDatabaseProperties,
  parsePage,
  buildContractPlanFilter,
};
