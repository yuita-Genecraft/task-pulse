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
      const r = await chrome.runtime.sendMessage({ type: "snapshot" });
      if (r?.ok && Array.isArray(r.entries))
        window.postMessage({ source: EXT, type: "snapshot", entries: r.entries, total: r.total }, location.origin);
    } finally { pending = false; }
  }
  window.addEventListener("message", e => {
    if (e.source === window && e.origin === location.origin && e.data && e.data.source === PAGE && e.data.type === "request") void send();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void send(); });
  setInterval(() => { if (document.visibilityState === "visible") void send(); }, 30000);
  void send();
})();
