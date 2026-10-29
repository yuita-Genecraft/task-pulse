// 工場タブ（factory-tab.js）を、実際の index.html（全スクリプトを埋め込み・ネットワークなし）で jsdom に載せる。fetch は全部ここの偽物。
//   lazy    : タブを開くまで、工場のファイルを取らない・iframe も無い。開くと 5 ファイルだけ取り、iframe は 1 つ。別のタブへ移って戻っても取り直さない
//   key     : 鍵が無い時は何も取らない。鍵は 5 つの取得の Authorization ヘッダー（固定の送り先 BASE）にだけ付き、iframe の srcdoc・URL・postMessage には入らない
//   pins    : PINS（sha256）と 1 バイトでも違うファイルが 1 つでもあれば iframe を作らない。404 は「鍵が違う」と言う。どちらも「もう一度」で取り直せる
//   sandbox : iframe の sandbox は "allow-scripts" ただ 1 つ・src 属性なし（srcdoc）・referrerpolicy no-referrer
//   channel : iframe の「準備できた」(fx-ready)に答えて、GLB 2 つのバイトだけを渡す（別の送り主・別の中身には答えない）
//   shim    : iframe 内の最初の script：GLB 2 つは親のバイトで答え、ほかの fetch（/api/* を含む）は全部断り、リンクは動かさず、親以外のメッセージは無視する
//   source  : factory-tab.js は localStorage・console・innerHTML・allow-same-origin を使わない・PINS は 5 つの 64 桁・送り先は固定
// 使い方: node --test tests/*.cjs（tests/node_modules が要る：cd tests && npm ci）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const BASE = "https://handoff-mcp.gooooerer.workers.dev/factory/";
const KEY = "read-key-0123456789-abcdef";
const SRC = fs.readFileSync(path.join(ROOT, "factory-tab.js"), "utf8");
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

// 試験用の本文（本物の 11 MB ではない）。index.html の目印は本物と同じ 2 つ。
const FILES = {
  "index.html": Buffer.from('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="factory.css"><script type="module" src="factory.js"></script></head><body><a class="brand" href="./">T</a><div id="scene"></div></body></html>'),
  "factory.css": Buffer.from("body{margin:0}/* </style> */"),
  "factory.js": Buffer.from("window.__ran=1;/* </script> */"),
  "assets/modules.glb": Buffer.from([1, 2, 3, 4]),
  "assets/courier.glb": Buffer.from([9, 8, 7]),
};
// factory-tab.js の PINS を、試験用の本文の sha256 に差し替えた版（本物のハッシュは本物のファイル用）
function testSource(pins = FILES) {
  let s = SRC;
  for (const [name, buf] of Object.entries(pins)) s = s.replace(new RegExp(`("${name.replace(/[./]/g, "\\$&")}": ")[0-9a-f]{64}(")`), `$1${sha(buf)}$2`);
  return s;
}

const opened = [];
test.afterEach(() => {
  while (opened.length) opened.pop().window.close();
});

function page({ hash = `#graph=${KEY}`, serve } = {}) {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  html = html.replace(/<script src="([^"]+)" defer><\/script>/g, (_, f) => {
    const code = f === "factory-tab.js" ? testSource() : fs.readFileSync(path.join(ROOT, f), "utf8");
    return `<script>${code.replace(/<\/script/g, "<\\/script")}</script>`;
  });
  const calls = [];
  const dom = new JSDOM(html, {
    url: "https://yuita-genecraft.github.io/task-pulse/" + hash,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, "crypto", { value: nodeCrypto.webcrypto, configurable: true });
      w.TextDecoder = TextDecoder;
      w.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, headers: init.headers || {}, credentials: init.credentials, referrerPolicy: init.referrerPolicy });
        if (u.startsWith(BASE)) {
          const name = u.slice(BASE.length);
          const r = serve ? serve(name) : FILES[name] ? { status: 200, body: FILES[name] } : null;
          if (!r) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
          const body = r.body || Buffer.alloc(0);
          return { ok: r.status >= 200 && r.status < 300, status: r.status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
        }
        return { ok: false, status: 404, json: async () => null, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      };
      w.indexedDB = { open: () => ({}) };
      w.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  opened.push(dom);
  return { w: dom.window, d: dom.window.document, calls };
}
const tick = (w, n = 12) => new Promise((r) => (function loop(i) { i ? w.setTimeout(() => loop(i - 1), 0) : r(); })(n));
const shown = (n) => !!n && !n.hidden && n.style.display !== "none";
const tab = (d, v) => d.querySelector(`#tabs .tab[data-view="${v}"]`);
const factoryCalls = (calls) => calls.filter((c) => c.url.startsWith(BASE));

