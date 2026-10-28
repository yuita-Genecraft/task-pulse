// 工場タブの隔離を、本物の Chrome（headless）で確かめる。jsdom は sandbox を実装しないので、ここだけは実ブラウザ。
// 本物の工場(10MB)は使わない：iframe の中で動くのは、この試験が置く小さな偽の factory.js ＝ 親・保存領域・外部通信へ手を伸ばして結果を親へ postMessage するだけ。
//   origin   : iframe の origin は "null"（allow-same-origin が無い）
//   parent   : 親の location・document・localStorage・cookie へ触ると SecurityError
//   network  : iframe 内の fetch（外部 URL・/api/*）は shim が断る
//   key      : 鍵は親へのどの URL にも出ない・iframe の中の文字列にも無い
// Chrome が無い環境では skip（CHROME=パス で指定可）。使い方: node --test tests/factory-tab-chrome.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const nodeCrypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CHROME = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && fs.existsSync(p));
const KEY = "chrome-e2e-key-0123456789";
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
const out = {};
const t = (k, f) => { try { out[k] = String(f()); } catch (e) { out[k] = 'blocked:' + e.name; } };
t('origin', () => location.origin);
t('parentHash', () => parent.location.hash);
t('parentDoc', () => parent.document.title);
t('topHref', () => top.location.href);
t('localStorage', () => localStorage.length);
t('cookie', () => document.cookie);
Promise.allSettled([fetch('https://example.com/'), fetch('/api/anything'), fetch('http://127.0.0.1:1/x')]).then((rs) => {
  out.fetches = rs.map((r) => r.status);
  parent.postMessage({ fxProbe: out }, '*');
});
`;
const FILES = {
  "index.html": Buffer.from('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="factory.css"><script type="module" src="factory.js"></script></head><body><a class="brand" href="./">T</a><div id="scene"></div></body></html>'),
  "factory.css": Buffer.from("body{margin:0}"),
  "factory.js": Buffer.from(PROBE),
  "assets/modules.glb": Buffer.from([1, 2, 3, 4]),
  "assets/courier.glb": Buffer.from([9, 8, 7]),
};

test("in real Chrome: the factory iframe is cut off from the parent, storage and the network", { skip: !CHROME && "no Chrome", timeout: 90000 }, async () => {
  const seen = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ url: req.url, auth: req.headers.authorization || "" });
    if (u.pathname.startsWith("/factory/")) {
      const f = FILES[u.pathname.slice("/factory/".length)];
      if (!f || req.headers.authorization !== "Bearer " + KEY) return void res.writeHead(404).end("nf");
      return void res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" }).end(f);
    }
    let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    html = html.replace(/<script src="([^"]+)" defer><\/script>/g, (_, f) => {
      let code = fs.readFileSync(path.join(ROOT, f), "utf8");
      if (f === "factory-tab.js") {
        code = code.replace("https://handoff-mcp.gooooerer.workers.dev/factory/", `http://127.0.0.1:${port}/factory/`);
        for (const [name, buf] of Object.entries(FILES)) code = code.replace(new RegExp(`("${name.replace(/[./]/g, "\\$&")}": ")[0-9a-f]{64}(")`), `$1${sha(buf)}$2`);
      }
      return `<script>${code.replace(/<\/script/g, "<\\/script")}</script>`;
    });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fx-chrome-"));
  const dport = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1000,800", "about:blank"], { stdio: "ignore" });
  let ws;
  try {
    let list;
    for (let i = 0; i < 60 && !list; i++) {
      try {
        list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
      } catch {
        await sleep(250);
      }
    }
    assert.ok(list, "Chrome started");
    ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pend.has(d.id)) (pend.get(d.id)(d), pend.delete(d.id));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/#graph=${KEY}` });
    await sleep(1500);
    assert.equal(seen.filter((s) => s.url.startsWith("/factory/")).length, 0, "nothing fetched before the tab is opened");
    await ev("window.__probe=null;addEventListener('message',e=>{if(e.data&&e.data.fxProbe)window.__probe=e.data.fxProbe});document.querySelector('#tabs .tab[data-view=factory]').click()");
    let probe = null;
    for (let i = 0; i < 60 && !probe; i++) {
      await sleep(500);
      probe = await ev("window.__probe");
    }
    assert.ok(probe, "the iframe ran and reported; " + JSON.stringify({ msg: await ev("(document.querySelector('.fx-msg')||{}).textContent+'|hidden='+(document.querySelector('.fx-msg')||{}).hidden+'|iframes='+document.querySelectorAll('iframe').length"), seen: seen.map((s) => s.url + " " + (s.auth ? "auth" : "noauth")) }));
    assert.equal(probe.origin, "null", "opaque origin");
    for (const k of ["parentHash", "parentDoc", "topHref", "localStorage", "cookie"]) assert.match(probe[k], /^blocked:/, k + " is blocked: " + probe[k]);
    assert.deepEqual(probe.fetches, ["rejected", "rejected", "rejected"], "every outside fetch is refused");
    const attrs = JSON.parse(await ev("(()=>{const f=document.querySelector('iframe');return JSON.stringify({sandbox:f.getAttribute('sandbox'),src:f.getAttribute('src'),key:f.getAttribute('srcdoc').includes(" + JSON.stringify(KEY) + ")})})()"));
    assert.deepEqual(attrs, { sandbox: "allow-scripts", src: null, key: false });
    const f = seen.filter((s) => s.url.startsWith("/factory/"));
    assert.equal(f.length, 5, "exactly the 5 pinned files");
    assert.ok(f.every((s) => s.auth === "Bearer " + KEY), "the key only in Authorization");
    assert.ok(!seen.some((s) => s.url.includes(KEY)), "the key is in no URL");
    assert.ok(!seen.some((s) => !s.url.startsWith("/factory/") && s.url !== "/" && s.url !== "/tasks.md" && !s.url.startsWith("/?") && !s.url.startsWith("/favicon")), "no other request reached the server: " + JSON.stringify(seen.map((s) => s.url)));
  } finally {
    try { ws && ws.close(); } catch {}
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
