// Task Pulse — ChatGPT。Claude の chats.js / handoff データを変更しない独立タブ。
// ローカル IndexedDB に URL・題・確認時刻・メモ・明示的な「外す」を保存。
// Chrome 拡張による自動登録は URL/題/確認時刻だけ。メッセージ本文や資格は扱わない。
(() => {
  "use strict";
  const tabs = document.getElementById("tabs");
  const stream = document.getElementById("stream");
  if (!tabs || !stream) return;
  const VIEW = "chatgpt";
  const DB = "taskpulse-chatgpt-local-v1";
  const STORE = "chats";
  const MAX_MEMO = 500;
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const pathRe = new RegExp("^/(?:g/g-[A-Za-z0-9_-]{1,160}/)?c/(" + uuid + ")$", "i");
  const extSource = "taskpulse-chatgpt-extension";
  const pageSource = "taskpulse-chatgpt-page";
  const dbReady = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  const el = (tag, cls, value) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const cleanTitle = (s) => {
    if (typeof s !== "string") return "";
    const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
      .replace(/\s+/g, " ").replace(/\s+[-|]\s+ChatGPT$/i, "").trim();
    if (!flat || flat === "ChatGPT") return "";
    return Array.from(flat).slice(0, 120).join("");
  };
  function canonical(raw) {
    if (typeof raw !== "string" || raw.length > 1024) return null;
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" || u.hostname !== "chatgpt.com" || u.port || u.username || u.password) return null;
      const m = pathRe.exec(u.pathname);
      if (!m) return null;
      const id = m[1].toLowerCase();
      return { id, url: "https://chatgpt.com" + u.pathname.slice(0, -m[1].length) + id };
    } catch (_) { return null; }
  }
  function validTime(s) {
    if (typeof s !== "string") return null;
    const t = Date.parse(s);
    return Number.isFinite(t) && t >= Date.UTC(2023, 0, 1) && t <= Date.now() + 300000 ? new Date(Math.min(t, Date.now())).toISOString() : null;
  }
  function transaction(id, edit) {
    return dbReady.then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let result;
      const get = store.get(id);
      get.onsuccess = () => {
        try {
          const outcome = edit(get.result || null);
          result = outcome.result;
          if (outcome.row) store.put(outcome.row);
        } catch (e) { tx.abort(); reject(e); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("保存が中止されました"));
    }));
  }
  function add(raw, title, observedAt) {
    const c = canonical(raw);
    const t = validTime(observedAt);
    if (!c || !t) return Promise.resolve(false);
    const name = cleanTitle(title);
    return transaction(c.id, (old) => {
      const newer = !old || Date.parse(t) > Date.parse(old.observedAt);
      const row = old ? { ...old } : {
        ...c, title: "", observedAt: t, memo: "", memoVersion: 0, closedAt: null,
      };
      if (newer) { row.url = c.url; row.observedAt = t; }
      if (name && (!old || newer || !old.title)) row.title = name;
      // 自動登録は「外す」を解除しない。誤って戻すには本人の操作が必要。
      return { row, result: true };
    });
  }
  function all() {
    return dbReady.then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  const fmt = (s) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "時刻不明";
    const j = new Date(d.getTime() + 9 * 3600000);
    const z = n => String(n).padStart(2, "0");
    return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${z(j.getUTCHours())}:${z(j.getUTCMinutes())}`;
  };
  const say = (text, error) => { status.textContent = text; status.className = error ? "cg-status cg-error" : "cg-status"; };

  const css = el("style");
  css.textContent = `
  .cg-panel{flex:1 1 auto;min-height:0;overflow-y:auto;padding:7px 14px 36px;-webkit-overflow-scrolling:touch}
  .cg-panel[hidden]{display:none}.wrap.v-chatgpt .pbar,.wrap.v-chatgpt .prow2,.wrap.v-chatgpt .tools,.wrap.v-chatgpt .paste{display:none}
  .cg-inner{max-width:820px;margin:0 auto}.cg-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px;padding:10px 0}
  .cg-top strong{color:var(--text)}.cg-top button{margin-left:auto}.cg-hint{font-size:11.5px;color:var(--muted);line-height:1.6;margin:0 0 10px}
  .cg-form{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.cg-form input{font:inherit;color:var(--text);background:var(--surface-2);border:1px solid var(--line);border-radius:7px;padding:9px;min-width:0;flex:1 1 165px}
  .cg-form input[type=url]{flex:3 1 260px}.cg-btn{font:inherit;font-size:12px;border:1px solid var(--line);color:var(--text);background:var(--surface-2);padding:7px 10px;border-radius:7px;cursor:pointer}
  .cg-btn:focus-visible,.cg-form input:focus-visible,.cg-edit:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .cg-row{background:var(--surface);border:1px solid var(--line-soft);border-radius:11px;padding:11px 13px;margin:7px 0;display:flex;gap:10px;align-items:center}
  .cg-body{min-width:0;flex:1 1 auto}.cg-title{font-weight:650;word-break:break-word;font-size:14px}.cg-meta{margin-top:4px;font-size:11.5px;color:var(--muted)}
  .cg-memo{margin-top:8px;background:var(--surface-2);padding:7px 9px;border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px}
  .cg-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.cg-open{padding:10px 13px;background:#243042;color:#dbe8ff;border:1px solid #33455e;border-radius:9px;text-decoration:none;font-size:12px;font-weight:600}
  .cg-edit{box-sizing:border-box;resize:vertical;width:100%;min-height:95px;background:var(--surface-2);border:1px solid var(--line);border-radius:7px;color:var(--text);padding:8px;font:inherit;margin-top:9px}
  .cg-status{font-size:12px;color:var(--muted);min-height:20px}.cg-error{color:var(--late)}.cg-closed{margin-top:18px;font-size:12px;color:var(--muted)}
  .cg-closed summary{cursor:pointer;padding:6px}.cg-closed .cg-row{opacity:.75}.cg-empty{font-size:13px;color:var(--muted);padding:18px 4px}
  .cg-heading{font-size:11px;color:var(--muted);padding:5px 0;border-bottom:1px solid var(--line-soft);margin-top:14px}
  `;
  document.head.appendChild(css);

  const claude = tabs.querySelector('[data-view="chats"]');
  if (claude) claude.textContent = "Claude";
  const tab = el("button", "tab", "ChatGPT");
  tab.type = "button";
  tab.dataset.view = VIEW;
  tabs.appendChild(tab);
  const panel = el("div", "cg-panel");
  panel.id = "chatgptPanel";
  panel.hidden = true;
  stream.insertAdjacentElement("afterend", panel);
  const inner = el("div", "cg-inner");
  panel.appendChild(inner);
  const top = el("div", "cg-top");
  const count = el("strong", null, "開いているチャット 0 件");
  const reload = el("button", "cg-btn", "更新");
  top.append(count, reload);
  inner.append(top, el("p", "cg-hint", "ChatGPTで開いた会話を拡張機能で自動登録できます。登録されるのはURL・題・確認時刻だけ。ここでのメモ・外す／戻すは、このブラウザに保存されます。他の端末とは同期しません。"));
  const form = el("form", "cg-form");
  const url = el("input"); url.type = "url"; url.required = true; url.placeholder = "ChatGPT のチャットURL（/c/…）"; url.setAttribute("aria-label", "チャットURL");
  const title = el("input"); title.type = "text"; title.placeholder = "題（任意）"; title.setAttribute("aria-label", "チャットの題"); title.maxLength = 120;
  const addBtn = el("button", "cg-btn", "登録"); addBtn.type = "submit";
  form.append(url, title, addBtn);
  const status = el("div", "cg-status");
  const list = el("div");
  inner.append(form, status, list);
  let rendering = 0;
  async function render() {
    const n = ++rendering;
    try {
      const rows = (await all()).filter(c => c && canonical(c.url) && validTime(c.observedAt));
      if (n !== rendering) return;
      const open = rows.filter(c => !c.closedAt).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
      const closed = rows.filter(c => c.closedAt).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
      count.textContent = `開いているチャット ${open.length} 件`;
      list.textContent = "";
      if (!open.length) list.append(el("div", "cg-empty", "登録されたチャットはありません。拡張機能でChatGPTを開くか、上でURLを登録してください。"));
      for (const c of open) list.append(chatRow(c));
      if (closed.length) {
        const details = el("details", "cg-closed");
        details.append(el("summary", null, `最近外したチャットなど（${closed.length}件）`));
        for (const c of closed) details.append(chatRow(c));
        list.append(details);
      }
    } catch (_) { if (n === rendering) say("このブラウザの保存領域を読めませんでした。設定を確認してください。", true); }
  }
  function chatRow(c) {
    const row = el("div", "cg-row");
    const body = el("div", "cg-body");
    body.append(el("div", "cg-title", c.title || "（題なし）"));
    body.append(el("div", "cg-meta", `ブラウザで確認 ${fmt(c.observedAt)}${c.url.includes("/g/g-") ? " ・プロジェクト内" : ""}`));
    if (c.memo) body.append(el("div", "cg-memo", c.memo));
    const actions = el("div", "cg-acts");
    const edit = el("button", "cg-btn", "メモを直す");
    edit.type = "button";
    edit.onclick = () => {
      if (actions.querySelector("textarea")) return;
      const base = { memo: c.memo || "", version: c.memoVersion || 0 };
      const ta = el("textarea", "cg-edit"); ta.value = base.memo; ta.maxLength = 4000;
      const save = el("button", "cg-btn", "保存"); save.type = "button";
      const cancel = el("button", "cg-btn", "やめる"); cancel.type = "button";
      cancel.onclick = () => { ta.remove(); save.remove(); cancel.remove(); };
      save.onclick = async () => {
        if (Array.from(ta.value).length > MAX_MEMO) return say(`メモは${MAX_MEMO}字までです。`, true);
        try {
          const res = await transaction(c.id, current => {
            if (!current || (current.memo || "") !== base.memo || (current.memoVersion || 0) !== base.version) return { result: "conflict" };
            return { row: { ...current, memo: ta.value, memoVersion: base.version + 1 }, result: "ok" };
          });
          if (res === "conflict") return say("別画面でメモが変更されました。更新後に直してください（上書きしていません）。", true);
          say("メモを保存しました。"); await render();
        } catch (_) { say("メモを保存できませんでした。", true); }
      };
      actions.append(ta, save, cancel); ta.focus();
    };
    actions.append(edit);
    const toggle = el("button", "cg-btn", c.closedAt ? "戻す" : "外す");
    toggle.type = "button";
    let armed = false;
    toggle.onclick = async () => {
      if (!c.closedAt && !armed) {
        armed = true; toggle.textContent = "外す？（もう一度押す）";
        setTimeout(() => { armed = false; if (toggle.isConnected) toggle.textContent = "外す"; }, 4000);
        return;
      }
      armed = false;
      try {
        await transaction(c.id, current => ({
          row: current ? { ...current, closedAt: c.closedAt ? null : (current.closedAt || new Date().toISOString()) } : null,
          result: true,
        }));
        say(c.closedAt ? "一覧へ戻しました。" : "一覧から外しました。ChatGPT側の会話は削除していません。");
        await render();
      } catch (_) { say("変更できませんでした。", true); }
    };
    actions.append(toggle);
    body.append(actions);
    const a = el("a", "cg-open", "開く"); a.href = c.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    row.append(body, a);
    return row;
  }
  function requestExtension() {
    window.postMessage({ source: pageSource, type: "request" }, location.origin);
  }
  form.onsubmit = async e => {
    e.preventDefault();
    if (!canonical(url.value)) return say("ChatGPTの通常チャットURL（/c/…）を入れてください。共有リンクは自動登録の対象外です。", true);
    try {
      await add(url.value, title.value, new Date().toISOString());
      url.value = ""; title.value = ""; say("登録しました（このブラウザ内）。"); await render();
    } catch (_) { say("保存できませんでした。", true); }
  };
  reload.onclick = () => { requestExtension(); void render(); };
  tabs.addEventListener("click", e => {
    const b = e.target.closest(".tab"); if (!b) return;
    const wrap = document.querySelector(".wrap");
    if (b.dataset.view === "chats") setTimeout(() => { const n = document.getElementById("pname"); if (n && claude && claude.classList.contains("on")) n.textContent = "Claude"; }, 0);
    if (b.dataset.view === VIEW) {
      panel.hidden = false; stream.style.display = "none";
      wrap && wrap.classList.add("v-chatgpt");
      tabs.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t === b));
      setTimeout(() => { const n = document.getElementById("pname"); if (n && !panel.hidden) n.textContent = "ChatGPT"; }, 0);
      requestExtension(); void render();
    } else if (!panel.hidden) {
      panel.hidden = true; wrap && wrap.classList.remove("v-chatgpt");
      if (!document.querySelector(".ch-panel:not([hidden]), .tg-panel:not([hidden])")) stream.style.display = "";
    }
  });
  window.addEventListener("message", async e => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== extSource || e.data.type !== "snapshot") return;
    const entries = Array.isArray(e.data.entries) ? e.data.entries.slice(0, 500) : [];
    try {
      for (const c of entries) if (c && typeof c === "object") await add(c.url, c.title, c.observedAt);
      if (!panel.hidden) await render();
    } catch (_) { say("拡張機能からの登録を保存できませんでした。", true); }
  });
  requestExtension();
})();