test("the 工場 tab exists; before it is opened nothing is fetched and there is no iframe", async () => {
  const { w, d, calls } = page();
  await tick(w);
  assert.ok(tab(d, "factory"));
  assert.equal(tab(d, "factory").textContent, "工場");
  assert.equal(d.querySelectorAll("iframe").length, 0);
  assert.deepEqual(factoryCalls(calls), []);
  assert.ok(!shown(d.getElementById("factoryPanel")));
});

test("no key in the URL: nothing is fetched, no iframe, the message says what to do", async () => {
  for (const hash of ["", "#", "#note=abc", "#graph="]) {
    const { w, d, calls } = page({ hash });
    await tick(w);
    tab(d, "factory").click();
    await tick(w);
    assert.deepEqual(factoryCalls(calls), [], hash);
    assert.equal(d.querySelectorAll("iframe").length, 0, hash);
    assert.match(d.querySelector(".fx-msg").textContent, /鍵がありません/, hash);
  }
});

test("with a key: exactly the 5 pinned files are fetched, with the key only in Authorization, to the fixed address", async () => {
  const { w, d, calls } = page();
  await tick(w);
  tab(d, "factory").click();
  await tick(w);
  const fc = factoryCalls(calls);
  assert.deepEqual(fc.map((c) => c.url.slice(BASE.length)).sort(), Object.keys(FILES).sort());
  for (const c of fc) {
    assert.equal(JSON.stringify(c.headers), JSON.stringify({ authorization: "Bearer " + KEY }));
    assert.equal(c.credentials, "omit");
    assert.equal(c.referrerPolicy, "no-referrer");
    assert.ok(!c.url.includes(KEY) && !c.url.includes("?") && !c.url.includes("#"));
  }
  assert.equal(calls.filter((c) => /\/graph|\/pulse|\/chats/.test(c.url)).length, 0, "no data route is read by this tab");
});

test("the iframe: one, sandbox allow-scripts only, srcdoc (no src), the key nowhere in it", async () => {
  const { w, d } = page();
  await tick(w);
  tab(d, "factory").click();
  await tick(w);
  const frames = d.querySelectorAll("iframe");
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.getAttribute("sandbox"), "allow-scripts");
  assert.ok(!f.hasAttribute("src"));
  assert.equal(f.getAttribute("referrerpolicy"), "no-referrer");
  const doc = f.getAttribute("srcdoc");
  assert.ok(!doc.includes(KEY) && !doc.includes("Bearer") && !doc.includes(BASE));
  assert.ok(doc.includes("<style>body{margin:0}") && doc.includes('<script type="module">window.__ran=1;'), "css and js are inlined");
  assert.ok(!doc.includes('href="factory.css"') && !doc.includes('src="factory.js"'));
  assert.ok(!doc.includes("</script> */") && !doc.includes("</style> */"), "a closing tag inside the files cannot end the inline block");
  assert.ok(doc.indexOf("window.fetch=") < doc.indexOf("window.__ran"), "the shim comes before the factory's own script");
});

