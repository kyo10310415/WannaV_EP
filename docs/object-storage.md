# Private S3互換教材ストレージ

## 原因と構成

従来はRenderの `/uploads/video-*.mp4` をexpress.staticで直接配信し、動画のRange GET（206）の全データがRender Outbound Bandwidthに計上されていました。サムネイルの小さい304応答が主原因ではありません。

変更後は、RenderでJWT・初回パスワード変更・支払い/Portal Access・レッスン解禁を確認してから、短期のS3署名GET URLを発行します。ブラウザがObject Storageから動画/教材画像を直接取得し、Renderは動画をプロキシしません。
移行済み動画の旧 `/uploads` GETも、同じ権限確認後に302でObject Storageへ転送します。206はObject Storageから返るのが正常です。

`OBJECT_STORAGE_ENABLED=false` が既定です。無効時は従来の保存/配信を維持し、追加したDB列は既存列を置き換えません。外部YouTube/Vimeo/Google DriveのURLと学習進捗・小テストは変更しません。

## 設定（管理者が手動実施）

1. R2またはS3互換の **private bucket** を作成してください。R2のr2.dev・公開カスタムドメインは有効化しないでください。AWS S3はBlock Public Accessを有効にします。
2. 対象bucketの教材プレフィックス `lessons/*` だけにGetObject/PutObject/DeleteObjectを許可する資格情報を作成します。HEADはGetObject権限で確認します。公開ACLの権限は不要です。
3. BucketのCORSを以下のように設定します。実際の本番origin・必要なら検証originだけを許可してください。

```json
[
  {
    "AllowedOrigins": ["https://wannav-ep.onrender.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-Range", "Content-Type"],
    "ExposeHeaders": ["Accept-Ranges", "Content-Range", "Content-Length", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Renderの **Web Service → Environment** に設定します。DBサービスのEnvironmentではありません。

|環境変数|設定|
|---|---|
|OBJECT_STORAGE_ENABLED|段階導入時はfalse、設定確認後true|
|OBJECT_STORAGE_ENDPOINT|R2は `https://<account-id>.r2.cloudflarestorage.com`。AWS S3は空欄で標準endpoint|
|OBJECT_STORAGE_REGION|R2はauto、AWSは対象bucketのリージョン（例ap-northeast-1）|
|OBJECT_STORAGE_BUCKET|private bucket名|
|OBJECT_STORAGE_ACCESS_KEY_ID|対象bucket用のaccess key ID|
|OBJECT_STORAGE_SECRET_ACCESS_KEY|secret access key。ブラウザ・Git・ログに公開しない|
|OBJECT_STORAGE_FORCE_PATH_STYLE|通常false、path-styleが必要な互換サービスだけtrue|
|MEDIA_SIGNED_URL_TTL_SECONDS|900が既定。許容60〜3600秒|

SDK v3はNode.js 20以降を必要とします。Renderの実行Nodeバージョンを確認してください（この実装はNode 24で検証）。SDK用の2依存のみを追加し、既存依存の一括更新はしていません。

署名URLは有効期間内のbearer URLです。コピーした第三者も有効期間内は使えるため共有・アクセスログ出力を避けてください。秘密鍵そのものはURLに含まれません。支払い状態の変更は次のURL発行で反映され、発行済みURLはTTLまで有効です。DRMではありません。

## 新規アップロード

有効時はOSの一時領域 `wannav-media-staging` に受信→既存ffmpegでRender Diskに小さいサムネイルを生成→streaming PUT→HEADでサイズ確認→DB保存→一時動画/画像の削除となります。2GBをメモリに丸ごと読み込みません。最終動画はRender Diskに保存しません。

失敗時はDBを更新せず、旧教材を残します。新ObjectはDB参照がないことを確認して削除を試みます。削除失敗やDBの状態を確認できない場合はObjectを残し、安全なobject keyだけログに出します。SDKエラーオブジェクト・署名URL・資格情報はログに出しません。
失敗した一時ファイルは回復用に残ります。容量を確認し、不要と確認できた一時ファイルだけ手動削除してください。本番のUPLOAD_DIRを一括削除しないでください。

動画は元の形式を保存します（MP4推奨。MOV/AVI/MKVのブラウザ対応は従来同様codec依存）。画像もprivate Objectへ保存し、PNGはffmpegが利用可能で小さくなる場合のみlossless WebPに変換します。変換失敗・サイズ増大時は原本を使います。教材画像の一覧には小さいJPEGサムネイルを使い、原画像を毎回一覧へ送信しません。ffmpeg不在時は画像の変換/サムネイル生成を省略し、教材本体は保持します。

期限切れ後の動画再開・Range再取得のエラー時はURLを再発行し、再生位置を復元します。長時間のシーク・モバイル実機は後述の本番確認が必要です。旧動画のサムネイル再生成は移行済みObjectも一時ダウンロードして対応します（通常再生はダウンロードしません）。

## 既存動画の移行

本番をバックアップし、先に検証用bucket/少数教材で確認してください。本スクリプトはこの作業中には本番で実行しません。RenderのShellで、**既存Diskと本番DBを参照するWeb Service上**で実行します。

