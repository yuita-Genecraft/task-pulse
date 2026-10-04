// taskgraf — Task Pulse の3つ目のタブ。handoff の GET /graph を、タブを開くたびに読み直して描く。
//
// 守っていること（設計メモ taskgraf v0.2〜v0.3・ChatGPT レビュー済み）
// - 外部の JavaScript は読み込まない。このファイルと index.html だけで描く（線は自前の SVG）。
// - 読むだけの鍵は、ブックマークの URL の # の後ろ（#graph=…）にだけ置く。localStorage など
//   どこにも保存しない（github.io の同じ住所の別ページから読めるため）。console にも出さない。
// - 鍵は Authorization ヘッダーで固定の送り先にだけ送る（送り先は差し替えられない）。
// - タブを開くたびに取り直す（キャッシュしない）。開いたままの自動更新はしない。取得時刻を出す。
// - 線は handoff に明示登録された open の関係だけ。「漏れはありうる」と必ず出す。
// - 最終更新は「動いている／止まっている」と名乗らず、観測のラベルで出す。
(() => {
  "use strict";
  const GRAPH_URL = "https://handoff-mcp.gooooerer.workers.dev/graph";
  const VIEW = "taskgraf";
  const DAY = 86400000;
  const TYPE_LABEL = { waits_on: "待ち", requests: "依頼" };

  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;

  // ---- 見た目（既存の色の変数をそのまま使う） ----
  const css = document.createElement("style");
  css.textContent = `
  .tg-panel{padding:4px 0 40px}
  .tg-panel[hidden]{display:none}
  .tg-meta{font-size:12px;color:var(--muted);line-height:1.6;margin:6px 2px 10px}
  .tg-meta b{color:var(--text);font-weight:600}
  .tg-note{color:var(--accent)}
  .tg-msg{font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--line);
    border-radius:10px;padding:12px 14px;line-height:1.7}
  .tg-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin:0 2px 8px}
  .tg-legend svg{vertical-align:middle;margin-right:4px}
  .tg-rels{font-size:12px;color:var(--text);margin:0 2px 10px;line-height:1.7}
  .tg-board{position:relative;padding-right:var(--tg-gutter,0px)}
  .tg-arcs{position:absolute;top:0;right:0;pointer-events:none;overflow:visible}
  .tg-card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 11px;
    margin:0 0 8px;cursor:pointer}
  .tg-card.linked{border-color:#33455e}
  .tg-row1{display:flex;align-items:center;gap:8px;justify-content:space-between}
  .tg-id{font-family:var(--mono);font-size:13px;color:var(--text);font-weight:600;word-break:break-all}
  .tg-chip{flex:none;font-size:10.5px;border-radius:999px;padding:2px 8px;border:1px solid currentColor;white-space:nowrap}
  .tg-c7{color:var(--done)} .tg-c30{color:var(--accent)} .tg-cold{color:var(--late)} .tg-cnone{color:var(--faint)}
  .tg-when{font-size:11px;color:var(--muted);margin-top:2px}
  .tg-line{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.55;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .tg-card.open .tg-line{-webkit-line-clamp:unset;display:block}
  .tg-line b{color:var(--text);font-weight:600}
  .tg-count{font-size:11.5px;color:var(--muted);margin-top:6px}
  .tg-sec{font-size:11px;color:var(--faint);margin:14px 2px 6px;letter-spacing:.04em}
  `;
  document.head.appendChild(css);

  // ---- タブとパネルを足す（既存のタブの処理には手を入れない） ----
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
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    if (b.dataset.view === VIEW) {
      stream.style.display = "none";
      panel.hidden = false;
      // 既存の処理（setView）が .on を付け替えるが、念のためこちらでも揃える
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
      void refresh();
    } else {
      panel.hidden = true;
      stream.style.display = "";
    }
  });
  panel.addEventListener("click", (e) => {
    const c = e.target.closest(".tg-card");
    if (!c) return;
    c.classList.toggle("open");
    drawArcs(); // 開くとカードの高さが変わるので、弧を引き直す
  });
  window.addEventListener("resize", () => {
    if (!panel.hidden) drawArcs();
  });

  // ---- 鍵：# の後ろからだけ読む。保存しない ----
  function readKey() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return "";
    return (new URLSearchParams(h).get("graph") || "").trim();
  }

  // ---- 取得 ----
  async function refresh() {
    const my = ++seq;
    const key = readKey();
    panel.textContent = "";
    if (!key) {
      panel.appendChild(msg("鍵がありません。ブックマークの URL の最後に「#graph=読むだけの鍵」を付けて開いてください（鍵は Mac の Keychain の handoff-graph-read-token）。"));
      return;
    }
    panel.appendChild(msg("取得中…"));
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
    render(g, new Date());
  }

  function show(node) {
    panel.textContent = "";
    panel.appendChild(node);
  }
  function msg(text) {
    const d = document.createElement("div");
    d.className = "tg-msg";
    d.textContent = text;
    return d;
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- 観測ラベル（最終更新からの日数） ----
  function activity(iso, now) {
    if (!iso) return { cls: "tg-cnone", label: "記録前", when: "この仕組みで記録を始める前から更新なし" };
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return { cls: "tg-cnone", label: "記録前", when: "" };
    const days = Math.floor((now.getTime() - t) / DAY);
    const when = fmt(new Date(t)) + " 更新";
    if (days <= 7) return { cls: "tg-c7", label: "7日以内に更新あり", when };
    if (days <= 30) return { cls: "tg-c30", label: "8〜30日更新なし", when };
    return { cls: "tg-cold", label: "31日以上更新なし", when };
  }
  function fmt(d) {
    // 表示は日本時間
    const j = new Date(d.getTime() + 9 * 3600000);
    const p = (n) => String(n).padStart(2, "0");
    return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
  }

  // ---- 並べ方：線でつながるレーンを上にまとめ、残りは新しい順（記録前は最後） ----
  function order(lanes, rels) {
    const ids = new Set(lanes.map((l) => l.id));
    const adj = new Map();
    for (const r of rels) {
      if (!ids.has(r.from) || !ids.has(r.to)) continue;
      for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) {
        if (!adj.has(a)) adj.set(a, new Set());
        adj.get(a).add(b);
      }
    }
    const byDegree = [...adj.keys()].sort((a, b) => adj.get(b).size - adj.get(a).size || a.localeCompare(b));
    const linked = [];
    const seen = new Set();
    for (const s of byDegree) {
      if (seen.has(s)) continue;
      const q = [s];
      seen.add(s);
      while (q.length) {
        const v = q.shift();
        linked.push(v);
        for (const w of [...adj.get(v)].sort()) if (!seen.has(w)) { seen.add(w); q.push(w); }
      }
    }
    const rest = lanes
      .filter((l) => !seen.has(l.id))
      .sort((a, b) => {
        const ta = a.last_activity_at ? Date.parse(a.last_activity_at) : -Infinity;
        const tb = b.last_activity_at ? Date.parse(b.last_activity_at) : -Infinity;
        return tb - ta || a.id.localeCompare(b.id);
      })
      .map((l) => l.id);
    return { linked, rest };
  }

  // ---- 描画 ----
  let current = null; // drawArcs 用：{ rels, cards: Map<id, element> }

  function render(g, now) {
    const lanes = Array.isArray(g.lanes) ? g.lanes : [];
    const rels = (Array.isArray(g.relations) ? g.relations : []).filter((r) => TYPE_LABEL[r.type]);
    const byId = new Map(lanes.map((l) => [l.id, l]));
    const { linked, rest } = order(lanes, rels);
    const shown = rels.filter((r) => byId.has(r.from) && byId.has(r.to));

    panel.textContent = "";
    const meta = el("div", "tg-meta");
    meta.append("取得 ", el("b", null, fmt(now)), "（開くたびに取り直し・開いたままでは更新しない）・レーン ",
      el("b", null, String(lanes.length)), " 本・線 ", el("b", null, String(shown.length)), " 本");
    meta.append(el("br"), el("span", "tg-note", g.note || "線は登録済みのものだけ。漏れはありうる。"));
    panel.appendChild(meta);

    const legend = el("div", "tg-legend");
    for (const [type, label] of Object.entries(TYPE_LABEL)) {
      const s = el("span");
      s.appendChild(legendSvg(type));
      s.append(label + "（矢印の先を" + (type === "waits_on" ? "待っている" : "頼んでいる") + "）");
      legend.appendChild(s);
    }
    panel.appendChild(legend);

    if (shown.length) {
      const list = el("div", "tg-rels");
      for (const r of shown) list.append(r.from + " → " + r.to + "（" + TYPE_LABEL[r.type] + "）", el("br"));
      panel.appendChild(list);
    }

    const board = el("div", "tg-board");
    const cards = new Map();
    const addCard = (id, isLinked) => {
      const l = byId.get(id);
      if (!l) return;
      const a = activity(l.last_activity_at, now);
      const c = el("div", "tg-card" + (isLinked ? " linked" : ""));
      c.dataset.lane = id;
      const r1 = el("div", "tg-row1");
      r1.append(el("span", "tg-id", id), el("span", "tg-chip " + a.cls, a.label));
      c.appendChild(r1);
      if (a.when) c.appendChild(el("div", "tg-when", a.when));
      const comp = el("div", "tg-line");
      comp.append(el("b", null, "コンパス "), l.compass || "");
      c.appendChild(comp);
      const foc = el("div", "tg-line");
      foc.append(el("b", null, "本丸 "), l.focus || "（未設定）");
      c.appendChild(foc);
      const t = l.tasks || {};
      const n = (k, s) => (t[k] && Number(t[k][s])) || 0;
      const open = n("main", "open") + n("cleanup", "open") + n("record", "open") + n("other", "open");
      const done = n("main", "done") + n("cleanup", "done") + n("record", "done") + n("other", "done");
      c.appendChild(el("div", "tg-count",
        `未完了 ${open}（main ${n("main", "open")}・cleanup ${n("cleanup", "open")}・record ${n("record", "open")}）／完了 ${done}`));
      board.appendChild(c);
      cards.set(id, c);
    };
    if (linked.length) board.appendChild(el("div", "tg-sec", "線でつながっているレーン"));
    linked.forEach((id) => addCard(id, true));
    if (rest.length) board.appendChild(el("div", "tg-sec", "ほかのレーン（最終更新の新しい順）"));
    rest.forEach((id) => addCard(id, false));
    panel.appendChild(board);

    current = { rels: shown, cards, board };
    requestAnimationFrame(drawArcs);
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }
  function marker(id, color) {
    const m = svgEl("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.appendChild(svgEl("path", { d: "M0,0 L8,4 L0,8 z", fill: color }));
    return m;
  }
  function stroke(type) {
    return type === "waits_on"
      ? { color: "var(--prog)", dash: "" }
      : { color: "var(--accent)", dash: "5 4" };
  }
  function legendSvg(type) {
    const s = stroke(type);
    const svg = svgEl("svg", { width: 34, height: 10 });
    const defs = svgEl("defs", {});
    defs.appendChild(marker("tg-lg-" + type, s.color));
    svg.appendChild(defs);
    svg.appendChild(svgEl("line", { x1: 2, y1: 5, x2: 30, y2: 5, stroke: s.color, "stroke-width": 1.6,
      "stroke-dasharray": s.dash, "marker-end": `url(#tg-lg-${type})` }));
    return svg;
  }

  // 右の余白に、つながるカード同士を弧で結ぶ（矢印は from → to）
  function drawArcs() {
    if (!current) return;
    const { rels, cards, board } = current;
    board.querySelectorAll(".tg-arcs").forEach((n) => n.remove());
    if (!rels.length) {
      board.style.setProperty("--tg-gutter", "0px");
      return;
    }
    const lane = 14;
    const gutter = 12 + lane * Math.min(rels.length, 6);
    board.style.setProperty("--tg-gutter", gutter + "px");
    const top = board.getBoundingClientRect().top;
    const svg = svgEl("svg", { class: "tg-arcs", width: gutter, height: board.scrollHeight || 1 });
    const defs = svgEl("defs", {});
    for (const type of Object.keys(TYPE_LABEL)) defs.appendChild(marker("tg-ar-" + type, stroke(type).color));
    svg.appendChild(defs);
    rels.forEach((r, i) => {
      const a = cards.get(r.from);
      const b = cards.get(r.to);
      if (!a || !b) return;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const y1 = ra.top - top + Math.min(22, ra.height / 2);
      const y2 = rb.top - top + Math.min(22, rb.height / 2);
      const x = 6 + lane * ((i % 6) + 1);
      const s = stroke(r.type);
      svg.appendChild(svgEl("path", {
        d: `M0,${y1} C${x},${y1} ${x},${y2} 2,${y2}`,
        fill: "none", stroke: s.color, "stroke-width": 1.6, "stroke-dasharray": s.dash,
        "marker-end": `url(#tg-ar-${r.type})`,
      }));
    });
    board.appendChild(svg);
  }

  window.addEventListener("hashchange", () => {
    if (!panel.hidden) void refresh();
  });
})();