test("a file that differs by one byte, or a 404, or an error: no iframe, the right message, and 'もう一度' fetches again", async () => {
  const bad = Buffer.from(FILES["assets/modules.glb"]);
  bad[0] ^= 1;
  for (const [label, serve, re] of [
    ["one byte", (n) => ({ status: 200, body: n === "assets/modules.glb" ? bad : FILES[n] }), /決めた版と違う/],
    ["404", () => null, /鍵が違う/],
    ["500", () => ({ status: 500 }), /取れませんでした/],
  ]) {
    const { w, d, calls } = page({ serve });
    await tick(w);
    tab(d, "factory").click();
    await tick(w);
    assert.equal(d.querySelectorAll("iframe").length, 0, label);
    assert.match(d.querySelector(".fx-msg").textContent, re, label);
    const before = factoryCalls(calls).length;
    d.querySelector(".fx-retry").click();
    await tick(w);
    assert.ok(factoryCalls(calls).length > before, label + ": retry fetched again");
  }
});

test("leaving and coming back does not fetch again or rebuild the iframe", async () => {
  const { w, d, calls } = page();
  await tick(w);
  tab(d, "factory").click();
  await tick(w);
  const first = d.querySelector("iframe");
  const n = factoryCalls(calls).length;
  for (const v of ["tasks", "autonomy", "taskgraf", "factory", "standby", "factory"]) {
    tab(d, v).click();
    await tick(w);
  }
  assert.equal(factoryCalls(calls).length, n);
  assert.equal(d.querySelectorAll("iframe").length, 1);
  assert.equal(d.querySelector("iframe"), first);
});

test("the channel: fx-ready from the iframe → exactly the 2 GLB byte arrays, nothing else; other senders get nothing", async () => {
  const { w, d } = page();
  await tick(w);
  tab(d, "factory").click();
  await tick(w);
  const f = d.querySelector("iframe");
  const sent = [];
  f.contentWindow.postMessage = (data, target, transfer) => sent.push({ data, target, transfer });
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "fx-ready" }, source: w })); // not the iframe
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "other" }, source: f.contentWindow }));
  await tick(w, 2);
  assert.equal(sent.length, 0);
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "fx-ready" }, source: f.contentWindow }));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.data.name), ["assets/modules.glb", "assets/courier.glb"]);
  for (const s of sent) {
    assert.equal(s.target, "*");
    assert.deepEqual(Object.keys(s.data).sort(), ["buf", "name", "type"]);
    assert.equal(s.data.type, "fx-glb");
    assert.deepEqual([...new Uint8Array(s.data.buf)], [...FILES[s.data.name]]);
    assert.ok(!JSON.stringify([...new Uint8Array(s.data.buf)]).includes(KEY));
  }
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "fx-ready" }, source: f.contentWindow }));
  assert.equal(sent.length, 2, "a second fx-ready is not answered again");
});

test("the shim inside the iframe: GLBs from the parent's bytes, every other fetch refused, links dead, strangers ignored", async () => {
  const { w, d } = page();
  await tick(w);
  tab(d, "factory").click();
  await tick(w);
  const doc = d.querySelector("iframe").getAttribute("srcdoc");
  const shim = /<script>([\s\S]*?)<\/script>/.exec(doc)[1];
  const listeners = {};
  const posted = [];
  const parent = { postMessage: (m, t) => posted.push({ m, t }) };
  const clicks = [];
  const sandbox = {
    window: { parent, addEventListener: (t, fn) => (listeners[t] = fn), fetch: (u) => Promise.resolve({ real: String(u) }) },
    document: { addEventListener: (t, fn, cap) => (listeners["doc:" + t] = fn) },
    Response: class { constructor(b, i) { this.b = b; this.i = i; } },
    TypeError, Promise, Map, JSON, String, ArrayBuffer,
  };
  vm.runInNewContext(shim, sandbox);
  assert.deepEqual(posted.map((p) => [p.m.type, p.t]), [["fx-ready", "*"]]);
  const f = sandbox.window.fetch;
  await assert.rejects(() => f("/api/task-pulse"), /offline/);
  await assert.rejects(() => f("https://example.com/x"), /offline/);
  await assert.rejects(() => f("https://handoff-mcp.gooooerer.workers.dev/graph"), /offline/);
  assert.deepEqual(await f("blob:null/abc"), { real: "blob:null/abc" }, "an image opened from the GLB (blob:) goes to the real fetch");
  assert.deepEqual(await f("data:image/png;base64,AAAA"), { real: "data:image/png;base64,AAAA" }, "and so does data:");
  await assert.rejects(() => f("https://blob:null/abc"), /offline/);
  let done = null;
  const p = f("https://yuita-genecraft.github.io/task-pulse/assets/modules.glb").then((r) => (done = r));
  await tick(w, 2);
  assert.equal(done, null, "waits for the parent");
  listeners.message({ source: { not: "parent" }, data: { type: "fx-glb", name: "assets/modules.glb", buf: new ArrayBuffer(1) } });
  await tick(w, 2);
  assert.equal(done, null, "a stranger's bytes are ignored");
  const buf = new Uint8Array([5, 6]).buffer;
  listeners.message({ source: parent, data: { type: "fx-glb", name: "assets/modules.glb", buf } });
  await p;
  assert.equal(done.i.status, 200);
  assert.deepEqual([...new Uint8Array(done.b)], [5, 6]);
  const again = await f({ url: "./assets/modules.glb" });
  assert.deepEqual([...new Uint8Array(again.b)], [5, 6], "a Request-like object works and the bytes can be read again");
  let prevented = false;
  listeners["doc:click"]({ target: { closest: (s) => (s === "a" ? {} : null) }, preventDefault: () => (prevented = true) });
  assert.ok(prevented, "a click on a link does nothing");
});

