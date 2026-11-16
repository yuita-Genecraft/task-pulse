// tests/progress.cjs — Task Pulse「タスク」タブの自動進行状況のテスト。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "progress.js"));

const SAMPLE_TASKS_MD = [
  "| No | タスク | 工数 | 起案日 | 状態 | 完了日 | 目的 | 核 | 説明 | 備考 |",
  "|----|--------|-----:|--------|------|--------|------|----|------|------|",
  "| 1   | Sample |      | 2026-06-12 | 進行中 |        | 開発 |    | サンプル |      |",
  "| 1.1 | Task 1 | 1    | 2026-06-12 | 進行中 |        | 開発 |    | 詳細     |      |",
].join("\n");

// 実物の snapshot.nodes の形（cc-jobs/flow-foundry/factory-events-send.mjs）：verdict・round・p01_count は無い。reason は "PASS" | "BLOCK 指摘N件" | "REVIEW" | "終了コード N"。
const N = (task, o = {}) => ({ id: "cc-jobs:pr:" + task, title: o.title || "審査 repo 第" + (o.round || 1) + "回", owner: "審査", goal: false, kind: "process", state: o.state || "running", attempt: o.attempt || "codex-review-x-r" + (o.round || 1) + "-abc", reason: o.reason, observedAt: o.at === undefined ? Date.parse("2026-11-16T11:00:00Z") : o.at, stale: !!o.stale });

const opened = [];
test.afterEach(() => {
  while (opened.length) opened.pop().window.close();
});

const tick = (w, n = 20) => new Promise((r) => (function loop(i) { i ? w.setTimeout(() => loop(i - 1), 0) : r(); })(n));

function page({ hash = "", serveEvents, serveGithub } = {}) {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  // Replace script tags with inlined script content
  html = html.replace(/<script\s+(?:defer\s+)?src="([^"]+)"(?:\s+defer)?><\/script>/g, (_, f) => {
    const code = fs.readFileSync(path.join(ROOT, f), "utf8");
    return `<script>${code.replace(/<\/script/g, "<\\/script")}</script>`;
  });

  const calls = [];
  const dom = new JSDOM(html, {
    url: "https://yuita-genecraft.github.io/task-pulse/" + hash,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({
          url: u,
          method: init.method || "GET",
          headers: init.headers || {},
          credentials: init.credentials,
          referrerPolicy: init.referrerPolicy,
        });
        if (u === "https://handoff-mcp.gooooerer.workers.dev/factory/events") {
          if (serveEvents) return serveEvents(init);
          return { ok: false, status: 404, json: async () => null, text: async () => "" };
        }
        if (u.startsWith("https://api.github.com/repos/")) {
          if (serveGithub) return serveGithub(u, init);
          return { ok: false, status: 404, json: async () => null, text: async () => "" };
        }
        if (u.endsWith("tasks.md")) {
          return { ok: true, status: 200, text: async () => SAMPLE_TASKS_MD };
        }
        return { ok: false, status: 404, json: async () => null, text: async () => "" };
      };
      w.indexedDB = { open: () => ({}) };
      w.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  opened.push(dom);
  return { dom, w: dom.window, d: dom.window.document, calls };
}

test("AC1: 鍵なし＝fetch しない", async () => {
  const { w, calls } = page({ hash: "" });
  await tick(w, 25);
  const relevant = calls.filter((c) => c.url.includes("factory/events") || c.url.includes("api.github.com"));
  assert.equal(relevant.length, 0, "no fetch calls to events or github when no key");
});

