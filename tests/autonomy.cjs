// autonomy.js — browser-independent checks: the pure helpers (loaded without a DOM, where the file exports them),
// and the rules the source must keep (no polling, no storage, no innerHTML, fixed endpoints, no LLM).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "autonomy.js");
const source = fs.readFileSync(file, "utf8");
const A = require(file);

const NOW = new Date("2026-10-24T14:00:00.000Z"); // 2026-10-24 23:00 JST
const cap = (text, truncated = false) => ({ text, truncated });
const pos = (kind, over = {}) => ({
  date: "2026-10-24",
  reached: cap("到達"),
  next: cap("次"),
  wait: { kind, text: cap(kind === "なし" ? "なし" : kind + "｜x") },
  evidence: cap("https://github.com/o/r/pull/1"),
  ...over,
});
const lane = (id, position = pos("なし"), over = {}) => ({ id, focus: "本丸", last_activity_at: "2026-10-24T10:00:00.000Z", position, ...over });

test("readPulse keeps the lanes whose shape fits and counts the rest", () => {
  const d = {
    generated_at: "x",
    lanes: [
      lane("a"),
      lane("b", null),
      lane("c", pos("ゆいた", { date: null, reached: null, next: null, evidence: null })),
      { id: 1 },
      lane("d", { ...pos("なし"), wait: { kind: 3, text: null } }),
      lane("e", { ...pos("なし"), reached: { text: "x" } }),
      null,
    ],
  };
  const r = A.readPulse(d);
  assert.deepEqual(r.lanes.map((l) => l.id), ["a", "b", "c"]);
  assert.equal(r.skipped, 4);
  assert.equal(A.readPulse({}), null);
  assert.equal(A.readPulse(null), null);
  assert.equal(A.readPulse({ lanes: "x" }), null);
});

test("waitKind: the four kinds, unknown, and a kind the page does not know yet", () => {
  for (const k of ["ゆいた", "他レーン", "外部", "なし", "unknown"]) assert.equal(A.waitKind(lane("x", pos(k))), k);
  assert.equal(A.waitKind(lane("x", pos("承認"))), "unknown");
  assert.equal(A.waitKind(lane("x", pos("__proto__"))), "unknown");
  assert.equal(A.waitKind(lane("x", null)), "unknown");
  assert.deepEqual(Object.keys(A.WAIT).sort(), ["unknown", "なし", "他レーン", "外部", "ゆいた"].sort());
});

test("the colors are the design's (ゆいた red, 他レーン yellow, 外部 blue, なし green, unknown gray)", () => {
  const cls = Object.fromEntries(Object.entries(A.WAIT).map(([k, v]) => [k, v.cls]));
  const color = (c) => new RegExp("\\." + c + "\\{--au-c:var\\(([^)]+)\\)\\}").exec(source)?.[1];
  assert.equal(color(cls["ゆいた"]), "--late");
  assert.equal(color(cls["他レーン"]), "--accent");
  assert.equal(color(cls["外部"]), "--prog");
  assert.equal(color(cls["なし"]), "--done");
  assert.equal(color(cls.unknown), "--muted");
});

test("daysOld / isStale count JST days; missing or unreadable dates are stale", () => {
  assert.equal(A.daysOld("2026-10-24", NOW), 0);
  assert.equal(A.daysOld("2026-10-23", NOW), 1);
  assert.equal(A.daysOld("2026-10-21", NOW), 3);
  assert.equal(A.daysOld("2026-10-25", new Date("2026-10-24T15:30:00.000Z")), 0, "00:30 JST on the 25th is that day");
  assert.equal(A.daysOld("2026/10/24", NOW), null);
  assert.equal(A.daysOld(null, NOW), null);
  assert.equal(A.isStale(lane("a", pos("なし", { date: "2026-10-23" })), NOW), false);
  assert.equal(A.isStale(lane("a", pos("なし", { date: "2026-10-22" })), NOW), true);
  assert.equal(A.isStale(lane("a", null), NOW), true);
  assert.equal(A.isStale(lane("a", pos("なし", { date: null })), NOW), true);
});