test("view switching: factory shows only its panel; leaving restores the stream or the destination's panel", async () => {
  const { w, d } = page();
  await tick(w);
  const stream = d.getElementById("stream");
  const fx = d.getElementById("factoryPanel");
  tab(d, "factory").click();
  await tick(w);
  assert.ok(!shown(stream) && shown(fx));
  assert.ok(d.querySelector(".wrap").classList.contains("v-factory"));
  assert.deepEqual([...d.querySelectorAll("#tabs .tab.on")].map((t) => t.dataset.view), ["factory"]);
  assert.equal(d.getElementById("pname").textContent, "工場");
  tab(d, "tasks").click();
  await tick(w);
  assert.ok(shown(stream) && !shown(fx));
  assert.ok(!d.querySelector(".wrap").classList.contains("v-factory"));
  tab(d, "factory").click();
  await tick(w);
  tab(d, "autonomy").click();
  await tick(w);
  assert.ok(!shown(stream) && !shown(fx));
  assert.ok([...d.querySelectorAll(".au-panel")].some(shown));
  tab(d, "factory").click();
  await tick(w);
  assert.ok(![...d.querySelectorAll(".au-panel")].some(shown));
  assert.ok(shown(fx) && !shown(stream));
});

test("a way back to the tasks that is not a tab click (サンプル・反映) closes the factory too", async () => {
  for (const how of ["sample", "apply"]) {
    const { w, d } = page();
    await tick(w);
    const stream = d.getElementById("stream");
    const fx = d.getElementById("factoryPanel");
    tab(d, "factory").click();
    await tick(w);
    assert.ok(!shown(stream) && shown(fx), how + ": the factory is open");
    if (how === "sample") d.getElementById("btnSample").click();
    else {
      d.getElementById("ta").value = "- [ ] 試験のタスク";
      d.getElementById("btnApply").click();
    }
    await tick(w);
    assert.deepEqual([...d.querySelectorAll("#tabs .tab.on")].map((t) => t.dataset.view), ["tasks"], how + ": the selected tab is the tasks");
    assert.ok(shown(stream) && !shown(fx), how + ": the task list is back and the factory panel is put away");
    assert.ok(!d.querySelector(".wrap").classList.contains("v-factory"), how + ": no v-factory class left");
    tab(d, "factory").click();
    await tick(w);
    assert.ok(!shown(stream) && shown(fx), how + ": the factory can be opened again");
  }
});

