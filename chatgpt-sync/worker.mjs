// ChatGPT chat registry, separate from handoff-mcp. Deploy is NOT automatic.
// Never log tokens, URLs, titles or memo bodies.
const SITE = 'https://yuita-genecraft.github.io';
const URL_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const URL_PATTERN = new RegExp('^/(?:g/g-[A-Za-z0-9_-]{1,160}/)?c/(' + URL_ID + ')$', 'i');
const ID_PATTERN = new RegExp('^' + URL_ID + '$');
const MAX_ROWS = 1000;
const send = (value, status = 200, origin = '') => new Response(JSON.stringify(value), {
  status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {}),
  },
});
const cleanText = (value, limit) => {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').replace(/\s+[-|]\s+ChatGPT$/i, '').trim();
  return Array.from(flat).slice(0, limit).join('');
};
export function canonical(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'chatgpt.com' || u.port || u.username || u.password) return null;
    const m = URL_PATTERN.exec(u.pathname);
    if (!m) return null;
    const id = m[1].toLowerCase();
    return { id, url: 'https://chatgpt.com' + u.pathname.slice(0, -m[1].length) + id };
  } catch { return null; }
}
export function parseObservation(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw) || !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t < Date.UTC(2023, 0, 1) || t > now + 300000) return null;
  return new Date(Math.min(t, now)).toISOString();
}
export function memoValue(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').trim();
  return Array.from(s).length <= 500 ? s : null;
}
export function keysValid(env) {
  const k = [env.READ_TOKEN, env.WRITE_TOKEN, env.CAPTURE_TOKEN];
  return k.every(s => typeof s === 'string' && s.length >= 32 && s.length <= 256) && new Set(k).size === 3;
}
function bearer(request, env, type) {
  const token = env[type + '_TOKEN'];
  return request.headers.get('authorization') === 'Bearer ' + token;
}
function corsOrigin(request, pathname, method) {
  const origin = request.headers.get('origin') || '';
  if (!origin || origin === SITE) return origin;
  // Only the upload-only endpoint accepts extension origins.
  if (pathname === '/capture' && (method === 'POST' || method === 'OPTIONS') && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;
  return null;
}
async function body(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 4096 || (request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/json') return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 4096) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function projectRow(r) {
  return {
    id: r.id, url: r.url, title: r.title, observedAt: r.observed_at,
    memo: r.memo, memoVersion: r.revision, revision: r.revision, closedAt: r.closed_at,
  };
}
export async function handle(request, env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const origin = corsOrigin(request, path, method);
  if (origin === null) return send({ error: 'not_found' }, 404);
  if (method === 'OPTIONS') {
    if ((origin !== SITE && !(path === '/capture' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin))) || (!['/capture', '/chats'].includes(path) && !ID_PATTERN.test(path.replace(/^\/chats\//, '')))) return send({ error: 'not_found' }, 404);
    return new Response(null, {
      status: 204,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
        'access-control-allow-headers': 'Authorization,Content-Type', 'access-control-max-age': '600', 'vary': 'Origin' },
    });
  }
  if (!keysValid(env)) return send({ error: 'not_found' }, 404, origin);
  const isGet = path === '/chats' && method === 'GET';
  const isCapture = path === '/capture' && method === 'POST';
  const match = /^\/chats\/([0-9a-f-]{36})$/.exec(path);
  const isPatch = method === 'PATCH' && match && ID_PATTERN.test(match[1]);
  if (!isGet && !isCapture && !isPatch) return send({ error: 'not_found' }, 404, origin);
  const auth = isGet ? bearer(request, env, 'READ') :
    isPatch ? bearer(request, env, 'WRITE') :
    bearer(request, env, 'CAPTURE') || bearer(request, env, 'WRITE');
  if (!auth) return send({ error: 'not_found' }, 404, origin);
  if (!env.DB || typeof env.DB.prepare !== 'function') return send({ error: 'unavailable' }, 503, origin);
  if (isGet) {
    const totalRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM gpt_chat').first();
    const result = await env.DB.prepare('SELECT * FROM gpt_chat ORDER BY observed_at DESC, id ASC LIMIT ?').bind(MAX_ROWS).all();
    const chats = (result.results || []).map(projectRow);
    return send({ chats, total: totalRow.n, limited: totalRow.n > MAX_ROWS }, 200, origin);
  }
  const input = await body(request);
  if (!input) return send({ error: 'invalid_json' }, 400, origin);
  if (isCapture) {
    const c = canonical(input.url);
    const when = parseObservation(input.observedAt);
    if (!c || !when || typeof input.title !== 'string' || input.title.length > 2000)
      return send({ error: 'invalid_capture' }, 400, origin);
    const title = cleanText(input.title, 120);
    await env.DB.prepare(
      "INSERT INTO gpt_chat (id,url,title,observed_at) VALUES (?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "url = CASE WHEN excluded.observed_at > gpt_chat.observed_at THEN excluded.url ELSE gpt_chat.url END, " +
      "title = CASE WHEN excluded.title <> '' AND (excluded.observed_at > gpt_chat.observed_at OR gpt_chat.title = '') THEN excluded.title ELSE gpt_chat.title END, " +
      "observed_at = MAX(gpt_chat.observed_at,excluded.observed_at)"
    ).bind(c.id, c.url, title, when).run();
    return send({ ok: true }, 200, origin);
  }
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !['memo', 'close', 'reopen'].includes(input.action))
    return send({ error: 'invalid_patch' }, 400, origin);
  let sql, args;
  if (input.action === 'memo') {
    const memo = memoValue(input.memo);
    if (memo === null) return send({ error: 'invalid_memo' }, 400, origin);
    sql = 'UPDATE gpt_chat SET memo=?,revision=revision+1 WHERE id=? AND revision=? RETURNING *';
    args = [memo, match[1], input.baseRevision];
  } else if (input.action === 'close') {
    sql = 'UPDATE gpt_chat SET closed_at=?,revision=revision+1 WHERE id=? AND revision=? AND closed_at IS NULL RETURNING *';
    args = [new Date().toISOString(), match[1], input.baseRevision];
  } else {
    sql = 'UPDATE gpt_chat SET closed_at=NULL,revision=revision+1 WHERE id=? AND revision=? AND closed_at IS NOT NULL RETURNING *';
    args = [match[1], input.baseRevision];
  }
  const changed = await env.DB.prepare(sql).bind(...args).first();
  if (changed) return send({ ok: true, chat: projectRow(changed) }, 200, origin);
  const current = await env.DB.prepare('SELECT * FROM gpt_chat WHERE id=?').bind(match[1]).first();
  return current ? send({ error: 'conflict', chat: projectRow(current) }, 409, origin) : send({ error: 'unknown_chat' }, 404, origin);
}
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch { return send({ error: 'internal_failure' }, 500); }
  },
};
