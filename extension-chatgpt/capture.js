// URL/title/time and author/turn identifiers only; never read prompt/message text.
(() => {
  "use strict";
  const pattern = /^\/(?:g\/g-[A-Za-z0-9_-]{1,160}\/)?c\/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;
  const composer = 'form[data-thread-find-composer], form[data-composer-placement], form:has(#prompt-textarea)';
  let lastUrl = "", lastSent = "", lastActivity = "", pendingInstruction = null;
  function capture(activityAt = null) {
    if (document.visibilityState !== "visible" && !activityAt) return;
    const u = new URL(location.href);
    if (u.protocol !== "https:" || u.hostname !== "chatgpt.com") return;
    const match = pattern.exec(u.pathname);
    if (!match) return;
    const cleanUrl = "https://chatgpt.com" + u.pathname.slice(0, -match[1].length) + match[1].toLowerCase();
    const title = document.title.replace(/\s+[-|]\s+ChatGPT$/i, "").trim().slice(0, 160);
    const stamp = cleanUrl + "\u0000" + title;
    if (activityAt ? lastActivity === activityAt : lastSent === stamp) return;
    lastSent = stamp;
    if (activityAt) lastActivity = activityAt;
    void chrome.runtime.sendMessage({ type: "capture", url: cleanUrl, title,
      ...(activityAt ? { activityAt } : {}) })
      .then(r => { if (!r?.ok && lastSent === stamp) lastSent = ""; })
      .catch(() => { if (lastSent === stamp) lastSent = ""; });
  }
  function lastUserTurn() {
    let last = null;
    for (const node of document.querySelectorAll('[data-message-author-role="user"], [data-turn-key]')) {
      const legacy = node.getAttribute('data-message-author-role') === 'user';
      // These hidden headings are author labels, not the message body.
      const user = legacy || [...node.querySelectorAll('h4.sr-only')].some(h =>
        ['あなたの発言:', 'You said:'].includes(h.textContent.trim()));
      if (user) {
        const id = node.getAttribute('data-message-id') || node.getAttribute('data-turn-key') || node.id;
        if (id) last = id;
      }
    }
    return last;
  }
  function armInstruction(event) {
    if (!event.isTrusted || !event.target?.closest?.(composer)) return;
    if (event.type === 'keydown' && (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing)) return;
    if (event.type === 'click') {
      const button = event.target.closest('button');
      if (!button || button.disabled || !(button.type === 'submit' ||
          button.getAttribute('data-testid') === 'send-button' ||
          ['送信', 'プロンプトを送信', 'Send prompt', 'Send message'].includes(button.getAttribute('aria-label')))) return;
    }
    if (pendingInstruction && lastUserTurn() !== pendingInstruction.previous) {
      checkInstruction(); return;
    }
    pendingInstruction = {
      at: new Date().toISOString(), until: Date.now() + 15000,
      url: location.href.split(/[?#]/)[0], previous: lastUserTurn(),
    };
  }
  function checkInstruction() {
    if (!pendingInstruction) return;
    const pending = pendingInstruction;
    if (Date.now() > pending.until || location.href.split(/[?#]/)[0] !== pending.url) {
      pendingInstruction = null; return;
    }
    const latest = lastUserTurn();
    if (latest && latest !== pending.previous) {
      pendingInstruction = null;
      capture(pending.at);
    }
  }
  // A trusted composer interaction alone does not resume anything. A newly
  // rendered user turn must confirm submission, so Shift+Enter, IME, upload,
  // focus, history hydration and title changes cannot count as instructions.
  document.addEventListener('submit', armInstruction, true);
  document.addEventListener('keydown', armInstruction, true);
  document.addEventListener('click', armInstruction, true);
  const heading = document.querySelector('title');
  if (heading) new MutationObserver(() => capture()).observe(heading, { childList:true, subtree:true, characterData:true });
  let checking = false;
  new MutationObserver(() => {
    if (!pendingInstruction || checking) return;
    checking = true;
    setTimeout(() => { checking = false; checkInstruction(); }, 100);
  }).observe(document.documentElement, {childList:true, subtree:true});
  document.addEventListener('visibilitychange', () => { lastSent = ""; capture(); });
  window.addEventListener('focus', () => { lastSent = ""; capture(); });
  window.addEventListener('popstate', () => capture());
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; capture(); } }, 2000);
  capture();
})();
