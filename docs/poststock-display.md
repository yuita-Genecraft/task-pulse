# 完成稿のポストストック表示

2026-11-07の本人「表示接続しといて」への接続。既存のポスト化スタンバイタブとDriveの公開読取口を使用する。新しいWorkerやサービスは作らない。

Mac側xhassin-pipelineの`toka_display.py`が、検証済み在庫の本文・画像のDriveリンク・枠・qualified/reserved・期限を、Driveポストストック内の専用管理節へ同期する。UIは同じ既存のfetch応答から管理節も読む。手で積んだ既存のスタンバイはその下に残す。

管理節の区切りは次の2行。その間は1行のJSONでversion=1、syncedAtはepoch秒、itemsは配列。

    <!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->
    <!--TOKA_QUALIFIED_STOCK_V1_END-->

各itemの項目はid（24桁hex）、frame、state（qualified/reserved）、body（元本文そのまま）、bodySha256（64桁hex）、expiresAt（epoch秒）、imageUrl。画像URLは`https://drive.google.com/file/d/ID/view`だけを採る。画像は共有権限を変更していないため本人の既存Driveで開く。CORE・批評・事実資料・ログ・内部pathはpayloadに含めない。

poststock.jsは本文をtextContentで表示し、選べる完成稿と予約済みを分ける。表示時刻で期限切れは数えない。本文コピーは元本文の改行ごとコピーする。管理節なしは準備中、取得失敗・構造不正はエラーとし、どちらも在庫0本と読み替えない。タブ選択・画面復帰・フォーカスと再読込ボタンで再取得する。新しい定期poll/AIは追加しない。

## 再実行

    npm --prefix tests ci
    node --test tests/poststock.cjs tests/autonomy.cjs tests/autonomy-dom.cjs tests/taskgraf.cjs tests/chatgpt_url.cjs tests/factory-tab.cjs

依存は既存のjsdom25.0.1のみ。新規5件は管理節の解析、安全なDOMと画像リンク、実ブラウザ文脈で本文コピー、予約/失効の計数、実index.htmlで旧スタンバイとの共存を確認する。既存ページfixtureは新しいparser-blocking scriptも読み込むようにし、既存タブ等のassertionは変えない。実モデル・実Driveには書き込まない。

実装はAGY02、試験文脈の修正はAGY05。Codex rootは機械的統合、固定headの検証、独立レビューへの素材と引継ぎを担当。重要PRとして独立Codex CLIレビューを受ける。実表示の完成は、Mac同期側のレビュー済み反映とDrive読戻し、Pages配備後の画面で確認する。

## r1からの修正と相互の審査材料

r1（aa42b9a）はBLOCK 3件。AGY06が不正なitemを黙って捨てず構造エラーにする修正と、実indexのfetch応答から完成稿・手積みカードの両方が作られる共存試験へ修正した。空のitems配列は正当な0件として扱う。共存試験はmockした既存pub/poststock応答を待って、実タブを選択し、本文・利用可能数・手積みカードを確認する（renderSectionの直接呼出しや手製カードでは代用しない）。

残る資料不足は、対となるxhassin-pipeline PR97の固定head/hash、caller/helper/stock.py、APPLY全文・plan・本番read-only CHECK_OKをr2へ同梱して解消する。Mac r2の2つの未修正残件（特殊改行の表示正規化・初回末尾空行）はMac側の明示どおりで、本人の極低頻度・低影響除外方針に従う。元stock・投稿を変更するものではない。UIは受け取った本文を変えない。
