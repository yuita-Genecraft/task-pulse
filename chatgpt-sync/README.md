# ChatGPT cross-device registry (Draft; NOT DEPLOYED)

This is a separate Cloudflare Worker and D1 table. It does not write to the handoff-mcp database or reuse its GRAPH_READ_TOKEN, CHATS_WRITE_TOKEN or MCP credential.

**Designated URL** (only after an approved deployment): `https://taskpulse-chatgpt.gooooerer.workers.dev`. This is a proposed worker name, not an observed live deployment.

Stored: ChatGPT canonical conversation URL, title, last observation time, a user memo (up to 500 code points), user-closed time, monotonically increasing edit revision. No message body, session cookie, ChatGPT API key, share link, or user account identity is collected.

## Auth separation

Three independent secrets (32–256 chars; different values; no fallback):

- `READ_TOKEN`: only GET /chats.
- `WRITE_TOKEN`: POST /capture and PATCH /chats/:id. Available in the trusted Task Pulse browser bookmark fragment as `gptwrite`, not in a request URL.
- `CAPTURE_TOKEN`: only POST /capture. Stored in Chrome extension options (`chrome.storage.local`), sent to the *fixed* Worker. It cannot read the registry or change memos/closed state.

The taskPulse page uses `gptread` and `gptwrite` from its URL fragment only; values must never be committed. A browser bookmark with secrets is a bearer credential: device/browser sync and same-origin scripts can read it. Secure storage, rotation, share scope, and leaked tokens must be assessed before production.

The Chrome extension records only when a normal ChatGPT conversation is opened; it does not enumerate all history. An offline capture is retained locally and retried. Automatic capture never reopens a manually closed chat. iPhone can **view and edit the same registry in Safari/Chrome** after the bookmark is configured; automatic monitoring of iPhone's ChatGPT app is NOT supported.

## API

- `GET /chats`: up to 1000 newest chats; returns `total` and `limited` (so excess never masquerades as a complete list).
- `POST /capture`: JSON `{url,title,observedAt}`; URL restricted to ChatGPT's own /c/:uuid or /g/g-.../c/:uuid. Shared links excluded. Newest observation wins. Does not modify `memo`, `revision`, or `closed_at`.
- `PATCH /chats/:id`: JSON `{action:"memo"|"close"|"reopen",baseRevision,memo?}`. Database CAS; stale rev returns 409 and current row.

CORS: only `https://yuita-genecraft.github.io` for UI; for capture, scoped Chrome extension origins. Other origins and unknown credentials 404. Not a substitute for strong user authentication; bearer tokens still confer their listed capabilities.

## Before production (explicit approval required)

1. Independently review and run tests against **real local D1 / wrangler dev** (the code-level tests alone cannot prove D1 SQL correctness).
2. Provision a dedicated D1 and apply the migration. Approve exact database/account and any additional charges.
3. Set three new secrets through approved secure operator path, not chat / GitHub. Validate they are all distinct.
4. Approve the worker deployment after checking DNS, CORS and the actual Worker URL; update the fixed URL in UI+extension if required.
5. Validate signed-in Chrome capture → Cloudflare D1 → taskPulse PC → iPhone real browser E2E, including permission failure, offline retry, conflict 409, stale observation, and closed-chat non-reopen.
6. Only after real E2E and required review, accept as ready. **Do not merge/deploy based on this Draft alone.**

No tokens are shipped in this repository. GitHub merge, a successful unit test, Worker deploy and user acceptance are different statuses.
