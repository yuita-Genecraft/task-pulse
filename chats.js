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
//
// メモと「外す／戻す」（2026-10-08）
// - 書くのは、書き込み専用の鍵（# の後ろの &write=…）がある時だけ。読む鍵（graph）では書かない。
//   書き込みの鍵も保存しない・console に出さない・固定の送り先にだけ Authorization ヘッダーで送る。
// - メモは handoff に置く（1チャットに1つ・500字まで）。保存の時は、表示した時のメモの時刻を一緒に送る。
//   その間に別の所（チャットなど）で書き換わっていたら、handoff は 409 を返して上書きしない。
// - メモの中の URL は、決めた場所（chatgpt.com など）の https だけをリンクにする。ほかは文字のまま。
// - 「外す」は一覧から外すだけ（claude.ai のチャットは消えない）。2回押した時だけ外れる。外した行は「戻す」で戻せる。
(() => {
  "use strict";
  const BASE = "https://handoff-mcp.gooooerer.workers.dev";
  const CHATS_URL = BASE + "/chats";
  const MEMO_MAX = 500; // handoff と同じ上限（コードポイント）
  // メモの中でリンクにしてよい場所（https・ホスト名の完全一致だけ）
  const LINK_HOSTS = new Set(["chatgpt.com", "chat.openai.com", "claude.ai", "github.com", "drive.google.com", "docs.google.com"]);
  // メモの中の URL らしい所（ASCII の URL の文字だけ＝日本語の句読点の手前で切れる）
  const URL_IN_TEXT = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
  const WRITE_HINT = "メモを書く・行を外すには、ブックマークの URL の # の後ろに「&write=書き込みの鍵」を足してください（Mac の Keychain の handoff-chats-write-token）。";
  const REOPEN_WHY = {
    closed_after_start: "戻そうとした間に、別の所で閉じられました",
    seen_not_after_close: "閉じた時刻より後の操作として扱えませんでした（少し待ってからもう一度）",
    not_asked: "戻す指示として扱われませんでした",
  };
  const VIEW = "chats";
  const UNCAT = "未分類"; // レーンが未設定（null）のチャットをまとめる表示名
  const CLOSER = { chat: "チャット自身", yuita: "ゆいた" }; // 申告（認証ではない）
  const HINT = "閉じたと明示に分かったチャットだけが外れます（時間が経っただけでは外れません）。「最後に動いた」は登録の時に分かった最後の時刻で、実際より遅れることがあります（ここで戻した行は、戻した時刻になります）。閉じた人は申告です。";
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
  .ch-closed .ch-row :is(.ch-title,.ch-meta,.ch-memo){opacity:.72}
  .ch-closed .ch-row.ch-back :is(.ch-title,.ch-meta,.ch-memo){opacity:1}
  .ch-memo{margin-top:7px;font-size:12.5px;line-height:1.55;color:var(--text);background:var(--surface-2);border:1px solid var(--line-soft);
    border-radius:8px;padding:6px 9px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
  .ch-memo a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
  .ch-acts{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:7px}
  .ch-btn{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:7px;
    padding:5px 10px;min-height:30px;cursor:pointer}
  .ch-btn:hover{color:var(--text);border-color:var(--muted)}
  .ch-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .ch-btn.ch-danger{color:#ffd9d9;background:#4a2326;border-color:#7a3a3f}
  .ch-btn.ch-primary{color:#dbe8ff;background:#243042;border-color:#33455e;font-weight:600}
  .ch-btn[disabled]{opacity:.5;cursor:default}
  .ch-ed{display:block;width:100%;box-sizing:border-box;min-height:96px;margin-top:7px;font:inherit;font-size:13px;line-height:1.5;
    color:var(--text);background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:7px 9px;resize:vertical}
  .ch-ed:focus{outline:2px solid var(--accent);outline-offset:0}
  .ch-edbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:6px}
  .ch-count{font:11px/1 var(--mono);color:var(--faint)}
  .ch-count.ch-over{color:var(--late)}
  .ch-say{font-size:11.5px;color:var(--muted);line-height:1.5}
  .ch-say.ch-err{color:var(--late)}
  .ch-row.ch-gone :is(.ch-title,.ch-meta,.ch-memo,.ch-open){opacity:.5}
  .ch-row.ch-gone .ch-title{text-decoration:line-through}
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

  // ---- 鍵：# の後ろからだけ読む。保存しない（読む鍵＝graph、書き込みの鍵＝write） ----
  function readKeys() {
    const h = location.hash.replace(/^#/, "");
    const p = new URLSearchParams(h);
    return { graph: (p.get("graph") || "").trim(), write: (p.get("write") || "").trim() };
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
    // メモの欄は無くてもよい（古い handoff）。あるなら文字列か null だけ。
    const okMemo = (c) => (c.memo === undefined || isStrOrNull(c.memo)) && (c.memo_updated_at === undefined || isStrOrNull(c.memo_updated_at));
    const withMemo = (c) => Object.assign({}, c, { memo: c.memo || null, memo_updated_at: c.memo_updated_at || null });
    const okOpen = (c) => !!c && isStr(c.url) && isStrOrNull(c.title) && isStrOrNull(c.project_id) && isStr(c.last_seen_at) && okMemo(c);
    const okClosed = (c) =>
      !!c && isStr(c.url) && isStrOrNull(c.title) && isStrOrNull(c.project_id) && isStr(c.closed_at) && isStr(c.closed_by) && okMemo(c);
    const chats = d.chats.filter(okOpen).map(withMemo);
    const closedIn = Array.isArray(d.recently_closed) ? d.recently_closed : [];
    const closed = closedIn.filter(okClosed).map(withMemo);
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
    const totalEl = el("b", null, String(data.total));
    counter = { el: totalEl, n: data.total };
    count.append("開いているチャット ", totalEl, " 件");
    const reload = el("button", "ch-reload", "更新");
    reload.type = "button";
    reload.addEventListener("click", () => void refresh());
    l1.append(count, el("span", "ch-time", "取得 " + fmt(now)), reload);
    bar.append(l1);
    bar.append(el("div", "ch-note", HINT));
    if (!readKeys().write) bar.append(el("div", "ch-note", WRITE_HINT));
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
    const memoBox = el("div");
    const edBox = el("div");
    body.append(memoBox, edBox);
    showMemo(memoBox, c);
    if (readKeys().write) body.append(actions(c, r, kind, memoBox, edBox));
    r.append(body, openLink(c));
    return r;
  }

  // ---- メモ：見せる（決めた場所の https だけリンク） ----
  function showMemo(box, c) {
    box.textContent = "";
    if (c.memo) box.append(memoView(c.memo));
  }
  function memoView(text) {
    const box = el("div", "ch-memo");
    let at = 0;
    for (const m of text.matchAll(URL_IN_TEXT)) {
      const raw = m[0].replace(/[.,;:!?)\]'"]+$/, ""); // URL の後ろの句読点は URL に入れない
      if (!raw) continue;
      if (m.index > at) box.append(document.createTextNode(text.slice(at, m.index)));
      const href = safeLink(raw);
      if (href) {
        const a = el("a", null, raw);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        box.append(a);
      } else {
        box.append(document.createTextNode(raw));
      }
      at = m.index + raw.length;
    }
    if (at < text.length) box.append(document.createTextNode(text.slice(at)));
    return box;
  }
  function safeLink(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" || !LINK_HOSTS.has(u.hostname) || u.username || u.password || u.port) return null;
    return u.href;
  }

  // ---- 書く：メモ・外す・戻す（書き込みの鍵がある時だけ） ----
  function actions(c, r, kind, memoBox, edBox) {
    const acts = el("div", "ch-acts");
    const say = el("span", "ch-say");
    const memoBtn = button(c.memo ? "メモを直す" : "メモを書く");
    memoBtn.addEventListener("click", () => openEditor(c, memoBox, edBox, memoBtn, say));
    acts.append(memoBtn, kind === "open" ? closeButton(c, r, say) : reopenButton(c, say, (already) => backFromClosed(r, say, already)));
    acts.append(say);
    return acts;
  }

  function openEditor(c, memoBox, edBox, memoBtn, say) {
    if (edBox.firstChild) return;
    tell(say, "");
    let base = c.memo_updated_at; // 表示した時のメモ（handoff はこれと違えば上書きしない）
    const ta = el("textarea", "ch-ed");
    ta.value = c.memo || "";
    ta.placeholder = "例：ChatGPT のセカンドオピニオン https://chatgpt.com/…（空にして保存すると消える）";
    ta.setAttribute("aria-label", "「" + (c.title || "題なし") + "」のメモ");
    const cnt = el("span", "ch-count");
    const save = button("保存");
    save.classList.add("ch-primary");
    const cancel = button("やめる");
    const bar = el("div", "ch-edbar");
    bar.append(save, cancel, cnt);
    edBox.append(ta, bar);
    memoBtn.disabled = true;
    const update = () => {
      const n = Array.from(ta.value).length;
      cnt.textContent = n + " / " + MEMO_MAX;
      cnt.classList.toggle("ch-over", n > MEMO_MAX);
      save.disabled = n > MEMO_MAX;
    };
    const close = () => {
      edBox.textContent = "";
      memoBtn.disabled = false;
      memoBtn.textContent = c.memo ? "メモを直す" : "メモを書く";
    };
    const doSave = async () => {
      if (save.disabled) return;
      save.disabled = true;
      tell(say, "保存しています…");
      const res = await write("/chats/memo", "PUT", { url: c.url, memo: ta.value, base_updated_at: base });
      const b = res.body || {};
      if (res.status === 200 && b.ok === true) {
        c.memo = isStr(b.memo) ? b.memo : null;
        c.memo_updated_at = isStr(b.memo_updated_at) ? b.memo_updated_at : null;
        showMemo(memoBox, c);
        close();
        tell(say, b.result === "cleared" ? "メモを消しました。" : b.result === "unchanged" ? "変更はありませんでした。" : "保存しました。");
        return;
      }
      if (res.status === 409 && b.error === "conflict") {
        // 別の所で書き換わっていた：今のメモを見せ、書いた文はそのまま残す
        c.memo = isStr(b.memo) ? b.memo : null;
        c.memo_updated_at = isStr(b.memo_updated_at) ? b.memo_updated_at : null;
        base = c.memo_updated_at;
        showMemo(memoBox, c);
        update();
        tell(say, "別の所でメモが書き換わっていました。上が今のメモです。直してから、もう一度保存してください。", true);
        return;
      }
      update();
      tell(say, writeError(res), true);
    };
    ta.addEventListener("input", update);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void doSave();
      }
    });
    save.addEventListener("click", () => void doSave());
    cancel.addEventListener("click", close);
    update();
    ta.focus();
  }

  // 外す：1回目で「外す？」に変わり、続けてもう1回押した時だけ外す
  function closeButton(c, r, say) {
    const b = button("外す");
    b.title = "一覧から外す（claude.ai のチャットは消えません）";
    let armed = null;
    const disarm = () => {
      clearTimeout(armed);
      armed = null;
      b.textContent = "外す";
      b.classList.remove("ch-danger");
    };
    b.addEventListener("click", async () => {
      if (!armed) {
        b.textContent = "外す？（もう一度押す）";
        b.classList.add("ch-danger");
        armed = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      b.disabled = true;
      b.textContent = "外しています…";
      const res = await write("/chats/close", "POST", { url: c.url });
      const body = res.body || {};
      if (res.status === 200 && body.ok === true) {
        // 画面では開いている行として数えていた＝どちらでも1減らす（別の所で先に閉じられていても、今は閉じている）
        r.classList.add("ch-gone");
        bump(r, -1);
        tell(say, body.already === true ? "別の所で先に閉じられていました（claude.ai のチャットは残っています）。" : "一覧から外しました（claude.ai のチャットは残っています）。");
        b.replaceWith(
          reopenButton(c, say, (already) => {
            r.classList.remove("ch-gone");
            bump(r, 1);
            tell(say, already ? "別の所で先に戻されていました。" : "戻しました。");
            const again = say.parentNode && say.parentNode.querySelector(".ch-reopen");
            if (again) again.replaceWith(closeButton(c, r, say));
          }),
        );
        return;
      }
      b.disabled = false;
      b.textContent = "外す";
      tell(say, writeError(res), true);
    });
    return b;
  }

  function reopenButton(c, say, onBack) {
    const b = button("戻す");
    b.classList.add("ch-reopen");
    b.title = "一覧に戻す";
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "戻しています…";
      const res = await write("/chats/reopen", "POST", { url: c.url });
      const body = res.body || {};
      if (res.status === 200 && body.ok === true) {
        // 画面では閉じた行だった＝どちらでも戻す（別の所で先に戻されていても、今は開いている）
        onBack(body.already === true);
        return;
      }
      b.disabled = false;
      b.textContent = "戻す";
      if (res.status === 409 && body.error === "not_reopened") {
        return tell(say, "戻せませんでした：" + (REOPEN_WHY[body.reason] || "handoff の規則で断られました") + "。", true);
      }
      tell(say, writeError(res), true);
    });
    return b;
  }

  function backFromClosed(r, say, already) {
    r.classList.add("ch-back");
    bump(r, 1);
    tell(say, (already ? "別の所で先に戻されていました" : "戻しました") + "（「更新」を押すと、上の一覧に出ます）。");
    const b = r.querySelector(".ch-reopen");
    if (b) b.remove();
  }

  // 書き込み：固定の送り先・書き込みの鍵は Authorization ヘッダーだけ・保存しない
  async function write(path, method, payload) {
    const key = readKeys().write;
    if (!key) return { status: -1, body: null };
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify(payload),
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
    return { status: res.status, body: body && typeof body === "object" ? body : null };
  }

  function writeError(res) {
    const b = res.body || {};
    if (res.status === -1) return "書き込みの鍵がありません。" + WRITE_HINT;
    if (res.status === 0) return "handoff に届きませんでした（通信の失敗）。";
    if (res.status === 404) return "書けませんでした（書き込みの鍵が違うか、書き込みの口がまだ有効になっていません）。";
    if (b.error === "too_long") return MEMO_MAX + "字を超えています（" + (Number.isInteger(b.length) ? b.length : "?") + "字）。";
    if (b.error === "unknown_chat") return "このチャットは一覧にありません（「更新」を押してください）。";
    if (res.status === 400 || res.status === 413 || res.status === 415) return "送った中身が受け付けられませんでした（" + res.status + "）。";
    return "handoff 側のエラーです（" + res.status + "）。";
  }

  let counter = null; // 「開いているチャット N 件」の数（外す・戻すで書き換える）
  // 答えが届いた時に、その行がもう画面に無い（「更新」で描き直した後）なら数は触らない＝新しい一覧の数が正
  function bump(r, d) {
    if (!counter || !r.isConnected) return;
    counter.n = Math.max(0, counter.n + d);
    counter.el.textContent = String(counter.n);
  }
  function tell(say, text, isError) {
    say.textContent = text;
    say.className = isError ? "ch-say ch-err" : "ch-say";
  }
  function button(text) {
    const b = el("button", "ch-btn", text);
    b.type = "button";
    return b;
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
