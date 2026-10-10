# Task Pulse ChatGPTタブ — 同期モード（Draft / 未デプロイ）

## 状態
既存PR #7のPCローカル機能を維持しつつ、ChatGPT専用Worker + D1への同期を追加するDraftです。
**GitHubにコードがあるだけでは使用できません。** Cloudflare D1/Workerの作成、3鍵の安全な設定、deployと実機受け入れが別途必要です。既存Claude用handoffの鍵やDBを共有しません。

## PC：会話の自動登録
- Chrome拡張の `extension-chatgpt` フォルダを開発者モードで読み込みます。
- 拡張の「オプション」画面で、運用者が設定済みの **CAPTURE_TOKEN（登録専用）**を設定します。
- ChatGPTで通常チャットを開くと、拡張バックグラウンドがURL・タイトル・ブラウザ観測時刻だけ送ります。会話本文・Cookie・ChatGPTのAPIキーは読みません。
- 通信不可・鍵未設定なら未送信キューに残し、5分ごとに再試行します。失敗後に勝手に消しません。
- 登録専用の鍵では一覧の閲覧・メモ更新・一覧から外す/戻すができません。
- `chrome.storage.local`は`TRUSTED_CONTEXTS`へ制限し、ページに入るcontent scriptは鍵を読めません。

## taskPulseでPC・iPhone共通一覧を使う
- 既存のブックマーク URL に、**# の後ろ**のパラメータ `gptread=...` と `gptwrite=...` を追加します（既存graph/write値はそのまま維持）。
- 同じブックマークをiPhoneで開けば、同じCloudflareの台帳を読む構成です。
- gptreadのみの場合は読み取り専用です。gptread未指定なら従来どおり端末ローカルの一覧です。
- 現在PC内にある過去のメモや「外す」記録は、自動的にネットへ送られません。同期モードで **「この端末の既存記録を同期」** を本人が押した場合だけ、同期台帳にまだないIDを作成します。既存IDのメモ/閉鎖状態は上書きせず、ローカル記録も消しません。
- ChatGPTの共有リンク（/share/）は登録しません。ChatGPTアプリ本体の会話を消す操作はありません。

## 未完成・制限
- iPhone版ChatGPTアプリで開いたチャットをOS越しに自動検出することは**今回の範囲外**。iPhoneからの閲覧/メモ/手動登録はサーバー反映後の対象です。
- 実機Chrome拡張、iPhoneブラウザ、Cloudflare remote D1、CORS/認証エラー、オフライン再送の本番E2Eは未実施。
- 非本番Nodeテストは`node --test chatgpt-sync/test/worker.test.mjs`。実SQLite/D1でのSQL回帰は未確認。
- ChatGPTの生成中/出力完了ランプは未実装。
- 公開ページに秘密鍵を埋めないでください。URLフラグメント内の鍵はブラウザ履歴・同期・同一originのコードから読めるbearer credentialです。

本番手順と承認ゲートは `chatgpt-sync/README.md` を参照してください。
