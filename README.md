# WannaV eラーニングシステム

VTuber育成スクール向けの動画ベースeラーニングポータルサイト

## 🎯 プロジェクト概要

- **プロジェクト名**: WannaV eラーニング
- **目的**: VTuber育成スクール（WannaV）の生徒向けに動画教材を提供し、進捗管理を行う
- **主な機能**:
  - 動画レッスン視聴
  - レッスンごとの小テスト（3問）
  - 進捗管理・可視化
  - 3日間未進展の生徒へのDiscord通知
  - 管理者による全体管理

## 🚀 主要機能

### ✅ 完了済み機能

1. **認証システム**
   - JWT認証
   - 役割ベースのアクセス制御（管理者/クルー/生徒）

2. **レッスン管理**
   - 動画アップロード（最大500MB）
   - レッスンの順序制御
   - 前のレッスン完了まで次のレッスンをロック

3. **進捗管理**
   - ユーザーごとの進捗追跡
   - 完了率の可視化
   - 小テスト全問正解で次へ進む

4. **管理者機能**
   - アカウント管理（追加/削除/権限編集）
   - コンテンツ管理（コース/レッスン/クイズ作成）
   - ユーザー進捗管理

5. **自動通知システム**
   - 3日間進展がない生徒へのDiscord Webhook通知
   - レッスン完了時のお祝いメッセージ（損失回避バイアス活用）

### 📋 画面構成

- **ログインページ** (`/`)
- **ダッシュボード** (`/dashboard`) - ユーザー情報と進捗表示
- **レッスン視聴画面** (`/lesson/:id`) - 動画視聴とクイズ
- **アカウント管理** (`/admin/accounts`) - 管理者のみ
- **コンテンツ管理** (`/admin/contents`) - 管理者のみ
- **ユーザー進捗管理** (`/admin/users`) - 管理者/クルー

## 🛠 技術スタック

- **Backend**: Node.js + Express
- **Database**: PostgreSQL (Render提供)
- **認証**: JWT + bcrypt
- **動画**: Multer（ファイルアップロード）
- **通知**: Discord Webhook
- **スケジューラ**: node-cron
- **フロントエンド**: HTML/CSS/JavaScript (VTuberカラーデザイン)

## 📊 データ構造

### データベーステーブル

1. **users** - ユーザー情報
2. **courses** - コース情報
3. **lessons** - レッスン（動画）情報
4. **quiz_questions** - クイズ問題
5. **user_progress** - ユーザー進捗
6. **notifications** - 通知ログ

## 🎨 デザイン

- **カラースキーム**: VTuberをイメージしたピンク/パープル/ブルー
- **視認性**: 高コントラスト、大きなボタン（最小48px高さ）
- **クリッカビリティ**: タッチフレンドリーなUI
- **アニメーション**: グラデーション、ホバーエフェクト

## 📦 インストールと起動

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env`ファイルを作成し、以下を設定：

```env
PORT=3000
DATABASE_URL=postgresql://user:password@host:5432/database
JWT_SECRET=your-secret-key
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook
ADMIN_EMAIL=admin@wannav.com
ADMIN_PASSWORD=admin123
```

### 3. サーバー起動

```bash
npm start
```

サーバーは`http://localhost:3000`で起動します。

## 🚢 Renderへのデプロイ

### 1. GitHubにプッシュ

```bash
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/username/wannav-elearning.git
git push -u origin main
```

### 2. Renderでデプロイ

1. [Render](https://render.com/)にログイン
2. **New +** → **Web Service**を選択
3. GitHubリポジトリを接続
4. 以下の設定:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**: `.env`の内容を設定

### 3. PostgreSQLデータベース作成

1. Renderで **New +** → **PostgreSQL**を選択
2. データベース作成後、`DATABASE_URL`をコピー
3. Web ServiceのEnvironment Variablesに`DATABASE_URL`を追加

## 🔐 デフォルトアカウント

初回起動時に以下の管理者アカウントが自動作成されます：

- **メール**: `admin@wannav.com`
- **パスワード**: `admin123`

**本番環境では必ずパスワードを変更してください！**

## 📱 使い方

### 生徒向け

1. ログイン
2. ダッシュボードでレッスン一覧を確認
3. レッスン開始（順番にロック解除）
4. 動画視聴後、クイズに全問正解で次へ進む
5. 進捗率を確認

### 管理者向け

1. ログイン
2. **アカウント管理**: 生徒/クルーのアカウント作成・編集
3. **コンテンツ管理**: コース/レッスン作成、動画アップロード、クイズ作成
4. **ユーザー進捗管理**: 全生徒の進捗をリアルタイム確認

## 🔔 自動通知システム

- **実行時間**: 毎日10:00 AM（日本時間の場合は調整が必要）
- **条件**: 3日間レッスン進展がない生徒
- **通知先**: Discord Webhook
- **メッセージ**: 損失回避バイアスを活用した励ましメッセージ

## 🌐 URL情報

- **本番環境**: (Renderデプロイ後に更新)
- **GitHub**: https://github.com/kyo10310415/WannaV_EP

## 📋 今後の開発推奨事項

1. パスワードリセット機能
2. メール通知の追加（Discord併用）
3. レッスン動画のストリーミング最適化
4. モバイルアプリ化
5. 学習分析ダッシュボード
6. コメント・質問機能
7. 証明書発行機能

## 🤝 サポート

問題が発生した場合は、GitHubのIssuesでご報告ください。

## 📝 ライセンス

ISC

---

**開発者**: AI Developer
**作成日**: 2026-03-18
**ステータス**: ✅ 完成 - Renderデプロイ準備完了
