// autonomy.js in the real page: index.html with every one of its scripts (inlined, so nothing is fetched from the
// network), in jsdom. Every fetch of the page goes to a stub here.
//   tabs   : every ordered pair of tabs (the existing ones and autonomy) → after each click exactly the panel of the
//            clicked tab is shown (the task stream only for タスク / ポスト化スタンバイ) and only that tab is "on"
//   band   : the ゆいた待ち band is text only — no tabindex, no role, nothing happens on a click or a key
//   order  : the cards and the ゆいた待ち band are newest first (last_activity_at), no readable time at the bottom,
//            the same time in handoff's order
//   sending: a note being sent survives a re-render (the 更新 button, a # change): the redrawn field stays locked and
//            a second send of the lane posts nothing; when the first POST resolves, the redrawn field shows it
// Needs tests/node_modules (cd tests && npm ci). Usage: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const PULSE = "https://handoff-mcp.gooooerer.workers.dev/pulse";
const NOTE = PULSE + "/note";

// The page's own timers (the チャット tab polls while it is open) would keep the run alive: close every window.
const opened = [];
test.afterEach(() => {
  while (opened.length) opened.pop().window.close();
});

function page({ hash = "#graph=read-key&note=note-key-0123456789-0123456789", lanes: given } = {}) {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  html = html.replace(/<script src="([^"]+)" defer><\/script>/g, (_, f) => `<script>${fs.readFileSync(path.join(ROOT, f), "utf8").replace(/<\/script/g, "<\\/script")}</script>`);
  const calls = [];
  const held = [];
  const lanes = given || [
    { id: "lane-a", focus: "本丸A", last_activity_at: new Date().toISOString(), position: pos("ゆいた", "ゆいた｜確認してほしい") },
    { id: "lane-b", focus: null, last_activity_at: null, position: pos("なし", "なし") },
  ];
  const dom = new JSDOM(html, {
    url: "https://yuita-genecraft.github.io/task-pulse/" + hash,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, method: init.method || "GET", body: init.body });
        if (u === PULSE) return Promise.resolve(res(w, 200, { generated_at: "x", lanes }));
        if (u === NOTE) return new Promise((resolve) => held.push(() => resolve(res(w, 201, { ok: true, id: "t1" }))));
        return Promise.resolve(res(w, 404, null));
      };
      // jsdom has no IndexedDB (the ChatGPT tab keeps its local list there): an open that never completes is enough
      // for the tab switching measured here.
      w.indexedDB = { open: () => ({}) };
      w.HTMLElement.prototype.scrollIntoView = function () {
        w.__scrolled = (w.__scrolled || 0) + 1;
      };
    },
  });
  opened.push(dom);
  return { dom, w: dom.window, d: dom.window.document, calls, held };
}
const pos = (kind, wait) => ({ date: "2026-10-25", reached: cap("到達"), next: cap("次"), wait: { kind, text: cap(wait) }, evidence: cap("r") });
const cap = (text) => ({ text, truncated: false });
function res(w, status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const tick = (w, n = 3) => new Promise((r) => (function loop(i) { i ? w.setTimeout(() => loop(i - 1), 0) : r(); })(n));
const shown = (n) => !!n && !n.hidden && n.style.display !== "none";

test("every ordered pair of tabs: only the clicked tab's panel is shown, only that tab is on", async () => {
  const { w, d } = page();
  await tick(w);
  const tabs = [...d.querySelectorAll("#tabs .tab")];
  const views = tabs.map((t) => t.dataset.view);
  assert.ok(views.includes("autonomy") && views.includes("taskgraf") && views.includes("chats") && views.length >= 6, views.join(","));
  const panelOf = { taskgraf: ".tg-panel", chats: ".ch-panel", chatgpt: ".cg-panel", codex: ".cg-panel", autonomy: ".au-panel" };
  const expect = (v) => {
    const stream = d.getElementById("stream");
    const want = { stream: v === "tasks" || v === "standby" };
    for (const [view, sel] of Object.entries(panelOf)) want[sel] = (want[sel] || false) || view === v;
    const got = { stream: shown(stream) };
    for (const sel of new Set(Object.values(panelOf))) got[sel] = [...d.querySelectorAll(sel)].some(shown);
    for (const sel of Object.keys(got)) if (!(sel in want)) want[sel] = false;
    return { want, got, on: tabs.filter((t) => t.classList.contains("on")).map((t) => t.dataset.view) };
  };
  for (const a of views) {
    for (const b of views) {
      if (a === b) continue;
      d.querySelector(`#tabs .tab[data-view="${a}"]`).click();
      await tick(w);
      d.querySelector(`#tabs .tab[data-view="${b}"]`).click();
      await tick(w);
      const r = expect(b);
      assert.deepEqual(r.got, r.want, `${a} → ${b}`);
      assert.deepEqual(r.on, [b], `${a} → ${b}: the on tab`);
    }
  }
});

test("the ゆいた待ち band is text only: no tabindex, no role, a click or a key does nothing", async () => {
  const { w, d } = page();
  d.querySelector('#tabs .tab[data-view="autonomy"]').click();
  await tick(w, 6);
  const rows = [...d.querySelectorAll(".au-band .au-bandrow")];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].textContent, "lane-aゆいた｜確認してほしい");
  for (const n of [d.querySelector(".au-band"), ...d.querySelectorAll(".au-band *")]) {
    assert.ok(!n.hasAttribute("tabindex") && !n.hasAttribute("role") && n.tagName !== "BUTTON" && n.tagName !== "A", n.outerHTML);
  }
  rows[0].click();
  rows[0].dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  rows[0].dispatchEvent(new w.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  await tick(w);
  assert.equal(w.__scrolled || 0, 0, "nothing scrolled");
});

