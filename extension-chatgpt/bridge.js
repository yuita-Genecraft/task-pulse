// Task Pulse との橋渡し。ネットワーク送信なし。拡張機能の storage にあるメタデータのみ渡す。
(() => {
  "use strict";
  const EXT = "taskpulse-chatgpt-extension";
  const PAGE = "taskpulse-chatgpt-page";
  if (location.hostname !== "yuita-genecraft.github.io" || !location.pathname.startsWith("/task-pulse/")) return;
  let pending = false;
  async function send() {
    if (pending) return;
    pending = true;
    try {
      const all = await chrome.storage.local.get(null);
      const entries = Object.entries(all).filter(([key]) => /^tp_gpt_[0-9a-f-]{36}$/.test(key))
        .map(([, value]) => value).slice(0, 500);
      window.postMessage({ source: EXT, type: "snapshot", entries }, location.origin);
    } finally { pending = false; }
  }
  window.addEventListener("message", e => {
    if (e.source === window && e.origin === location.origin && e.data && e.data.source === PAGE && e.data.type === "request") void send();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some(key => key.startsWith("tp_gpt_"))) void send();
  });
  void send();
})();
