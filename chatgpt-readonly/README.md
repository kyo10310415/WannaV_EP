# ChatGPT read-only source API

`CHATGPT_READ_TOKEN` にこのサービス専用の32文字以上のランダム値を設定。共通MCPサーバーの対応する `*_TOKEN` に同じ値を設定します。既存ログイン用の秘密鍵・トークンは再利用しません。

`GET /integrations/chatgpt/v1/catalog` と `GET /integrations/chatgpt/v1/query?request=<JSON>` のみ。Bearer認証必須。未設定は拒否し、他の業務ルートの認証には影響しません。固定SELECT・列の許可リストのみ使用し、PostgreSQLはREAD ONLYトランザクションで実行します。1万行・4MiBを超える結果は集計せず絞り込みを要求します。更新や同期、通知は実行しません。

共通サーバーの配置・認証・接続手順は中央管理リポジトリの `integrations/chatgpt/README.md` を参照。