test("AC2: 鍵あり＝/factory/events に Bearer を付けて1回、repo ごとに GitHub を1回", async () => {
  const KEY = "my-secret-key-12345";
  const SNAP = {
    nodes: [
      N("ownerA__repo1-1", { state: "running" }),
      N("ownerA__repo1-2", { state: "done", reason: "PASS" }),
      N("ownerB__repo2-1", { state: "failed", reason: "BLOCK 指摘2件" }),
    ],
    edges: [],
    source: { kind: "execution-events", graphGeneratedAt: "2026-11-16T00:00:00.000Z" },
  };

  const { w, calls } = page({
    hash: `#graph=${KEY}`,
    serveEvents: (init) => {
      assert.equal(init.headers.authorization, "Bearer " + KEY);
      return {
        ok: true,
        status: 200,
        json: async () => ({ received_at: "2026-11-16T10:00:00.000Z", snapshot: SNAP }),
      };
    },
    serveGithub: (_url, init) => {
      assert.ok(!init.headers.authorization, "GitHub call has no auth token");
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    },
  });

  await tick(w, 25);

  const eventCalls = calls.filter((c) => c.url.includes("factory/events"));
  assert.equal(eventCalls.length, 1, "exactly 1 call to /factory/events with Bearer key");
  assert.equal(eventCalls[0].headers.authorization, "Bearer " + KEY);

  const ghCalls = calls.filter((c) => c.url.includes("api.github.com"));
  assert.equal(ghCalls.length, 2, "exactly 1 call per unique repo (ownerA/repo1 and ownerB/repo2)");
  assert.ok(ghCalls.some((c) => c.url.includes("ownerA/repo1/pulls")));
  assert.ok(ghCalls.some((c) => c.url.includes("ownerB/repo2/pulls")));
});

test("AC3: open→進行中・7日以内 merged→完了・それ以外は出ない", () => {
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const SNAP = {
    nodes: [
      N("test-org__app-1", { state: "running" }),
      N("test-org__app-2", { state: "done", reason: "PASS" }),
      N("test-org__app-3", { state: "done", reason: "PASS" }),
      N("test-org__app-4", { state: "failed", reason: "終了コード 1" }),
    ],
  };
  const ghPulls = [
    { number: 1, title: "PR1 Open", state: "open", merged_at: null, created_at: "2026-11-15T00:00:00Z" },
    { number: 2, title: "PR2 Merged 3d ago", state: "closed", merged_at: "2026-11-13T12:00:00Z", created_at: "2026-11-10T00:00:00Z" },
    { number: 3, title: "PR3 Merged 10d ago", state: "closed", merged_at: "2026-11-06T12:00:00Z", created_at: "2026-11-05T00:00:00Z" },
    { number: 4, title: "PR4 Closed Not Merged", state: "closed", merged_at: null, created_at: "2026-11-12T00:00:00Z" },
  ];
  const ghData = { "test-org/app": ghPulls };
  const rows = P.buildRows(SNAP, ghData, { now });
  const prRows = rows.filter((r) => !r.isParent);

  // Only PR 1 and PR 2 should appear
  assert.equal(prRows.length, 2);
  assert.equal(prRows[0].task, "PR1 Open");
  assert.equal(prRows[0].status, "進行中");
  assert.equal(prRows[0].doneAt, "");

  assert.equal(prRows[1].task, "PR2 Merged 3d ago");
  assert.equal(prRows[1].status, "完了");
  assert.equal(prRows[1].doneAt, "2026-11-13");
});

test("AC4: private（404）の行は題が「非公開」で、審査の状態は出る", () => {
  const SNAP = {
    nodes: [
      N("secret-org__hidden-repo-42", { state: "failed", round: 2, reason: "BLOCK 指摘3件" }),
    ],
  };
  // GitHub returns 404 / null for private repo
  const ghData = { "secret-org/hidden-repo": null };
  const rows = P.buildRows(SNAP, ghData, { now: Date.parse("2026-11-16T12:00:00Z") });
  const prRows = rows.filter((r) => !r.isParent);
  assert.equal(prRows.length, 1);
  assert.equal(prRows[0].task, "PR #42（題は非公開）");
  assert.equal(prRows[0].status, "進行中");
  assert.equal(prRows[0].desc, "審査 BLOCK（2回目・指摘3件）・merge の状態は非公開のため不明");
});

