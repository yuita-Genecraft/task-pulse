// ChatGPT本文・Cookie・資格は読まない。URL/タブ題/ブラウザで確認した時刻だけ。
(() => {
  "use strict";
  const pattern = /^\/(?:g\/g-[A-Za-z0-9_-]{1,160}\/)?c\/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;
  let lastUrl = "";
  let lastSent = "";
  function capture() {
    if (document.visibilityState !== "visible") return;
    const u = new URL(location.href);
    if (u.protocol !== "https:" || u.hostname !== "chatgpt.com") return;
    const match = pattern.exec(u.pathname);
    if (!match) return;
    const id = match[1].toLowerCase();
    const cleanUrl = "https://chatgpt.com" + u.pathname.slice(0, -match[1].length) + id;
    const title = document.title.replace(/\s+[-|]\s+ChatGPT$/i, "").trim().slice(0, 160);
    const stamp = cleanUrl + "\u0000" + title;
    if (lastSent === stamp) return;
    lastSent = stamp;
    void chrome.storage.local.set({ ["tp_gpt_" + id]: { url: cleanUrl, title, observedAt: new Date().toISOString() } })
      .catch(() => { if (lastSent === stamp) lastSent = ""; });
  }
  const heading = document.querySelector("title");
  if (heading) new MutationObserver(capture).observe(heading, { childList: true, subtree: true, characterData: true });
  document.addEventListener("visibilitychange", () => { lastSent = ""; capture(); });
  window.addEventListener("focus", () => { lastSent = ""; capture(); });
  window.addEventListener("popstate", capture);
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; capture(); } }, 2000);
  capture();
})();