test("the source's own rules", () => {
  const CODE = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/localStorage|sessionStorage|indexedDB|console\.|innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(CODE));
  assert.match(CODE, /const BASE = "https:\/\/handoff-mcp\.gooooerer\.workers\.dev\/factory\/";/);
  const pins = [...SRC.matchAll(/^\s+"([^"]+)": "([0-9a-f]{64})",$/gm)];
  assert.deepEqual(pins.map((m) => m[1]).sort(), Object.keys(FILES).sort());
  assert.equal(new Set(pins.map((m) => m[2])).size, 5);
  assert.deepEqual((CODE.match(/postMessage\(/g) || []).length, 2 + 1, "parent→iframe twice (the GLBs, the work snapshot), plus the shim's ready");
  assert.ok(/postMessage\(\{ type: "fx-events", snapshot: snap \}, "\*"\)/.test(CODE), "the snapshot message carries the snapshot only");
  assert.ok(!/postMessage\([^)]*key/i.test(CODE));
});

// ---- 段2：実際の仕事の写し（GET /factory/events） ----
const SNAP = { nodes: [{ id: "cc-jobs:pr:x__repo-1", title: "審査 repo #1 第1回", owner: "審査", goal: false, state: "done" }], edges: [], source: { kind: "execution-events", graphGeneratedAt: "2026-10-29T08:00:00.000Z" } };
const eventsBody = (at, snap = SNAP) => Buffer.from(JSON.stringify({ received_at: at, snapshot: snap }));
async function openAndReady(opts) {
  const pg = page(opts);
  await tick(pg.w);
  tab(pg.d, "factory").click();
  await tick(pg.w);
  const f = pg.d.querySelector("iframe");
  const sent = [];
  f.contentWindow.postMessage = (data, target, transfer) => sent.push({ data, target, transfer });
  pg.w.dispatchEvent(new pg.w.MessageEvent("message", { data: { type: "fx-ready" }, source: f.contentWindow }));
  await tick(pg.w);
  return { ...pg, f, sent, note: () => pg.d.querySelector(".fx-note").textContent };
}

test("events: nothing stored yet (404) → no snapshot is sent, the note says the sample is shown", async () => {
  const { sent, calls, note } = await openAndReady();
  assert.deepEqual(sent.map((s) => s.data.type), ["fx-glb", "fx-glb"]);
  const ev = calls.filter((c) => c.url === BASE + "events");
  assert.equal(ev.length, 1, "asked once, after the factory said it is ready");
  assert.match(note(), /まだ届いていません/);
});

test("events: a stored snapshot → sent to the iframe once (no key in it), the note says real work is shown, re-sent only when newer", async () => {
  let at = "2026-10-29T08:00:05.000Z";
  const { w, d, sent, calls, note } = await openAndReady({ serve: (n) => (n === "events" ? { status: 200, body: eventsBody(at) } : { status: 200, body: FILES[n] }) });
  const evMsgs = () => sent.filter((s) => s.data.type === "fx-events");
  assert.equal(evMsgs().length, 1);
  assert.deepEqual(Object.keys(evMsgs()[0].data).sort(), ["snapshot", "type"]);
  assert.equal(JSON.stringify(evMsgs()[0].data.snapshot), JSON.stringify(SNAP));
  assert.ok(!JSON.stringify(evMsgs()[0].data).includes(KEY), "the key is not in the message");
  const ev = calls.filter((c) => c.url === BASE + "events");
  assert.ok(ev.every((c) => c.headers.authorization === "Bearer " + KEY && c.credentials === "omit" && c.referrerPolicy === "no-referrer"), "the key only in Authorization, no cookies, no referrer");
  assert.match(note(), /実際の仕事/);
  // leave and come back: the same snapshot is not sent again, the factory files are not fetched again
  const filesBefore = factoryCalls(calls).filter((c) => c.url !== BASE + "events").length;
  tab(d, "tasks").click();
  tab(d, "factory").click();
  await tick(w);
  assert.equal(evMsgs().length, 1, "same received_at → not sent again");
  assert.equal(factoryCalls(calls).filter((c) => c.url !== BASE + "events").length, filesBefore, "the factory itself is not fetched again");
  at = "2026-10-29T08:10:05.000Z";
  tab(d, "tasks").click();
  tab(d, "factory").click();
  await tick(w);
  assert.equal(evMsgs().length, 2, "a newer snapshot is sent");
});

