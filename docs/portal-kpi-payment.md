# Portal Session・Active Day・学習KPI・支払い同期 運用ガイド

## 1. 調査結果

- 旧利用計測はdashboard読み込みごとにPOST /api/usage/openを送り、app_usage_dailyを加算していた。
- user_progressは生徒・教材ごとに1行。view_count、watch_percent、completed、quiz_attempts、quiz_passedは独立した値。
- completeQuizは受験ごとに回数を加算し、直近の合否でcompletedとquiz_passedを更新する。過去attemptの合否履歴はない。合格後の再受験不合格も状態を更新する既存挙動は維持。
- Google Driveはgoogle-auth-library/JWTとaxios、サービスアカウント認証を使用。Sheetsも同じ資格情報取得関数を再利用し、scope別の認証クライアントを作成。
- users.id → student_profiles.user_id → student_profiles.notion_page_id → notion_students.notion_page_id。
- 支払い照合番号はnotion_students.student_numberのみ。前後空白を除去し、氏名・username照合は行わない。
- 支払い判定の開始日はCOALESCE(sp.lesson_start_date, ns.lesson_start_month)。具体的な開始日を優先し、NULLのときだけNotionの開始月を使用する。生徒一覧など他機能の優先順位は変更しない。
- 「必須科目」の分類列は存在しない。sequential_unlockを必須科目だと推測せず、REQUIRED_COURSE_IDSで明示する。

## 2. 実装内容

利用をPortal Sessionとして重複防止し、既存の日次・月次API項目を維持した。別途Active Dayを記録し、本日の利用有無と月間利用日数を表示する。
管理画面の生徒名欄に「学習・支払い詳細」を追加。通常教材全体、必須科目、コース別・教材別の指標をダイアログに表示する。
支払いは起動時と一定間隔で同期し、認可時はPostgreSQLだけを参照する。
既存の動画離脱保存はBearerが送れないsendBeaconから認証付きkeepalive fetchに変更。
クイズ合格済み教材でもMP4視聴率を保存し、iframe動画では小テストと独立した自己申告の視聴完了ボタンを用意する。

## 3. 変更ファイル

| ファイル | 変更理由 |
|---|---|
| .env.example | visit、必須科目、支払い連携・段階導入設定 |
| README.md | 本ガイドへの入口 |
| docs/portal-kpi-payment.md | 定義・導入・検証手順 |
| server.js | メディア保護・利用制限画面・ログアウト時のメディアCookie削除 |
| src/config/portal.js | 時間設定とfeature flagの集約 |
| src/middleware/auth.js | 認証後の共通支払い判定 |
| src/middleware/portalAccess.js | DBによる認可、メディア認証 |
| src/models/schema.js | 冪等テーブル・カラム追加 |
| src/models/AppUsage.js | 同時イベントを単一SQLで重複防止 |
| src/models/Progress.js | 今後の正確な不合格回数を保持 |
| src/models/LearningAnalytics.js | 既存進捗によるコース・教材別KPI |
| src/models/StudentPayment.js | 一括照合・UPSERT・アクセス判定・同期情報 |
| src/utils/paymentSheet.js | Sheets readonly取得・日本時間前月・ヘッダー正規化 |
| src/utils/scheduler.js | 起動時・定期支払い同期 |
| src/routes/usage.js | 既存successにrecordedを追加 |
| src/routes/admin.js | 生徒詳細KPI・同期状況の読取API |
| src/routes/auth.js | メディア用HttpOnly Cookie |
| src/routes/characters.js | 画像への直接アクセスにも支払い判定 |
| src/routes/lessons.js | 視聴率入力の有限数検証 |
| public/js/portal-session.js | 前景イベントでvisit記録・支払い制限画面への遷移 |
| public/js/admin-analytics.js | 詳細UI・同期状況・安全な文字列表示 |
| views/dashboard.html | 共通visit処理を呼び出す |
| views/special-contents.html | 直接アクセス時もvisit記録・支払い案内 |
| views/lesson.html | visit記録・視聴完了分離・認証付き離脱保存 |
| views/admin-users.html | 詳細ダイアログ・同期状況 |
| views/access-restricted.html | 断定を避けた利用制限案内 |
| test/app-usage.test.js | 新visit仕様に合わせて既存テスト更新 |
| test/payment-rules.test.js | 月・ヘッダー・照合・支払い・KPI |
| test/portal-client.test.js | 非表示・復帰・イベント重複 |
| test/portal-db.integration.test.js | 隔離PostgreSQLエンジンでSQL・認可・回帰検証 |

## 4. DB変更

