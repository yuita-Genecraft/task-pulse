// autonomy — Task Pulse の「autonomy」タブ。handoff の GET /pulse を、タブを開いた時と「更新」を押した時に読み直し、
// 有効なレーンを1枚ずつ並べて、それぞれの今（到達点・次の一手・待ち・根拠・最終更新）を出す。
// 上に「ゆいた待ち」のレーンだけの帯（待ちの文を1行で出すだけ。ボタンは置かない）。各レーンに、ゆいたが1行書く「申送り」の欄（POST /pulse/note）。
// 設計メモ_TaskPulse_autonomyタブと承認カード v0.1 §0.1・§5.2・§6。承認カードは作らない（2026-10-24 ゆいたの決定）。
//
// 守っていること（taskgraf.js・chats.js と同じ）
// - 外部の JavaScript は読み込まない。LLM も使わない。このファイルと index.html だけで描く。
// - 自動の読み直しはしない：読むのは、タブを開いた時・「更新」を押した時・# が変わった時だけ（setInterval で /pulse を読まない）。
// - 読むだけの鍵は、ブックマークの URL の # の後ろ（#graph=…・taskgraf と同じ鍵）にだけ置く。書く鍵は &note=…。
//   このページはどちらの鍵も localStorage などに書かない（github.io の同じ住所の別ページから読めるため）。console にも出さない。
//   「保存しない」はこの意味だけ：鍵はブックマークと閲覧履歴の URL には入っている。同じ origin の JavaScript からは location.hash で読める。
// - 鍵は Authorization ヘッダーで、固定の送り先にだけ送る（送り先は差し替えられない）。読む鍵で書かない・書く鍵で読まない。
// - データは textContent でだけ入れる（文字列の innerHTML は使わない）。リンクにするのは、決めた場所の https だけ。
// - 待ちの色は handoff が返す種別（ゆいた／他レーン／外部／なし／unknown）だけで決める。本文から推測しない。
// - レーンの名前は、このファイルに書かない（公開 repo のため）。
// - 申送りは追記だけ（そのレーンの main task が1件増える）。送っている間はボタンを止め、届いたら欄を空にする（二度押しで2件にしない）。
(() => {
  "use strict";
  const BASE = "https://handoff-mcp.gooooerer.workers.dev";
  const PULSE_URL = BASE + "/pulse";
  const NOTE_URL = BASE + "/pulse/note";
  const VIEW = "autonomy";
  const NOTE_MAX = 300; // handoff と同じ上限（コードポイント）
  const DAY = 86400000;
  // 待ちの種別 → 表示（設計メモ §6：ゆいた＝赤・他レーン＝黄・外部＝青・なし＝緑・不明＝灰）
  const WAIT = {
    "ゆいた": { label: "ゆいた待ち", cls: "w-yuita" },
    "他レーン": { label: "他レーン待ち", cls: "w-lane" },
    "外部": { label: "外部待ち", cls: "w-ext" },
    "なし": { label: "待ちなし", cls: "w-none" },
    unknown: { label: "旧形式・不明", cls: "w-unknown" },
  };
  // 根拠の中でリンクにしてよい場所（https・ホスト名の完全一致だけ）
  const LINK_HOSTS = new Set(["github.com", "claude.ai", "drive.google.com", "docs.google.com", "chatgpt.com"]);
  const URL_IN_TEXT = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
  const NOTE_HINT = "申送りを書くには、ブックマークの URL の # の後ろに「&note=書く鍵」を足してください（ゆいたの端末だけに置く鍵）。";
  const HINT = "読むのは、タブを開いた時と「更新」を押した時だけです（自動では読み直しません）。各レーンの【現在地】は担当が書いた申告で、観測ではありません。";

  // ---- 形を読む・決める（画面に触らない。tests/autonomy.cjs が直接呼ぶ） ----
  const isStr = (v) => typeof v === "string";
  const isStrOrNull = (v) => v === null || typeof v === "string";
  const isCapped = (v) => v === null || (!!v && typeof v === "object" && isStr(v.text) && typeof v.truncated === "boolean");
  function okPosition(p) {
    if (p === null) return true;
    if (!p || typeof p !== "object") return false;
    if (!isStrOrNull(p.date) || !isCapped(p.reached) || !isCapped(p.next) || !isCapped(p.evidence)) return false;
    return !!p.wait && typeof p.wait === "object" && isStr(p.wait.kind) && isCapped(p.wait.text);
  }
  const okLane = (l) => !!l && isStr(l.id) && isStrOrNull(l.focus) && isStrOrNull(l.last_activity_at) && okPosition(l.position);
  /** The answer of GET /pulse: the lanes whose shape fits (the rest are counted), or null when the answer is not one. */
  function readPulse(d) {
    if (!d || typeof d !== "object" || !Array.isArray(d.lanes)) return null;
    const lanes = d.lanes.filter(okLane);
    return { lanes, skipped: d.lanes.length - lanes.length };
  }
  /** The kind as shown: one of WAIT's keys (a kind handoff does not know yet = unknown). */
  function waitKind(lane) {
    const k = lane.position ? lane.position.wait.kind : "unknown";
    return Object.prototype.hasOwnProperty.call(WAIT, k) ? k : "unknown";
  }
  /** Days from the 【現在地】 date (JST) to today (JST), or null when there is no readable date. */
  function daysOld(date, now) {
    if (!isStr(date) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return null;
    const t = Date.parse(date + "T00:00:00+09:00");
    if (Number.isNaN(t)) return null;
    const j = new Date(now.getTime() + 9 * 3600000);
    const today = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * 3600000;
    return Math.round((today - t) / DAY);
  }
  /** Faint when the 【現在地】 is older than about a day (設計メモ §6: 24h より古いと薄く) or missing. */
  const isStale = (lane, now) => {
    const d = lane.position ? daysOld(lane.position.date, now) : null;
    return d === null || d > 1;
  };
  /** The line as it will be sent (trimmed), or the reason it cannot be. Same rule as handoff (300・1行). */
  function checkNote(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return { ok: false, error: "空です。" };
    const n = Array.from(text).length;
    if (n > NOTE_MAX) return { ok: false, error: NOTE_MAX + "字を超えています（" + n + "字）。" };
    if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return { ok: false, error: "1行で書いてください（改行は入れられません）。" };
    return { ok: true, text };
  }
  /** Text cut into plain parts and links (links only for https on LINK_HOSTS, exact host). */
  function linkParts(text) {
    const out = [];
    let at = 0;
    for (const m of text.matchAll(URL_IN_TEXT)) {
      let u = m[0].replace(/[).,;:!?]+$/, "");
      let ok = false;
      try {
        const p = new URL(u);
        ok = p.protocol === "https:" && LINK_HOSTS.has(p.hostname) && !p.username && !p.password && !p.port;
      } catch (_) {
        ok = false;
      }
      if (!ok) continue;
      if (m.index > at) out.push({ text: text.slice(at, m.index) });
      out.push({ text: u, href: u });
      at = m.index + u.length;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }
  /** What the 送信 answer means for ゆいた (status from handoff, or -1 no key / 0 no network). */
  function noteError(status, body) {
    const b = body && typeof body === "object" ? body : {};
    if (status === -1) return "書く鍵がありません。" + NOTE_HINT;
    if (status === 0) return "handoff に届きませんでした（通信の失敗）。";
    if (status === 404 && b.error === "no active lane") return "このレーンは今は有効ではありません（「更新」を押してください）。";
    if (status === 404) return "書けませんでした（書く鍵が違うか、書く口がまだ有効になっていません）。";
    if (status === 400 && isStr(b.error) && /secret/.test(b.error)) return "秘密の形（鍵・トークン）を含んでいるので送りませんでした。";
    if (status === 400 || status === 413 || status === 415) return "送った中身が受け付けられませんでした（" + status + "）。";
    return "handoff 側のエラーです（" + status + "）。";
  }
  const PURE = { readPulse, waitKind, daysOld, isStale, checkNote, linkParts, noteError, WAIT, NOTE_MAX, PULSE_URL, NOTE_URL };
  if (typeof document === "undefined") {
    if (typeof module === "object" && module.exports) module.exports = PURE;
    return;
  }

  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;

  const css = document.createElement("style");
  css.textContent = `
  .au-panel{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 14px 40px}
  .au-panel[hidden]{display:none}
  .wrap.v-autonomy .pbar,.wrap.v-autonomy .prow2,.wrap.v-autonomy .tools,.wrap.v-autonomy .paste{display:none}
  .au-bar{padding:10px 2px 2px;font-size:12px;color:var(--muted)}
  .au-l1{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px}
  .au-l1 b{color:var(--text);font:600 13px/1 var(--mono)}
  .au-time{font:11px/1 var(--mono);color:var(--faint)}
  .au-reload{margin-left:auto;font:inherit;font-size:12px;color:var(--text);background:var(--surface-2);border:1px solid var(--line);
    border-radius:7px;padding:6px 12px;cursor:pointer}
  .au-reload:focus-visible,.au-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .au-note{margin-top:5px;font-size:11px;color:var(--faint);line-height:1.5}
  .au-msg{margin:14px 2px;font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--line-soft);
    border-radius:12px;padding:12px 14px;line-height:1.7}
  .au-band{margin:12px 0 4px;padding:10px 12px;border-radius:12px;border:1px solid #6a2f36;background:#2a1a1f}
  .au-band.au-band-none{border-color:var(--line-soft);background:var(--surface)}
  .au-band h3{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;color:#ffc9cd}
  .au-band.au-band-none h3{color:var(--muted);margin:0}
  .au-bandrow{display:flex;gap:8px;align-items:baseline;font-size:13px;line-height:1.5;padding:3px 0;cursor:pointer}
  .au-bandrow b{flex:none;font:600 12.5px/1.5 var(--mono);color:var(--text)}
  .au-bandrow span{min-width:0;word-break:break-word;color:#ffe3e5}
  .au-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin-top:12px}
  @media (min-width:700px){.au-grid{grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))}}
  .au-card{min-width:0;background:var(--surface);border:1px solid var(--line-soft);border-left:4px solid var(--au-c);border-radius:11px;padding:11px 12px 12px;
    scroll-margin-top:10px}
  .au-card.au-stale{opacity:.6}
  .au-card.au-flash{box-shadow:0 0 0 2px var(--au-c)}
  .au-ch{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .au-name{font:700 13.5px/1.3 var(--mono);color:var(--text);word-break:break-all}
  .au-chip{font-size:11px;font-weight:700;color:#0e1117;background:var(--au-c);border-radius:999px;padding:2px 8px;line-height:1.4}
  .au-ago{margin-left:auto;font:11px/1 var(--mono);color:var(--muted)}
  .au-focus{margin-top:5px;font-size:12px;color:var(--muted);line-height:1.5;word-break:break-word}
  .au-kv{display:grid;grid-template-columns:62px minmax(0,1fr);gap:4px 10px;margin:8px 0 0;font-size:12.5px;line-height:1.55}
  .au-kv dt{color:var(--muted)}
  .au-kv dd{margin:0;color:var(--text);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
  .au-kv dd.au-wait{font-weight:600}
  .au-kv a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
  .au-cut{color:var(--faint)}
  .au-none{margin-top:8px;font-size:12px;color:var(--faint)}
  .au-say-row{display:flex;gap:6px;margin-top:10px}
  .au-in{flex:1 1 auto;min-width:0;font:inherit;font-size:13px;color:var(--text);background:var(--surface-2);border:1px solid var(--line);
    border-radius:8px;padding:7px 9px}
  .au-in:focus{outline:2px solid var(--accent);outline-offset:0}
  .au-btn{flex:none;font:inherit;font-size:12px;font-weight:600;color:#dbe8ff;background:#243042;border:1px solid #33455e;border-radius:8px;
    padding:0 12px;min-height:34px;cursor:pointer}
  .au-btn[disabled]{opacity:.5;cursor:default}
  .au-count{font:11px/1 var(--mono);color:var(--faint);margin-top:4px}
  .au-count.au-over{color:var(--late)}
  .au-say{margin-top:4px;font-size:11.5px;color:var(--muted);line-height:1.5}
  .au-say.au-err{color:var(--late)}
  .w-yuita{--au-c:var(--late)} .w-lane{--au-c:var(--accent)} .w-ext{--au-c:var(--prog)} .w-none{--au-c:var(--done)} .w-unknown{--au-c:var(--muted)}
  @media (min-width:768px){.au-panel{padding:6px 24px 48px}}
  `;
  document.head.appendChild(css);

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = VIEW;
  btn.textContent = "autonomy";
  tabs.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "au-panel";
  panel.id = "autonomyPanel";
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
      wrap && wrap.classList.add("v-autonomy");
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
      // 既存の処理がタスクの見出しを書いた後に、この画面の見出しに置き換える
      setTimeout(() => {
        const pn = document.getElementById("pname");
        if (pn && !panel.hidden) pn.textContent = "autonomy";
      }, 0);
      void refresh();
    } else if (!panel.hidden) {
      panel.hidden = true;
      wrap && wrap.classList.remove("v-autonomy");
      // 行き先が自分の枠を持つ画面（taskgraf・チャット）なら、その枠が出ている＝タスクの流れは戻さない
      if (!document.querySelector(".tg-panel:not([hidden]),.ch-panel:not([hidden])")) stream.style.display = "";
    }
  });
  window.addEventListener("hashchange", () => {
    if (!panel.hidden) void refresh();
  });

  // ---- 鍵：# の後ろからだけ読む。このページは localStorage などに書かない（読む鍵＝graph、書く鍵＝note） ----
  function readKeys() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ""));
    return { graph: (p.get("graph") || "").trim(), note: (p.get("note") || "").trim() };
  }

  async function refresh() {
    const my = ++seq;
    const key = readKeys().graph;
    if (!key) {
      return show(msg("鍵がありません。ブックマークの URL の最後に「#graph=読むだけの鍵」を付けて開いてください（taskgraf と同じ鍵。Mac の Keychain の handoff-graph-read-token）。"));
    }
    show(msg("取得中…"));
    let res;
    try {
      res = await fetch(PULSE_URL, {
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
    if (res.status === 404) return show(msg("読めませんでした（鍵が違うか、/pulse の口がまだ有効になっていません）。"));
    if (!res.ok) return show(msg("handoff 側のエラーです（" + res.status + "）。"));
    let d;
    try {
      d = await res.json();
    } catch (_) {
      if (my === seq) show(msg("返ってきた中身を読めませんでした。"));
      return;
    }
    if (my !== seq) return;
    const data = readPulse(d);
    if (!data) return show(msg("返ってきた中身の形が想定と違います。"));
    render(data, new Date());
  }

  // ---- 描く ----
  function render(data, now) {
    const inner = el("div");
    const bar = el("div", "au-bar");
    const l1 = el("div", "au-l1");
    const count = el("span");
    count.append("有効なレーン ", el("b", null, String(data.lanes.length)), " 本");
    const reload = el("button", "au-reload", "更新");
    reload.type = "button";
    reload.addEventListener("click", () => void refresh());
    l1.append(count, el("span", "au-time", "取得 " + fmt(now)), reload);
    bar.append(l1, el("div", "au-note", HINT));
    if (!readKeys().note) bar.append(el("div", "au-note", NOTE_HINT));
    if (data.skipped > 0) bar.append(el("div", "au-note", "形の読めないレーンが " + data.skipped + " 本ありました（出していません）。"));
    inner.append(bar);

    const cards = new Map();
    const waiting = data.lanes.filter((l) => waitKind(l) === "ゆいた");
    const band = el("section", "au-band" + (waiting.length ? "" : " au-band-none"));
    band.append(el("h3", null, waiting.length ? "ゆいた待ち " + waiting.length + " 本" : "ゆいた待ちはありません"));
    for (const l of waiting) {
      const r = el("div", "au-bandrow");
      r.tabIndex = 0;
      r.setAttribute("role", "button");
      r.append(el("b", null, l.id), el("span", null, l.position.wait.text ? l.position.wait.text.text : ""));
      const go = () => {
        const c = cards.get(l.id);
        if (!c) return;
        c.scrollIntoView({ behavior: "smooth", block: "start" });
        c.classList.add("au-flash");
        setTimeout(() => c.classList.remove("au-flash"), 1200);
      };
      r.addEventListener("click", go);
      r.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      band.append(r);
    }
    inner.append(band);

    if (!data.lanes.length) inner.append(msg("有効なレーンがありません。"));
    const grid = el("div", "au-grid");
    for (const l of data.lanes) {
      const c = card(l, now);
      cards.set(l.id, c);
      grid.append(c);
    }
    inner.append(grid);
    show(inner);
  }

  function card(l, now) {
    const kind = waitKind(l);
    const c = el("article", "au-card " + WAIT[kind].cls + (isStale(l, now) ? " au-stale" : ""));
    const h = el("div", "au-ch");
    h.append(el("span", "au-name", l.id), el("span", "au-chip", l.position ? WAIT[kind].label : "現在地なし"));
    h.append(el("span", "au-ago", l.last_activity_at ? "更新 " + ago(l.last_activity_at, now) : "更新 記録前"));
    c.append(h);
    if (l.focus) c.append(el("div", "au-focus", "本丸：" + l.focus));
    const p = l.position;
    if (!p) {
      c.append(el("div", "au-none", "【現在地】がまだありません。"));
    } else {
      const kv = el("dl", "au-kv");
      const row = (k, node) => {
        kv.append(el("dt", null, k));
        kv.append(node);
      };
      const old = daysOld(p.date, now);
      row("日付", el("dd", null, p.date ? p.date + (old === null ? "" : old <= 0 ? "（今日）" : "（" + old + "日前）") : "（読めない）"));
      row("到達点", capped(p.reached));
      row("次の一手", capped(p.next));
      const w = capped(p.wait.text);
      w.classList.add("au-wait");
      row("待ち", w);
      row("根拠", capped(p.evidence, true));
      c.append(kv);
      if (kind === "unknown") c.append(el("div", "au-none", "待ちが4種（ゆいた｜・他レーン（名）｜・外部（名）｜・なし）の形ではありません（古い書き方か、欄が読めない記録）。"));
    }
    c.append(sayBox(l.id));
    return c;
  }

  function capped(v, links) {
    const dd = el("dd");
    if (!v) {
      dd.textContent = "（読めない）";
      return dd;
    }
    if (links) for (const part of linkParts(v.text)) dd.append(part.href ? link(part) : part.text);
    else dd.textContent = v.text;
    if (v.truncated) dd.append(el("span", "au-cut", "…（続きあり）"));
    return dd;
  }
  function link(part) {
    const a = el("a", null, part.text);
    a.href = part.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // ---- 申送り（POST /pulse/note）：書く鍵がある時だけ ----
  function sayBox(laneId) {
    const box = el("div");
    if (!readKeys().note) return box;
    const r = el("div", "au-say-row");
    const input = el("input", "au-in");
    input.type = "text";
    input.placeholder = "申送りを1行（このレーンの main task になります）";
    input.setAttribute("aria-label", laneId + " への申送り");
    input.autocomplete = "off";
    const send = el("button", "au-btn", "送る");
    send.type = "button";
    const cnt = el("div", "au-count", "0/" + NOTE_MAX);
    const say = el("div", "au-say");
    let busy = false;
    const update = () => {
      const n = Array.from(input.value.trim()).length;
      cnt.textContent = n + "/" + NOTE_MAX;
      cnt.classList.toggle("au-over", n > NOTE_MAX);
      send.disabled = busy || n === 0 || n > NOTE_MAX;
    };
    input.addEventListener("input", update);
    const go = async () => {
      if (busy) return;
      const v = checkNote(input.value);
      if (!v.ok) return tell(say, v.error, true);
      busy = true;
      input.disabled = true;
      update();
      tell(say, "送っています…");
      const res = await postNote(laneId, v.text);
      busy = false;
      input.disabled = false;
      if (res.status === 201) {
        input.value = "";
        tell(say, "送りました（" + laneId + " の main task として載りました）。");
      } else {
        tell(say, noteError(res.status, res.body), true);
      }
      update();
    };
    send.addEventListener("click", () => void go());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void go();
      }
    });
    update();
    r.append(input, send);
    box.append(r, cnt, say);
    return box;
  }

  // 書き込み：固定の送り先・書く鍵は Authorization ヘッダーだけ・このページは localStorage などに書かない
  async function postNote(projectId, text) {
    const key = readKeys().note;
    if (!key) return { status: -1, body: null };
    let res;
    try {
      res = await fetch(NOTE_URL, {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, text }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (_) {
      return { status: 0, body: null };
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    return { status: res.status, body };
  }

  function tell(say, text, isError) {
    say.textContent = text;
    say.className = isError ? "au-say au-err" : "au-say";
  }
  function show(node) {
    panel.replaceChildren(node);
  }
  function msg(text) {
    return el("div", "au-msg", text);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
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
})();