```sh
# 既定はdry-run：DB・Object・既存ファイルを変更しない
node scripts/migrate-media-to-object-storage.js --dry-run

# 設定とdry-run結果を確認後に明示的に実行
node scripts/migrate-media-to-object-storage.js --apply

# 教材画像も移す場合（既存画像は原本のまま移行）
node scripts/migrate-media-to-object-storage.js --apply --images
```

安全なファイル名・存在・サイズ・通常ファイル（symlink不可）を確認→Objectへupload/HEAD→DB列保存。途中で差し替えられた行は条件付きUPDATEで保護します。失敗行は原本・DBを残し、他の教材を続行します。すでにstorage keyがある行はskipして再実行できます。失敗がある場合exit codeは1です。DBは通常起動で先にマイグレーション済みにしてください。

**標準ではローカルファイルを削除しません。** 明示的な `--apply --delete-local` はObjectのサイズ・現在のDB参照・安全なファイルを再確認して対象教材ファイルだけを削除します。これはローカルfallbackを失うため、十分な再生確認・バックアップ後の別作業として扱ってください。thumbs/charactersは削除しません。

## 移行前後の確認

1. 管理者、生徒（許可/未解禁）、未認証、未払いの各ケースでmedia-url APIを確認します。拒否時はURLを発行しません。
2. 生徒のNetworkで、Object教材の `<video>` のsrcと大容量206のhostがObject Storageになっていることを確認します。Render `/api/lessons/:id/media-url` は小さいJSONだけ、古い移行済み `/uploads` GETは302だけになります。
3. 再視聴、モバイル、途中シーク、15分を超えた再開、95%判定、完了ボタン、小テスト、順次解禁を確認します。X/YouTubeの演出等とは独立です。
4. Render Metrics/Request Logsで `/uploads/video-*` の大容量206が減ることを確認します。まだ未移行の動画は従来配信です。署名付きURLを検証スクリーンショット/ログで共有しないでください。
5. オブジェクト削除失敗のログがないか確認します。orphan keyはDBに参照がないことを確認してから手動再削除します。

## ロールバック

移行した既存動画は元の `video_url/video_filename` とローカル原本を保持しています。`OBJECT_STORAGE_ENABLED=false` に戻すと、その教材はローカルへfallbackします。列やObjectを削除する必要はありません。

**新規Object専用教材はDiskに原本がないので、単純にfalseに戻すだけでは再生できません。** その場合はObjectを有効のまま問題を修正するか、バックアップからファイルをDiskへ復元し対応するローカルURLをDBへ設定してから切り替えます。存在しないfallbackを返さず503にします。

Render Diskは今回削除できません。移行期間の旧動画、サムネイル、確定キャラクター画像が残ります。全メディア・別機能の移行/バックアップを確認した後、別タスクで縮小/削除を検討してください。

## DB / API

`lessons.video_storage_key` / `image_storage_key`（nullable TEXT）をIF NOT EXISTSで追加。旧URL・filenameは残します。署名URLはDBに保存しません。

`GET /api/lessons/:id/media-url?kind=video|image`（Bearer JWT必須）はurl、storage、contentType、expiresAtを返し、Cache-Controlはprivate,no-storeです。URL発行にも既存auth経由の支払い制御と、管理者以外のProgress.canAccessLessonを適用します。

サービス層にupload、verify、signedGet、delete、key、contentTypeを集約しました。将来のpresigned PUTはここに追加可能ですが、今回はフロントの大規模変更とアップロード完了検証の追加を避け、一時転送方式にしています。

公式資料: [AWS SDK v3 S3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)、[R2 presigned URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

## 変更ファイル / 検証の範囲

- ストレージ: `src/services/objectStorage.js`, `src/services/lessonMedia.js`
- 移行: `scripts/migrate-media-to-object-storage.js`
- API / 配信: `server.js`, `src/routes/admin.js`, `src/routes/lessons.js`, `src/middleware/objectMediaRedirect.js`, `src/middleware/portalAccess.js`
- DB: `src/models/Lesson.js`, `src/models/schema.js`
- プレーヤー: `views/lesson.html`
- テスト: `test/object-storage.test.js`, `test/media-playback.test.js`, `test/special-content.test.js`
- 設定 / 依存 / 文書: `.env.example`, `package.json`, `package-lock.json`, `README.md`, `RENDER_DEPLOY.md`, `docs/object-storage.md`

ローカルの隔離PostgreSQLとSDKモックでupload・HEAD・署名・未認証/未解禁/未払い・管理者・外部動画・旧Disk fallback・DB/upload失敗・差し替え・削除・dry-run・再実行・明示削除・期限切れ再発行を検証します。実際のR2/S3・本番のRange再生/モバイル・Render帯域削減は未検証です。

`npm audit` で既存依存（axios / multer / qs）に3件（high 2、moderate 1）が検出されています。今回追加したSDKではなく、変更前のlockfileにも同じバージョンがありました。関連するアップロードのセキュリティも含め、別途互換性を検証した依存更新が必要です。今回の変更では一括audit fixを実行していません。
