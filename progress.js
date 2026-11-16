// progress.js — Task Pulse「タスク」タブの自動進行状況。
// 鍵（#graph=…）がある時、handoff の GET /factory/events と GitHub REST から最新の進捗を取得し、
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
    if (opts.privateNote) d = d ? `${d}・merge の状態は非公開のため不明` : "merge の状態は非公開のため不明";
    return d;
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

  function buildRows(snapshot, ghData, options = {}) {
    const now = typeof options.now === "number" ? options.now : (options.now ? Date.parse(options.now) : Date.now());
    const prMap = parsePrReviews(snapshot);
    if (prMap.size === 0) return [];

    // Group by repository: "owner/repo" -> array of PR review records
    const repos = new Map();
    for (const pr of prMap.values()) {
      const repoKey = `${pr.owner}/${pr.repo}`;
      if (!repos.has(repoKey)) repos.set(repoKey, []);
      repos.get(repoKey).push(pr);
    }

    // Sort repository keys alphabetically for consistency
    const sortedRepoKeys = Array.from(repos.keys()).sort();
    const rows = [];
    let parentNo = 0;

    for (const repoKey of sortedRepoKeys) {
      const prList = repos.get(repoKey).sort((a, b) => a.pr - b.pr);

      // Lookup GitHub data for this repo
      let ghPulls = null;
      if (ghData) {
        if (typeof ghData.get === "function") {
          ghPulls = ghData.get(repoKey);
        } else if (repoKey in ghData) {
          ghPulls = ghData[repoKey];
        }
      }
      const ghMap = new Map();
      if (Array.isArray(ghPulls)) {
        for (const p of ghPulls) {
          if (p && Number.isSafeInteger(p.number)) {
            ghMap.set(p.number, p);
          }
        }
      }

      const childRows = [];
      for (const prReview of prList) {
        const ghPr = ghMap.get(prReview.pr);
        let status = "";
        let doneAt = "";
        let ki = "";
        let title = "";
        let privateRow = false;

        if (ghPr) {
          title = sanitizeText(ghPr.title);
          if (ghPr.created_at) ki = toDateString(ghPr.created_at);

          if (ghPr.merged_at) {
            const mergedMs = Date.parse(ghPr.merged_at);
            const diffMs = now - mergedMs;
            if (diffMs > SEVEN_DAYS_MS) {
              // 7日より前の merged は出さない
              continue;
            }
            status = "完了";
            doneAt = toDateString(ghPr.merged_at);
          } else if (ghPr.state === "closed") {
            // closed で merged でないものは出さない
            continue;
          } else {
            // open
            status = "進行中";
          }
        } else {
          // GitHub 404 (private) or failed fetch
          // merge 済みかどうかが分からないので、7日より前に最後に動いた行は進行中と偽らず出さない
          if (!prReview.observedAt || now - prReview.observedAt > SEVEN_DAYS_MS) continue;
          title = `PR #${prReview.pr}（題は非公開）`;
          ki = toDateString(prReview.observedAt);
          status = "進行中";
          privateRow = true;
        }

        const desc = formatDesc(prReview, { privateNote: privateRow });
        childRows.push({
          isParent: false,
          pr: prReview.pr,
          task: title,
          effort: "1",
          ki,
          status,
          doneAt,
          purpose: "開発",
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

  // GitHub の公開データだけを5分、sessionStorage に置く（未認証の rate limit＝60回/時を、タブの押し直しで使い切らないため）。鍵・events の中身は置かない。
  const GH_CACHE_MS = 5 * 60 * 1000;
  function readGhCache(repo) {
    try {
      const raw = sessionStorage.getItem("tp-gh-pulls:" + repo);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o.at !== "number" || Date.now() - o.at > GH_CACHE_MS) return null;
      return { pulls: Array.isArray(o.pulls) ? o.pulls : null };
    } catch {
      return null;
    }
  }
  function writeGhCache(repo, pulls) {
    try {
      const slim = Array.isArray(pulls)
        ? pulls.map((p) => ({ number: p.number, title: p.title, state: p.state, merged_at: p.merged_at, created_at: p.created_at }))
        : null;
      sessionStorage.setItem("tp-gh-pulls:" + repo, JSON.stringify({ at: Date.now(), pulls: slim }));
    } catch {
      /* 保存できなくても動く */
    }
  }

  let seq = 0;

  async function refresh() {
    const key = readKey();
    if (!key) {
      banner.hidden = true;
      banner.textContent = "";
      return;
    }
    const mySeq = ++seq;
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
      if (!data || typeof data !== "object" || !data.snapshot) throw new Error("invalid snapshot");
      if (mySeq !== seq) return;

      const prMap = parsePrReviews(data.snapshot);
      const uniqueRepos = new Set();
      for (const pr of prMap.values()) {
        uniqueRepos.add(`${pr.owner}/${pr.repo}`);
      }

      const ghByRepo = new Map();
      await Promise.all(
        Array.from(uniqueRepos).map(async (repoFullName) => {
          const cached = readGhCache(repoFullName);
          if (cached) {
            ghByRepo.set(repoFullName, cached.pulls);
            return;
          }
          try {
            const ghRes = await fetch(
              `https://api.github.com/repos/${repoFullName}/pulls?state=all&sort=updated&direction=desc&per_page=30`,
              {
                method: "GET",
                credentials: "omit",
                referrerPolicy: "no-referrer",
                headers: { Accept: "application/vnd.github.v3+json" },
              }
            );
            if (ghRes.ok) {
              const pulls = await ghRes.json();
              if (Array.isArray(pulls)) {
                ghByRepo.set(repoFullName, pulls);
                writeGhCache(repoFullName, pulls);
                return;
              }
            }
            ghByRepo.set(repoFullName, null);
            writeGhCache(repoFullName, null);
          } catch {
            ghByRepo.set(repoFullName, null);
          }
        })
      );

      if (mySeq !== seq) return;

      const rows = buildRows(data.snapshot, ghByRepo);
      const md = toMarkdown(rows);

      if (typeof window.load === "function") {
        window.load(md);
      } else if (typeof load === "function") {
        load(md);
      }

      banner.className = "progress-status";
      banner.hidden = false;
      const t = data.received_at ? new Date(data.received_at) : new Date();
      banner.textContent = "取得 " + fmt(isNaN(t.getTime()) ? new Date() : t);
    } catch {
      if (mySeq !== seq) return;
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
      banner.hidden = true;
    }
  });

  // Initial load
  void refresh();
})();
