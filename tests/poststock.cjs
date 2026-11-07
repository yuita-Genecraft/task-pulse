const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const PostStock = require("../poststock.js");

describe("PostStock Unit and Integration Tests", () => {
  const sampleManagedBlock = [
    "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->",
    JSON.stringify({
      version: 1,
      syncedAt: 1794020000,
      items: [
        {
          id: "1234567890abcdef12345678",
          frame: "技",
          state: "qualified",
          body: "exact final body\nwith newline & special chars <script>alert(1)</script>",
          bodySha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          expiresAt: 1794110000,
          imageUrl: "https://drive.google.com/file/d/DRIVE_FILE_ID_1/view"
        }
      ]
    }),
    "<!--TOKA_QUALIFIED_STOCK_V1_END-->"
  ].join("\n");

  test("1. parse exact body, missing managed block, and malformed blocks", () => {
    // Exact body preserved
    const res = PostStock.parse(sampleManagedBlock);
    assert.ok(res);
    assert.equal(res.version, 1);
    assert.equal(res.syncedAt, 1794020000);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].body, "exact final body\nwith newline & special chars <script>alert(1)</script>");

    // Absent managed block returns null
    const absent = PostStock.parse("## Just markdown\nNo markers here.");
    assert.equal(absent, null);

    // Malformed: missing END marker throws
    assert.throws(() => {
      PostStock.parse("<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->\n{\"version\":1}\n");
    }, /Malformed managed block markers/);

    // Malformed: duplicate BEGIN marker throws
    assert.throws(() => {
      PostStock.parse(
        "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->\n<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->\n{\"version\":1}\n<!--TOKA_QUALIFIED_STOCK_V1_END-->"
      );
    }, /Malformed managed block markers/);

    // Malformed: invalid JSON throws
    assert.throws(() => {
      PostStock.parse("<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->\n{invalid_json\n<!--TOKA_QUALIFIED_STOCK_V1_END-->");
    }, /Malformed JSON/);

    // Malformed: unsupported version throws
    assert.throws(() => {
      PostStock.parse(
        "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->\n{\"version\":2,\"syncedAt\":1,\"items\":[]}\n<!--TOKA_QUALIFIED_STOCK_V1_END-->"
      );
    }, /Unsupported managed block version/);
  });

  test("2. safe DOM rendering, whitelisted href, exact body textContent, and clipboard copy", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "poststock.js"), "utf8"));
    const doc = dom.window.document;

    const validItem = {
      id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      frame: "枠",
      state: "qualified",
      body: "XSS test: <img src=x onerror=alert('xss')> | Markdown table | marker <!--word-->",
      bodySha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      expiresAt: 2000000000,
      imageUrl: "https://drive.google.com/file/d/VALID_ID_123/view"
    };

    const invalidIdPayload = [
      "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->",
      JSON.stringify({
        version: 1,
        syncedAt: 1794020000,
        items: [
          {
            id: "short_id",
            frame: "枠",
            state: "qualified",
            body: "invalid id",
            bodySha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            expiresAt: 2000000000,
            imageUrl: "https://drive.google.com/file/d/VALID_ID_123/view"
          }
        ]
      }),
      "<!--TOKA_QUALIFIED_STOCK_V1_END-->"
    ].join("\n");

    const unsafeUrlPayload = [
      "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->",
      JSON.stringify({
        version: 1,
        syncedAt: 1794020000,
        items: [
          {
            id: "bbbbbbbbbbbbbbbbbbbbbbbb",
            frame: "枠",
            state: "qualified",
            body: "unsafe url",
            bodySha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            expiresAt: 2000000000,
            imageUrl: "javascript:alert(1)"
          }
        ]
      }),
      "<!--TOKA_QUALIFIED_STOCK_V1_END-->"
    ].join("\n");

    const validPayload = [
      "<!--TOKA_QUALIFIED_STOCK_V1_BEGIN-->",
      JSON.stringify({
        version: 1,
        syncedAt: 1794020000,
        items: [validItem]
      }),
      "<!--TOKA_QUALIFIED_STOCK_V1_END-->"
    ].join("\n");

    assert.throws(() => {
      PostStock.parse(invalidIdPayload);
    }, /Invalid item/);

    assert.throws(() => {
      PostStock.parse(unsafeUrlPayload);
    }, /Invalid item/);

    const parsed = PostStock.parse(validPayload);
    assert.equal(parsed.items.length, 1, "Only the whitelisted and valid item is retained");

    const section = dom.window.PostStock.renderSection({ status: "ready", data: parsed }, { document: doc, now: 1000000000 });
    doc.body.appendChild(section);

    // Verify safe DOM: textContent preserves exact string, no <img> injected
    const bodyEl = section.querySelector(".poststock-body");
    assert.ok(bodyEl);
    assert.equal(bodyEl.textContent, "XSS test: <img src=x onerror=alert('xss')> | Markdown table | marker <!--word-->");
    assert.equal(section.querySelectorAll("img").length, 0, "No <img> element created from untrusted HTML in body");

    // Whitelisted anchor
    const anchor = section.querySelector("a.poststock-img-link");
    assert.ok(anchor);
    assert.equal(anchor.href, "https://drive.google.com/file/d/VALID_ID_123/view");
    assert.equal(anchor.rel, "noopener noreferrer");

    // Clipboard copy exact text
    let copiedText = "";
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t) => {
          copiedText = t;
        }
      }
    });
    const copyBtn = section.querySelector("button.poststock-copy-btn");
    copyBtn.click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(copiedText, "XSS test: <img src=x onerror=alert('xss')> | Markdown table | marker <!--word-->");
    assert.equal(copyBtn.textContent, "コピー完了");
    dom.window.close();
  });

  test("3. reserved vs available counts, expiry filtering, and Japanese Asia/Tokyo formatting", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const doc = dom.window.document;
    const now = 1794000000;

    const testData = {
      version: 1,
      syncedAt: now,
      items: [
        {
          id: "111111111111111111111111",
          frame: "技",
          state: "qualified",
          body: "Active available 1",
          bodySha256: "0".repeat(64),
          expiresAt: now + 3600, // active
          imageUrl: "https://drive.google.com/file/d/ID1/view"
        },
        {
          id: "222222222222222222222222",
          frame: "枠",
          state: "qualified",
          body: "Expired qualified",
          bodySha256: "0".repeat(64),
          expiresAt: now - 3600, // expired
          imageUrl: "https://drive.google.com/file/d/ID2/view"
        },
        {
          id: "333333333333333333333333",
          frame: "型",
          state: "reserved",
          body: "Active reserved",
          bodySha256: "0".repeat(64),
          expiresAt: now + 7200, // active
          imageUrl: "https://drive.google.com/file/d/ID3/view"
        },
        {
          id: "444444444444444444444444",
          frame: "型",
          state: "reserved",
          body: "Expired reserved",
          bodySha256: "0".repeat(64),
          expiresAt: now - 7200, // expired
          imageUrl: "https://drive.google.com/file/d/ID4/view"
        }
      ]
    };

    const section = PostStock.renderSection({ status: "ready", data: testData }, { document: doc, now });
    // Title includes: 選べる完成稿 1本／目標3本 (excludes expired and reserved)
    const header = section.querySelector(".poststock-header");
    assert.ok(header.textContent.includes("選べる完成稿 1本／目標3本"));

    // Reserved separate group
    assert.ok(section.textContent.includes("予約済み"));
    const cards = section.querySelectorAll(".poststock-card");
    assert.equal(cards.length, 2, "Only non-expired cards (1 available, 1 reserved) are rendered");

    // Tokyo date check
    const formattedDate = PostStock.formatDateTokyo(1794110000);
    assert.ok(typeof formattedDate === "string" && formattedDate.length > 0);
  });

  test("4. absent block and error state rendering without false 0", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const doc = dom.window.document;

    // Absent block shows 完成稿の表示は準備中
    const absentSection = PostStock.renderSection({ status: "absent" }, { document: doc });
    assert.ok(absentSection.querySelector(".poststock-status-box"));
    assert.equal(absentSection.querySelector(".poststock-status-box").textContent, "完成稿の表示は準備中");

    // Error state shows error box, not false 0
    const errorSection = PostStock.renderSection({ status: "error", error: "Fetch 500" }, { document: doc });
    assert.ok(errorSection.querySelector(".poststock-error-box"));
    assert.ok(errorSection.querySelector(".poststock-error-box").textContent.includes("Fetch 500"));
    assert.ok(!errorSection.textContent.includes("0本／目標3本"), "Error state must not display false 0");
  });

  test("5. integration: loadStandby updates both manual and new qualified section in index.html", async () => {
    const htmlPath = path.join(__dirname, "..", "index.html");
    let htmlContent = fs.readFileSync(htmlPath, "utf8");

    htmlContent = htmlContent.replace(/<script\s+src="([^"]+)"(?:\s+defer)?\s*><\/script>/g, (_, src) => {
      const scriptPath = path.join(__dirname, "..", src);
      try {
        return `<script>${fs.readFileSync(scriptPath, "utf8").replace(/<\/script/g, "<\\/script")}</script>`;
      } catch {
        return "";
      }
    });

    const payload = [
      "| ネタ | 主張 | 手元の骨 | 残作業 | 鮮度 |",
      "|---|---|---|---|---|",
      "| 手動スタンバイ1 | 手動の主張 | 骨データ | 本文化のみ | 今日 |",
      "",
      sampleManagedBlock
    ].join("\n");

    let resolveFeed;
    const feedGate = new Promise((resolve) => {
      resolveFeed = resolve;
    });

    const dom = new JSDOM(htmlContent, {
      runScripts: "dangerously",
      url: "https://example.com/index.html",
      beforeParse(window) {
        if (!window.indexedDB) {
          window.indexedDB = {
            open: () => {
              const req = {
                result: {
                  createObjectStore: () => ({ createIndex: () => {} }),
                  transaction: () => ({
                    objectStore: () => ({
                      get: () => ({ onsuccess: null }),
                      put: () => ({ onsuccess: null }),
                      getAll: () => ({ onsuccess: null })
                    })
                  })
                },
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
                addEventListener: () => {},
                removeEventListener: () => {}
              };
              setTimeout(() => {
                if (req.onsuccess) req.onsuccess({ target: req });
              }, 0);
              return req;
            }
          };
        }

        window.fetch = (url) => {
          if (String(url).includes("pub/poststock")) {
            return feedGate.then(() => ({
              ok: true,
              status: 200,
              text: async () => payload
            }));
          }
          return Promise.resolve({ ok: false, status: 404, text: async () => "" });
        };
      }
    });

    try {
      const doc = dom.window.document;

      // Switch to standby tab
      const tabs = doc.querySelectorAll(".tab");
      const standbyTab = Array.from(tabs).find(t => t.dataset.view === "standby");
      assert.ok(standbyTab, "Standby tab button exists with data-view=standby");
      standbyTab.click();

      // Resolve controlled feed
      resolveFeed();

      // Await actual async fetch completion (bounded <= 2sec)
      const start = Date.now();
      while (Date.now() - start < 2000) {
        if (doc.querySelector(".poststock-section") && doc.querySelector(".scard")) {
          break;
        }
        await new Promise(r => setTimeout(r, 20));
      }

      const stream = doc.getElementById("stream");
      assert.ok(stream.querySelector(".poststock-section"), "New 完成稿 section rendered");
      assert.ok(stream.querySelector(".scard"), "Existing manual standby card rendered");

      // Assertions actual DOM body/copybutton/qualifiedcount and actual legacy .scard contains manual topic FROM FEED
      const bodyEl = stream.querySelector(".poststock-body");
      assert.ok(bodyEl, "Card body rendered");
      assert.equal(bodyEl.textContent, "exact final body\nwith newline & special chars <script>alert(1)</script>");

      const copyBtn = stream.querySelector(".poststock-copy-btn");
      assert.ok(copyBtn, "Copy button rendered");
      assert.equal(copyBtn.textContent, "本文をコピー");

      const header = stream.querySelector(".poststock-header");
      assert.ok(header, "PostStock header rendered");
      assert.ok(header.textContent.includes("選べる完成稿 1本／目標3本"), "Qualified count matches");

      const scard = stream.querySelector(".scard");
      assert.ok(scard.textContent.includes("手動スタンバイ1"), "Legacy .scard contains manual topic from feed");

      // Switch back to tasks tab
      const tasksTab = Array.from(tabs).find(t => t.dataset.view === "tasks");
      assert.ok(tasksTab);
      tasksTab.click();
      assert.equal(doc.querySelector(".wrap").classList.contains("v-standby"), false);
    } finally {
      dom.window.close();
    }
  });
});
