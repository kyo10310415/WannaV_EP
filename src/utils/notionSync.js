/**
 * notionSync.js
 * Notion データベースからエントリープランの生徒情報を取得し、
 * PostgreSQL にキャッシュする同期ユーティリティ。
 *
 * 使用環境変数:
 *   NOTION_TOKEN        - Notion Integration Token (secret_xxxx)
 *   NOTION_DATABASE_ID  - 対象 Notion データベースの ID
 */

const { Client } = require('@notionhq/client');
const NotionStudent = require('../models/NotionStudent');

// ===== Notion プロパティ名の定義（実際の DB に合わせて調整） =====
// Notion DB のプロパティ名が日本語の場合はそのまま記述
const PROP = {
  STUDENT_NAME:    '生徒名',
  NAME_FURIGANA:   '本名ふりがな',
  STUDENT_NUMBER:  '学籍番号',
  LESSON_START:    'レッスン開始月',
  STATUS:          'ステータス',
  CONTRACT_PLAN:   '契約プラン',
};

const ENTRY_PLAN_NAME = 'エントリープラン';

/**
 * Notion プロパティ値をテキストに変換するヘルパー
 */
function getTextValue(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') || null;
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') || null;
    case 'select':
      return prop.select?.name || null;
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

/**
 * Notion ページを内部形式に変換
 */
function parsePage(page) {
  const props = page.properties || {};

  const studentName   = getTextValue(props[PROP.STUDENT_NAME]);
  const nameFurigana  = getTextValue(props[PROP.NAME_FURIGANA]);
  const studentNumber = getTextValue(props[PROP.STUDENT_NUMBER]);
  const lessonStartMonth = getTextValue(props[PROP.LESSON_START]);
  const status        = getTextValue(props[PROP.STATUS]);
  const contractPlan  = getTextValue(props[PROP.CONTRACT_PLAN]);

  // Notion ページ自体の URL（www.notion.so/page_id 形式）
  const notionUrl = page.url || `https://www.notion.so/${page.id.replace(/-/g, '')}`;

  return {
    notionPageId:   page.id,
    studentName,
    nameFurigana,
    studentNumber,
    notionUrl,
    lessonStartMonth,
    status,
    contractPlan,
    rawData: page
  };
}

/**
 * Notion DB を全件取得（ページネーション対応）
 * エントリープランのみフィルタして返す
 */
async function fetchEntryPlanStudents() {
  const token    = process.env.NOTION_TOKEN;
  const dbId     = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    throw new Error('NOTION_TOKEN または NOTION_DATABASE_ID が設定されていません');
  }

  const notion = new Client({ auth: token });
  const students = [];
  let cursor = undefined;

  // Notion API でエントリープランをフィルタ（select型の場合）
  const filter = {
    property: PROP.CONTRACT_PLAN,
    select: { equals: ENTRY_PLAN_NAME }
  };

  do {
    const response = await notion.databases.query({
      database_id: dbId,
      filter,
      start_cursor: cursor,
      page_size: 100
    });

    for (const page of response.results) {
      const parsed = parsePage(page);
      // フィルタが効いているはずだが念のため再チェック
      if (parsed.contractPlan === ENTRY_PLAN_NAME) {
        students.push(parsed);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return students;
}

/**
 * メイン同期関数
 * 1. Notion からエントリープラン生徒を全件取得
 * 2. PostgreSQL へ UPSERT
 * @returns {{ synced: number, timestamp: Date }}
 */
async function syncNotionStudents() {
  console.log('🔄 Notion 生徒データ同期開始...');

  try {
    const students = await fetchEntryPlanStudents();
    console.log(`📋 Notion から ${students.length} 件取得（エントリープランのみ）`);

    if (students.length === 0) {
      console.log('⚠️ 取得データが 0 件です。Notion DB の設定を確認してください。');
      return { synced: 0, timestamp: new Date() };
    }

    const upserted = await NotionStudent.upsertMany(students);
    console.log(`✅ Notion 同期完了: ${upserted} 件を DB に保存`);

    return { synced: upserted, timestamp: new Date() };
  } catch (error) {
    console.error('❌ Notion 同期エラー:', error.message);
    throw error;
  }
}

module.exports = { syncNotionStudents, fetchEntryPlanStudents };
