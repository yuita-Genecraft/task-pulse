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

function page({ hash = "", serveEvents, serveGithub, serveTasks } = {}) {
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
          if (serveTasks) return serveTasks();
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

const NOW0 = Date.parse("2026-11-16T12:00:00Z");
// cc-jobs が node に足す pr（題・merge の状態）
const PR = (state, o = {}) => ({ title: o.title === undefined ? "題 " + state : o.title, state, mergedAt: o.mergedAt === undefined ? (state === "MERGED" ? "2026-11-14T12:00:00Z" : null) : o.mergedAt, checkedAt: o.checkedAt || "2026-11-16T11:30:00Z" });
const withPr = (node, pr) => Object.assign(node, { pr });
const prRows = (nodes, opts = { now: NOW0 }) => P.buildRows({ nodes }, opts).filter((r) => !r.isParent);

test("AC2: 鍵あり＝/factory/events に Bearer を付けて1回・api.github.com は一度も呼ばない", async () => {
  const KEY = "my-secret-key-12345";
  const SNAP = {
    nodes: [
      withPr(N("ownerA__repo1-1", { state: "running" }), PR("OPEN")),
      withPr(N("ownerA__repo1-2", { state: "done", reason: "PASS" }), PR("MERGED")),
      N("ownerB__repo2-1", { state: "failed", reason: "BLOCK 指摘2件" }),
    ],
    edges: [],
    source: { kind: "execution-events", graphGeneratedAt: "2026-11-16T00:00:00.000Z" },
  };
  const { w, calls } = page({
    hash: `#graph=${KEY}`,
    serveEvents: (init) => {
      assert.equal(init.headers.authorization, "Bearer " + KEY);
      return { ok: true, status: 200, json: async () => ({ received_at: "2026-11-16T10:00:00.000Z", snapshot: SNAP }) };
    },
  });
  await tick(w, 25);
  const eventCalls = calls.filter((c) => c.url.includes("factory/events"));
  assert.equal(eventCalls.length, 1);
  assert.equal(eventCalls[0].headers.authorization, "Bearer " + KEY);
  assert.equal(calls.filter((c) => c.url.includes("api.github.com") || c.url.includes("github.com/")).length, 0, "GitHub は呼ばない");
});

test("AC3: OPEN→進行中・MERGED(3日前)→完了＋完了日・MERGED(10日前)→出ない・CLOSED→出ない", () => {
  const rows = prRows([
    withPr(N("o__r-1"), PR("OPEN", { title: "開いている" })),
    withPr(N("o__r-2", { state: "done", reason: "PASS" }), PR("MERGED", { title: "3日前に merge", mergedAt: "2026-11-13T12:00:00Z" })),
    withPr(N("o__r-3", { state: "done", reason: "PASS" }), PR("MERGED", { title: "10日前に merge", mergedAt: "2026-11-06T12:00:00Z" })),
    withPr(N("o__r-4"), PR("CLOSED", { title: "閉じただけ" })),
  ]);
  assert.deepEqual(rows.map((r) => r.task), ["開いている", "3日前に merge"]);
  assert.equal(rows[0].status, "進行中");
  assert.equal(rows[1].status, "完了");
  assert.equal(rows[1].doneAt, "2026-11-13");
});

test("AC4: node.pr が無い行は「PR #N（題なし）」・7日以内だけ・説明に「merge の状態は不明」", () => {
  const rows = prRows([
    N("o__r-1", { state: "failed", reason: "BLOCK 指摘3件", round: 2, at: NOW0 - 86400000 }),
    N("o__r-2", { state: "done", reason: "PASS", at: NOW0 - 8 * 86400000 }),
    N("o__r-3", { state: "done", reason: "PASS", at: null }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task, "PR #1（題なし）");
  assert.equal(rows[0].status, "進行中");
  assert.equal(rows[0].desc, "審査 BLOCK（2回目・指摘3件）・merge の状態は不明（取れていない）");
  assert.ok(!rows[0].desc.includes("非公開"));
});

test("AC5: 題の | と改行で表が壊れない", () => {
  const rows = P.buildRows({ nodes: [withPr(N("test-org__repo-1"), PR("OPEN", { title: "fix(ui): table | split | bar\r\nand linebreaks\nshould be clean" }))] }, { now: NOW0 });
  const md = P.toMarkdown(rows);
  const lines = md.split("\n").filter((l) => l.startsWith("|"));
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    assert.equal(line.replace(/^\||\|$/g, "").split("|").length, 10, "each row has exactly 10 columns");
    assert.ok(!line.includes("\n") && !line.includes("\r"));
  }
  assert.ok(md.includes("fix(ui): table ｜ split ｜ bar and linebreaks should be clean"));
});

test("AC5b: node.pr の形が不正（state・title・checkedAt・mergedAt）なら無い扱い", () => {
  const bad = [
    PR("OPEN", { title: 5 }),
    PR("OPEN", { title: "" }),
    PR("OPEN", { title: "x".repeat(121) }),
    { title: "t", state: "open", mergedAt: null, checkedAt: "2026-11-16T11:30:00Z" },
    { title: "t", state: "OPEN", mergedAt: null, checkedAt: "yesterday" },
    { title: "t", state: "MERGED", mergedAt: null, checkedAt: "2026-11-16T11:30:00Z" },
    { title: "t", state: "MERGED", mergedAt: "not-a-time", checkedAt: "2026-11-16T11:30:00Z" },
    "string",
    [],
  ];
  for (const b of bad) {
    const rows = prRows([withPr(N("o__r-1", { state: "done", reason: "PASS" }), b)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task, "PR #1（題なし）", JSON.stringify(b));
  }
});

test("AC6: 取得失敗で既存の表のまま", async () => {
  const { w, d } = page({ hash: "#graph=some-key", serveEvents: () => ({ ok: false, status: 500, json: async () => null }) });
  await tick(w, 25);
  const banner = d.getElementById("progressStatus");
  assert.ok(banner);
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, "取得に失敗");
  assert.ok(d.querySelectorAll(".card").length > 0, "previous task cards still exist");
});

test("AC6b: 成功すると帯に取得時刻と「確認時刻の時点」が出て、説明に確認時刻が出る", async () => {
  const snap = { nodes: [withPr(N("o__r-1", { state: "done", reason: "PASS" }), PR("OPEN", { title: "進行中の題", checkedAt: "2026-11-16T11:30:00Z" }))] };
  const { w, d } = page({ hash: "#graph=k", serveEvents: () => ({ ok: true, status: 200, json: async () => ({ received_at: "2026-11-16T12:00:00.000Z", snapshot: snap }) }) });
  await tick(w, 25);
  assert.match(d.getElementById("progressStatus").textContent, /^取得 11\/16 21:00（merge の状態は各行の確認時刻の時点）$/);
  assert.ok(d.body.textContent.includes("進行中の題"));
  assert.ok(d.body.textContent.includes("確認 11/16 20:30"));
});

test("AC7: 純関数（buildRows／toMarkdown）が node で呼べる", () => {
  assert.equal(typeof P.buildRows, "function");
  assert.equal(typeof P.toMarkdown, "function");
  const rows = P.buildRows({ nodes: [withPr(N("a__b-1"), PR("OPEN", { title: "Test" }))] }, { now: NOW0 });
  const md = P.toMarkdown(rows);
  assert.ok(md.includes("| No | タスク |") && md.includes("a/b") && md.includes("Test"));
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


// ---- 実物の形の説明 ----
const descOf = (nodes) => prRows(nodes).map((r) => r.desc);

test("説明：PASS／BLOCK 指摘1件／failed 終了コード／審査中／stale は実物の reason と title から。P0/P1 とは書かない", () => {
  const d = descOf([
    N("o__r-1", { state: "done", reason: "PASS", round: 3 }),
    N("o__r-2", { state: "failed", reason: "BLOCK 指摘1件", round: 2 }),
    N("o__r-3", { state: "failed", reason: "終了コード 1" }),
    N("o__r-4", { state: "running", round: 1 }),
    N("o__r-5", { state: "unknown", stale: true, reason: "PASS" }),
  ]);
  const u = "・merge の状態は不明（取れていない）";
  assert.deepEqual(d, ["審査 PASS（3回目）" + u, "審査 BLOCK（2回目・指摘1件）" + u, "審査が失敗" + u, "審査中（1回目）" + u, "審査の記録が古い" + u]);
  assert.ok(!d.join("").includes("P0/P1"));
});

test("round は title の「第N回」、無ければ attempt の -rN-", () => {
  const n = N("o__r-1", { state: "done", reason: "PASS" });
  n.title = "審査 repo";
  n.attempt = "codex-review-20261116-ccj-pr1-r4-9440f33";
  assert.deepEqual(descOf([n]), ["審査 PASS（4回目）・merge の状態は不明（取れていない）"]);
});


// ---- r2：Codex r1 の指摘①〜⑤（先に赤を見てから直した試験） ----
const later = (w, ms) => new Promise((r) => w.setTimeout(r, ms));
const okEvents = (snap) => ({ ok: true, status: 200, json: async () => ({ received_at: "2026-11-16T12:00:00.000Z", snapshot: snap }) });
const liveSnap = (title) => ({ nodes: [withPr(N("o__r-1", { state: "done", reason: "PASS" }), PR("OPEN", { title, checkedAt: new Date().toISOString() }))] });

test("R2-1: tasks.md の取得が live の表より後に届いても、live の表を上書きしない", async () => {
  let releaseTasks;
  const gate = new Promise((r) => (releaseTasks = r));
  const { w, d } = page({
    hash: "#graph=k",
    serveEvents: () => okEvents(liveSnap("ライブの題R2-1")),
    serveTasks: async () => { await gate; return { ok: true, status: 200, text: async () => SAMPLE_TASKS_MD }; },
  });
  await tick(w, 25);
  assert.ok(d.body.textContent.includes("ライブの題R2-1"), "live が先に出る");
  releaseTasks();
  await tick(w, 25);
  assert.ok(d.body.textContent.includes("ライブの題R2-1"), "遅れて届いた tasks.md が live を消した");
});

test("R2-2: 取得中に別のタブへ移ったら、応答が来てもタブを戻さず帯も出さない（失敗の時も）", async () => {
  for (const mode of ["ok", "fail"]) {
    let release;
    const gate = new Promise((r) => (release = r));
    const { w, d } = page({ hash: "#graph=k", serveEvents: async () => { await gate; return mode === "ok" ? okEvents(liveSnap("題R2-2")) : { ok: false, status: 500, json: async () => null }; } });
    await tick(w, 10);
    d.querySelector('.tab[data-view="standby"]').click();
    await tick(w, 5);
    release();
    await tick(w, 25);
    assert.equal(d.querySelector(".tab.on").dataset.view, "standby", mode + ": タブが tasks に戻された");
    assert.equal(d.getElementById("progressStatus").hidden, true, mode + ": 別のタブで帯が出た");
  }
});

test("R2-3: 鍵を外したら、取得中の応答の題を出さない・すでに出た題は消える", async () => {
  // (a) 取得中に鍵を外す
  let release;
  const gate = new Promise((r) => (release = r));
  const a = page({ hash: "#graph=k", serveEvents: async () => { await gate; return okEvents(liveSnap("秘密の題R2-3a")); } });
  await tick(a.w, 10);
  a.w.location.hash = "";
  await tick(a.w, 5);
  release();
  await tick(a.w, 25);
  assert.ok(!a.d.body.textContent.includes("秘密の題R2-3a"), "鍵を外した後に private の題が出た");
  // (b) 出た後に鍵を外す
  const b = page({ hash: "#graph=k", serveEvents: () => okEvents(liveSnap("秘密の題R2-3b")) });
  await tick(b.w, 25);
  assert.ok(b.d.body.textContent.includes("秘密の題R2-3b"));
  b.w.location.hash = "";
  await tick(b.w, 25);
  assert.ok(!b.d.body.textContent.includes("秘密の題R2-3b"), "鍵を外しても出た題が残った");
  assert.ok(b.d.body.textContent.includes("Sample"), "元の表に戻る");
});

test("R2-4: 形の壊れた成功応答は、既存の表を消さずに「取得に失敗」", async () => {
  for (const bad of [{ snapshot: true }, { snapshot: { nodes: "invalid" } }, { snapshot: {} }, { snapshot: [] }]) {
    const { w, d } = page({ hash: "#graph=k", serveEvents: () => ({ ok: true, status: 200, json: async () => bad }) });
    await tick(w, 25);
    assert.equal(d.getElementById("progressStatus").textContent, "取得に失敗", JSON.stringify(bad));
    assert.ok(d.body.textContent.includes("Sample"), "既存の表が消えた " + JSON.stringify(bad));
  }
});

test("R2-5: node.pr は OPEN／CLOSED に mergedAt があれば不正・暦に無い日付（2026-02-30・2026-99-99）は不正", () => {
  const bads = [
    PR("OPEN", { mergedAt: "2026-11-14T12:00:00Z" }),
    PR("CLOSED", { mergedAt: "2026-11-14T12:00:00Z" }),
    PR("MERGED", { mergedAt: "2026-02-30T12:00:00Z" }),
    PR("MERGED", { mergedAt: "2026-99-99T99:99:99Z" }),
    PR("OPEN", { checkedAt: "2026-02-30T12:00:00Z" }),
    PR("OPEN", { checkedAt: "2026-11-31T00:00:00Z" }),
  ];
  for (const b of bads) {
    const rows = prRows([withPr(N("o__r-1", { state: "done", reason: "PASS" }), b)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task, "PR #1（題なし）", JSON.stringify(b));
  }
  const ok = prRows([withPr(N("o__r-1", { state: "done", reason: "PASS" }), PR("OPEN", { title: "正しい題" }))]);
  assert.equal(ok[0].task, "正しい題");
});
