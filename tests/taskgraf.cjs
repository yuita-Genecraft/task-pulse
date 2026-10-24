// taskgraf.js — the order of the lanes outside the center (newestFirst, loaded without a DOM).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const G = require(path.join(__dirname, "..", "taskgraf.js"));
const at = (id, t) => ({ id, last_activity_at: t });
const order = (ls) => G.newestFirst(ls).map((l) => l.id);

test("newestFirst: newest first, no readable time at the bottom (below any real time), the same time keeps the order", () => {
  assert.deepEqual(order([at("a", "2026-10-24T01:00:00.000Z"), at("b", "2026-10-25T01:00:00.000Z"), at("c", "2026-10-23T01:00:00.000Z")]), ["b", "a", "c"]);
  // a time before 1970 (negative ms) is still above a missing or unreadable one
  assert.deepEqual(order([at("bad", "x"), at("none", null), at("old", "1969-12-31T00:00:00.000Z"), at("empty", "")]), ["old", "bad", "none", "empty"]);
  assert.deepEqual(order([at("p", "2026-10-25T00:00:00.000Z"), at("q", "2026-10-25T09:00:00+09:00"), at("r", "2026-10-25T00:00:00.000Z")]), ["p", "q", "r"]);
  assert.deepEqual(order([at("r", "2026-10-25T00:00:00.000Z"), at("q", "2026-10-25T09:00:00+09:00"), at("p", "2026-10-25T00:00:00.000Z")]), ["r", "q", "p"]);
  const ls = [at("a", "2026-10-24T00:00:00.000Z"), at("b", "2026-10-25T00:00:00.000Z")];
  G.newestFirst(ls);
  assert.deepEqual(ls.map((l) => l.id), ["a", "b"], "the input is not changed");
});