test("checkNote: trimmed, 1..300 code points, one line (same rule as handoff)", () => {
  assert.deepEqual(A.checkNote("  遅い  "), { ok: true, text: "遅い" });
  assert.equal(A.checkNote("").ok, false);
  assert.equal(A.checkNote("   ").ok, false);
  assert.equal(A.checkNote(null).ok, false);
  assert.equal(A.checkNote("あ".repeat(299) + "🙂").ok, true, "an emoji counts as one");
  assert.equal(A.checkNote("あ".repeat(301)).ok, false);
  assert.equal(A.checkNote("一\n二").ok, false);
  assert.equal(A.checkNote("a\tb").ok, false);
  assert.equal(A.NOTE_MAX, 300);
});

test("linkParts links only https on the allowed hosts, exactly", () => {
  const links = (t) => A.linkParts(t).filter((p) => p.href).map((p) => p.href);
  assert.deepEqual(links("PR https://github.com/o/r/pull/1 と https://claude.ai/code/session_x。"), [
    "https://github.com/o/r/pull/1",
    "https://claude.ai/code/session_x",
  ]);
  assert.deepEqual(links("http://github.com/x https://github.com.evil.example/x https://evil.example/github.com"), []);
  assert.deepEqual(links("https://user:pw@github.com/x https://github.com:8443/x"), []);
  assert.deepEqual(links("（https://github.com/o/r/pull/2）"), ["https://github.com/o/r/pull/2"]);
  assert.equal(A.linkParts("リンクなし").map((p) => p.text).join(""), "リンクなし");
  const t = "a https://github.com/x b";
  assert.equal(A.linkParts(t).map((p) => p.text).join(""), t, "the text is kept whole");
});

test("noteError never shows the server's text, and says what to do", () => {
  assert.match(A.noteError(-1, null), /書く鍵がありません/);
  assert.match(A.noteError(0, null), /届きませんでした/);
  assert.match(A.noteError(404, { error: "no active lane" }), /有効ではありません/);
  assert.match(A.noteError(404, null), /鍵が違う/);
  assert.match(A.noteError(400, { error: "text looks like a secret (ghp_)" }), /秘密の形/);
  assert.match(A.noteError(400, { error: "<b>x</b>" }), /受け付けられませんでした（400）/);
  assert.ok(!A.noteError(400, { error: "<b>x</b>" }).includes("<b>"));
  assert.match(A.noteError(500, null), /エラーです（500）/);
});

test("the fixed endpoints", () => {
  assert.equal(A.PULSE_URL, "https://handoff-mcp.gooooerer.workers.dev/pulse");
  assert.equal(A.NOTE_URL, "https://handoff-mcp.gooooerer.workers.dev/pulse/note");
  const fetches = [...source.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches.sort(), ["NOTE_URL", "PULSE_URL"]);
});

test("the rules the source keeps", () => {
  const code = source.replace(/^\s*\/\/.*$/gm, ""); // comments may name what is not done
  assert.ok(!/setInterval/.test(code), "no polling");
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code), "keys are not stored");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), "text goes in through textContent only");
  assert.ok(!/console\./.test(code), "nothing in the console");
  assert.ok(!/anthropic|openai|generativelanguage|\/v1\/messages|\/v1\/chat/i.test(code), "no LLM");
  assert.ok(!/<script|import\(|importScripts|new Function|eval\(/.test(code), "no other code is loaded");
  assert.ok(/credentials: "omit"/.test(code) && /referrerPolicy: "no-referrer"/.test(code) && /cache: "no-store"/.test(code));
  assert.ok(/location\.hash/.test(code) && !/location\.search/.test(code), "keys come from the # only");
  // the read key goes only to /pulse and the write key only to /pulse/note
  const pulse = /fetch\(PULSE_URL[\s\S]*?\}\);/.exec(code)[0];
  const note = /fetch\(NOTE_URL[\s\S]*?\}\);/.exec(code)[0];
  assert.match(code, /const key = readKeys\(\)\.graph;\s*if \(!key\)/);
  assert.match(code, /const key = readKeys\(\)\.note;\s*if \(!key\) return \{ status: -1/);
  assert.match(pulse, /method: "GET"/);
  assert.match(note, /method: "POST"/);
  assert.ok(!/propose_card|get_cards|consume_card|cards\/answer|CARD_TOKEN|承認/i.test(code), "no approval cards (the lane cards are only the list)");
});
