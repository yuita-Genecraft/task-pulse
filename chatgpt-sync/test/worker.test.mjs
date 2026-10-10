import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, parseObservation, memoValue, keysValid, handle } from '../worker.mjs';

const ID = '6ac8be6a-bcb4-83ec-88fa-32d79a3cddf4';
const URL1 = 'https://chatgpt.com/c/' + ID;
const URL2 = 'https://chatgpt.com/g/g-projectA/c/' + ID;
const origin = 'https://yuita-genecraft.github.io';
const envOf = (DB) => ({
  DB, READ_TOKEN: 'r'.repeat(40), WRITE_TOKEN: 'w'.repeat(40), CAPTURE_TOKEN: 'c'.repeat(40),
});
function mockDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...v) { args = v; return stmt; },
        async first() {
          if (sql.startsWith('INSERT INTO gpt_chat')) {
            const [id,url,title,when,memo,closedAt] = args;
            if (rows.has(id)) return null;
            rows.set(id,{ id,url,title,observed_at:when,memo,revision:0,closed_at:closedAt });
            return { id };
          }
          if (sql.startsWith('SELECT COUNT(*)')) return { n: rows.size };
          if (sql.startsWith('SELECT * FROM gpt_chat WHERE')) return rows.get(args[0]) || null;
          if (sql.startsWith('UPDATE gpt_chat')) {
            const close = sql.includes('closed_at=?');
            const reopen = sql.includes('closed_at=NULL');
            const id = close ? args[1] : args[0];
            const base = close ? args[2] : args[1];
            const key = sql.includes('SET memo=') ? args[1] : id;
            const ref = rows.get(key);
            const version = sql.includes('SET memo=') ? args[2] : base;
            if (!ref || ref.revision !== version) return null;
            if (close && ref.closed_at) return null;
            if (reopen && !ref.closed_at) return null;
            if (sql.includes('SET memo=')) ref.memo = args[0];
            else if (close) ref.closed_at = args[0];
            else ref.closed_at = null;
            ref.revision++;
            return { ...ref };
          }
          return null;
        },
        async all() {
          if (!sql.startsWith('SELECT * FROM gpt_chat ORDER')) throw Error('unexpected all');
          return { results: Array.from(rows.values()).sort((a,b) => b.observed_at.localeCompare(a.observed_at)).slice(0,args[0]) };
        },
        async run() {
          if (!sql.startsWith('INSERT INTO gpt_chat')) throw Error('unexpected run');
          const [id, url, title, seen] = args;
          const r = rows.get(id);
          if (!r) rows.set(id,{ id, url, title, observed_at:seen, memo:'', revision:0, closed_at:null });
          else {
            if (seen > r.observed_at) r.url = url;
            if (title && (seen > r.observed_at || !r.title)) r.title = title;
            if (seen > r.observed_at) r.observed_at = seen;
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
}
const request = (path,method='GET', token='', data=undefined, extra={}) => new Request('https://taskpulse-chatgpt.gooooerer.workers.dev' + path,{
  method,
  headers: { origin, authorization: token ? 'Bearer ' + token : '', ...(data ? { 'content-type':'application/json' } : {}), ...extra },
  ...(data ? {body:JSON.stringify(data)} : {}),
});
test('URL and input boundaries', () => {
  assert.equal(canonical(URL1 + '?foo=bar#auth')?.url, URL1);
  assert.equal(canonical(URL2)?.id, ID);
  assert.equal(canonical('https://chatgpt.com/c/' + ID.toUpperCase())?.id, ID);
  for (const bad of ['http://chatgpt.com/c/'+ID, 'https://chatgpt.com.evil/c/'+ID,
     'https://chatgpt.com/share/'+ID, 'https://chatgpt.com/c/not-a-uuid',
     'https://chatgpt.com@evil.com/c/'+ID, 'https://chatgpt.com/c/'+ID+'/more'])
    assert.equal(canonical(bad),null,bad);
  assert.equal(parseObservation('2100-01-01T00:00:00Z'),null);
  assert.equal(parseObservation('2026-01-01T00:00:00'),null);
  assert.equal(memoValue('a'.repeat(500)).length,500);
  assert.equal(memoValue('a'.repeat(501)),null);
  assert.equal(keysValid({READ_TOKEN:'a'.repeat(32),WRITE_TOKEN:'a'.repeat(32),CAPTURE_TOKEN:'c'.repeat(32)}),false);
});
test('auth isolation, CORS, capture monotonicity and CAS', async () => {
  const DB=mockDb(), env=envOf(DB);
  let r=await handle(request('/chats','GET',env.WRITE_TOKEN),env);
  assert.equal(r.status,404,'write must not read');
  r=await handle(request('/capture','POST',env.READ_TOKEN,{url:URL1,title:'bad',observedAt:new Date().toISOString()}),env);
  assert.equal(r.status,404,'read must not capture');
  r=await handle(request('/chats/'+ID,'PATCH',env.CAPTURE_TOKEN,{action:'close',baseRevision:0}),env);
  assert.equal(r.status,404,'capture must not close');
  r=await handle(request('/chats','GET',env.READ_TOKEN,undefined,{origin:'https://evil.example'}),env);
  assert.equal(r.status,404,'wrong origin');
  r=await handle(request('/capture','POST',env.CAPTURE_TOKEN,{url:URL1,title:'Example',observedAt:'2026-10-10T00:01:00Z'}),env);
  assert.equal(r.status,200);
  r=await handle(request('/capture','POST',env.CAPTURE_TOKEN,{url:URL2,title:'Older',observedAt:'2026-10-09T00:01:00Z'}),env);
  assert.equal(r.status,200);
  r=await handle(request('/chats','GET',env.READ_TOKEN),env);
  let data=await r.json();
  assert.equal(data.total,1);
  assert.equal(data.chats[0].title,'Example','older capture never overwrites title');
  r=await handle(request('/chats/'+ID,'PATCH',env.WRITE_TOKEN,{action:'memo',baseRevision:0,memo:'keep'}),env);
  assert.equal(r.status,200);
  r=await handle(request('/chats/'+ID,'PATCH',env.WRITE_TOKEN,{action:'memo',baseRevision:0,memo:'stale'}),env);
  assert.equal(r.status,409);
  r=await handle(request('/chats/'+ID,'PATCH',env.WRITE_TOKEN,{action:'close',baseRevision:1}),env);
  assert.equal(r.status,200);
  r=await handle(request('/capture','POST',env.CAPTURE_TOKEN,{url:URL2,title:'New',observedAt:'2026-10-10T00:02:00Z'}),env);
  assert.equal(r.status,200);
  r=await handle(request('/chats','GET',env.READ_TOKEN),env);
  data=await r.json();
  assert.ok(data.chats[0].closedAt,'capture cannot reopen explicitly closed chat');
  assert.equal(data.chats[0].memo,'keep','capture cannot change memo');
  assert.equal(data.chats[0].revision,2);
  r=await handle(request('/chats/'+ID,'PATCH',env.WRITE_TOKEN,{action:'reopen',baseRevision:2}),env);
  assert.equal(r.status,200);
  assert.equal((await r.json()).chat.closedAt,null);
  r=await handle(request('/import','POST',env.CAPTURE_TOKEN,{url:URL1,title:'No',observedAt:'2026-10-10T00:03:00Z',memo:'No',closedAt:null}),env);
  assert.equal(r.status,404,'capture token must not import memos');
  r=await handle(request('/import','POST',env.WRITE_TOKEN,{url:'https://chatgpt.com/c/3b5c73c2-aaaa-bbbb-cccc-0123456789ab',title:'Imported',observedAt:'2026-10-10T00:03:00Z',memo:'private memo',closedAt:null}),env);
  assert.equal(r.status,200);
  assert.equal((await r.json()).inserted,true);
  r=await handle(request('/import','POST',env.WRITE_TOKEN,{url:'https://chatgpt.com/c/3b5c73c2-aaaa-bbbb-cccc-0123456789ab',title:'Overwrite',observedAt:'2026-10-10T00:04:00Z',memo:'bad',closedAt:null}),env);
  assert.equal((await r.json()).inserted,false,'import must never overwrite existing');
  assert.equal(DB.rows.get('3b5c73c2-aaaa-bbbb-cccc-0123456789ab').memo,'private memo');
});

test('CORS preflight only on configured UI and capture-only extension', async () => {
  const env=envOf(mockDb());
  let r=await handle(request('/chats','OPTIONS','',undefined,{origin}),env);
  assert.equal(r.status,204);
  const ext='chrome-extension://'+'a'.repeat(32);
  r=await handle(request('/capture','OPTIONS','',undefined,{origin:ext}),env);
  assert.equal(r.status,204);
  assert.equal(r.headers.get('access-control-allow-origin'),ext);
  r=await handle(request('/chats','OPTIONS','',undefined,{origin:ext}),env);
  assert.equal(r.status,404);
});
