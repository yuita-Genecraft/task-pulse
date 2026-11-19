// progress.js — Task Pulse「タスク」タブの自動進行状況。
// 鍵（#graph=…）がある時、handoff の GET /factory/events（cc-jobs が足した node.pr＝PR の題・merge の状態を含む）から最新の進捗を取得し、
// markdown 表に変換してタスク一覧を更新する。鍵が無い時は tasks.md のまま。
(() => {
  "use strict";

  const EVENTS_URL = "https://handoff-mcp.gooooerer.workers.dev/factory/events";
  const TASK_ID_RE = /^cc-jobs:pr:([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)-(\d+)(?::[^:]*)?$/;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  function readKey(hash = typeof location !== "undefined" ? location.hash : "") {
    const h = String(hash || "").replace(/^#/, "");
    if (!h) return "";
    return (new URLSearchParams(h).get("graph") || "").trim();
  }

  function fmt(d) {
    const j = new Date(d.getTime() + 9 * 3600000);
    const p = (n) => String(n).padStart(2, "0");
    return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
  }

  function toDateString(val) {
    if (!val) return "";
    const ms = typeof val === "number" ? val : Date.parse(val);
    if (!Number.isFinite(ms)) return "";
    const j = new Date(ms + 9 * 3600000);
    const y = j.getUTCFullYear();
    const m = String(j.getUTCMonth() + 1).padStart(2, "0");
    const d = String(j.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function sanitizeText(s) {
    return String(s ?? "")
      .replace(/\|/g, "｜")
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  function formatDesc({ verdict, round, findings, state, stale }, opts = {}) {
    const roundStr = round ? `${round}回目` : "";
    const parts = [roundStr];
    if (Number.isSafeInteger(findings) && findings >= 0) parts.push(`指摘${findings}件`);
    const detail = parts.filter(Boolean).join("・");
    const tail = detail ? `（${detail}）` : "";
    let d = "";
    if (stale) d = "審査の記録が古い";
    else if (verdict === "BLOCK" || verdict === "PASS" || verdict === "REVIEW") d = `審査 ${verdict}${tail}`;
    else if (state === "failed") d = "審査が失敗";
    else if (state === "running") d = round ? `審査中（${roundStr}）` : "審査中";
    else if (state === "queued" || state === "waiting") d = "審査待ち";
    if (opts.unknownMerge) d = d ? `${d}・merge の状態は不明（取れていない）` : "merge の状態は不明（取れていない）";
    else if (opts.checkedAt) d = d ? `${d}・確認 ${fmt(new Date(opts.checkedAt))}` : `確認 ${fmt(new Date(opts.checkedAt))}`;
    return d;
  }

  // cc-jobs が node に足す pr（題・merge の状態）。形が違えば無い物として扱う（嘘の表示を作らない）。
  const PR_STATES = new Set(["OPEN", "MERGED", "CLOSED"]);
  const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
  // 暦に無い日付（2026-02-30・2026-99-99）を通さない：読み戻して年月日時分秒が同じか確かめる
  function realIso(str) {
    if (typeof str !== "string") return false;
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?Z$/.exec(str);
    if (!m) return false;
    const d = new Date(str);
    if (!Number.isFinite(d.getTime())) return false;
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() + 1 === +m[2] && d.getUTCDate() === +m[3] && d.getUTCHours() === +m[4] && d.getUTCMinutes() === +m[5] && d.getUTCSeconds() === +m[6];
  }

  function validPr(p) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 120) return null;
    if (!PR_STATES.has(p.state)) return null;
    if (!realIso(p.checkedAt)) return null;
    let mergedAt = null;
    if (p.mergedAt !== null && p.mergedAt !== undefined) {
      if (!realIso(p.mergedAt)) return null;
      mergedAt = p.mergedAt;
    }
    if (p.state === "MERGED" && !mergedAt) return null;
    if (p.state !== "MERGED" && mergedAt) return null; // 送り手の約束：mergedAt は MERGED の時だけ
    return { title: p.title, state: p.state, mergedAt, checkedAt: p.checkedAt };
  }

  function parsePrReviews(snapshot) {
    const prMap = new Map();
    if (!snapshot || typeof snapshot !== "object") return prMap;

    function processItem(item) {
      if (!item || typeof item !== "object") return;
      const taskId = String(item.id || item.task || "");
      const m = TASK_ID_RE.exec(taskId);
      if (!m) return;
      const owner = m[1];
      const repo = m[2];
      const pr = Number(m[3]);
      const key = `${owner}/${repo}#${pr}`;

      let entry = prMap.get(key);
      if (!entry) {
        entry = {
          owner,
          repo,
          pr,
          verdict: null,
          round: null,
          findings: null,
          pr_info: null,
          stale: false,
          state: null,
          observedAt: null,
        };
        prMap.set(key, entry);
      }

      if (item.state && typeof item.state === "string") {
        entry.state = item.state;
      }
      if (item.stale === true) entry.stale = true;
      const pi = validPr(item.pr);
      if (pi) entry.pr_info = pi;
      if (item.verdict && typeof item.verdict === "string") {
        entry.verdict = item.verdict.toUpperCase();
      } else if (item.reason && typeof item.reason === "string") {
        const vm = item.reason.match(/^\s*(PASS|BLOCK|REVIEW)\b/i);
        if (vm) entry.verdict = vm[1].toUpperCase();
      }

      if (item.title && typeof item.title === "string" && /第(\d+)回/.test(item.title)) {
        entry.round = Number(item.title.match(/第(\d+)回/)[1]);
      } else if (item.attempt && typeof item.attempt === "string" && /-r(\d+)(?:-|$)/.test(item.attempt)) {
        entry.round = Number(item.attempt.match(/-r(\d+)(?:-|$)/)[1]);
      }

      if (item.reason && typeof item.reason === "string") {
        const pm = item.reason.match(/指摘\s*(\d+)\s*件/);
        if (pm) entry.findings = Number(pm[1]);
      }

      const timeVal = item.observedAt || item.at || item.registeredAt;
      if (timeVal) {
        const ms = typeof timeVal === "number" ? timeVal : Date.parse(timeVal);
        if (Number.isFinite(ms)) {
          if (!entry.observedAt || ms >= entry.observedAt) {
            entry.observedAt = ms;
          }
        }
      }
    }

    if (Array.isArray(snapshot.nodes)) {
      for (const node of snapshot.nodes) processItem(node);
    }
    if (Array.isArray(snapshot.events)) {
      for (const ev of snapshot.events) processItem(ev);
    }
    if (Array.isArray(snapshot.tasks)) {
      for (const t of snapshot.tasks) {
        processItem(t);
        if (Array.isArray(t.attempts)) {
          for (const att of t.attempts) processItem({ ...att, task: t.task });
        }
      }
    }
    if (Array.isArray(snapshot)) {
      for (const item of snapshot) processItem(item);
    }

    return prMap;
  }

  function buildRows(snapshot, options = {}) {
    const now = typeof options.now === "number" ? options.now : (options.now ? Date.parse(options.now) : Date.now());
    const prMap = parsePrReviews(snapshot);
    if (prMap.size === 0) return [];

    // repo ごとにまとめる："owner/repo" -> PR の審査の記録
    const repos = new Map();
    for (const pr of prMap.values()) {
      const repoKey = `${pr.owner}/${pr.repo}`;
      if (!repos.has(repoKey)) repos.set(repoKey, []);
      repos.get(repoKey).push(pr);
    }

    const sortedRepoKeys = Array.from(repos.keys()).sort();
    const rows = [];
    let parentNo = 0;

    for (const repoKey of sortedRepoKeys) {
      const prList = repos.get(repoKey).sort((a, b) => a.pr - b.pr);

      const childRows = [];
      for (const prReview of prList) {
        const info = prReview.pr_info;
        let status = "";
        let doneAt = "";
        let ki = "";
        let title = "";
        let purpose = "開発";

        if (info) {
          const cleanTitle = sanitizeText(info.title);
          title = `#${prReview.pr} ${cleanTitle}`;
          const m = /^【([^】]+)】/.exec(cleanTitle);
          if (m && m[1].trim()) {
            purpose = m[1].trim();
          }
          if (info.state === "OPEN") {
            status = "進行中";
          } else if (info.state === "MERGED") {
            if (now - Date.parse(info.mergedAt) > SEVEN_DAYS_MS) continue; // 7日より前の merged は出さない
            status = "完了";
            doneAt = toDateString(info.mergedAt);
          } else {
            continue; // merge されずに閉じた物は出さない
          }
        } else {
          // 題も merge の状態も取れていない行。merge 済みか分からないので、7日より前に最後に動いた行は進行中と偽らず出さない
          if (!prReview.observedAt || now - prReview.observedAt > SEVEN_DAYS_MS) continue;
          title = `PR #${prReview.pr}（題なし）`;
          ki = toDateString(prReview.observedAt);
          status = "進行中";
        }

        const desc = formatDesc(prReview, info ? { checkedAt: info.checkedAt } : { unknownMerge: true });
        childRows.push({
          isParent: false,
          pr: prReview.pr,
          task: title,
          effort: "1",
          ki,
          status,
          doneAt,
          purpose,
          core: "",
          desc,
          note: "",
        });
      }

      // If no children survived filtering, do not output parent row
      if (childRows.length === 0) continue;

      parentNo++;
      const allDone = childRows.every((c) => c.status === "完了");
      const parentRow = {
        isParent: true,
        no: String(parentNo),
        task: repoKey,
        effort: "",
        ki: "",
        status: allDone ? "完了" : "進行中",
        doneAt: "",
        purpose: "開発",
        core: "",
        desc: "",
        note: "",
      };
      rows.push(parentRow);

      childRows.forEach((c, idx) => {
        c.no = `${parentNo}.${idx + 1}`;
        rows.push(c);
      });
    }

    return rows;
  }

  function toMarkdown(rows) {
    const header = "| No | タスク | 工数 | 起案日 | 状態 | 完了日 | 目的 | 核 | 説明 | 備考 |";
    const divider = "|----|--------|-----:|--------|------|--------|------|----|------|------|";
    const lines = [header, divider];
    for (const r of rows) {
      lines.push(
        `| ${sanitizeText(r.no)} | ${sanitizeText(r.task)} | ${sanitizeText(r.effort)} | ${sanitizeText(r.ki)} | ${sanitizeText(r.status)} | ${sanitizeText(r.doneAt)} | ${sanitizeText(r.purpose)} | ${sanitizeText(r.core)} | ${sanitizeText(r.desc)} | ${sanitizeText(r.note)} |`
      );
    }
    return lines.join("\n");
  }

  // Node (pure test environment without DOM)
  if (typeof document === "undefined") {
    if (typeof module === "object" && module.exports) {
      module.exports = {
        readKey,
        fmt,
        toDateString,
        sanitizeText,
        formatDesc,
        parsePrReviews,
        buildRows,
        toMarkdown,
      };
    }
    return;
  }

  // Browser / DOM environment
  const stream = document.getElementById("stream");
  const tabs = document.getElementById("tabs");
  if (!stream || !tabs) return;

  const css = document.createElement("style");
  css.textContent = `
  .progress-status{padding:6px 14px;font:11px/1.4 var(--mono);color:var(--muted);background:var(--surface);border-bottom:1px solid var(--line-soft)}
  .progress-status.error{color:var(--late);background:rgba(244,112,122,.08)}
  `;
  document.head.appendChild(css);

  const banner = document.createElement("div");
  banner.id = "progressStatus";
  banner.className = "progress-status";
  banner.hidden = true;
  stream.insertAdjacentElement("beforebegin", banner);

  let seq = 0;

  const onTasksTab = () => {
    const on = document.querySelector(".tab.on");
    return !on || on.dataset.view === "tasks";
  };

  // 鍵が無くなった時：取得中の応答を無効にし、出ていた題（private）を消して元の表（tasks.md／サンプル）へ戻す
  function dropLive() {
    seq++;
    banner.hidden = true;
    banner.textContent = "";
    if (window.__liveTasks) {
      window.__liveTasks = false;
      // 元の表（tasks.md／サンプル）がまだ届いていなければ、空の表を置いて題を消す（届いたら index.html がそれを表示する）
      const base = typeof window.__baseText === "string" ? window.__baseText : toMarkdown([]);
      if (typeof window.load === "function") window.load(base, true);
    }
  }

  async function refresh() {
    const key = readKey();
    if (!key) {
      dropLive();
      return;
    }
    const mySeq = ++seq;
    // 取得の最中に、別のタブへ移った・鍵が外れた・鍵が替わった時は、この応答を捨てる
    const stale = () => mySeq !== seq || readKey() !== key || !onTasksTab();
    try {
      const res = await fetch(EVENTS_URL, {
        method: "GET",
        headers: { authorization: "Bearer " + key },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("events fetch failed");
      const data = await res.json();
      if (!data || typeof data !== "object" || !data.snapshot || typeof data.snapshot !== "object" || !Array.isArray(data.snapshot.nodes)) throw new Error("invalid snapshot");
      if (stale()) return;

      const rows = buildRows(data.snapshot);
      const md = toMarkdown(rows);

      window.__liveTasks = true; // 遅れて届く tasks.md が live の表を上書きしない（index.html が見る）
      if (typeof window.load === "function") {
        window.load(md);
      } else if (typeof load === "function") {
        load(md);
      }

      banner.className = "progress-status";
      banner.hidden = false;
      const t = data.received_at ? new Date(data.received_at) : new Date();
      banner.textContent = "取得 " + fmt(isNaN(t.getTime()) ? new Date() : t) + "（merge の状態は各行の確認時刻の時点）";
    } catch {
      if (stale()) return;
      banner.className = "progress-status error";
      banner.hidden = false;
      banner.textContent = "取得に失敗";
    }
  }

  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    if (b.dataset.view === "tasks") {
      if (banner.textContent) banner.hidden = false;
      void refresh();
    } else {
      seq++; // 取得中の応答を捨てる（タブを戻さない・帯を出さない）
      banner.hidden = true;
    }
  });

  window.addEventListener("hashchange", () => {
    if (!readKey()) dropLive();
    else void refresh();
  });

  // Initial load
  void refresh();
})();
