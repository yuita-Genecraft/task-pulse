// Trusted extension service worker: capture token never reaches page/content scripts.
const DEST = 'https://taskpulse-chatgpt.gooooerer.workers.dev/capture';
const SITE = 'https://yuita-genecraft.github.io';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const chatPath = new RegExp('^/(?:g/g-[A-Za-z0-9_-]{1,160}/)?c/(' + UUID + ')$', 'i');
const pendingKey = id => 'tp_pending_' + id;
const entryKey = id => 'tp_gpt_' + id;
const protectedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const sanitizedTitle = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 120);
function canonical(s) {
  try {
    if (typeof s !== 'string' || s.length > 1024) return null;
    const u = new URL(s);
    if (u.origin !== 'https://chatgpt.com' || u.username || u.password) return null;
    const m = chatPath.exec(u.pathname);
    if (!m) return null;
    const id = m[1].toLowerCase();
    return { id, url: 'https://chatgpt.com' + u.pathname.slice(0, -m[1].length) + id };
  } catch { return null; }
}
async function storeCapture(message) {
  await protectedStorage;
  const c = canonical(message.url);
  if (!c || typeof message.title !== 'string') return false;
  const observedAt = new Date().toISOString(); // trusted extension clock, not page-provided timestamp
  const record = { url: c.url, title: sanitizedTitle(message.title), observedAt };
  await chrome.storage.local.set({ [entryKey(c.id)]: record, [pendingKey(c.id)]: record });
  void flush();
  return true;
}
let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    await protectedStorage;
    const opt = await chrome.storage.local.get(['captureToken']);
    const token = opt.captureToken;
    if (typeof token !== 'string' || token.length < 32) return;
    const all = await chrome.storage.local.get(null);
    const queued = Object.entries(all).filter(([key]) => /^tp_pending_[0-9a-f-]{36}$/.test(key))
      .sort((a,b) => Date.parse(a[1]?.observedAt) - Date.parse(b[1]?.observedAt)).slice(0, 50);
    for (const [key, payload] of queued) {
      if (!payload || !canonical(payload.url)) continue;
      let res;
      try {
        res = await fetch(DEST, {
          method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch { return; }
      if (!res.ok) return; // No blind retry within this run; alarm will retry later.
      const latest = (await chrome.storage.local.get(key))[key];
      if (latest && latest.url === payload.url && latest.title === payload.title && latest.observedAt === payload.observedAt)
        await chrome.storage.local.remove(key);
    }
  } finally { flushing = false; }
}
function fromChatGPT(sender) {
  try { return new URL(sender.url).origin === 'https://chatgpt.com'; } catch { return false; }
}
function fromPulse(sender) {
  try { const u = new URL(sender.url); return u.origin === SITE && u.pathname.startsWith('/task-pulse/'); } catch { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    await protectedStorage;
    if (message?.type === 'capture' && fromChatGPT(sender)) return { ok: await storeCapture(message) };
    if (message?.type === 'snapshot' && fromPulse(sender)) {
      const all = await chrome.storage.local.get(null);
      const entries = Object.entries(all).filter(([key]) => /^tp_gpt_[0-9a-f-]{36}$/.test(key))
        .map(([, record]) => record).sort((a,b) => Date.parse(b?.observedAt) - Date.parse(a?.observedAt));
      return { ok: true, entries: entries.slice(0, 500), total: entries.length };
    }
    if (message?.type === 'flush' && sender.url?.startsWith(chrome.runtime.getURL('options.html'))) {
      void flush(); return { ok: true };
    }
    return { ok: false };
  })().then(reply, () => reply({ ok: false }));
  return true;
});
chrome.alarms.create('capture-retry', { periodInMinutes: 5 }).catch(() => {});
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'capture-retry') void flush(); });
chrome.runtime.onStartup.addListener(() => void flush());
void flush();
