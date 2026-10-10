(() => {
  "use strict";
  const token = document.getElementById("token");
  const result = document.getElementById("result");
  chrome.storage.local.get("captureToken").then(r => {
    result.textContent = r.captureToken ? "鍵は保存済みです（値は表示しません）。" : "鍵は未設定です。";
  }).catch(() => { result.textContent = "保存領域を読めません。"; });
  document.getElementById("save").onclick = async () => {
    const value = token.value.trim();
    if (value.length < 32 || value.length > 256) return result.textContent = "鍵は32〜256文字です。";
    try {
      await chrome.storage.local.set({ captureToken: value });
      token.value = "";
      result.textContent = "保存しました。未送信分を再送します。";
      chrome.runtime.sendMessage({ type: "flush" }).catch(() => {});
    } catch (_) { result.textContent = "保存に失敗しました。"; }
  };
  document.getElementById("clear").onclick = async () => {
    await chrome.storage.local.remove("captureToken");
    token.value = "";
    result.textContent = "鍵を消しました。未送信のローカル記録は保持します。";
  };
})();
