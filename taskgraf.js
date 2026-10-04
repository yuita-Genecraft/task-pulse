// taskgraf — Task Pulse の3つ目のタブ。handoff の GET /graph を、タブを開くたびに読み直して、
// Obsidian のキャンバスのような図（カード・グループの枠・曲線の矢印・指で拡大と移動）で描く。
//
// 守っていること（設計メモ taskgraf v0.2〜v0.3・ChatGPT レビュー済み）
// - 外部の JavaScript は読み込まない。このファイルと index.html だけで描く（カードは HTML、線は SVG）。
// - 読むだけの鍵は、ブックマークの URL の # の後ろ（#graph=…）にだけ置く。localStorage など
//   どこにも保存しない（github.io の同じ住所の別ページから読めるため）。console にも出さない。
// - 鍵は Authorization ヘッダーで固定の送り先にだけ送る（送り先は差し替えられない）。
// - タブを開くたびに取り直す（キャッシュしない）。開いたままの自動更新はしない。取得時刻を出す。
// - 線は handoff に明示登録された open の関係だけ。「漏れはありうる」と必ず出す。
// - 最終更新は「動いている／止まっている」と名乗らず、観測のラベルで出す。
// - 配置は開くたびに自動で計算し、保存しない。カードの追加や線を引く編集はしない。
(() => {
  "use strict";
  const GRAPH_URL = "https://handoff-mcp.gooooerer.workers.dev/graph";
  const VIEW = "taskgraf";
  const DAY = 86400000;
  const TYPE_LABEL = { waits_on: "待ち", requests: "依頼" };
  const TYPE_VERB = { waits_on: "を待っている", requests: "に頼んでいる" };
  const BUCKETS = [
    ["a7", "7日以内に更新あり", "var(--done)", "rgba(70,210,127,.06)"],
    ["a30", "8〜30日更新なし", "var(--accent)", "rgba(245,165,36,.06)"],
    ["a31", "31日以上更新なし", "var(--late)", "rgba(244,112,122,.06)"],
    ["none", "記録前", "var(--faint)", "rgba(88,96,115,.08)"],
  ];
  const BUCKET = Object.fromEntries(BUCKETS.map(([k, label, color, fill]) => [k, { label, color, fill }]));
  const LINKED = { label: "線でつながるレーン", color: "var(--prog)", fill: "rgba(90,160,242,.07)" };
  const CW = 200, CH = 132, GX = 26, GY = 26, PAD = 26, LGAP = 96, GGAP = 72, TOP = 34;

  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;

  const css = document.createElement("style");
  css.textContent = `
  .tg-panel{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
  .tg-panel[hidden]{display:none}
  .wrap.v-taskgraf .pbar,.wrap.v-taskgraf .prow2,.wrap.v-taskgraf .tools,.wrap.v-taskgraf .paste{display:none}
  .tg-bar{flex:0 0 auto;padding:8px 14px 7px;font-size:11.5px;color:var(--muted);line-height:1.55;border-bottom:1px solid var(--line-soft)}
  .tg-bar b{color:var(--text);font-weight:600}
  .tg-note{color:var(--accent)}
  .tg-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:3px}
  .tg-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
  .tg-legend svg{vertical-align:middle;margin-right:3px}
  .tg-msg{margin:14px;font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;line-height:1.7}
  .tg-view{flex:1 1 auto;min-height:0;position:relative;overflow:hidden;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;
    background-color:var(--bg);background-image:radial-gradient(rgba(138,147,166,.22) 1px,transparent 1.2px);background-size:22px 22px}
  .tg-view.grab{cursor:grabbing}
  .tg-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
  .tg-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
  .tg-group{position:absolute;border:1.5px solid;border-radius:16px}
  .tg-glabel{position:absolute;left:-1px;top:-30px;font-size:13px;font-weight:600;padding:4px 11px;border-radius:9px;white-space:nowrap;color:#13161d}
  .tg-card{position:absolute;width:${CW}px;height:${CH}px;background:var(--surface);border:1px solid var(--line);border-radius:11px;
    padding:10px 12px 10px 15px;overflow:hidden;cursor:pointer;box-shadow:0 2px 0 rgba(0,0,0,.28)}
  .tg-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--tg-c)}
  .tg-card.sel{border-color:var(--tg-c);box-shadow:0 0 0 2px var(--tg-c)}
  .tg-row1{display:flex;align-items:center;justify-content:space-between;gap:6px}
  .tg-id{font-family:var(--mono);font-size:13px;font-weight:650;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tg-chip{flex:none;font-size:10px;line-height:1.5;border-radius:999px;padding:0 7px;border:1px solid var(--tg-c);color:var(--tg-c);white-space:nowrap}
  .tg-line{font-size:11.5px;color:var(--muted);line-height:1.45;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .tg-line b{color:var(--text);font-weight:600}
  .tg-count{position:absolute;left:15px;right:12px;bottom:8px;font-size:10.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tg-ctrl{position:absolute;right:12px;bottom:12px;display:flex;gap:6px;z-index:3}
  .tg-ctrl button{font:inherit;font-size:13px;min-width:40px;height:36px;padding:0 10px;color:var(--text);background:var(--surface-2);border:1px solid var(--line);border-radius:9px;cursor:pointer}
  .tg-sheet{position:absolute;left:10px;right:10px;bottom:10px;max-height:62%;overflow:auto;background:var(--surface);border:1px solid var(--line);
    border-radius:13px;padding:13px 15px 12px;z-index:4;box-shadow:0 10px 28px rgba(0,0,0,.5);user-select:text;-webkit-user-select:text;cursor:auto}
  .tg-sheet[hidden]{display:none}
  .tg-sheet h4{margin:0 64px 4px 0;font:650 14px/1.3 var(--mono);color:var(--text);word-break:break-all}
  .tg-sheet p{margin:7px 0;font-size:12.5px;color:var(--muted);line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .tg-sheet p b{color:var(--text);font-weight:600}
  .tg-sheet .x{position:absolute;right:10px;top:9px;font:inherit;font-size:12px;color:var(--text);background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
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

  // ---- 配置：線でつながるレーンは矢印の向きに段を作り、残りは最終更新の区分ごとの枠に並べる ----
  function layout(lanes, rels, now, narrow) {
    const ids = new Set(lanes.map((l) => l.id));
    const edges = rels.filter((r) => TYPE_LABEL[r.type] && ids.has(r.from) && ids.has(r.to) && r.from !== r.to);
    const linked = [...new Set(edges.flatMap((r) => [r.from, r.to]))].sort();
    const pos = new Map();
    const groups = [];
    let y = TOP;
    if (linked.length) {
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
      const tierList = tiers.filter(Boolean);
      const maxPer = Math.max(...tierList.map((t) => t.length));
      let w, h;
      if (narrow) { // 上から下へ
        w = 2 * PAD + maxPer * CW + (maxPer - 1) * GX;
        tierList.forEach((tier, i) => tier.forEach((id, j) => {
          const off = ((maxPer - tier.length) * (CW + GX)) / 2;
          pos.set(id, { x: PAD + off + j * (CW + GX), y: y + PAD + i * (CH + LGAP) });
        }));
        h = 2 * PAD + tierList.length * CH + (tierList.length - 1) * LGAP;
      } else { // 左から右へ
        w = 2 * PAD + tierList.length * CW + (tierList.length - 1) * LGAP;
        tierList.forEach((tier, i) => tier.forEach((id, j) => {
          const off = ((maxPer - tier.length) * (CH + GY)) / 2;
          pos.set(id, { x: PAD + i * (CW + LGAP), y: y + PAD + off + j * (CH + GY) });
        }));
        h = 2 * PAD + maxPer * CH + (maxPer - 1) * GY;
      }
      groups.push({ ...LINKED, label: `${LINKED.label}（${edges.length} 本）`, x: 0, y, w, h, kind: "linked" });
      y += h + GGAP;
    }
    const cols = narrow ? 2 : 4;
    const rest = lanes.filter((l) => !pos.has(l.id));
    for (const [key] of BUCKETS) {
      const list = rest
        .filter((l) => bucketOf(l.last_activity_at, now) === key)
        .sort((a, b) => (Date.parse(b.last_activity_at || 0) || 0) - (Date.parse(a.last_activity_at || 0) || 0) || a.id.localeCompare(b.id));
      if (!list.length) continue;
      const c = Math.min(cols, list.length);
      const rows = Math.ceil(list.length / c);
      list.forEach((l, i) => pos.set(l.id, { x: PAD + (i % c) * (CW + GX), y: y + PAD + Math.floor(i / c) * (CH + GY) }));
      const w = 2 * PAD + c * CW + (c - 1) * GX;
      const h = 2 * PAD + rows * CH + (rows - 1) * GY;
      groups.push({ ...BUCKET[key], label: `${BUCKET[key].label}（${list.length}）`, x: 0, y, w, h, kind: key });
      y += h + GGAP;
    }
    const width = Math.max(0, ...groups.map((g) => g.x + g.w));
    return { pos, groups, edges, bounds: { x: 0, y: 0, w: width, h: Math.max(0, y - GGAP) } };
  }

  // カードの辺から辺へ。横に離れていれば左右の辺、縦に離れていれば上下の辺をつなぐ
  function route(a, b) {
    const ac = { x: a.x + CW / 2, y: a.y + CH / 2 };
    const bc = { x: b.x + CW / 2, y: b.y + CH / 2 };
    const dx = bc.x - ac.x;
    const dy = bc.y - ac.y;
    let p1, p2, c1, c2;
    if (Math.abs(dx) - CW / 2 >= Math.abs(dy) - CH / 2) {
      const s = dx >= 0 ? 1 : -1;
      p1 = { x: ac.x + (s * CW) / 2, y: ac.y };
      p2 = { x: bc.x - (s * CW) / 2 - s * 3, y: bc.y };
      const k = Math.max(36, Math.abs(p2.x - p1.x) / 2);
      c1 = { x: p1.x + s * k, y: p1.y };
      c2 = { x: p2.x - s * k, y: p2.y };
    } else {
      const s = dy >= 0 ? 1 : -1;
      p1 = { x: ac.x, y: ac.y + (s * CH) / 2 };
      p2 = { x: bc.x, y: bc.y - (s * CH) / 2 - s * 3 };
      const k = Math.max(36, Math.abs(p2.y - p1.y) / 2);
      c1 = { x: p1.x, y: p1.y + s * k };
      c2 = { x: p2.x, y: p2.y - s * k };
    }
    const m = (t) => {
      const u = 1 - t;
      return {
        x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
        y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
      };
    };
    return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, mid: m(0.5) };
  }

  // ---- 描画 ----
  function render(g, now) {
    const lanes = Array.isArray(g.lanes) ? g.lanes : [];
    const rels = Array.isArray(g.relations) ? g.relations : [];
    panel.textContent = "";

    const bar = el("div", "tg-bar");
    const L = layout(lanes, rels, now, false);
    bar.append("取得 ", el("b", null, fmt(now)), "（開くたびに取り直す）・レーン ", el("b", null, String(lanes.length)),
      "・線 ", el("b", null, String(L.edges.length)), "　", el("span", "tg-note", g.note || "線は登録済みのものだけ。漏れはありうる。"));
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
      const ic = svg("svg", { width: 22, height: 8 });
      ic.appendChild(svg("line", { x1: 1, y1: 4, x2: 21, y2: 4, style: `stroke:${type === "waits_on" ? "var(--prog)" : "var(--accent)"};stroke-width:1.6${type === "requests" ? ";stroke-dasharray:4 3" : ""}` }));
      s.append(ic, label);
      legend.appendChild(s);
    }
    bar.appendChild(legend);
    panel.appendChild(bar);

    const view = el("div", "tg-view");
    panel.appendChild(view);
    const narrow = (view.clientWidth || panel.clientWidth || window.innerWidth || 0) < 700;
    const lay = narrow ? layout(lanes, rels, now, true) : L;
    const world = el("div", "tg-world");
    view.appendChild(world);
    const byId = new Map(lanes.map((l) => [l.id, l]));

    for (const gr of lay.groups) {
      const box = el("div", "tg-group");
      box.dataset.group = gr.kind;
      Object.assign(box.style, { left: gr.x + "px", top: gr.y + "px", width: gr.w + "px", height: gr.h + "px", borderColor: gr.color, background: gr.fill });
      const lab = el("div", "tg-glabel", gr.label);
      lab.style.background = gr.color;
      box.appendChild(lab);
      world.appendChild(box);
    }

    const edgeLayer = svg("svg", { class: "tg-edges", width: Math.max(1, lay.bounds.w), height: Math.max(1, lay.bounds.h) });
    const defs = svg("defs", {});
    for (const [type, color] of [["waits_on", "var(--prog)"], ["requests", "var(--accent)"]]) {
      const mk = svg("marker", { id: "tg-head-" + type, viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
      mk.appendChild(svg("path", { d: "M1,1 L9,5 L1,9 z", style: `fill:${color}` }));
      defs.appendChild(mk);
    }
    edgeLayer.appendChild(defs);
    world.appendChild(edgeLayer);

    const cards = new Map();
    for (const l of lanes) {
      const p = lay.pos.get(l.id);
      if (!p) continue;
      const bk = BUCKET[bucketOf(l.last_activity_at, now)];
      const c = el("div", "tg-card");
      c.dataset.lane = l.id;
      c.style.left = p.x + "px";
      c.style.top = p.y + "px";
      c.style.setProperty("--tg-c", bk.color);
      const r1 = el("div", "tg-row1");
      r1.append(el("span", "tg-id", l.id), el("span", "tg-chip", bk.label));
      const comp = el("div", "tg-line");
      comp.append(el("b", null, "コンパス "), l.compass || "");
      const foc = el("div", "tg-line");
      foc.append(el("b", null, "本丸 "), l.focus || "（未設定）");
      const n = counts(l);
      c.append(r1, comp, foc, el("div", "tg-count", `未完了 ${n.open}・完了 ${n.done}`));
      world.appendChild(c);
      cards.set(l.id, c);
    }

    for (const r of lay.edges) {
      const a = lay.pos.get(r.from);
      const b = lay.pos.get(r.to);
      if (!a || !b) continue;
      const { d, mid } = route(a, b);
      const color = r.type === "waits_on" ? "var(--prog)" : "var(--accent)";
      edgeLayer.appendChild(svg("path", {
        class: "tg-edge", d, fill: "none", "marker-end": `url(#tg-head-${r.type})`,
        style: `stroke:${color};stroke-width:2${r.type === "requests" ? ";stroke-dasharray:6 5" : ""}`,
      }));
      const label = TYPE_LABEL[r.type];
      const w = 12 + label.length * 13;
      edgeLayer.appendChild(svg("rect", { x: mid.x - w / 2, y: mid.y - 11, width: w, height: 22, rx: 7, style: `fill:var(--bg);stroke:${color};stroke-width:1` }));
      const t = svg("text", { x: mid.x, y: mid.y + 4.5, "text-anchor": "middle", style: `fill:${color};font-size:12px;font-weight:600;font-family:var(--ui)` });
      t.textContent = label;
      edgeLayer.appendChild(t);
    }

    const sheet = el("div", "tg-sheet");
    sheet.hidden = true;
    view.appendChild(sheet);
    const ctrl = el("div", "tg-ctrl");
    const bFit = el("button", null, "全体");
    const bIn = el("button", null, "＋");
    const bOut = el("button", null, "−");
    bFit.setAttribute("aria-label", "全体を表示");
    bIn.setAttribute("aria-label", "拡大");
    bOut.setAttribute("aria-label", "縮小");
    ctrl.append(bFit, bIn, bOut);
    view.appendChild(ctrl);

    // ---- 拡大・移動 ----
    let tx = 0, ty = 0, sc = 1;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const apply = () => {
      world.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`;
      view.style.backgroundPosition = `${tx}px ${ty}px`;
      view.style.backgroundSize = `${22 * sc}px ${22 * sc}px`;
    };
    const zoomAt = (f, cx, cy) => {
      const ns = clamp(sc * f, 0.15, 2.5);
      tx = cx - ((cx - tx) * ns) / sc;
      ty = cy - ((cy - ty) * ns) / sc;
      sc = ns;
      apply();
    };
    const vw = () => view.clientWidth || window.innerWidth || 390;
    const vh = () => view.clientHeight || 600;
    const fitAll = () => {
      const b = lay.bounds;
      sc = clamp(Math.min((vw() - 32) / Math.max(1, b.w), (vh() - 56) / Math.max(1, b.h)), 0.15, 1);
      tx = (vw() - b.w * sc) / 2;
      ty = 16;
      apply();
    };
    const fitWidth = () => { // 最初の見え方：横幅に合わせて、上（線でつながるレーン）から
      const b = lay.bounds;
      sc = clamp((vw() - 24) / Math.max(1, b.w), 0.4, 1);
      tx = (vw() - b.w * sc) / 2;
      ty = 12;
      apply();
    };
    fitWidth();
    bFit.addEventListener("click", (e) => { e.stopPropagation(); fitAll(); });
    bIn.addEventListener("click", (e) => { e.stopPropagation(); zoomAt(1.25, vw() / 2, vh() / 2); });
    bOut.addEventListener("click", (e) => { e.stopPropagation(); zoomAt(0.8, vw() / 2, vh() / 2); });

    const pts = new Map();
    let moved = 0, downTarget = null, lastMid = null, lastDist = 0;
    const local = (e) => {
      const r = view.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    view.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tg-ctrl") || e.target.closest(".tg-sheet")) return;
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
      const prev = pts.get(e.pointerId);
      const cur = local(e);
      pts.set(e.pointerId, cur);
      if (pts.size >= 2) {
        const [p, q] = [...pts.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        if (lastDist > 0) zoomAt(dist / lastDist, mid.x, mid.y);
        tx += mid.x - lastMid.x;
        ty += mid.y - lastMid.y;
        apply();
        lastDist = dist;
        lastMid = mid;
      } else {
        tx += cur.x - prev.x;
        ty += cur.y - prev.y;
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
        const c = downTarget.closest && downTarget.closest(".tg-card");
        if (c) openSheet(c.dataset.lane);
        else closeSheet();
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

    // ---- カードをタップすると下に全文 ----
    function openSheet(id) {
      const l = byId.get(id);
      if (!l) return;
      cards.forEach((c, k) => c.classList.toggle("sel", k === id));
      sheet.textContent = "";
      const x = el("button", "x", "閉じる");
      x.addEventListener("click", (e) => { e.stopPropagation(); closeSheet(); });
      const bk = BUCKET[bucketOf(l.last_activity_at, now)];
      const when = l.last_activity_at && !Number.isNaN(Date.parse(l.last_activity_at)) ? `（${fmt(new Date(Date.parse(l.last_activity_at)))} 更新）` : "";
      const n = counts(l);
      const p = (head, body) => {
        const e1 = el("p");
        e1.append(el("b", null, head + " "), body);
        return e1;
      };
      sheet.append(x, el("h4", null, l.id), p("最終更新", bk.label + when), p("コンパス", l.compass || ""), p("本丸", l.focus || "（未設定）"),
        p("タスク", `未完了 ${n.open}（main ${n.main}・cleanup ${n.cleanup}・record ${n.record}）／完了 ${n.done}`));
      const mine = lay.edges.filter((r) => r.from === id || r.to === id);
      if (mine.length) {
        sheet.appendChild(p("線", mine.map((r) => (r.from === id ? `${r.to} ${TYPE_VERB[r.type]}` : `${r.from} から${TYPE_LABEL[r.type]}`)).join("／")));
      }
      sheet.hidden = false;
    }
    function closeSheet() {
      sheet.hidden = true;
      cards.forEach((c) => c.classList.remove("sel"));
    }
  }
})();