CREATE TABLE IF NOT EXISTS、ALTER TABLE ADD COLUMN IF NOT EXISTSを使用。
既存回数の削除・換算・支払い状態を生徒statusへ上書きする処理は追加しない。

- portal_visit_state：user_id主キー/FK、last_activity_at、visit_started_at、last_event_started_visit。
- portal_active_days：user_id/FK、activity_date（日本時間）。主キー(user_id,activity_date)、日付・生徒の集計用インデックス。過去の日数を推測で埋めず、導入後から記録する。
- student_payment_status：user_id/FK、student_number、payment_month、payment_status、is_paid、source_row、sync_error、synced_at、source_key。主キー(user_id,payment_month)。
- payment_sync_state：source_key主キー、payment_month、last_success_at、last_attempt_at、last_error、issues(JSONB)。
- user_progress.quiz_failed_attempts：NULL許容integer。既存受験履歴はNULLのまま。新規受験記録、または受験回数0からの初回以降だけ正確に蓄積。
- 追加テーブルの主キーインデックスを利用。既存idx_app_usage_daily_date_userを引き続き使用。

支払いを別テーブルにしたのは、学習・契約ステータスと責務を分離し、生徒×判定月単位で履歴を保持するため。
過去月は一括で遡及取得せず、各月の同期時に蓄積する。

## 5. Portal Session・Active Day定義

- 生徒の最後にサーバーへ届いた前景利用イベントから、60分以上経過した次の利用が1Session。初回も1。「1回の利用」を測る。
- PORTAL_SESSION_INACTIVITY_MINUTESの既定は60。運用調整をコード変更なしで行うため環境変数化し、configに集約。旧PORTAL_VISIT_INACTIVITY_HOURSは使用しないのでRender設定から削除する。
- 10:00→10:59は同じSession。次が11:59なら最後の利用から60分なので新Session。
- Active Dayは日本時間でその日に1回でも前景利用が記録されたか。1日に複数Sessionがあっても1日。同じSessionが日付をまたいでも翌日に操作があれば翌日のActive Dayを記録する。
- 生徒別APIはactive_today（本日の利用有無）とmonthly_active_days（今月の利用日数）を追加。全体はdaily_active_students（本日利用した生徒数）とmonthly_active_student_days（今月の生徒別利用日数の合計、延べ人日）。月間ユニーク人数とは異なる。
- Active Dayは導入後のみ計測し、導入月は途中からの集計となる。既存Session開始日の記録から過去の利用日数を推測しない。
- dashboard、lesson、special-contentsで初回表示、visibilitychange、pageshow、focus、pointerdown、keydown、scrollを利用。
- hiddenでは送信しない。自動リロード・無操作のタイマー送信なし。手前では30秒の送信抑制と通信中ガードを設けるため、観測時刻には最大約30秒＋通信遅延の粒度がある。
- 複数タブ・リクエストの最終重複防止はDBのユーザー主キーON CONFLICTによる原子的更新。同一SQLのCTEから新visitの場合だけapp_usage_dailyを加算。
- MP4の5%刻みのwatch-progress通信で、表示中・再生中・シーク中でない場合にplaybackActive=trueを送る。再視聴でも同じ通信を使用。非表示・一時停止・離脱保存・手動完了は再生activityにしない。
- サーバーでは生徒・動画教材・教材アクセス権を確認し、recordActivityで60分以内の既存Sessionのlast_activity_atとActive Dayだけ更新する。Session数は加算せず、期限切れや未作成のSessionは復活・作成しない。ユーザー操作のrecordOpenが開始判定を担う。更新はDB行ロックで同時処理を直列化する。
- 表示状態はブラウザー申告であり実視聴を証明するものではない。iframe動画の再生検知、5%進むまで60分以上かかる極端な長時間動画、ネットワーク不達中の継続推定は対象外。専用タイマー通信は追加しない。
- 新visitの開始日をAsia/Tokyoで日次計上。同じvisitのまま日を跨いだだけでは翌日に加算しない。
- 既存APIのdaily_usage_count/monthly_usage_count、open_countを維持。過去は旧ページ表示回数のため、導入前後で定義が変わる。導入日時を分析時に区別すること。
- ブラウザー通信失敗・離脱時の未送信による完全な計測保証はない。利用記録の失敗で学習を止めない。

## 6. KPI定義

通常教材全体はis_special_content=false。スペシャルはコース詳細で別表示。
必須科目はREQUIRED_COURSE_IDSに列挙した通常コース内の教材。自由科目もコース詳細で同じ指標を表示。
分母0は0%にせず「対象なし／算出不可」。