test("AC5: | や改行を含む title が表を壊さない", () => {
  const SNAP = {
    nodes: [
      N("test-org__repo-1", { state: "running" }),
    ],
  };
  const ghData = {
    "test-org/repo": [
      { number: 1, title: "fix(ui): table | split | bar\r\nand linebreaks\nshould be clean", state: "open", merged_at: null },
    ],
  };
  const rows = P.buildRows(SNAP, ghData);
  const md = P.toMarkdown(rows);

  const lines = md.split("\n").filter((l) => l.startsWith("|"));
  assert.ok(lines.length >= 3); // header + divider + parent + child
  for (const line of lines) {
    const cols = line.replace(/^\||\|$/g, "").split("|");
    assert.equal(cols.length, 10, "each row must have exactly 10 columns without stray pipes");
    assert.ok(!line.includes("\n"), "no raw newlines in markdown line");
    assert.ok(!line.includes("\r"), "no raw carriage returns in markdown line");
  }
  // Title should have fullwidth ｜ instead of ASCII |
  assert.ok(md.includes("fix(ui): table ｜ split ｜ bar and linebreaks should be clean"));
});

test("AC6: 取得失敗で既存の表のまま", async () => {
  const { w, d } = page({
    hash: "#graph=some-key",
    serveEvents: () => ({ ok: false, status: 500, json: async () => null }),
  });
  await tick(w, 25);
  const banner = d.getElementById("progressStatus");
  assert.ok(banner);
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, "取得に失敗");
  // Previous table (tasks.md or sample) remains intact
  const cards = d.querySelectorAll(".card");
  assert.ok(cards.length > 0, "previous task cards still exist");
});

test("AC7: pure 関数（buildRows／toMarkdown）が node で呼べる", () => {
  assert.equal(typeof P.buildRows, "function");
  assert.equal(typeof P.toMarkdown, "function");
  const rows = P.buildRows(
    { nodes: [N("a__b-1", { state: "running" })] },
    { "a/b": [{ number: 1, title: "Test", state: "open" }] }
  );
  assert.ok(Array.isArray(rows));
  const md = P.toMarkdown(rows);
  assert.ok(typeof md === "string");
  assert.ok(md.includes("| No | タスク |"));
  assert.ok(md.includes("a/b"));
  assert.ok(md.includes("Test"));
});

