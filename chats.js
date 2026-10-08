// chats — Task Pulse の「チャット」タブ。handoff の GET /chats を、タブを開くたびに読み直し、
// 開いているチャットをレーンごとに並べて、それぞれを開くリンクを出す。
// タブを「何をやっていたかの置き場」にしないための一覧。ここから開き直せるので、ブラウザのタブは全部閉じてよい。
//
// 守っていること（taskgraf.js と同じ）
// - 外部の JavaScript は読み込まない。このファイルと index.html だけで描く。
// - 読むだけの鍵は、ブックマークの URL の # の後ろ（#graph=…・taskgraf と同じ鍵）にだけ置く。localStorage など
//   どこにも保存しない（github.io の同じ住所の別ページから読めるため）。console にも出さない。
// - 鍵は Authorization ヘッダーで、固定の送り先にだけ送る（送り先は差し替えられない）。
// - タブを開くたびと「更新」を押した時に取り直す（キャッシュしない）。取得時刻を出す。
// - データは textContent でだけ入れる（文字列の innerHTML は使わない）。
// - リンクにするのは claude.ai のチャット／Claude Code のセッションの形の URL だけ（handoff 側でも同じ形しか入らない）。
// - 一覧から外れるのは、閉じたと明示に分かったチャットだけ（handoff の規則）。時間が経っただけでは外れない。
// - 「閉じた人」は呼んだ側の申告で、認証された人ではない（handoff の規則）。画面でも「申告」と出す。
// - レーンの名前やチャットの URL は、このファイルに書かない（公開 repo のため）。
(() => {
  "use strict";
  const CHATS_URL = "https://handoff-mcp.gooooerer.workers.dev/chats";
  const VIEW = "chats";
  const UNCAT = "未分類"; // レーンが未設定（null）のチャットをまとめる表示名
  const CLOSER = { chat: "チャット自身", yuita: "ゆいた" }; // 申告（認証ではない）
  const HINT = "閉じたと明示に分かったチャットだけが外れます（時間が経っただけでは外れません）。「最後に動いた」は登録の時に分かった最後の時刻で、実際より遅れることがあります。閉じた人は申告です。";
  const URL_RE =
    /^https:\/\/claude\.ai\/(?:chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|code\/session_[A-Za-z0-9]{8,64})$/;

  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;

  const css = document.createElement("style");
  css.textContent = `
  .ch-panel{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 14px 40px}
  .ch-panel[hidden]{display:none}
  .wrap.v-chats .pbar,.wrap.v-chats .prow2,.wrap.v-chats .tools,.wrap.v-chats .paste{display:none}
  .ch-bar{padding:10px 2px 2px;font-size:12px;color:var(--muted)}
  .ch-l1{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px}
  .ch-l1 b{color:var(--text);font:600 13px/1 var(--mono)}
  .ch-time{font:11px/1 var(--mono);color:var(--faint)}
  .ch-reload{margin-left:auto;font:inherit;font-size:12px;color:var(--text);background:var(--surface-2);border:1px solid var(--line);
    border-radius:7px;padding:6px 12px;cursor:pointer}
  .ch-reload:focus-visible,.ch-open:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .ch-note{margin-top:5px;font-size:11px;color:var(--faint);line-height:1.5}
  .ch-msg{margin:14px 2px;font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--line-soft);
    border-radius:12px;padding:12px 14px;line-height:1.7}
  .ch-group{margin:16px 0 4px}
  .ch-gh{display:flex;align-items:center;gap:8px;margin:0 2px 6px;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--muted)}
  .ch-gh::after{content:"";flex:1 1 auto;height:1px;background:var(--line-soft)}
  .ch-gname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
  .ch-cnt{font:11px/1 var(--mono);color:var(--faint)}
  .ch-row{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line-soft);border-radius:11px;
    padding:10px 10px 10px 13px;margin:6px 0}
  .ch-body{flex:1 1 auto;min-width:0}
  .ch-title{font-size:14px;font-weight:600;line-height:1.35;word-break:break-word}
  .ch-meta{display:flex;flex-wrap:wrap;align-items:center;gap:3px 8px;margin-top:5px;font:11.5px/1.3 var(--mono);color:var(--muted)}
  .ch-chip{font:10.5px/1 var(--mono);color:var(--muted);background:var(--surface-2);border:1px solid var(--line-soft);border-radius:5px;padding:2px 5px}
  .ch-open{flex:0 0 auto;display:inline-flex;align-items:center;min-height:40px;font-size:13px;font-weight:600;color:#dbe8ff;
    background:#243042;border:1px solid #33455e;border-radius:9px;padding:0 15px;text-decoration:none;white-space:nowrap}
  .ch-bad{flex:0 0 auto;font-size:11px;color:var(--late)}
  .ch-more{margin:10px 2px;font-size:11.5px;color:var(--muted);line-height:1.6}
  .ch-closed{margin:20px 0 0}
  .ch-closed summary{cursor:pointer;font-size:12px;color:var(--muted);padding:6px 2px}
  .ch-closed .ch-row{opacity:.72}
  @media (min-width:768px){.ch-panel{padding:6px 24px 48px}.ch-inner{max-width:820px}}
  `;
  document.head.appendChild(css);

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = VIEW;
  btn.textContent = "チャット";
  tabs.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "ch-panel";
  panel.id = "chatsPanel";
  panel.hidden = true;
  stream.insertAdjacentElement("afterend", panel);

  let seq = 0; // 古い取得の結果で新しい表示を上書きしない
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    const wrap = document.querySelector(".wrap");
    if (b.dataset.view === VIEW) {
      stream.style.display = "none";
      panel.hidden = false;
      wrap && wrap.classList.add("v-chats");
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
      // 既存の処理がタスクの見出しを書いた後に、この画面の見出しに置き換える
      setTimeout(() => {
        const pn = document.getElementById("pname");
        if (pn && !panel.hidden) pn.textContent = "チャット";
      }, 0);
      void refresh();
    } else if (!panel.hidden) {
      panel.hidden = true;
      wrap && wrap.classList.remove("v-chats");
      // 行き先が自分の枠を持つ画面（taskgraf）なら、その枠が出ている＝タスクの流れは戻さない
      if (!document.querySelector(".tg-panel:not([hidden])")) stream.style.display = "";
    }
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
      return show(msg("鍵がありません。ブックマークの URL の最後に「#graph=読むだけの鍵」を付けて開いてください（taskgraf と同じ鍵。Mac の Keychain の handoff-graph-read-token）。"));
    }
    show(msg("取得中…"));
    let res;
    try {
      res = await fetch(CHATS_URL, {
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
    if (res.status === 404) return show(msg("読めませんでした（鍵が違うか、チャットの一覧の口がまだ有効になっていません）。"));
    if (!res.ok) return show(msg("handoff 側のエラーです（" + res.status + "）。"));
    let d;
    try {
      d = await res.json();
    } catch (_) {
      if (my === seq) show(msg("返ってきた中身を読めませんでした。"));
      return;
    }
    if (my !== seq) return;
    const data = readList(d);
    if (!data) return show(msg("返ってきた中身の形が想定と違います。"));
    render(data, new Date());
  }

  // ---- 中身を読む：形の合うものだけを使う（合わないものは数だけ出す） ----
  const isStr = (v) => typeof v === "string";
  const isStrOrNull = (v) => v === null || typeof v === "string";
  function readList(d) {
    if (!d || typeof d !== "object" || !Array.isArray(d.chats)) return null;
    const okOpen = (c) => !!c && isStr(c.url) && isStrOrNull(c.title) && isStrOrNull(c.project_id) && isStr(c.last_seen_at);
    const okClosed = (c) =>
      !!c && isStr(c.url) && isStrOrNull(c.title) && isStrOrNull(c.project_id) && isStr(c.closed_at) && isStr(c.closed_by);
    const chats = d.chats.filter(okOpen);
    const closedIn = Array.isArray(d.recently_closed) ? d.recently_closed : [];
    const closed = closedIn.filter(okClosed);
    const total = Number.isInteger(d.open_total) && d.open_total >= chats.length ? d.open_total : chats.length;
    const skipped = d.chats.length - chats.length + (closedIn.length - closed.length);
    return { chats, closed, total, skipped };
  }

  // ---- 描く ----
  function render(data, now) {
    const inner = el("div", "ch-inner");
    const bar = el("div", "ch-bar");
    const l1 = el("div", "ch-l1");
    const count = el("span");
    count.append("開いているチャット ", el("b", null, String(data.total)), " 件");
    const reload = el("button", "ch-reload", "更新");
    reload.type = "button";
    reload.addEventListener("click", () => void refresh());
    l1.append(count, el("span", "ch-time", "取得 " + fmt(now)), reload);
    bar.append(l1);
    bar.append(el("div", "ch-note", HINT));
    inner.append(bar);

    if (!data.chats.length) {
      inner.append(msg("開いているチャットはありません。チャットは始まった時に自分で載り、閉じたと分かった時に外れます。"));
    }
    for (const g of groupsOf(data.chats)) {
      const sec = el("section", "ch-group");
      const h = el("h3", "ch-gh");
      h.append(el("span", "ch-gname", g.lane === null ? UNCAT : g.lane), el("span", "ch-cnt", String(g.list.length)));
      sec.append(h);
      for (const c of g.list) sec.append(row(c, now, "open"));
      inner.append(sec);
    }
    if (data.total > data.chats.length) {
      inner.append(el("div", "ch-more", "ほかに " + (data.total - data.chats.length) + " 件あります（最後に動いたのが古いもの）。ここには出していません。"));
    }
    if (data.skipped > 0) {
      inner.append(el("div", "ch-more", "形の読めない " + data.skipped + " 件は出していません。"));
    }
    if (data.closed.length) {
      const det = el("details", "ch-closed");
      det.append(el("summary", null, "最近閉じたチャット（7日以内・" + data.closed.length + " 件）"));
      for (const c of data.closed) det.append(row(c, now, "closed"));
      inner.append(det);
    }
    show(inner);
  }

  // レーンごとにまとめる。まとまりの並び＝中の一番新しい動きの順（新しい順）。同じならレーン名のコードポイント順。中は新しい順。
  function groupsOf(chats) {
    const by = new Map();
    for (const c of chats) {
      const k = c.project_id;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(c);
    }
    const groups = [...by.entries()].map(([lane, list]) => {
      list.sort((a, b) => time(b.last_seen_at) - time(a.last_seen_at));
      return { lane, list, latest: time(list[0].last_seen_at) };
    });
    groups.sort((a, b) => b.latest - a.latest || byCodePoint(a.lane === null ? "\u{10FFFF}" : a.lane, b.lane === null ? "\u{10FFFF}" : b.lane));
    return groups;
  }

  function row(c, now, kind) {
    const r = el("div", "ch-row");
    const body = el("div", "ch-body");
    body.append(el("div", "ch-title", c.title || "（題なし）"));
    const meta = el("div", "ch-meta");
    if (/^https:\/\/claude\.ai\/code\//.test(c.url)) meta.append(el("span", "ch-chip", "Code"));
    if (kind === "open") {
      meta.append(el("span", null, "最後に動いた " + ago(c.last_seen_at, now) + "（" + fmtIso(c.last_seen_at) + "）"));
    } else {
      if (c.project_id !== null) meta.append(el("span", "ch-chip", c.project_id));
      meta.append(el("span", null, "閉じた " + ago(c.closed_at, now) + "（" + fmtIso(c.closed_at) + "）・申告：" + (CLOSER[c.closed_by] || c.closed_by)));
    }
    body.append(meta);
    r.append(body, openLink(c));
    return r;
  }

  function openLink(c) {
    if (!URL_RE.test(c.url)) return el("span", "ch-bad", "開けない形の URL");
    const a = el("a", "ch-open", "開く");
    a.href = c.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", "「" + (c.title || "題なし") + "」を開く");
    return a;
  }

  // ---- 小さい道具 ----
  function show(node) {
    panel.textContent = "";
    panel.appendChild(node);
  }
  function msg(text) {
    return el("div", "ch-msg", text);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function time(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  }
  function ago(iso, now) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "（時刻不明）";
    const m = Math.floor((now.getTime() - t) / 60000);
    if (m < 1) return "たった今";
    if (m < 60) return m + "分前";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "時間前";
    return Math.floor(h / 24) + "日前";
  }
  function fmt(d) {
    const j = new Date(d.getTime() + 9 * 3600000); // 日本時間
    const p = (n) => String(n).padStart(2, "0");
    return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
  }
  function fmtIso(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? "—" : fmt(new Date(t));
  }
  // 並び：コードポイントの順（localeCompare は環境で順が変わるので使わない）
  function byCodePoint(a, b) {
    const x = [...a], y = [...b];
    for (let i = 0; i < x.length && i < y.length; i++) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d) return d;
    }
    return x.length - y.length;
  }
})();
