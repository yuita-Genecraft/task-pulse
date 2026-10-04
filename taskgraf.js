// taskgraf — Task Pulse の3つ目のタブ。handoff の GET /graph を、タブを開くたびに読み直して、1枚のマインドマップとして描く。
// 形：真ん中に「待ち・依頼でつながるレーン」を置いて太い矢印で結ぶ（中心）。その左右に、まとまりを半円を描くように並べ（中間のノード）、
// まとまりからレーンへ細い枝を外向きに扇状に伸ばす（葉のノード）。中心→まとまり→レーンの3層。
// 太い矢印は登録済みの待ち・依頼だけ。中心→まとまり、まとまり→レーンの枝は「所属を見せるための構造」なので細く薄く、矢印は付けない。
// レーンは中心のものも含めて、ふだんは「● 名前 未完了数」だけのノード（四角い背景・枠・影は使わない）。中心は文字の大きさと明るさ、
// そして待ち・依頼の太い矢印で主役にする。拡大すると「状態・未完了数」の行が出る。四角い UI は、レーンを押した時の詳細カードだけ。
// （/graph がいつか個別のタスクを返すようになったら、レーンから先へ枝を足せる形にしてある。今は返さないので、タスクは描かない）
//
// 守っていること（設計メモ taskgraf v0.2〜v0.3・ChatGPT レビュー済み）
// - 外部の JavaScript は読み込まない。このファイルと index.html だけで描く（ノードは HTML、線は SVG）。
// - 読むだけの鍵は、ブックマークの URL の # の後ろ（#graph=…）にだけ置く。localStorage など
//   どこにも保存しない（github.io の同じ住所の別ページから読めるため）。console にも出さない。
// - 鍵は Authorization ヘッダーで固定の送り先にだけ送る（送り先は差し替えられない）。
// - タブを開くたびに取り直す（キャッシュしない）。開いたままの自動更新はしない。取得時刻を出す。
// - 線は handoff に明示登録された open の関係だけ。「漏れはありうる」と必ず出す。推測した関係・分類は描かない。
// - まとまりは、/graph が各レーンに返す group だけ（handoff に人が確かめて入れた値。初期値は STEP2 で承認表から入れた）。
//   group は明示データとして扱う：文字列ならそのまとまり／null（未設定）は「未分類」／/graph に無いレーン（closed・test を含む）は描かない／
//   中央へ移して描くレーンも、所属のまとまりは詳細に出す。名前やコンパスからまとまりを推測することはしない。
//   まとまりの一覧・名前・並び順はこのファイルに書かない（公開 repo のため）。並びは名前のコードポイント順（正規化しない）で、「未分類」は最後。
//   どのレーンにも group が無い時（まとまりを返さない古い /graph）は、最終更新の区分をまとまりの代わりにする。
//   group が一部のレーンにだけ無い・文字列でも null でもない・空の文字列の時は、設定エラーを出して、まとまりは描かない（最終更新の区分で描く）。
// - 最終更新は「動いている／止まっている」と名乗らず、観測のラベルで出す。
// - 配置は開くたびに自動で計算し、保存しない。データは textContent と createElementNS で入れる（文字列の innerHTML は使わない）。
(() => {
  "use strict";
  const GRAPH_URL = "https://handoff-mcp.gooooerer.workers.dev/graph";
  const VIEW = "taskgraf";
  const DAY = 86400000;
  const TYPE_LABEL = { waits_on: "待ち", requests: "依頼" };
  const TYPE_VERB = { waits_on: "を待っている", requests: "に頼んでいる" };
  const BUCKETS = [
    ["a7", "7日以内に更新あり", "#3ecf75"],
    ["a30", "8〜30日更新なし", "#f0a03a"],
    ["a31", "31日以上更新なし", "#f05a5a"],
    ["none", "記録前", "#7c8496"],
  ];
  const BUCKET = Object.fromEntries(BUCKETS.map(([key, label, color]) => [key, { key, label, color }]));
  const SEL = "#8b7bff"; // 選択中（青紫）
  const REL = "#dcd7ff", REL_HI = "#b4a9ff"; // 待ち・依頼の線（白〜紫）
  const PALETTE = ["#9a93d6", "#6aa8a0", "#7a96c8", "#c4a06a", "#c48a9a", "#7fa87f", "#77a9c0", "#a898cc"]; // まとまりの色（低彩度・アクセントだけに使う）
  const UNCAT = "未分類"; // group が未設定（null）のレーンをまとめる表示名
  const HUB = { w: 170, h: 46 }, CORE = { w: 150, h: 26 }; // 中心のノードの文字の範囲（配置と矢印の出入りに使う。四角は描かない。拡大時の行の分も含む）
  const TIER_GAP = 88, CORE_GAP = 110; // 中心の段の間・横の間（太い矢印と「待ち」の札、拡大時の行が入る間）
  const LANE_H = 36; // レーンの縦の間（拡大して本丸の行が出ても重ならない高さ）
  const PANE_W = 320; // 詳細カードの幅

  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;

  const css = document.createElement("style");
  css.textContent = `
  .tg-panel{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden;background:#0b0d14}
  .tg-panel[hidden]{display:none}
  .wrap.v-taskgraf .pbar,.wrap.v-taskgraf .prow2,.wrap.v-taskgraf .tools,.wrap.v-taskgraf .paste{display:none}
  .tg-bar{flex:0 0 auto;padding:6px 14px 6px;font-size:11.5px;color:#8d94a6;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.05)}
  .tg-bar b{color:#e6e8ee;font-weight:600}
  .tg-l1{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 14px}
  .tg-info{color:#a99a7c;font-size:11px;cursor:help}
  .tg-err{margin-top:2px;color:#ff8f8f;font-weight:600}
  .tg-legend{display:flex;flex-wrap:wrap;gap:2px 14px;font-size:10.5px;color:#7d8496}
  .tg-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
  .tg-legend svg{vertical-align:middle;margin-right:4px}
  .tg-msg{margin:14px;font-size:13px;color:#e3e5eb;background:#141722;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 14px;line-height:1.7}
  .tg-view{flex:1 1 auto;min-height:0;position:relative;overflow:hidden;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;
    background:radial-gradient(ellipse 70% 60% at 50% 48%,#131a33 0%,#0e1222 45%,#0b0d14 100%)}
  .tg-view.grab{cursor:grabbing}
  .tg-dots{position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(rgba(255,255,255,.03) 1px,transparent 1.3px);background-size:24px 24px}
  .tg-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
  .tg-svg{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
  .tg-halo{position:absolute;border-radius:50%;pointer-events:none}
  .tg-cat{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;font-size:13px;font-weight:650;letter-spacing:.03em;
    padding:4px 11px;border-radius:999px;border:1px solid;pointer-events:none;transition:opacity .15s}
  .tg-cat .cnt{margin-left:7px;font-size:11px;font-weight:500;opacity:.75}
  .tg-node{position:absolute;width:max-content;display:flex;flex-wrap:wrap;align-items:center;column-gap:6px;white-space:nowrap;cursor:pointer;
    padding:2px 6px;border-radius:8px;border:1px solid transparent;transform:translate(-10px,-50%);transition:opacity .15s,background-color .15s,border-color .15s}
  .tg-node.side-l{flex-direction:row-reverse;transform:translate(calc(-100% + 10px),-50%)}
  .tg-node:hover .tg-name{color:#ffffff}
  .tg-node .tg-name{font-size:12.5px;line-height:16px;font-weight:600;color:#dde0e8}
  .tg-node .tg-open{font-size:10.5px;color:#8a91a3;font-variant-numeric:tabular-nums}
  .tg-node .tg-nst{display:none;flex-basis:100%;margin-left:14px;font-size:10.5px;line-height:12px;color:#8f96a8}
  .tg-node.side-l .tg-nst{margin:0 14px 0 0;text-align:right}
  .tg-world.z1 .tg-node .tg-nst{display:block}
  .tg-world.zmin .tg-node .tg-open{display:none}
  .tg-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--tg-c);box-shadow:0 0 0 3px rgba(11,13,20,.9)}
  .tg-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .tg-node.core{transform:translate(-50%,-50%)}
  .tg-node.core .tg-name{font-size:14.5px;line-height:18px;color:#f2f3fb}
  .tg-node.core .tg-open{font-size:11px;color:#c9cdd8}
  .tg-node.core .tg-dot{width:10px;height:10px;box-shadow:0 0 0 3px rgba(139,123,255,.3)}
  .tg-node.core.hub .tg-name{font-size:18px;line-height:22px;font-weight:700;color:#ffffff}
  .tg-node.core.hub .tg-dot{width:11px;height:11px;box-shadow:0 0 0 4px rgba(139,123,255,.34)}
  .tg-world.has-sel .tg-node,.tg-world.has-sel .tg-cat{opacity:.28}
  .tg-world.has-sel .tg-svg.branches{opacity:.35}
  .tg-world.has-sel .tg-node.rel{opacity:1}
  .tg-node.sel{opacity:1!important;z-index:3}
  .tg-node.sel .tg-dot{box-shadow:0 0 0 4px rgba(139,123,255,.55),0 0 14px rgba(139,123,255,.65)}
  .tg-node.sel .tg-name{color:#ffffff;text-shadow:0 0 14px rgba(139,123,255,.6)}
  .tg-pane{position:absolute;width:${PANE_W}px;max-height:calc(100% - 20px);overflow:auto;z-index:4;padding:14px 15px 15px;border-radius:16px;
    background:rgba(18,20,32,.97);border:1px solid rgba(139,123,255,.45);box-shadow:0 18px 40px rgba(0,0,0,.5),0 0 0 1px rgba(139,123,255,.12);
    user-select:text;-webkit-user-select:text;cursor:auto}
  .tg-pane[hidden]{display:none}
  .tg-ph{display:flex;align-items:center;gap:10px}
  .tg-ph .tg-dot{width:11px;height:11px}
  .tg-ph h4{margin:0;font-size:17px;font-weight:700;color:#f1f2f6;word-break:break-all;line-height:1.25}
  .tg-ph small{display:block;font-size:11.5px;color:#9aa1b2;margin-top:2px}
  .tg-x{margin-left:auto;flex:none;font:inherit;font-size:12px;color:#d9dce4;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
    border-radius:9px;padding:6px 11px;cursor:pointer}
  .tg-sec{margin-top:11px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}
  .tg-sec h5{margin:0 0 6px;font-size:10.5px;letter-spacing:.1em;color:#8088a0;font-weight:700}
  .tg-kv{display:grid;grid-template-columns:68px 1fr;gap:5px 10px;margin:0;font-size:12.5px;line-height:1.6}
  .tg-kv dt{color:#8a91a5}
  .tg-kv dd{margin:0;color:#e3e5eb;white-space:pre-wrap;word-break:break-word}
  .tg-rl{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:9px;cursor:pointer;font-size:12.5px;color:#e3e5eb}
  .tg-rl:hover{background:rgba(255,255,255,.05)}
  .tg-rl .tg-name{font-size:12.5px;font-weight:600}
  .tg-tag{flex:none;font-size:11px;color:#d7d1ff;border:1px solid rgba(139,123,255,.55);border-radius:999px;padding:0 8px;line-height:18px}
  .tg-rl .n{margin-left:auto;color:#9aa1b2;font-size:11.5px;white-space:nowrap}
  .tg-none{font-size:12px;color:#8f97a8;line-height:1.6}
  .tg-tt{width:100%;border-collapse:collapse;font-size:12.5px}
  .tg-tt th,.tg-tt td{padding:3px 2px;text-align:right;color:#e3e5eb;border-bottom:1px solid rgba(255,255,255,.05);font-weight:400}
  .tg-tt th{color:#8a91a5;font-size:11px}
  .tg-tt td:first-child,.tg-tt th:first-child{text-align:left;color:#9aa1b2}
  .tg-ctrl{position:absolute;left:12px;bottom:12px;display:flex;gap:6px;z-index:3}
  .tg-ctrl button{font:inherit;font-size:13px;min-width:42px;height:38px;padding:0 12px;color:#e3e5eb;background:rgba(20,22,34,.9);
    border:1px solid rgba(255,255,255,.09);border-radius:10px;cursor:pointer}
  @media (max-width:699px){.tg-ctrl{left:auto;right:12px}.tg-ctrl button{min-width:50px;height:48px;font-size:15px;border-radius:12px}
    .tg-legend{flex-wrap:nowrap;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}
    .tg-legend::-webkit-scrollbar{display:none}
    .tg-view.sheet-open .tg-ctrl{bottom:auto;top:12px}}
  `;
  document.head.appendChild(css);

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = VIEW;
  btn.textContent = "taskgraf";
  tabs.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "tg-panel";
  panel.id = "taskgrafPanel";
  panel.hidden = true;
  stream.insertAdjacentElement("afterend", panel);

  let seq = 0; // 古い取得の結果で新しい表示を上書きしない
  let last = null; // 最後に描いたデータ（画面の向きが変わった時に描き直すため。保存はしない）
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    const wrap = document.querySelector(".wrap");
    if (b.dataset.view === VIEW) {
      stream.style.display = "none";
      panel.hidden = false;
      wrap && wrap.classList.add("v-taskgraf");
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
      // 既存の処理がタスクの見出しを書いた後に、taskgraf の見出しに置き換える
      setTimeout(() => {
        const pn = document.getElementById("pname");
        if (pn && !panel.hidden) pn.textContent = "taskgraf";
      }, 0);
      void refresh();
    } else {
      panel.hidden = true;
      stream.style.display = "";
      wrap && wrap.classList.remove("v-taskgraf");
    }
  });
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    if (panel.hidden || !last) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(last.g, last.now), 150);
  });
  window.addEventListener("hashchange", () => {
    if (!panel.hidden) void refresh();
  });

  // ---- 鍵：# の後ろからだけ読む。保存しない ----
  function readKey() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return "";
    return (new URLSearchParams(h).get("graph") || "").trim();
  }

  async function refresh() {
    const my = ++seq;
    const key = readKey();
    if (!key) {
      last = null;
      return show(msg("鍵がありません。ブックマークの URL の最後に「#graph=読むだけの鍵」を付けて開いてください（鍵は Mac の Keychain の handoff-graph-read-token）。"));
    }
    show(msg("取得中…"));
    let res;
    try {
      res = await fetch(GRAPH_URL, {
        method: "GET",
        headers: { authorization: "Bearer " + key },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (_) {
      if (my === seq) show(msg("handoff に届きませんでした（通信の失敗）。"));
      return;
    }
    if (my !== seq) return;
    if (res.status === 404) return show(msg("読めませんでした（鍵が違うか、読み取りの口が無効です）。"));
    if (!res.ok) return show(msg("handoff 側のエラーです（" + res.status + "）。"));
    let g;
    try {
      g = await res.json();
    } catch (_) {
      return show(msg("返ってきた中身を読めませんでした。"));
    }
    if (my !== seq) return;
    last = { g, now: new Date() };
    render(g, last.now);
  }

  function show(node) {
    panel.textContent = "";
    panel.appendChild(node);
  }
  function msg(text) {
    return el("div", "tg-msg", text);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }

  // ---- 観測ラベル（最終更新からの日数） ----
  function bucketOf(iso, now) {
    if (!iso) return "none";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "none";
    const days = Math.floor((now.getTime() - t) / DAY);
    return days <= 7 ? "a7" : days <= 30 ? "a30" : "a31";
  }
  function fmt(d) {
    const j = new Date(d.getTime() + 9 * 3600000); // 日本時間
    const p = (n) => String(n).padStart(2, "0");
    return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
  }
  const counts = (l) => {
    const t = l.tasks || {};
    const n = (k, s) => (t[k] && Number(t[k][s])) || 0;
    const kinds = ["main", "cleanup", "record", "other"];
    return {
      open: kinds.reduce((a, k) => a + n(k, "open"), 0),
      done: kinds.reduce((a, k) => a + n(k, "done"), 0),
      main: n("main", "open"), cleanup: n("cleanup", "open"), record: n("record", "open"),
    };
  };

  // ---- まとまり：/graph の group を明示データとして読む（推測では足さない。一覧・名前・並び順はこのファイルに持たない） ----
  // 返り値：catOf＝Map(レーン id → まとまり)／catList＝[{ key, label, uncat }]（描く順）／catError＝設定エラーの文。
  // 「未分類」は group が null のレーンだけ。同じ文字の名前のまとまりが登録されていても混ぜないよう、key を分けて持つ。
  const hasGroup = (l) => Object.prototype.hasOwnProperty.call(l, "group");
  function readGroups(lanes) {
    if (!lanes.some(hasGroup)) return { catOf: null, catList: null, catError: "" }; // まとまりを返さない /graph（最終更新の区分で描く）
    const bad = lanes.filter((l) => !hasGroup(l) || !(l.group === null || (typeof l.group === "string" && l.group !== "")));
    if (bad.length) return { catOf: null, catList: null, catError: `/graph のまとまり（group）を読めないレーンがあります：${bad.map((l) => l.id).join("・")}。` };
    const byName = new Map();
    for (const name of lanes.map((l) => l.group).filter((x) => x !== null).sort(byCodePoint)) {
      if (!byName.has(name)) byName.set(name, { key: "g:" + name, label: name, uncat: false });
    }
    const catList = [...byName.values()];
    const uncat = { key: "u", label: UNCAT, uncat: true };
    if (lanes.some((l) => l.group === null)) catList.push(uncat);
    const catOf = new Map(lanes.map((l) => [l.id, l.group === null ? uncat : byName.get(l.group)]));
    return { catOf, catList, catError: "" };
  }
  // 名前の並び：コードポイントの順（UTF-8 のバイト列の順と同じ）。正規化しない。localeCompare は使わない（環境で順が変わるため）
  function byCodePoint(a, b) {
    const x = [...a], y = [...b];
    for (let i = 0; i < x.length && i < y.length; i++) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d) return d;
    }
    return x.length - y.length;
  }

  // ---- 中心：待ち・依頼でつながるレーン。矢印の向きに上から下へ段を作り、段の中は左右に開く（中心は原点） ----
  function layoutCore(lanes, rels) {
    const ids = new Set(lanes.map((l) => l.id));
    const edges = rels.filter((r) => TYPE_LABEL[r.type] && ids.has(r.from) && ids.has(r.to) && r.from !== r.to);
    const linked = [...new Set(edges.flatMap((r) => [r.from, r.to]))].sort();
    const boxes = new Map();
    if (!linked.length) return { edges, boxes, hub: "", bounds: null };
    const degree = new Map();
    for (const r of edges) for (const id of [r.from, r.to]) degree.set(id, (degree.get(id) || 0) + 1);
    const hub = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const depth = new Map(linked.map((id) => [id, 0]));
    for (let k = 0; k < linked.length; k++) {
      let moved = false;
      for (const r of edges) {
        const want = depth.get(r.from) + 1;
        if (depth.get(r.to) < want && want < linked.length) { depth.set(r.to, want); moved = true; }
      }
      if (!moved) break;
    }
    const tiers = [];
    for (const id of linked) (tiers[depth.get(id)] ||= []).push(id);
    const size = (id) => (id === hub ? HUB : CORE);
    let y = 0;
    for (const tier of tiers.filter(Boolean)) {
      const total = tier.reduce((s, id) => s + size(id).w, 0) + (tier.length - 1) * CORE_GAP;
      const th = Math.max(...tier.map((id) => size(id).h));
      let x = -total / 2;
      for (const id of tier) { const s = size(id); boxes.set(id, { x, y: y + (th - s.h) / 2, w: s.w, h: s.h }); x += s.w + CORE_GAP; }
      y += th + TIER_GAP;
    }
    const bs = [...boxes.values()];
    const minX = Math.min(...bs.map((b) => b.x)), maxX = Math.max(...bs.map((b) => b.x + b.w));
    const minY = Math.min(...bs.map((b) => b.y)), maxY = Math.max(...bs.map((b) => b.y + b.h));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (const b of bs) { b.x -= cx; b.y -= cy; }
    return { edges, boxes, hub, bounds: { x: minX - cx, y: minY - cy, w: maxX - minX, h: maxY - minY } };
  }

  // カードの辺から辺へ（上下に離れていれば上下の辺、左右に離れていれば左右の辺）。a・b は {x, y, w, h}
  function route(a, b) {
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = bc.x - ac.x, dy = bc.y - ac.y;
    let p1, p2, c1, c2;
    if (Math.abs(dy) - (a.h + b.h) / 4 >= Math.abs(dx) - (a.w + b.w) / 4) {
      const s = dy >= 0 ? 1 : -1;
      p1 = { x: ac.x, y: ac.y + (s * a.h) / 2 };
      p2 = { x: bc.x, y: bc.y - (s * b.h) / 2 - s * 6 };
      const k = Math.max(30, Math.abs(p2.y - p1.y) / 2);
      c1 = { x: p1.x, y: p1.y + s * k }; c2 = { x: p2.x, y: p2.y - s * k };
    } else {
      const s = dx >= 0 ? 1 : -1;
      p1 = { x: ac.x + (s * a.w) / 2, y: ac.y };
      p2 = { x: bc.x - (s * b.w) / 2 - s * 6, y: bc.y };
      const k = Math.max(30, Math.abs(p2.x - p1.x) / 2);
      c1 = { x: p1.x + s * k, y: p1.y }; c2 = { x: p2.x - s * k, y: p2.y };
    }
    const m = (t) => { const u = 1 - t; return {
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y }; };
    return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, mid: m(0.5) };
  }

  // 文字の幅のめやす（配置の重なり計算に使う。英数字は 0.6em、全角は 1em）
  const textW = (s, px) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.6) * px, 0);
  const laneW = (l) => 12 + 8 + 6 + textW(l.id, 12.5) + 6 + textW(String(counts(l).open), 10.5) + 12;

  // ---- まとまりとレーン：左右に分け、まとまりを半円を描くように縦に並べ、レーンを外向きに扇状に出す ----
  // cats：[{ key, label, color, lanes:[lane] }]。返り値：まとまりの位置（cats に書き込む）と、レーンの位置 Map(id → { x, y, side, w })
  function layoutMind(cats, core, narrow) {
    const right = [], left = [];
    let sumR = 0, sumL = 0;
    [...cats].map((c, i) => ({ c, i })).sort((a, b) => b.c.lanes.length - a.c.lanes.length || a.i - b.i).forEach((o) => {
      if (sumR <= sumL) { right.push(o); sumR += o.c.lanes.length + 1; } else { left.push(o); sumL += o.c.lanes.length + 1; }
    });
    const byIndex = (a, b) => a.i - b.i; // 各側の中は並びの順（上から下）
    const pos = new Map();
    const coreHW = core ? core.w / 2 : 40;
    const X0 = coreHW + (narrow ? 40 : 110); // まとまりの列の基準（中心からの距離）
    const BULGE = narrow ? 24 : 90; // 真ん中のまとまりほど外へ（半円）
    const placeSide = (list, s) => {
      const blocks = list.sort(byIndex).map(({ c }) => ({ c, h: Math.max(46, c.lanes.length * LANE_H) + 22 }));
      const total = blocks.reduce((a, b) => a + b.h, 0);
      const half = total / 2 + 40;
      let y = -total / 2;
      for (const { c, h } of blocks) {
        const cy = y + h / 2;
        const cw = textW(c.label, 13) + textW(String(c.lanes.length), 11) + 7 + 26;
        const cx = s * (X0 + cw / 2 + BULGE * Math.sqrt(Math.max(0, 1 - (cy / half) ** 2)));
        Object.assign(c, { x: cx, y: cy, w: cw, side: s });
        const n = c.lanes.length, mid = (n - 1) / 2;
        c.lanes.forEach((l, k) => {
          const fan = n > 1 ? 1 - Math.abs(k - mid) / (mid + 1) : 1; // 真ん中のレーンほど少し外へ（扇）
          pos.set(l.id, { x: cx + s * (cw / 2 + 58 + 28 * fan), y: cy + (k - mid) * LANE_H, side: s, w: laneW(l) });
        });
        y += h;
      }
    };
    placeSide(right, 1);
    placeSide(left, -1);
    return pos;
  }

  // ---- 描画 ----
  function render(g, now) {
    const lanes = Array.isArray(g.lanes) ? g.lanes : [];
    const rels = Array.isArray(g.relations) ? g.relations : [];
    const byId = new Map(lanes.map((l) => [l.id, l]));
    const { catOf, catList, catError } = readGroups(lanes);
    panel.textContent = "";

    const bar = el("div", "tg-bar");
    const view = el("div", "tg-view");
    const dots = el("div", "tg-dots");
    view.appendChild(dots);
    panel.append(bar, view);
    const narrow = (view.clientWidth || panel.clientWidth || window.innerWidth || 0) < 700;

    // 中心（待ち・依頼でつながるレーン）と、まとまり→レーン
    const core = layoutCore(lanes, rels);
    const rest = lanes.filter((l) => !core.boxes.has(l.id))
      .sort((a, b) => (Date.parse(b.last_activity_at || 0) || 0) - (Date.parse(a.last_activity_at || 0) || 0) || a.id.localeCompare(b.id));
    const groups = [];
    if (catOf) {
      catList.forEach((c, i) => { // 色は並びの順で振る（まとまりの名前の集合が変わらない限り、開くたびに同じ色と位置）
        const ls = rest.filter((l) => catOf.get(l.id) === c);
        if (ls.length) groups.push({ key: "cat:" + c.key, label: c.label, color: c.uncat ? "#9aa1b2" : PALETTE[i % PALETTE.length], lanes: ls });
      });
    } else {
      for (const [key, label, color] of BUCKETS) {
        const ls = rest.filter((l) => bucketOf(l.last_activity_at, now) === key);
        if (ls.length) groups.push({ key, label, color, lanes: ls });
      }
    }
    const lanePos = layoutMind(groups, core.bounds, narrow);
    const boxOf = (id) => {
      if (core.boxes.has(id)) return core.boxes.get(id);
      const p = lanePos.get(id);
      if (!p) return null;
      return { x: p.side > 0 ? p.x - 10 : p.x + 10 - p.w, y: p.y - 14, w: p.w, h: 28, side: p.side };
    };

    // 上の細い2行
    const l1 = el("div", "tg-l1");
    const s1 = el("span");
    s1.append("取得 ", el("b", null, fmt(now)), "・レーン ", el("b", null, String(lanes.length)), "・待ち／依頼 ", el("b", null, String(core.edges.length)));
    const info = el("span", "tg-info", "ⓘ 線は登録済みのものだけ・漏れはありうる");
    info.title = g.note || "線は relation 表に open で明示登録された関係だけ。登録漏れはありうる。";
    l1.append(s1, info);
    const legend = el("div", "tg-legend");
    for (const [, label, color] of BUCKETS) {
      const s = el("span");
      const dot = el("i");
      dot.style.background = color;
      s.append(dot, label);
      legend.appendChild(s);
    }
    for (const [type, label] of Object.entries(TYPE_LABEL)) {
      const s = el("span");
      const ic = svg("svg", { width: 20, height: 8 });
      ic.appendChild(svg("line", { x1: 1, y1: 4, x2: 19, y2: 4, style: `stroke:${REL};stroke-width:2${type === "requests" ? ";stroke-dasharray:4 3" : ""}` }));
      s.append(ic, label);
      legend.appendChild(s);
    }
    {
      const s = el("span");
      const ic = svg("svg", { width: 20, height: 8 });
      ic.appendChild(svg("line", { x1: 1, y1: 4, x2: 19, y2: 4, style: "stroke:rgba(170,176,200,.5);stroke-width:1" }));
      s.append(ic, catOf ? "所属（確認済みのまとまり）" : "所属（最終更新の区分）");
      legend.appendChild(s);
    }
    {
      const s = el("span");
      const dot = el("i");
      dot.style.background = SEL;
      s.append(dot, "選択中");
      legend.appendChild(s);
    }
    bar.append(l1, legend);
    if (catError) bar.appendChild(el("div", "tg-err", `設定エラー：${catError}直すまで、まとまりは描かずに最終更新の区分で描いています。`));

    const world = el("div", "tg-world");
    view.appendChild(world);
    const halo = (cx, cy, w, h, color, a) => {
      const d = el("div", "tg-halo");
      Object.assign(d.style, { left: cx - w / 2 + "px", top: cy - h / 2 + "px", width: w + "px", height: h + "px",
        background: `radial-gradient(ellipse at center, ${color}${a} 0%, transparent 70%)` });
      world.appendChild(d);
    };
    if (core.bounds) halo(0, 0, core.bounds.w + 260, core.bounds.h + 200, SEL, "24");
    for (const c of groups) halo(c.x, c.y, c.w + 150, 120, c.color, "1a");

    // 枝（所属を見せる構造）：中心→まとまり、まとまり→レーン。細く薄く、矢印なし
    const branches = svg("svg", { class: "tg-svg branches" });
    world.appendChild(branches);
    const coreHW = core.bounds ? core.bounds.w / 2 : 0, coreHH = core.bounds ? core.bounds.h / 2 : 0;
    const curve = (x1, y1, x2, y2) => { const k = (x2 - x1) * 0.5; return `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`; };
    for (const c of groups) {
      const s = c.side;
      const sy = Math.max(-coreHH * 0.6, Math.min(coreHH * 0.6, c.y * 0.25));
      branches.appendChild(svg("path", { class: "tg-br", d: curve(s * (coreHW + 6), sy, c.x - (s * c.w) / 2, c.y), fill: "none", style: "stroke:rgba(170,160,235,.28);stroke-width:1.5" }));
      for (const l of c.lanes) {
        const p = lanePos.get(l.id);
        branches.appendChild(svg("path", { class: "tg-br", d: curve(c.x + (s * c.w) / 2, c.y, p.x - s * 7, p.y), fill: "none", style: `stroke:${c.color}5e;stroke-width:1.1` }));
      }
    }

    // 待ち・依頼の線（この地図で一番強い線）。ほかの意味の線を描く経路は持たない
    const edgeLayer = svg("svg", { class: "tg-svg edges" });
    const defs = svg("defs", {});
    for (const [id, color] of [["n", REL], ["h", REL_HI]]) {
      const mk = svg("marker", { id: "tg-head-" + id, viewBox: "0 0 12 12", refX: 9, refY: 6, markerWidth: 15, markerHeight: 15, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" });
      mk.appendChild(svg("path", { d: "M1,1.5 L11,6 L1,10.5 z", style: `fill:${color}` }));
      defs.appendChild(mk);
    }
    edgeLayer.appendChild(defs);
    world.appendChild(edgeLayer);
    const lines = [];
    for (const r of core.edges) {
      const a = core.boxes.get(r.from), b = core.boxes.get(r.to);
      if (!a || !b) continue;
      const { d, mid } = route(a, b);
      const dash = r.type === "requests" ? ";stroke-dasharray:9 7" : "";
      const path = svg("path", { class: "tg-rel", d, fill: "none", "marker-end": "url(#tg-head-n)", style: `stroke:${REL};stroke-width:3.6;stroke-linecap:round${dash}` });
      const text = TYPE_LABEL[r.type];
      const w = 20 + text.length * 13;
      const chip = svg("rect", { x: mid.x - w / 2, y: mid.y - 12, width: w, height: 24, rx: 12, style: "fill:#1a1b33;stroke:rgba(180,169,255,.7);stroke-width:1.2" });
      const t = svg("text", { x: mid.x, y: mid.y + 4.5, "text-anchor": "middle", style: "fill:#f0edff;font-size:12.5px;font-weight:700;font-family:var(--ui)" });
      t.textContent = text;
      edgeLayer.append(path, chip, t);
      lines.push({ r, path, chip, t, dash });
    }

    // まとまりのノード（中間の層）
    for (const c of groups) {
      const n = el("div", "tg-cat", c.label);
      n.dataset.group = c.key;
      n.appendChild(el("span", "cnt", String(c.lanes.length)));
      Object.assign(n.style, { left: c.x + "px", top: c.y + "px", color: c.color, borderColor: c.color + "66", background: c.color + "1a" });
      world.appendChild(n);
    }

    // レーンのノード：中心も葉も「● 名前 未完了数」（拡大時は「状態・未完了数」の行）。四角い背景・枠は描かない
    const items = new Map();
    for (const l of lanes) {
      const bk = BUCKET[bucketOf(l.last_activity_at, now)];
      const n = counts(l);
      const isCore = core.boxes.has(l.id);
      const p = isCore ? null : lanePos.get(l.id);
      if (!isCore && !p) continue;
      const it = el("div", isCore ? "tg-node core" + (l.id === core.hub ? " hub" : "") : "tg-node leaf " + (p.side > 0 ? "side-r" : "side-l"));
      it.dataset.lane = l.id;
      it.setAttribute("role", "button");
      it.setAttribute("tabindex", "0");
      it.setAttribute("aria-label", `${l.id}・${bk.label}・未完了 ${n.open}`);
      it.title = `${l.id}｜${bk.label}・未完了 ${n.open}`;
      it.style.setProperty("--tg-c", bk.color);
      const open = el("span", "tg-open", isCore ? `未完了 ${n.open}` : String(n.open));
      if (isCore) {
        const b = core.boxes.get(l.id); // 文字の範囲の真ん中に置く（矢印はこの範囲の辺から出入りする）
        Object.assign(it.style, { left: b.x + b.w / 2 + "px", top: b.y + b.h / 2 + "px" });
      } else {
        Object.assign(it.style, { left: p.x + "px", top: p.y + "px" });
      }
      it.append(el("span", "tg-dot"), el("span", "tg-name", l.id), open, el("div", "tg-nst", `${bk.label} · 未完了 ${n.open}`));
      world.appendChild(it);
      items.set(l.id, it);
    }

    // 詳細カード（選んだレーンだけ）とボタン
    const pane = el("div", "tg-pane");
    pane.hidden = true;
    view.appendChild(pane);
    const ctrl = el("div", "tg-ctrl");
    const bFit = el("button", null, "全体");
    const bIn = el("button", null, "＋");
    const bOut = el("button", null, "−");
    bFit.setAttribute("aria-label", "全体を表示");
    bIn.setAttribute("aria-label", "拡大");
    bOut.setAttribute("aria-label", "縮小");
    ctrl.append(bFit, bIn, bOut);
    view.appendChild(ctrl);

    // ---- 拡大・移動と、拡大の度合いで中身を変える（semantic zoom） ----
    let tx = 0, ty = 0, sc = 1, selected = "", nearSel = new Set(), paneSide = 1;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const vw = () => view.clientWidth || window.innerWidth || 390;
    const vh = () => view.clientHeight || 600;
    const apply = () => {
      world.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`;
      const bg = Math.max(12, 24 * sc);
      dots.style.backgroundSize = `${bg}px ${bg}px`;
      dots.style.backgroundPosition = `${tx}px ${ty}px`;
      world.classList.toggle("zmin", sc < 0.6); // 小さく見る時は、名前だけに
      world.classList.toggle("z1", sc >= 1.5); // 大きく拡大すると「状態・未完了数」の行
      placePane();
    };
    const zoomAt = (f, cx, cy) => {
      const ns = clamp(sc * f, 0.15, 3);
      tx = cx - ((cx - tx) * ns) / sc;
      ty = cy - ((cy - ty) * ns) / sc;
      sc = ns;
      apply();
    };
    const allBounds = () => {
      const bs = [...core.boxes.values()];
      for (const id of lanePos.keys()) bs.push(boxOf(id));
      for (const c of groups) bs.push({ x: c.x - c.w / 2, y: c.y - 16, w: c.w, h: 32 });
      if (core.bounds) bs.push({ x: core.bounds.x, y: core.bounds.y - 20, w: core.bounds.w, h: core.bounds.h + 40 });
      if (!bs.length) return { x: 0, y: 0, w: 1, h: 1 };
      const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
      return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
    };
    const fitAll = () => {
      const b = allBounds();
      sc = clamp(Math.min((vw() - 40) / b.w, (vh() - 50) / b.h), 0.15, 1.15);
      tx = (vw() - b.w * sc) / 2 - b.x * sc;
      ty = (vh() - b.h * sc) / 2 - b.y * sc;
      apply();
    };
    bFit.addEventListener("click", (e) => { e.stopPropagation(); fitAll(); });
    bIn.addEventListener("click", (e) => { e.stopPropagation(); zoomAt(1.25, vw() / 2, vh() / 2); });
    bOut.addEventListener("click", (e) => { e.stopPropagation(); zoomAt(0.8, vw() / 2, vh() / 2); });

    const pts = new Map();
    let moved = 0, downTarget = null, lastMid = null, lastDist = 0;
    const local = (e) => { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    view.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tg-ctrl") || e.target.closest(".tg-pane")) return;
      view.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, local(e));
      if (pts.size === 1) { moved = 0; downTarget = e.target; }
      if (pts.size === 2) {
        const [p, q] = [...pts.values()];
        lastDist = Math.hypot(p.x - q.x, p.y - q.y);
        lastMid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        moved = 99;
      }
      view.classList.add("grab");
    });
    view.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId), cur = local(e);
      pts.set(e.pointerId, cur);
      if (pts.size >= 2) {
        const [p, q] = [...pts.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        if (lastDist > 0) zoomAt(dist / lastDist, mid.x, mid.y);
        tx += mid.x - lastMid.x; ty += mid.y - lastMid.y;
        apply();
        lastDist = dist; lastMid = mid;
      } else {
        tx += cur.x - prev.x; ty += cur.y - prev.y;
        moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
        apply();
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size === 1) { lastDist = 0; return; }
      if (pts.size) return;
      view.classList.remove("grab");
      if (moved < 6 && downTarget) {
        const c = downTarget.closest && downTarget.closest("[data-lane]");
        if (c) select(c.dataset.lane); else select("");
      }
      downTarget = null;
    };
    view.addEventListener("pointerup", up);
    view.addEventListener("pointercancel", up);
    view.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
      else { tx -= e.deltaX; ty -= e.deltaY; apply(); }
    }, { passive: false });
    view.addEventListener("keydown", (e) => {
      const c = e.target.closest && e.target.closest("[data-lane]");
      if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(c.dataset.lane); }
      if (e.key === "Escape") select("");
    });

    // ---- 選択：選んだレーンの点と名前を光らせ、直接つながる相手を次に、ほかを背景に（キャンバスに四角は出さない）。詳細は詳細カードで ----
    function select(id) {
      selected = id && byId.has(id) ? id : "";
      const near = new Set();
      for (const { r } of lines) if (selected && (r.from === selected || r.to === selected)) { near.add(r.from); near.add(r.to); }
      nearSel = near;
      world.classList.toggle("has-sel", !!selected);
      view.classList.toggle("sheet-open", narrow && !!selected); // スマホで詳細が出ている間は、ボタンを上へ逃がす
      items.forEach((it, k) => { it.classList.toggle("sel", k === selected); it.classList.toggle("rel", near.has(k) && k !== selected); });
      for (const k of lines) {
        const on = !!selected && (k.r.from === selected || k.r.to === selected);
        const off = !!selected && !on;
        k.path.setAttribute("style", `stroke:${on ? REL_HI : REL};stroke-width:${on ? 4.2 : 3.6};stroke-linecap:round;opacity:${off ? 0.25 : 1}${on ? ";filter:drop-shadow(0 0 3px rgba(139,123,255,.45))" : ""}${k.dash}`);
        k.path.setAttribute("marker-end", on ? "url(#tg-head-h)" : "url(#tg-head-n)");
        k.chip.setAttribute("opacity", off ? "0.3" : "1");
        k.t.setAttribute("opacity", off ? "0.3" : "1");
      }
      if (!selected) { pane.hidden = true; return; }
      openPane(selected);
      if (narrow) { // スマホ：選んだレーンと直接つながる相手を画面の上の方に収め、その下に詳細カードを出す
        const bs = [selected, ...near].map(boxOf).filter(Boolean);
        const l = Math.min(...bs.map((b) => b.x)), t = Math.min(...bs.map((b) => b.y));
        const r = Math.max(...bs.map((b) => b.x + b.w)), bt = Math.max(...bs.map((b) => b.y + b.h));
        sc = clamp(Math.min(Math.max(sc, 0.7), (vw() - 24) / (r - l), (vh() * 0.4) / (bt - t)), 0.3, 1.2);
        tx = vw() / 2 - ((l + r) / 2) * sc;
        ty = 78 - t * sc;
        apply();
        return;
      }
      // PC：「選んだレーン＋直接つながる相手＋詳細カード」の3つが重ならずに画面に入るようにする。
      // 詳細カードは相手を含めた範囲の外側（左側のレーンなら左）に置く。まず動かす（pan）だけで収め、
      // それで入らない時だけ、必要な分だけ縮小する。詳細カードの幅は変えない。閉じても倍率は戻さない
      const M = 10, GAP = 16, W = Math.min(PANE_W, vw() - 20);
      const bs = memberRects();
      const g = { l: Math.min(...bs.map((b) => b.x)), t: Math.min(...bs.map((b) => b.y)), r: Math.max(...bs.map((b) => b.x + b.w)), b: Math.max(...bs.map((b) => b.y + b.h)) };
      const pref = ((boxOf(selected) || {}).side || 1) < 0 ? -1 : 1;
      const room = (s) => (g.r - g.l) * s + GAP + W <= vw() - 2 * M && (g.b - g.t) * s <= vh() - 2 * M;
      if (!room(sc)) { // 入らない時だけ、範囲の真ん中を基準に必要な分だけ縮小
        const ns = clamp(Math.min(sc, (vw() - 2 * M - GAP - W) / Math.max(1, g.r - g.l), (vh() - 2 * M) / Math.max(1, g.b - g.t)), 0.15, 3);
        const mx = ((g.l + g.r) / 2) * sc + tx, my = ((g.t + g.b) / 2) * sc + ty;
        tx = mx - ((g.l + g.r) / 2) * ns;
        ty = my - ((g.t + g.b) / 2) * ns;
        sc = ns;
      }
      const L = g.l * sc + tx, R = g.r * sc + tx;
      const okR = L >= M && R + GAP + W <= vw() - M, okL = L - GAP - W >= M && R <= vw() - M;
      if (pref > 0 ? okR : okL) paneSide = pref;
      else if (pref > 0 ? okL : okR) paneSide = -pref;
      else { // どちらにも入らなければ、外側に入るところまで動かす
        paneSide = pref;
        if (pref > 0) tx += R + GAP + W > vw() - M ? vw() - M - (R + GAP + W) : L < M ? M - L : 0;
        else tx += L - GAP - W < M ? M - (L - GAP - W) : R > vw() - M ? vw() - M - R : 0;
      }
      const T = g.t * sc + ty, B = g.b * sc + ty;
      if (T < M) ty += M - T; else if (B > vh() - M) ty -= B - (vh() - M);
      apply();
    }
    function memberRects() { // 選んだレーンと直接つながる相手の、実際に描かれている文字の範囲（world 座標。測れない時は配置の値）
      const v = view.getBoundingClientRect();
      return [selected, ...nearSel].map((id) => {
        const it = items.get(id), r = it ? it.getBoundingClientRect() : null;
        if (r && r.width && sc) return { x: (r.left - v.left - tx) / sc, y: (r.top - v.top - ty) / sc, w: r.width / sc, h: r.height / sc };
        return boxOf(id);
      }).filter(Boolean);
    }
    function groupRect() { // 選んだレーンと直接つながる相手を合わせた、画面の上の範囲
      const bs = memberRects();
      const l = Math.min(...bs.map((b) => b.x)), t = Math.min(...bs.map((b) => b.y));
      const r = Math.max(...bs.map((b) => b.x + b.w)), bt = Math.max(...bs.map((b) => b.y + b.h));
      return { left: l * sc + tx, top: t * sc + ty, right: r * sc + tx, bottom: bt * sc + ty };
    }

    // 詳細カードは選んだレーンに付いて動く。PC は「選んだレーン＋直接つながる相手」の外側、スマホは下
    function placePane() {
      if (pane.hidden || !selected) return;
      const b = boxOf(selected);
      if (!b) return;
      const sy = b.y * sc + ty, sh = b.h * sc;
      const W = Math.min(PANE_W, vw() - 20);
      pane.style.width = W + "px";
      if (narrow) {
        const top = Math.min(Math.max(70, groupRect().bottom + 12), vh() - 170); // 選んだレーンと相手の下から、画面の下まで（中はスクロール）
        pane.style.maxHeight = Math.max(160, vh() - top - 10) + "px";
        pane.style.left = (vw() - W) / 2 + "px";
        pane.style.top = top + "px";
        return;
      }
      pane.style.maxHeight = vh() - 20 + "px";
      const H = pane.offsetHeight || 380;
      const gb = groupRect(); // 開いた時に決めた側（paneSide）に、相手を含めた範囲から少し離して置く
      pane.style.left = (paneSide > 0 ? gb.right + 16 : gb.left - 16 - W) + "px";
      pane.style.top = clamp(sy + sh / 2 - H / 2, 10, Math.max(10, vh() - H - 10)) + "px";
    }

    // ---- 詳細：概要／関連／タスク／言及 ----
    function openPane(id) {
      const l = byId.get(id);
      const bk = BUCKET[bucketOf(l.last_activity_at, now)];
      const n = counts(l);
      const when = l.last_activity_at && !Number.isNaN(Date.parse(l.last_activity_at)) ? `（${fmt(new Date(Date.parse(l.last_activity_at)))} 更新）` : "";
      const mine = core.edges.filter((r) => r.from === id || r.to === id);
      const relText = mine.length ? mine.map((r) => (r.from === id ? `${r.to} ${TYPE_VERB[r.type]}` : `${r.from} から${TYPE_LABEL[r.type]}`)).join("／") : "なし";
      pane.textContent = "";
      const head = el("div", "tg-ph");
      const hd = el("span", "tg-dot");
      hd.style.background = bk.color;
      const tt = el("div");
      tt.append(el("h4", null, id), el("small", null, `最終更新 ${bk.label}${when}・未完了 ${n.open}`));
      const x = el("button", "tg-x", "閉じる");
      x.addEventListener("click", (e) => { e.stopPropagation(); select(""); });
      head.append(hd, tt, x);
      pane.appendChild(head);
      const sec = (title) => { const s = el("div", "tg-sec"); s.dataset.sec = title; s.appendChild(el("h5", null, title)); pane.appendChild(s); return s; };
      const kv = (pairs) => { const dl = el("dl", "tg-kv"); for (const [k, v] of pairs) dl.append(el("dt", null, k), el("dd", null, v)); return dl; };
      sec("概要").appendChild(kv([
        ["コンパス", l.compass || "（未設定）"],
        ["本丸", l.focus || "（未設定）"],
        ["タスク", `未完了 ${n.open}（main ${n.main}・cleanup ${n.cleanup}・record ${n.record}）／完了 ${n.done}`],
        ["最終更新", bk.label + when],
        ["待ち・依頼", relText],
        ...(catOf ? [["まとまり", catOf.get(id).label]] : []),
      ]));
      const rs = sec("関連");
      if (!mine.length) rs.appendChild(el("div", "tg-none", "待ち・依頼でつながるレーンはありません（登録済みの線だけ）。"));
      for (const r of mine) {
        const other = r.from === id ? r.to : r.from;
        const ol = byId.get(other);
        const ob = BUCKET[bucketOf(ol.last_activity_at, now)];
        const row = el("div", "tg-rl");
        const od = el("span", "tg-dot");
        od.style.background = ob.color;
        row.append(od, el("span", "tg-name", other), el("span", "tg-tag", r.from === id ? `${TYPE_LABEL[r.type]} →` : `← ${TYPE_LABEL[r.type]}`),
          el("span", "n", `未完了 ${counts(ol).open}`));
        row.addEventListener("click", (e) => { e.stopPropagation(); select(other); reveal(other); });
        rs.appendChild(row);
      }
      const ts = sec("タスク");
      const table = el("table", "tg-tt");
      const hr = el("tr");
      hr.append(el("th", null, "種類"), el("th", null, "未完了"), el("th", null, "完了"));
      table.appendChild(hr);
      const t = l.tasks || {};
      for (const k of ["main", "cleanup", "record", "other"]) {
        const o = (t[k] && Number(t[k].open)) || 0, d = (t[k] && Number(t[k].done)) || 0;
        if (k === "other" && !o && !d) continue;
        const tr = el("tr");
        tr.append(el("td", null, k), el("td", null, String(o)), el("td", null, String(d)));
        table.appendChild(tr);
      }
      ts.appendChild(table);
      sec("言及").appendChild(el("div", "tg-none", "このデータには言及が含まれていません。"));
      pane.hidden = false;
    }
    function reveal(id) { // 画面の外にあれば、そのレーンが見える所まで動かす
      const b = boxOf(id);
      if (!b) return;
      const sx = b.x * sc + tx, sy = b.y * sc + ty;
      if (sx < 10 || sy < 10 || sx + b.w * sc > vw() - 10 || sy + b.h * sc > vh() - 10) {
        tx = vw() / 2 - (b.x + b.w / 2) * sc;
        ty = vh() / 3 - (b.y + b.h / 2) * sc;
        apply();
      }
    }

    // ---- 最初の見え方 ----
    // PC：地図の全体（中心・まとまり・レーン）が画面いっぱいに収まる倍率。何も選ばずに開く。
    // スマホ：中心と、近くのまとまりがのぞく倍率。全体は「全体」で縮小して見る。
    if (narrow && core.bounds) {
      const span = 2 * ((core.bounds.w / 2) + 40 + 60); // 中心と、左右のいちばん近いまとまりの名前がのぞく幅
      sc = clamp((vw() - 16) / span, 0.45, 1.0);
      tx = vw() / 2;
      ty = vh() * 0.42;
      apply();
    } else fitAll();
  }
})();