test("events: a wrong shape, a wrong kind, too large, or an error → nothing sent, the sample stays", async () => {
  const cases = [
    { status: 200, body: Buffer.from("not json") },
    { status: 200, body: Buffer.from(JSON.stringify({ received_at: "x", snapshot: { source: { kind: "task-pulse" } } })) },
    { status: 200, body: Buffer.from(JSON.stringify({ snapshot: SNAP })) },
    { status: 200, body: Buffer.alloc(300 * 1024 + 1, 32) },
    { status: 500, body: Buffer.from("{}") },
  ];
  for (const c of cases) {
    const { sent, note } = await openAndReady({ serve: (n) => (n === "events" ? c : { status: 200, body: FILES[n] }) });
    assert.equal(sent.filter((s) => s.data.type === "fx-events").length, 0, JSON.stringify(c.body.slice(0, 40).toString()));
    assert.match(note(), /見本/);
  }
});

test("events: no snapshot is asked for before the factory is ready, and none without a key", async () => {
  const pg = page();
  await tick(pg.w);
  tab(pg.d, "factory").click();
  await tick(pg.w);
  assert.equal(pg.calls.filter((c) => c.url === BASE + "events").length, 0, "not before fx-ready");
  const nokey = page({ hash: "" });
  await tick(nokey.w);
  tab(nokey.d, "factory").click();
  await tick(nokey.w);
  assert.equal(nokey.calls.length, nokey.calls.filter((c) => !c.url.startsWith(BASE)).length);
});

test("the shim answers /api/execution-events only from the parent's snapshot, and loads it once the page has loaded", async () => {
  const { w, d } = page();
  await tick(w);
  tab(d, "factory").click();
  await tick(w);
  const doc = d.querySelector("iframe").getAttribute("srcdoc");
  const shim = /<script>([\s\S]*?)<\/script>/.exec(doc)[1];
  const listeners = {};
  const parent = { postMessage: () => {} };
  let clicked = 0;
  const docStub = { readyState: "loading", addEventListener: () => {}, getElementById: (id) => (id === "events-source" ? { click: () => clicked++ } : null) };
  const sandbox = {
    window: { parent, addEventListener: (t, fn) => (listeners[t] = fn), fetch: (u) => Promise.resolve({ real: String(u) }) },
    document: docStub,
    Response: class { constructor(b, i) { this.b = b; this.i = i; } },
    TypeError, Promise, Map, JSON, String, ArrayBuffer,
  };
  vm.runInNewContext(shim, sandbox);
  const f = sandbox.window.fetch;
  await assert.rejects(() => f("/api/execution-events"), /offline/, "before a snapshot: refused like every other /api");
  listeners.message({ source: { not: "parent" }, data: { type: "fx-events", snapshot: SNAP } });
  await assert.rejects(() => f("/api/execution-events"), /offline/, "a stranger's snapshot is ignored");
  listeners.message({ source: parent, data: { type: "fx-events", snapshot: { source: { kind: "other" } } } });
  await assert.rejects(() => f("/api/execution-events"), /offline/, "a snapshot of another kind is ignored");
  listeners.message({ source: parent, data: { type: "fx-events", snapshot: SNAP } });
  const r = await f("/api/execution-events");
  assert.equal(r.i.status, 200);
  assert.deepEqual(JSON.parse(r.b), SNAP);
  await assert.rejects(() => f("/api/task-pulse"), /offline/, "other /api paths stay refused");
  await assert.rejects(() => f("https://evil.example/api/execution-events"), /offline/, "only the page's own relative path is answered");
  assert.equal(clicked, 0, "not clicked before the page has loaded");
  assert.equal(typeof listeners.load, "function", "waits for load");
  docStub.readyState = "complete";
  listeners.load();
  assert.equal(clicked, 1, "after load, the factory's 明示実行イベント is pressed once");
  listeners.message({ source: parent, data: { type: "fx-events", snapshot: SNAP } });
  assert.equal(clicked, 1, "the very same object is not loaded twice");
  listeners.message({ source: parent, data: { type: "fx-events", snapshot: { ...SNAP } } });
  assert.equal(clicked, 2, "a new snapshot is loaded");
});
