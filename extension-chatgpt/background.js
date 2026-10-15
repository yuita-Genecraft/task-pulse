// Trusted extension service worker: capture token never reaches page/content scripts.
const DEST = 'https://taskpulse-chatgpt.gooooerer.workers.dev/capture';
const SITE = 'https://yuita-genecraft.github.io';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const chatPath = new RegExp('^/g/g-p-6ab08ead99b88191ab18129fe14730d9(?:-[A-Za-z0-9_-]+)?/c/(' + UUID + ')$', 'i');
const pendingKey = id => 'tp_pending_' + id;
const entryKey = id => 'tp_gpt_' + id;
let storageWork = Promise.resolve();
function serializedStorage(action) {
  const next = storageWork.then(action);
  storageWork = next.catch(() => {});
  return next;
}
const protectedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
// A private operator-built package may contain only its upload credential.
// Public source ships an empty object; read/write credentials never go here.
const credentialReady = (async () => {
  await protectedStorage;
  const saved = await chrome.storage.local.get('captureToken');
  if (Object.hasOwn(saved, 'captureToken')) return;
  try {
    const response = await fetch(chrome.runtime.getURL('capture-config.json'));
    const value = (await response.json()).captureToken;
    if (typeof value === 'string' && value.length >= 32 && value.length <= 256)
      await chrome.storage.local.set({captureToken:value});
  } catch (_) { /* Public packages remain in local mode until configured. */ }
})();
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
function trackedIdentity(raw) {
  try {
    const u=new URL(raw);
    const m=new RegExp('/c/('+UUID+')$', 'i').exec(u.pathname);
    return u.origin==='https://chatgpt.com' && m ? m[1].toLowerCase() : null;
  } catch { return null; }
}
async function leaveProject(message) {
  await protectedStorage;
  const id=trackedIdentity(message.url);
  if (!id) return false;
  await serializedStorage(async()=>{
    const previous=(await chrome.storage.local.get(entryKey(id)))[entryKey(id)];
    if (!previous || previous.outOfProject) return;
    const record={action:'leaveProject',url:'https://chatgpt.com/c/'+id,observedAt:new Date().toISOString()};
    await chrome.storage.local.set({[entryKey(id)]:{...previous,outOfProject:true},[pendingKey(id)]:record});
  });
  void flush();return true;
}
async function storeCapture(message) {
  await protectedStorage;
  const c = canonical(message.url);
  if (!c || typeof message.title !== 'string') return false;
  const t = message.activityAt == null ? null : Date.parse(message.activityAt);
  if (t !== null && (!Number.isFinite(t) || t < Date.UTC(2023,0,1) || t > Date.now())) return false;
  await serializedStorage(async () => {
    const previous = (await chrome.storage.local.get(entryKey(c.id)))[entryKey(c.id)];
    const oldActivity = Date.parse(previous?.activityAt || '') || 0;
    const activity = Math.max(oldActivity, t || 0);
    const record = { url:c.url, title:sanitizedTitle(message.title), observedAt:new Date().toISOString(),
      ...(activity ? {activityAt:new Date(activity).toISOString()} : {}) };
    await chrome.storage.local.set({[entryKey(c.id)]:record, [pendingKey(c.id)]:record});
  });
  void flush();
  return true;
}
let flushing = false;
let flushAgain = false;
async function flush() {
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    await credentialReady;
    const opt = await chrome.storage.local.get(['captureToken']);
    const token = opt.captureToken;
    if (typeof token !== 'string' || token.length < 32) return;
    const all = await chrome.storage.local.get(null);
    const queued = Object.entries(all).filter(([key,payload]) => /^tp_pending_[0-9a-f-]{36}$/.test(key) && (canonical(payload?.url) || (payload?.action === 'leaveProject' && trackedIdentity(payload.url))))
      .sort((a,b) => Date.parse(a[1]?.observedAt) - Date.parse(b[1]?.observedAt)).slice(0, 50);
    for (const [key, payload] of queued) {
      if (!payload || !(canonical(payload.url) || (payload.action === 'leaveProject' && trackedIdentity(payload.url)))) continue;
      let res;
      try {
        res = await fetch(DEST, {
          method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch { return; }
      if (!res.ok) return; // No blind retry within this run; alarm will retry later.
      await serializedStorage(async () => {
        const latest = (await chrome.storage.local.get(key))[key];
        if (latest && latest.url === payload.url && latest.title === payload.title &&
            latest.observedAt === payload.observedAt && latest.activityAt === payload.activityAt)
          await chrome.storage.local.remove(key);
      });
    }
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; void flush(); }
  }
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
    if (message?.type === 'leaveProject' && fromChatGPT(sender)) return { ok: await leaveProject(message) };
    if (message?.type === 'capture' && fromChatGPT(sender)) return { ok: await storeCapture(message) };
    if (message?.type === 'snapshot' && fromPulse(sender)) {
      const all = await chrome.storage.local.get(null);
      const entries = Object.entries(all).filter(([key]) => /^tp_gpt_[0-9a-f-]{36}$/.test(key))
        .map(([, record]) => record).filter(record => !record?.outOfProject && canonical(record?.url)).sort((a,b) => Date.parse(b?.observedAt) - Date.parse(a?.observedAt));
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
