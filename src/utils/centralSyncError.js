const messages = {
  CONFIG_MISSING:'中央管理DBの接続設定がありません。環境変数を確認してください。',
  CONFIG_SAME_DATABASE:'中央管理DBとポータルDBに同じ接続URLが設定されています。',
  SYNC_DISABLED:'中央管理DB連携は無効です。',
  EMPTY_STUDENTS:'中央管理DBの生徒が0件のため、前回データを保持して同期を中止しました。',
  INVALID_STUDENT:'中央管理DBの学籍番号・生徒名が未設定、または学籍番号が重複しています。',
  AMBIGUOUS_STUDENT:'既存の生徒連携が重複しています。学籍番号・Notion IDを確認してください。',
  DUPLICATE_PAGE:'中央管理DBのNotion IDが重複しています。',
  INVALID_DATE:'レッスン開始日の形式が不正です。',
  INVALID_RESERVATION:'中央管理DBの予約ID・学籍番号・日時が未設定、または予約IDが重複しています。',
  '42703':'中央管理DBまたはポータルDBに必要な列がありません。DBのマイグレーションを確認してください。',
  '42P01':'必要なテーブルがありません。接続先DB・スキーマを確認してください。',
  '42501':'DBの読み取りまたは保存権限が不足しています。',
  '28P01':'DBのユーザー名またはパスワードが正しくありません。',
  '3D000':'指定されたデータベースが存在しません。',
  '53300':'DBの接続数が上限に達しています。',
  '23505':'保存先の連携IDなどが重複しています。',
  '22007':'DBの日時形式が不正です。',
  '22008':'DBの日時が有効範囲外です。',
  '25006':'保存先DBが読み取り専用です。ポータルDBの接続設定を確認してください。',
  ENOTFOUND:'DBのホスト名を解決できません。Internal URLのワークスペース・リージョンを確認してください。',
  ECONNREFUSED:'DB接続が拒否されました。接続先ホスト・ポートを確認してください。',
  ETIMEDOUT:'DB接続または取得がタイムアウトしました。ネットワーク・DBの負荷を確認してください。',
  EHOSTUNREACH:'DBへ到達できません。ネットワーク設定を確認してください。',
  ECONNRESET:'DB接続が切断されました。',
  TLS_MODE_MISMATCH:'接続先がSSLをサポートしていません。RenderのInternal URLではCENTRAL_DATABASE_SSL=falseを確認してください。',
  TLS_CERTIFICATE:'TLS証明書を検証できません。接続ホストとCA設定を確認してください。External接続の検証を無効にしないでください。',
  UNKNOWN:'同期処理に失敗しました。ログの処理段階を確認してください。',
};
const certificateCodes = new Set(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
class CentralSyncError extends Error {
  constructor(code,stage) {
    const safeCode = Object.hasOwn(messages,code) ? code : 'UNKNOWN';
    super(messages[safeCode]);
    this.code=safeCode;this.stage=stage;
  }
}
function classify(error,stage) {
  if(error instanceof CentralSyncError) return error;
  let code=error?.code;
  if(certificateCodes.has(code)) code='TLS_CERTIFICATE';
  else if(/server does not support SSL/i.test(error?.message || '')) code='TLS_MODE_MISMATCH';
  else if(/timeout|timed out/i.test(error?.message || '')) code='ETIMEDOUT';
  return new CentralSyncError(code,stage);
}
module.exports = {CentralSyncError,classify};
