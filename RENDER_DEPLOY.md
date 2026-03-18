# 🚀 Renderデプロイ完全ガイド

WannaV eラーニングシステムをRenderにデプロイする手順

---

## 📋 事前準備

- ✅ GitHubリポジトリ: https://github.com/kyo10310415/WannaV_EP
- ✅ Renderアカウント
- ⚠️ Discord Webhook URL（オプション - 通知機能に必要）

---

## 🗄️ ステップ1: PostgreSQLデータベース作成

### 1.1 Renderにログイン

[Render Dashboard](https://dashboard.render.com/)にアクセスしてログイン

### 1.2 PostgreSQL作成

1. **「New +」** → **「PostgreSQL」** を選択

2. 以下の設定を入力：
   - **Name**: `wannav-db` （任意の名前）
   - **Database**: `wannav_elearning` （自動生成でOK）
   - **User**: （自動生成でOK）
   - **Region**: `Singapore (Southeast Asia)` または最寄りの地域
   - **PostgreSQL Version**: 最新版
   - **Plan**: **Free** （開発・テスト用）または **Starter 7$** （本番用）

3. **「Create Database」** をクリック

### 1.3 接続情報をコピー

データベースが作成されたら、以下をコピー：

- **Internal Database URL** （Web Serviceで使用）
  - 形式: `postgresql://user:password@host/database`
  - 例: `postgresql://wannav_db_user:xyzABC123@dpg-xxxxx-a.singapore-postgres.render.com/wannav_db`

💡 **重要**: External URLではなく、**Internal Database URL**を使用してください（同じRender内で高速接続）

---

## 🌐 ステップ2: Web Service作成

### 2.1 Web Service作成開始

1. Render Dashboardに戻る
2. **「New +」** → **「Web Service」** を選択

### 2.2 GitHubリポジトリ接続

1. **「Connect a repository」** セクションで、GitHubアカウントを接続
2. リポジトリ一覧から **`WannaV_EP`** を選択
3. **「Connect」** をクリック

### 2.3 基本設定

以下の情報を入力：

| 項目 | 値 |
|-----|-----|
| **Name** | `wannav-elearning` （任意の名前） |
| **Region** | データベースと同じ地域（例: Singapore） |
| **Branch** | `main` |
| **Root Directory** | 空欄（プロジェクトルート） |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

### 2.4 インスタンスタイプ選択

- **Free** （開発・テスト用、スリープあり）
- **Starter $7/month** （本番用、常時稼働）

💡 Freeプランは15分間アクセスがないとスリープします。本番運用にはStarterプランを推奨。

---

## 🔧 ステップ3: 環境変数設定

**「Environment Variables」** セクションで以下を追加：

### 必須環境変数

```bash
PORT=3000
NODE_ENV=production
DATABASE_URL=[ステップ1.3でコピーしたInternal Database URL]
JWT_SECRET=wannav-super-secret-jwt-key-change-in-production-2024
ADMIN_EMAIL=admin@wannav.com
ADMIN_PASSWORD=admin123
```

### オプション環境変数（Discord通知を使う場合）

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### 環境変数の追加方法

1. **「Add Environment Variable」** をクリック
2. **Key**（変数名）と **Value**（値）を入力
3. 上記の変数をすべて追加

💡 **セキュリティ**: 本番環境では`JWT_SECRET`と`ADMIN_PASSWORD`を必ず変更してください！

---

## 🚀 ステップ4: デプロイ実行

1. すべての設定を確認
2. **「Create Web Service」** をクリック
3. デプロイが自動的に開始されます

### デプロイプロセス

```
📦 Building...
  └─ npm install
  └─ Dependencies installed

🚀 Starting...
  └─ npm start
  └─ Server running on port 3000

✅ Deploy successful!
```

### デプロイ時間

- 初回デプロイ: **5〜10分**
- 以降の更新: **3〜5分**

---

## 🔍 ステップ5: デプロイ確認

### 5.1 URLを確認

デプロイ完了後、以下のようなURLが発行されます：

```
https://wannav-elearning.onrender.com
```

### 5.2 動作確認

1. 上記URLにアクセス
2. ログインページが表示されることを確認
3. デフォルト管理者アカウントでログイン：
   - **メール**: `admin@wannav.com`
   - **パスワード**: `admin123`

### 5.3 ログ確認

Render Dashboardの **「Logs」** タブで以下を確認：

```
✅ Database connected successfully
✅ All database tables created successfully
✅ Admin user created: admin@wannav.com
✅ Cron job scheduled: Daily inactive user reminders at 10:00 AM
🎉 WannaV eラーニング server running on http://0.0.0.0:3000
```

---

## 🔔 ステップ6: Discord Webhook設定（オプション）

### 6.1 Discord Webhookの作成

1. Discordサーバーで通知を受け取りたいチャンネルを開く
2. チャンネル設定（⚙️）→ **「連携サービス」**
3. **「ウェブフック」** → **「新しいウェブフック」**
4. ウェブフック名を設定（例: `WannaV Bot`）
5. **「ウェブフックURLをコピー」**

### 6.2 Renderに設定

1. Render DashboardのWeb Service設定を開く
2. **「Environment」** タブ
3. `DISCORD_WEBHOOK_URL`を追加（値は上記でコピーしたURL）
4. **「Save Changes」** → 自動再デプロイ

### 6.3 通知テスト

- 3日間未進展の生徒がいる場合、毎日10:00 AMに自動通知
- レッスン完了時に即座にお祝いメッセージ

---

## 🔄 更新・再デプロイ方法

### コードを更新した場合

```bash
cd /home/user/wannav-elearning
git add .
git commit -m "更新内容の説明"
git push origin main
```

Renderが自動的に検知して再デプロイします（Auto-Deploy有効時）。

### 手動デプロイ

Render Dashboardで **「Manual Deploy」** → **「Deploy latest commit」**

---

## 🛠️ トラブルシューティング

### ❌ データベース接続エラー

**エラー**: `Database connection error`

**解決方法**:
1. `DATABASE_URL`が正しく設定されているか確認
2. **Internal Database URL**を使用しているか確認（Externalではない）
3. PostgreSQLがアクティブか確認

### ❌ ビルドエラー

**エラー**: `npm install` failed

**解決方法**:
1. `package.json`が正しいか確認
2. Node.jsバージョンを確認（Renderは最新LTSを使用）
3. ログで具体的なエラーを確認

### ❌ サーバー起動エラー

**エラー**: `Server failed to start`

**解決方法**:
1. 環境変数がすべて設定されているか確認
2. `PORT`が`3000`に設定されているか確認
3. ログで詳細を確認

### ❌ 動画アップロードエラー

**エラー**: ファイルサイズ制限

**解決方法**:
- Renderの無料プランはディスク容量に制限あり
- 大容量動画は外部ストレージ（AWS S3, Cloudflare R2等）の使用を推奨

### ❌ Discord通知が届かない

**解決方法**:
1. `DISCORD_WEBHOOK_URL`が正しいか確認
2. Webhookが削除されていないか確認
3. ログで送信エラーを確認

---

## 📊 パフォーマンス最適化

### Freeプランのスリープ対策

Freeプランは15分間アクセスがないとスリープします。

**対策**:
1. **UptimeRobot**などの監視サービスで5分ごとにpingを送る
2. Starterプラン（$7/月）にアップグレード

### データベースバックアップ

Renderは自動バックアップを提供していますが、重要なデータは手動バックアップも推奨：

```bash
pg_dump $DATABASE_URL > backup.sql
```

---

## ✅ デプロイ完了チェックリスト

- [ ] PostgreSQLデータベース作成完了
- [ ] Web Service作成完了
- [ ] 環境変数すべて設定完了
- [ ] デプロイ成功（ログ確認）
- [ ] URLアクセス可能
- [ ] ログイン動作確認
- [ ] 管理者アカウントでログイン成功
- [ ] Discord Webhook設定（オプション）
- [ ] 本番パスワード変更完了

---

## 🎉 デプロイ完了！

これで**WannaV eラーニングシステム**が本番環境で稼働しています！

### 次のステップ

1. **管理者アカウントのパスワード変更**
2. **生徒アカウント作成**
3. **コース・レッスン作成**
4. **動画アップロード**
5. **クイズ作成**

---

## 📞 サポート

問題が発生した場合：
- GitHub Issues: https://github.com/kyo10310415/WannaV_EP/issues
- Render Status: https://status.render.com/

---

**作成日**: 2026-03-18
**対象環境**: Render (PostgreSQL + Node.js)
