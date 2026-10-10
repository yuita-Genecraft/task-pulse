# ChatGPT同期：本番前の安全境界と未完了項目（実装側セルフチェック）

対象：`task-pulse` main `b8266dd6997186de0b33cfb75abe2b9c3e71546d`、およびこの試験PRで変更するCI/fixture。
作成：2026-10-10。**これは実装担当の自己検査メモであり、独立critic PASSでも、本番配備承認でもない。**

## 実測で閉じた範囲

- 元のmock-D1試験とは別に、Wrangler 4.79.0の**ローカルD1**へ`0001.sql`を適用し、HTTPリクエストをWorkerへ実際に通す。
- 正常登録、他origin/異なる役割のBearer拒否、古い観測値、メモCAS/409、閉鎖と復帰、close後の再登録で自動復帰しないこと、importのcreate-only、共有リンク拒否を確認する。
- 同一baseRevisionの2つの並列更新は、片方だけ200/片方409を期待。D1のDB実装の原子性を測る。
- GitHub Actionsは`permissions: contents: read`で、本番シークレット・本番D1・deployを使わない。Wranglerのtest configは既知の**公開ダミー鍵**だけ。

## セキュリティ所見（独立審査前）

| 論点 | 現状と範囲 | 本番前に残る判断 |
|---|---|---|
| 認証鍵の配布 | READ / WRITE / CAPTUREを分離し、サーバーで経路ごとに検査。ただしページのREAD/WRITEはURLフラグメント保持。 | ブックマーク・端末同期・同一github.io originの別スクリプト・共有URLでの漏洩経路を評価。これをL2の主体分離とは呼ばない。 |
| Chrome拡張 | CAPTUREキーは背景側`storage.local`に保存・`TRUSTED_CONTEXTS`設定。コンテンツスクリプトからは直接取り出さない。 | 実Chromeで権限動作、拡張停止・再開・離脱・鍵失効を確認。自動取得が会話本文を読まないことも実物で再検査。 |
| 同期DBの範囲 | 個別チャットURL・題・時刻・500字メモ・閉鎖・revisionが永続化。削除APIなし。 | 保存期間、全削除・エクスポート、バックアップ、アクセス権の運用を最終決定。 |
| 費用・濫用 | captureに明示した操作単位のrate limit / cost gateはない。権限保持者なら行数を増やせる。 | 登録鍵流出時の失効と費用封じを先に確認。無料枠の存在だけを本番の費用上限としない。 |
| 部分的可用性 | 一覧`MAX_ROWS=1000`超は`limited`、UI側は正常な全件一覧と偽らず拒否する。 | 1000件超の表示・ページング、同期障害中の可用性、警告通知の設計。 |
| デプロイ同一性 | GitHub mainへのmerge≠Worker配備、CI成功≠本番E2E。 | D1実ID・migration適用版・active Worker version・HTTP応答とPC/iPhone実機受入を独立にreadback。 |
| iPhone ChatGPTアプリ | iPhoneのtaskPulseからの閲覧・編集を対象とする。 | ChatGPT iOSアプリで開いた会話の自動検知機能はないことを利用者に明示。 |

## 本番へ進めない理由

1. 本番用のD1と3資格の作成・配備は別承認が必要。現行の通信先はソースコード上の**提案URL**であり、実際のWorker ID・DNS・現在Active版の証拠がない。
2. 本物のCloudflare remote D1・本物のChrome拡張・iPhoneでのE2E受入が未実施。
3. 安全境界・資格露出・費用・データ保持についての**非実装側の独立レビュー**が未完了。

従って結果ラベルは、ローカルD1検証が通った場合でも「ローカルD1での実装試験成功」まで。本番PASS・独立critic PASSは付けない。
