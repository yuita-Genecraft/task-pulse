// factory — Task Pulse の「工場」タブ。3D 工場（Flow Foundry・見本データの build）を、タブを開いた時に初めて 1 回だけ取って見せる。
// 段1：見本のデータで動く。本物のタスクにはつながない（/graph・/pulse はこのファイルでは読まない）。
//
// 工場のファイル（約 11 MB）は、この公開 repo には置かない。handoff の GET /factory/<file>（読む鍵の Bearer が無ければ 404・handoff-mcp の
// docs/factory-assets.md）から、タブを開いた時に、親ページが鍵を付けて取る。
//
// 守っていること
// - 取った 5 ファイルは、下の PINS（sha256）と 1 バイトでも違えば使わない（置き場が差し替えられても、ここに無いバイトは動かさない）。
// - 鍵は、読むだけの鍵（# の後ろの #graph=…・taskgraf と同じ）を、固定の送り先 BASE の /factory/ への Authorization ヘッダーにだけ使う。
//   iframe には渡さない（srcdoc にも postMessage にも URL にも入れない）。localStorage などに書かない。console に出さない。
// - 工場は sandbox="allow-scripts"（allow-same-origin なし）の iframe に隔離する：親の URL・localStorage・cookie に触れない。
//   iframe の中の fetch は、GLB 2 つ（親が postMessage で渡すバイト）と、iframe 自身が作った blob:/data:（GLB に入っている画像を開くのに three.js が使う・外へ出ない）以外は全部断る（/api/* も外へ出ない＝工場は見本のまま「取得に失敗しました」と出す）。
//   iframe 内のリンクは動かさない。親から iframe へ渡すのは、GLB 2 つのバイトだけ。
// - 17 MB を取るのは、タブを開いた時だけ。一度作った iframe は、別のタブへ移っても消さない（戻った時に取り直さない）。失敗したら「もう一度」だけ出す。
(() => {
  "use strict";
  const BASE = "https://handoff-mcp.gooooerer.workers.dev/factory/";
  const VIEW = "factory";
  // handoff-mcp の factory-assets/factory/SHA256SUMS.txt と同じ値（handoff-mcp PR の docs/factory-assets.md にも元の値が書いてある）
  const PINS = {
    "index.html": "3b9a389022b476a7dda60fec48721e52d783dc4e62ed9d5afcea3e93201ca871",
    "factory.css": "4205ed10d1da82ae1dc5cc68a84eb385c64c4d3ebefdb47129acd2036ca37eab",
    "factory.js": "9bc1dc4e8674c37b246a68a11a554ff0fa82a01a626156fa39c318db27a3e84a",
    "assets/modules.glb": "287d94ae16ca63bd389637aaf7c0f27b7989820a12f0a91942f8c5a82647c2ab",
    "assets/courier.glb": "1e3a666d92279259ac14c3ba5a933b31288d4f7fd5909f6f7dd1abac27d807a9",
  };
  const GLBS = ["assets/modules.glb", "assets/courier.glb"];
  const LINK_TAG = '<link rel="stylesheet" href="factory.css">';
  const SCRIPT_TAG = '<script type="module" src="factory.js"></script>';

  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;

  // ---- 形を決める（画面に触らない） ----
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  async function sha256Hex(buf) {
    return hex(await crypto.subtle.digest("SHA-256", buf));
  }
  function readKey() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return "";
    return (new URLSearchParams(h).get("graph") || "").trim();
  }
  // 工場の中で最初に動く小さな script。GLB 2 つは親のバイトで答え、ほかの通信は全部断り、リンクは動かさない。
  const SHIM = `<script>(()=>{
const NAMES=${JSON.stringify(GLBS)};
const waiting=new Map(),got=new Map();
const want=(n)=>got.has(n)?Promise.resolve(got.get(n)):new Promise((r)=>{const a=waiting.get(n)||[];a.push(r);waiting.set(n,a);});
const realFetch=window.fetch.bind(window);
window.fetch=function(input,init){
  const u=String(typeof input==='string'?input:(input&&input.url)||'');
  if(/^(blob|data):/.test(u))return realFetch(input,init);
  const n=NAMES.find((x)=>u.endsWith('/'+x));
  if(!n)return Promise.reject(new TypeError('offline'));
  return want(n).then((b)=>new Response(b.slice(0),{status:200,headers:{'content-type':'model/gltf-binary'}}));
};
window.addEventListener('message',(e)=>{
  if(e.source!==window.parent)return;
  const d=e.data;
  if(!d||d.type!=='fx-glb'||!NAMES.includes(d.name)||!(d.buf instanceof ArrayBuffer))return;
  got.set(d.name,d.buf);
  for(const r of waiting.get(d.name)||[])r(d.buf);
  waiting.delete(d.name);
});
document.addEventListener('click',(e)=>{if(e.target&&e.target.closest&&e.target.closest('a'))e.preventDefault();},true);
window.parent.postMessage({type:'fx-ready'},'*');
})();<\/script>`;
  // 固定の本文（sha256 が合ったバイト）から、iframe の srcdoc を作る。見つからない目印があれば作らない。
  function buildSrcdoc(files) {
    const html = files["index.html"], css = files["factory.css"], js = files["factory.js"];
    if (!html.includes(LINK_TAG) || !html.includes(SCRIPT_TAG)) return null;
    const inlineCss = "<style>" + css.replace(/<\/style/gi, "<\\/style") + "</style>";
    const inlineJs = '<script type="module">' + js.replace(/<\/script/gi, "<\\/script") + "<\/script>";
    return html.replace(LINK_TAG, () => SHIM + inlineCss).replace(SCRIPT_TAG, () => inlineJs);
  }

  const css = document.createElement("style");
  css.textContent = `
  .wrap.v-factory{max-width:none}
  .wrap.v-factory .pbar, .wrap.v-factory .prow2{display:none}
  .fx-panel{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;background:var(--bg)}
  .fx-panel[hidden]{display:none}
  .fx-frame{flex:1 1 auto;width:100%;min-height:0;border:0;background:#05090d}
  .fx-msg{margin:14px;font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--line-soft);border-radius:12px;padding:12px 14px;line-height:1.7}
  .fx-retry{margin-left:8px;font:inherit;font-size:12px;font-weight:600;color:#dbe8ff;background:#243042;border:1px solid #33455e;border-radius:8px;padding:4px 12px;cursor:pointer}
  .fx-note{flex:none;margin:0;padding:6px 14px;font-size:11px;line-height:1.5;color:var(--faint);border-top:1px solid var(--line-soft)}
  `;
  document.head.appendChild(css);

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = VIEW;
  btn.textContent = "工場";
  tabs.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "fx-panel";
  panel.id = "factoryPanel";
  panel.hidden = true;
  const msgBox = document.createElement("div");
  msgBox.className = "fx-msg";
  msgBox.hidden = true;
  const note = document.createElement("p");
  note.className = "fx-note";
  note.textContent = "見本のデータで動く 3D の工場です。本物のタスクにはまだつながっていません。";
  panel.append(msgBox, note);
  stream.insertAdjacentElement("afterend", panel);

  function say(text, retry) {
    msgBox.hidden = false;
    msgBox.textContent = text;
    if (retry) {
      const r = document.createElement("button");
      r.type = "button";
      r.className = "fx-retry";
      r.textContent = "もう一度";
      r.addEventListener("click", () => void load());
      msgBox.appendChild(r);
    }
  }

  let frame = null;
  let loading = false;
  async function fetchFile(name, key) {
    const res = await fetch(BASE + name, {
      method: "GET",
      headers: { authorization: "Bearer " + key },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (res.status === 404) throw new Error("denied");
    if (!res.ok) throw new Error("http " + res.status);
    return res.arrayBuffer();
  }
  async function load() {
    if (frame || loading) return;
    const key = readKey();
    if (!key) {
      say("鍵がありません。ブックマークの URL の最後に「#graph=読むだけの鍵」を付けて開いてください（taskgraf と同じ鍵）。", true);
      return;
    }
    loading = true;
    say("工場を取っています…（約 11 MB）");
    try {
      const names = Object.keys(PINS);
      const bufs = await Promise.all(names.map((n) => fetchFile(n, key)));
      const files = {};
      for (let i = 0; i < names.length; i++) {
        if ((await sha256Hex(bufs[i])) !== PINS[names[i]]) throw new Error("mismatch " + names[i]);
        files[names[i]] = names[i].endsWith(".glb") ? bufs[i] : new TextDecoder("utf-8", { fatal: true }).decode(bufs[i]);
      }
      const srcdoc = buildSrcdoc(files);
      if (!srcdoc) throw new Error("shape");
      const f = document.createElement("iframe");
      f.className = "fx-frame";
      f.title = "Flow Foundry（3D 工場・見本データ）";
      f.setAttribute("sandbox", "allow-scripts");
      f.setAttribute("referrerpolicy", "no-referrer");
      const onMessage = (e) => {
        if (e.source !== f.contentWindow || !e.data || e.data.type !== "fx-ready") return;
        window.removeEventListener("message", onMessage);
        for (const n of GLBS) {
          const copy = files[n].slice(0);
          f.contentWindow.postMessage({ type: "fx-glb", name: n, buf: copy }, "*", [copy]);
        }
      };
      window.addEventListener("message", onMessage);
      f.srcdoc = srcdoc;
      frame = f;
      msgBox.hidden = true;
      panel.insertBefore(f, note);
    } catch (e) {
      const why = String((e && e.message) || e);
      if (why === "denied") say("読めませんでした（鍵が違うか、工場の置き場が無効です）。", true);
      else if (why.startsWith("mismatch") || why === "shape") say("取れたファイルが、決めた版と違うので使いませんでした。", true);
      else say("工場を取れませんでした（通信の失敗かエラー）。", true);
    } finally {
      loading = false;
    }
  }

  const OTHER_PANELS = ".tg-panel:not([hidden]),.ch-panel:not([hidden]),.cg-panel:not([hidden]),.au-panel:not([hidden])";
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    const wrap = document.querySelector(".wrap");
    if (b.dataset.view === VIEW) {
      stream.style.display = "none";
      panel.hidden = false;
      wrap && wrap.classList.add("v-factory");
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
      void load();
      // 既存の処理がタスクの見出しを書いた後に、この画面の見出しに置き換える
      setTimeout(() => {
        const pn = document.getElementById("pname");
        if (pn && !panel.hidden) pn.textContent = "工場";
      }, 0);
    } else if (!panel.hidden) {
      panel.hidden = true;
      wrap && wrap.classList.remove("v-factory");
      // 行き先が自分の枠を持つ画面なら、その枠が出ている＝タスクの流れは戻さない
      if (!document.querySelector(OTHER_PANELS)) stream.style.display = "";
    }
  });
})();