| 指標 | 分子 | 分母・計算 |
|---|---|---|
| 教材完了率 | completed=trueの教材数 | 集計範囲内教材数 |
| 解放率 | 現在canAccessLessonと同じ条件でアクセス可能な教材数 | 集計範囲内教材数 |
| 動画を開いた教材数 | videoかつview_count>0の教材数 | 比率表示時は動画教材数 |
| 動画表示回数 | videoのview_count合計 | 回数、分母なし |
| 視聴率 | 保存済みwatch_percent | 0〜100。再生位置または本人操作による |
| 視聴完了 | videoかつwatch_percent>=95の教材数 | 比率表示時は動画教材数 |
| 小テスト受験率 | quiz_attempts>0の対象教材数 | 現在小テストがある教材数 |
| 総受験回数 | quiz_attempts合計 | 回数、分母なし |
| 平均受験回数 | 受験済み対象教材のquiz_attempts合計 | 受験済み対象教材数 |
| 平均リトライ回数 | max(quiz_attempts-1,0)合計 | 受験済み対象教材数 |
| 最終合格率 | quiz_passed=trueの対象教材数 | 現在小テストがある教材数 |
| 不合格回数 | quiz_failed_attempts合計 | 過去合否不明の対象があれば算出不可 |
| 受験ベース合格率 | quiz_attempts合計−不合格回数合計 | 総受験回数。過去合否不明を含むと算出不可 |

現在アクセス可能な教材を個別表示。コースごとの次の未解放教材は順序の先頭にあるcan_access=false教材。
順次解放は同じコースで前に並ぶ全教材のcompletedと、クイズがあればquiz_passedを確認する。途中に教材を追加・移動した場合も既存の完了履歴は残るが、新しい並びで前提を満たすまで後続はロックされる。

旧DBだけでは不合格回数と受験ベース合格率は正確に取得できない。
今回追加した集計カラムで新規履歴については正確に取得可能。
過去受験の復元や受験日時・得点別分析にはattempt履歴テーブルが必要であり、今回は追加しない。
視聴率は実視聴秒数を保証しない（シーク・自己申告を含む）。クイズ合格を視聴完了とみなさない。

## 7. Payment Integration

- 取得元：20231212_WannaV_契約状況 / RAW_支払い状況。Spreadsheet IDは設定のみから取得。
- 取得：A13:ZZを1回のSheets APIで読み、ヘッダーは先頭行、D列はindex3、月次候補はO列(index14)以降。BB等に固定しない。
- APIはUNFORMATTED_VALUE/SERIAL_NUMBER。文字列年月・年月日とSheets日付シリアルを年月へ正規化する。
- 対象月：Asia/Tokyoの当月から1か月引き、YYYY-MM-01形式。1月は前年12月。
- 同期：アプリ起動時と既定1時間（60分）ごと。Google取得後にDBトランザクション、一括SELECT、一括UPSERT。
- 多重同期はPostgreSQLのadvisory lockで防止。Sheetsアクセス中も1接続を占有する（API timeout 30秒）。
- エラー：API失敗・前月列なし・重複月列・空シートは正常データを更新しない。最新試行エラーだけ別テーブルへ保存。
- 同じ学籍番号が複数行、または複数アカウントへ紐づく場合はduplicateとして当該生徒を更新しない。前回正常データを保持する。
- 学籍番号なしはmissing_student_numberで更新除外。Sheetで番号不在ならnot_found/is_paid=false。
- 正常同期済みの生徒で、開始日以降、前月セルのtrim後の完全一致「支払い完了」だけ許可。
- source変更時は他のSpreadsheet/Sheetの同期を有効な根拠にしない。
- 初回正常同期前、月替わり後に当該月の正常同期がまだない、開始日・番号不明、新規生徒未同期はfail-open。要確認を管理画面に表示し、解消してから有効化する。
- 同期障害時は同じ判定月の前回正常データを継続利用。DB自体に接続できない場合はPAYMENT_REQUIREDと断定せず503。
- middleware：共通authからrequirePortalAccessを呼ぶ。lessons/progress/portal/usage/students/characters等の認証付き生徒APIに適用。スタッフは対象外。
- /uploadsとキャラクター画像の直接URLもfeature flag=true時に保護。auth/meで既存JWTをHttpOnly/SameSite=Strict Cookieへ設定し、mediaのみ受け付ける。ログアウトで戻るログインページではCookie削除。
- JSON APIは既存Bearer認証。ログイン・パスワード変更は支払い制限から除外。
- 制限画面は「現在ポータルをご利用いただけません。お支払い状況をご確認ください。」と表示。
- 管理画面の詳細APIは管理者・クルー、既存進捗画面と同じ権限。支払い状況の手動上書きは設けない。