test("秘密の形: 大小文字・%エンコードされた鍵が console/DOM/localStorage/エラーメッセージに出ない", async () => {
  const RAW_KEY = "Secret_Key+Abc/123==";
  const ENCODED_KEY = encodeURIComponent(RAW_KEY); // "Secret_Key%2BAbc%2F123%3D%3D"

  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  let eventAuthHeader = null;
  const { w, d } = page({
    hash: `#graph=${ENCODED_KEY}`,
    serveEvents: (init) => {
      eventAuthHeader = init.headers.authorization;
      return { ok: false, status: 500, json: async () => null };
    },
  });

  try {
    await tick(w, 25);

    // 1. Authorization header received the decoded key exactly
    assert.equal(eventAuthHeader, "Bearer " + RAW_KEY);

    // 2. Secret does NOT appear in any console output
    for (const log of logs) {
      assert.ok(!log.includes(RAW_KEY), "raw key must not appear in console");
      assert.ok(!log.includes(ENCODED_KEY), "encoded key must not appear in console");
    }

    // 3. Secret does NOT appear in DOM
    const domHtml = d.body.innerHTML;
    assert.ok(!domHtml.includes(RAW_KEY), "raw key must not appear in DOM HTML");
    assert.ok(!domHtml.includes(ENCODED_KEY), "encoded key must not appear in DOM HTML");

    // 4. Secret does NOT appear in localStorage
    const lsKeys = Object.keys(w.localStorage || {});
    for (const k of lsKeys) {
      const val = w.localStorage.getItem(k);
      assert.ok(!k.includes(RAW_KEY) && !val.includes(RAW_KEY), "raw key must not be in localStorage");
    }

    // 5. Secret does NOT appear in error message
    const banner = d.getElementById("progressStatus");
    assert.equal(banner.textContent, "取得に失敗");
    assert.ok(!banner.textContent.includes(RAW_KEY));
    assert.ok(!banner.textContent.includes(ENCODED_KEY));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
});

// ---- 実物の形の説明・private の古い行・stale・GitHub の5分の置き場 ----
const NOW = Date.parse("2026-11-16T12:00:00Z");
const descOf = (nodes, gh = {}) => P.buildRows({ nodes }, gh, { now: NOW }).filter((r) => !r.isParent).map((r) => r.desc);

test("説明：PASS／BLOCK 指摘1件／failed 終了コード／審査中／stale は実物の reason と title から。P0/P1 とは書かない", () => {
  const d = descOf([
    N("o__r-1", { state: "done", reason: "PASS", round: 3 }),
    N("o__r-2", { state: "failed", reason: "BLOCK 指摘1件", round: 2 }),
    N("o__r-3", { state: "failed", reason: "終了コード 1" }),
    N("o__r-4", { state: "running", round: 1 }),
    N("o__r-5", { state: "unknown", stale: true, reason: "PASS" }),
  ]);
  assert.deepEqual(d, [
    "審査 PASS（3回目）・merge の状態は非公開のため不明",
    "審査 BLOCK（2回目・指摘1件）・merge の状態は非公開のため不明",
    "審査が失敗・merge の状態は非公開のため不明",
    "審査中（1回目）・merge の状態は非公開のため不明",
    "審査の記録が古い・merge の状態は非公開のため不明",
  ]);
  assert.ok(!d.join("").includes("P0/P1"));
});

test("round は title の「第N回」、無ければ attempt の -rN-", () => {
  const n = N("o__r-1", { state: "done", reason: "PASS" });
  n.title = "審査 repo";
  n.attempt = "codex-review-20261116-ccj-pr1-r4-9440f33";
  assert.deepEqual(descOf([n]), ["審査 PASS（4回目）・merge の状態は非公開のため不明"]);
});

test("private（GitHub が取れない）：7日より前に最後に動いた行は出ない・7日以内は出る", () => {
  const old = N("o__r-1", { state: "done", reason: "PASS", at: NOW - 8 * 86400000 });
  const fresh = N("o__r-2", { state: "done", reason: "PASS", at: NOW - 6 * 86400000 });
  const none = N("o__r-3", { state: "done", reason: "PASS", at: null });
  const rows = P.buildRows({ nodes: [old, fresh, none] }, { "o/r": null }, { now: NOW }).filter((r) => !r.isParent);
  assert.deepEqual(rows.map((r) => r.pr), [2]);
});

test("public（GitHub が取れる）：審査の記録が古くても open は進行中・題は GitHub の title", () => {
  const old = N("o__r-1", { state: "done", reason: "PASS", at: NOW - 30 * 86400000 });
  const rows = P.buildRows({ nodes: [old] }, { "o/r": [{ number: 1, title: "公開の題", state: "open", merged_at: null }] }, { now: NOW }).filter((r) => !r.isParent);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task, "公開の題");
  assert.equal(rows[0].status, "進行中");
  assert.ok(!rows[0].desc.includes("非公開"));
});

test("GitHub の取得結果は5分 sessionStorage に置かれ、2回目の開きでは GitHub を引かない（鍵・events は置かない）", async () => {
  const KEY = "cachekey-abcdef";
  const snap = { nodes: [N("o__r-1", { state: "done", reason: "PASS" })] };
  const serve = {
    hash: `#graph=${KEY}`,
    serveEvents: () => ({ ok: true, status: 200, json: async () => ({ received_at: "2026-11-16T10:00:00.000Z", snapshot: snap }) }),
    serveGithub: () => ({ ok: true, status: 200, json: async () => [{ number: 1, title: "T", state: "open", merged_at: null, extra: "drop" }] }),
  };
  const first = page(serve);
  await tick(first.w, 25);
  assert.equal(first.calls.filter((c) => c.url.includes("api.github.com")).length, 1);
  const stored = Object.entries(Object.assign({}, first.w.sessionStorage)).filter(([k]) => k.startsWith("tp-gh-pulls:"));
  assert.equal(stored.length, 1);
  assert.ok(!stored[0][1].includes(KEY) && !stored[0][1].includes("extra"));
  // 同じ window で、タブを押し直す
  first.calls.length = 0;
  first.d.querySelector('#tabs .tab[data-view="tasks"]').click();
  await tick(first.w, 25);
  assert.equal(first.calls.filter((c) => c.url.includes("api.github.com")).length, 0, "5分の間は GitHub を引かない");
  assert.equal(first.calls.filter((c) => c.url.includes("factory/events")).length, 1, "events は毎回取り直す");
});
