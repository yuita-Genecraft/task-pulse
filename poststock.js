(function (root, factory) {
  if (typeof exports === "object" && typeof module !== "undefined") {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define([], factory);
  } else {
    root.PostStock = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const BEGIN_MARKER = "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->";
  const END_MARKER = "<!--TOKA_QUALIFIED_STOCK_V1_END-->";
  const ID_RE = /^[0-9a-f]{24}$/;
  const SHA_RE = /^[0-9a-f]{64}$/;
  const IMAGE_URL_RE = /^https:\/\/drive\.google\.com\/file\/d\/[a-zA-Z0-9_-]+\/view$/;

  function parse(text) {
    if (typeof text !== "string") return null;

    const lines = text.split(/\r?\n/);
    const beginIndices = [];
    const endIndices = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === BEGIN_MARKER) beginIndices.push(i);
      if (line === END_MARKER) endIndices.push(i);
    }

    if (beginIndices.length === 0 && endIndices.length === 0) {
      return null;
    }

    if (beginIndices.length !== 1 || endIndices.length !== 1 || beginIndices[0] >= endIndices[0]) {
      throw new Error("Malformed managed block markers: begin=" + beginIndices.length + ", end=" + endIndices.length);
    }

    const blockLines = lines.slice(beginIndices[0] + 1, endIndices[0]);
    const contentLines = blockLines.filter(l => l.trim().length > 0);
    if (contentLines.length !== 1) {
      throw new Error("Malformed managed block: singleline JSON payload required");
    }

    let payload;
    try {
      payload = JSON.parse(contentLines[0].trim());
    } catch (e) {
      throw new Error("Malformed JSON in managed block: " + e.message);
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Malformed managed block: payload must be an object");
    }

    if (payload.version !== 1) {
      throw new Error("Unsupported managed block version: " + payload.version);
    }

    if (typeof payload.syncedAt !== "number" || !Number.isFinite(payload.syncedAt)) {
      throw new Error("Invalid or missing syncedAt in managed block");
    }

    if (!Array.isArray(payload.items)) {
      throw new Error("Malformed managed block: items must be an array");
    }

    const validItems = [];
    for (const item of payload.items) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.id !== "string" || !ID_RE.test(item.id)) continue;
      if (item.state !== "qualified" && item.state !== "reserved") continue;
      if (typeof item.frame !== "string") continue;
      if (typeof item.body !== "string") continue;
      if (typeof item.bodySha256 !== "string" || !SHA_RE.test(item.bodySha256)) continue;
      if (typeof item.expiresAt !== "number" || !Number.isFinite(item.expiresAt) || item.expiresAt <= 0) continue;
      if (typeof item.imageUrl !== "string" || !IMAGE_URL_RE.test(item.imageUrl)) continue;

      validItems.push({
        id: item.id,
        frame: item.frame,
        state: item.state,
        body: item.body,
        bodySha256: item.bodySha256,
        expiresAt: item.expiresAt,
        imageUrl: item.imageUrl
      });
    }

    return {
      version: payload.version,
      syncedAt: payload.syncedAt,
      items: validItems
    };
  }

  function formatDateTokyo(epochSec) {
    if (!epochSec || !Number.isFinite(epochSec)) return "";
    try {
      const d = new Date(epochSec * 1000);
      return new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(d);
    } catch (e) {
      const d = new Date((epochSec + 9 * 3600) * 1000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const h = String(d.getUTCHours()).padStart(2, "0");
      const min = String(d.getUTCMinutes()).padStart(2, "0");
      return y + "/" + m + "/" + day + " " + h + ":" + min;
    }
  }

  function copyToClipboard(text, doc) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    try {
      const d = doc || (typeof document !== "undefined" ? document : null);
      if (!d) return Promise.resolve(false);
      const ta = d.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      d.body.appendChild(ta);
      ta.select();
      const ok = d.execCommand ? d.execCommand("copy") : false;
      d.body.removeChild(ta);
      return Promise.resolve(ok);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function renderCard(item, doc) {
    const card = doc.createElement("div");
    card.className = "poststock-card" + (item.state === "reserved" ? " reserved" : "");
    card.dataset.id = item.id;

    const top = doc.createElement("div");
    top.className = "poststock-top";

    const frame = doc.createElement("span");
    frame.className = "poststock-frame";
    frame.textContent = item.frame;
    top.appendChild(frame);

    const exp = doc.createElement("span");
    exp.className = "poststock-exp";
    exp.textContent = "期限 " + formatDateTokyo(item.expiresAt);
    top.appendChild(exp);

    card.appendChild(top);

    const body = doc.createElement("div");
    body.className = "poststock-body";
    body.textContent = item.body;
    card.appendChild(body);

    const actions = doc.createElement("div");
    actions.className = "poststock-actions";

    const copyBtn = doc.createElement("button");
    copyBtn.className = "btn poststock-copy-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "本文をコピー";
    copyBtn.addEventListener("click", () => {
      copyToClipboard(item.body, doc).then(ok => {
        copyBtn.textContent = ok ? "コピー完了" : "コピー失敗";
        if (typeof setTimeout === "function") {
          setTimeout(() => {
            copyBtn.textContent = "本文をコピー";
          }, 2000);
        }
      });
    });
    actions.appendChild(copyBtn);

    const driveLink = doc.createElement("a");
    driveLink.className = "btn poststock-img-link";
    driveLink.href = item.imageUrl;
    driveLink.target = "_blank";
    driveLink.rel = "noopener noreferrer";
    driveLink.textContent = "画像を開く（Drive）";
    actions.appendChild(driveLink);

    card.appendChild(actions);
    return card;
  }

  function renderSection(state, options) {
    const doc = (options && options.document) || (typeof document !== "undefined" ? document : null);
    if (!doc) return null;

    const now = (options && typeof options.now === "number") ? options.now : Math.floor(Date.now() / 1000);
    const onReload = options && typeof options.onReload === "function" ? options.onReload : null;

    const section = doc.createElement("div");
    section.className = "poststock-section";

    if (!state || state.status === "absent") {
      const header = doc.createElement("div");
      header.className = "seclabel poststock-header";
      header.innerHTML = '<span>選べる完成稿</span><span class="ln"></span>';
      if (onReload) {
        const reloadBtn = doc.createElement("button");
        reloadBtn.className = "btn";
        reloadBtn.textContent = "再読込";
        reloadBtn.addEventListener("click", onReload);
        header.appendChild(reloadBtn);
      }
      section.appendChild(header);

      const msg = doc.createElement("div");
      msg.className = "poststock-status-box";
      msg.textContent = "完成稿の表示は準備中";
      section.appendChild(msg);
      return section;
    }

    if (state.status === "error") {
      const header = doc.createElement("div");
      header.className = "seclabel poststock-header";
      header.innerHTML = '<span>選べる完成稿</span><span class="ln"></span>';
      if (onReload) {
        const reloadBtn = doc.createElement("button");
        reloadBtn.className = "btn";
        reloadBtn.textContent = "再読込";
        reloadBtn.addEventListener("click", onReload);
        header.appendChild(reloadBtn);
      }
      section.appendChild(header);

      const err = doc.createElement("div");
      err.className = "poststock-error-box";
      err.textContent = "完成稿の読み込みエラー: " + (state.error || "データ取得に失敗しました");
      section.appendChild(err);
      return section;
    }

    const items = (state.data && Array.isArray(state.data.items)) ? state.data.items : [];
    const activeItems = items.filter(it => it.expiresAt > now);
    const availableItems = activeItems.filter(it => it.state === "qualified");
    const reservedItems = activeItems.filter(it => it.state === "reserved");

    const header = doc.createElement("div");
    header.className = "seclabel poststock-header";
    header.innerHTML = '<span>選べる完成稿 ' + availableItems.length + '本／目標3本</span><span class="ln"></span>';
    if (onReload) {
      const reloadBtn = doc.createElement("button");
      reloadBtn.className = "btn";
      reloadBtn.textContent = "再読込";
      reloadBtn.addEventListener("click", onReload);
      header.appendChild(reloadBtn);
    }
    section.appendChild(header);

    if (availableItems.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "poststock-empty";
      empty.textContent = "現在利用可能な完成稿はありません（0本）";
      section.appendChild(empty);
    } else {
      for (const item of availableItems) {
        section.appendChild(renderCard(item, doc));
      }
    }

    if (reservedItems.length > 0) {
      const resLabel = doc.createElement("div");
      resLabel.className = "seclabel";
      resLabel.innerHTML = '<span>予約済み</span><span class="cnt">' + reservedItems.length + '</span><span class="ln"></span>';
      section.appendChild(resLabel);

      for (const item of reservedItems) {
        section.appendChild(renderCard(item, doc));
      }
    }

    return section;
  }

  return {
    BEGIN_MARKER,
    END_MARKER,
    ID_RE,
    SHA_RE,
    IMAGE_URL_RE,
    parse,
    formatDateTokyo,
    copyToClipboard,
    renderCard,
    renderSection
  };
});