## 8. Render設定

```env
PORTAL_SESSION_INACTIVITY_MINUTES=60
REQUIRED_COURSE_IDS=
GOOGLE_PAYMENT_SPREADSHEET_ID=
GOOGLE_PAYMENT_SHEET_NAME=RAW_支払い状況
PAYMENT_SYNC_INTERVAL_MINUTES=60
PAYMENT_ACCESS_CONTROL_ENABLED=false
```

既存GOOGLE_SERVICE_ACCOUNT_JSONを再利用（JSONまたはBase64）。
代替はGOOGLE_SERVICE_ACCOUNT_EMAILとGOOGLE_PRIVATE_KEY。
既存のGOOGLE_APPLICATION_CREDENTIALSファイル方式も維持。
Google CloudでSheets APIを有効にし、対象Spreadsheetをサービスアカウントへ閲覧共有する。
APIの形式は[Google公式values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)参照。

導入手順：

1. 制御falseでデプロイ（起動時に冪等DB追加）。
2. 正しいSpreadsheet IDと共有・Google認証を設定。
3. 管理画面の最終正常同期・判定対象月・エラー／要確認一覧を確認。
4. 支払い完了・未完了・開始前の複数生徒をSheetと目視照合。
5. 開始日・番号未設定・重複を解消。必須コースIDを確認し設定。
6. PAYMENT_ACCESS_CONTROL_ENABLED=trueで再デプロイし生徒・スタッフを確認。
7. 問題があればfalseに戻して再デプロイ。支払い履歴を削除する必要はない。

この作業では本番設定・本番DB・Google Sheetsの変更は行っていない。

## 9. テスト

今回の実行結果：PGLITE_TEST_MODULEを設定してnpm testを実行し、118 PASS / 0 FAIL / 0 SKIP。
開始日の優先順位、継続再生・無操作・日跨ぎ・重複・背景再生の回帰テストを含む。変更したJavaScriptとレッスン画面内の構文確認、git diff --checkも成功。
本番Google Sheetsとの照合、実ブラウザーでの画面確認、本番複数接続の負荷試験は未実施。

通常：npm test。SQL統合テストには隔離PGlite実行環境を任意で使用できる。
アプリの依存関係は追加していない。

```powershell
$runtime = Join-Path $env:TEMP 'wannav-pg-verification'
npm install --prefix $runtime --no-package-lock --no-audit --no-fund @electric-sql/pglite
$env:PGLITE_TEST_MODULE = Join-Path $runtime 'node_modules/@electric-sql/pglite'
npm test
```

PGLITE_TEST_MODULE未設定時はSQL統合テスト1グループのみskipされる。
指定時は本番接続なしで、空DBに全schemaを2回適用し、visit競合・日付境界・旧値保持・
学習進捗・支払い同期・障害時保持・直接API拒否を検証する。
PGliteは単一接続エンジンのため、本番複数PostgreSQL接続の負荷試験とは異なる。

## 10. 残課題

- 本番Sheetsの読み取り・目視照合は、Spreadsheet ID設定とサービスアカウント共有後。
- 必須科目のコースIDは運用側で設定。既存コース名や順次解放設定からは推測しない。
- 過去visitへの換算、過去attempt履歴の復元、Zoom参加率、継続率の実装は対象外。
- 外部動画サービスの視聴秒数や、既にダウンロード済みのファイルの閲覧は制御・保証できない。

## 11. リスク・確認事項

- API障害・前月列なし：同期エラーを確認。前回正常値は維持されるため支払い更新の反映が遅れる。
- 月替わりの同期未成功や身元情報不明は誤ブロック回避のため利用可能。管理者が要確認を解消する必要がある。
- duplicate：旧正常値を維持。勝手に片方の行を採用しない。
- Google認証：Sheets API有効化・readonly scope・閲覧共有が必要。資格情報はログへ出さない。
- session：DBの原子的更新で同時イベントに対応。ブラウザーの送信抑制・ネットワーク不達による観測限界は残る。
- SQL：認可は生徒主キーと月の索引検索。詳細KPIは開いた生徒だけ取得、一覧の全生徒へN+1で追加しない。実本番の負荷測定は未実施。
- 保護開始前のキャッシュ・ダウンロード済み媒体や、外部サービスの共有済みURLは取り消せない。
- 既存schema.jsの既存マイグレーション挙動は維持。追加テーブルはデータ削除を伴わない。
