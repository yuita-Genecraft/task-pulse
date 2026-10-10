# Task Pulse ChatGPT タブ — ローカル版（ドラフト）

- 既存の「チャット」を「Claude」と表示し、「ChatGPT」を追加。
- ChatGPTは本人の通常チャットURL（`https://chatgpt.com/c/<UUID>` またはプロジェクト内 `/g/g-.../c/<UUID>`）だけ登録。`/share/`リンクは対象外。query/fragmentは破棄。
- 追加するものはURL・題・閲覧確認時刻・手入力メモ（500字以下）・明示的な一覧外しと戻しのみ。会話本文・Cookie・APIキー・トークンは取得せず、外部APIへのPOSTはない。
- Chrome拡張をインストールすれば、PC版ChatGPTで開いたチャットを自動的に `chrome.storage.local` に記録し、同じPCのTask Pulseを開いたときに同期。拡張機能なしでもURL手動登録できる。
- Task Pulse側の記録はブラウザのIndexedDB。二重タブのメモ保存は同一レコードの readwrite transaction と memoVersion で競合検出。拡張機能の自動登録で「外す」を解除しない。
- **他端末（iPhone含む）との同期・ChatGPTの過去全チャット一括取得・作業中/完了ランプの観測は未対応**。インストール前に開いた会話は自動で埋まらない。
- `Claude`のhandoff一覧・権限・LANE・ランプの既存API、公開本番は変更しない。

## 拡張機能をPC Chromeに読み込む

1. `chrome://extensions` を開いて「デベロッパーモード」を有効にする。
2. 「パッケージ化されていない拡張機能を読み込む」で `extension-chatgpt` フォルダを選ぶ。
3. ChatGPTで会話を開き、Task PulseのChatGPTタブで「更新」。

この版はCloudflareの正本DBではない。同期のために既存handoffの鍵を流用しない。iPhoneや別PCから同じ一覧を読むには、後続の専用レジストリと最小権限の登録口が必要。