test("the cards and the ゆいた待ち band are newest first; no readable time at the bottom; the same time keeps handoff's order", async () => {
  const at = (iso, id, kind = "なし") => ({ id, focus: null, last_activity_at: iso, position: pos(kind, kind === "ゆいた" ? "ゆいた｜" + id : "なし") });
  // handoff's order (project rowid), not the order of the times
  const lanes = [
    at("2026-10-20T00:00:00.000Z", "old", "ゆいた"),
    at(null, "never"),
    at("2026-10-25T00:30:00.000Z", "same-1", "ゆいた"),
    at("not a time", "garbage"),
    at("2026-10-25T09:10:00.000Z", "newest"),
    at("2026-10-25T00:30:00.000Z", "same-2", "ゆいた"),
    at("2026-10-24T12:00:00.000Z", "mid"),
  ];
  const { w, d } = page({ lanes });
  d.querySelector('#tabs .tab[data-view="autonomy"]').click();
  await tick(w, 6);
  const cards = [...d.querySelectorAll(".au-grid .au-card .au-name")].map((n) => n.textContent);
  assert.deepEqual(cards, ["newest", "same-1", "same-2", "mid", "old", "never", "garbage"]);
  const band = [...d.querySelectorAll(".au-band .au-bandrow b")].map((n) => n.textContent);
  assert.deepEqual(band, ["same-1", "same-2", "old"]);
});

for (const [how, redraw] of [
  ["the 更新 button", (d) => d.querySelector(".au-reload").click()],
  ["a # change", (d, w) => { w.location.hash = "#graph=read-key&note=note-key-0123456789-0123456789&x=1"; }],
]) {
  test(`a note being sent survives a re-render by ${how}: no second POST, the result lands in the redrawn field`, async () => {
    const { w, d, calls, held } = page();
    d.querySelector('#tabs .tab[data-view="autonomy"]').click();
    await tick(w, 6);
    const field = () => d.querySelector('.au-in[aria-label="lane-a への申送り"]');
    const sendBtn = () => field().parentElement.querySelector(".au-btn");
    field().value = "同じ本文";
    field().dispatchEvent(new w.Event("input"));
    sendBtn().click();
    await tick(w);
    const posts = () => calls.filter((c) => c.url === NOTE).length;
    assert.equal(posts(), 1, "the first send posted");
    const before = field();
    redraw(d, w);
    await tick(w, 6);
    assert.notEqual(field(), before, "the card was redrawn");
    assert.equal(field().value, "同じ本文", "the redrawn field shows the line being sent");
    assert.ok(field().disabled && sendBtn().disabled, "the redrawn field is locked while the POST is open");
    // Even past the lock (the button forced on, Enter in the field): nothing more is posted for the lane.
    sendBtn().disabled = false;
    sendBtn().click();
    field().disabled = false;
    field().dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(w);
    assert.equal(posts(), 1, "no second POST for the same lane while the first is open");
    // The other lane is not blocked.
    const other = d.querySelector('.au-in[aria-label="lane-b への申送り"]');
    assert.ok(!other.disabled, "another lane can still send");
    held.shift()();
    await tick(w, 6);
    assert.equal(field().value, "", "after 201 the redrawn field is emptied");
    assert.ok(!field().disabled, "and unlocked");
    assert.match(field().parentElement.parentElement.querySelector(".au-say").textContent, /送りました/);
    assert.equal(posts(), 1);
  });
}
