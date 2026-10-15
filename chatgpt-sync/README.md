# ChatGPT / Codex registry — shared project only

This is a separate Cloudflare Worker and D1 table. It does not write to the handoff-mcp database or reuse its GRAPH_READ_TOKEN, CHATS_WRITE_TOKEN or MCP credential.

**Live URL**: `https://taskpulse-chatgpt.gooooerer.workers.dev`. Deployed on 2026-10-15 after explicit user approval and independent source review. Active Worker version at deployment: `45fa7d3e-1544-4930-9030-94f57ebf9b39`; dedicated D1: `744b431c-4b95-4f8e-bf9d-4cec0077cb0b` (APAC).

Scope is fixed to **Claudeセカンドオピニオン** (`g-p-6ab08ead99b88191ab18129fe14730d9`), as explicitly requested on 2026-10-15. Other projects and unassigned chats cannot be captured/imported or returned/edited through the registry. ChatGPT membership comes from its project URL; Codex membership comes from `threads.project_id`. Unknown membership is excluded. Migration 0003 preserves all old rows and memos; prior Codex rows with unknown membership remain hidden. The UI also excludes unscoped local records, and Codex manual registration/import are unavailable because a deep link does not prove project membership.

Previously tracked chats observed outside the project send an identity-and-time-only `leaveProject` capture, clearing visibility without deleting the record or collecting the new project's title/body/identity. Older queued captures cannot restore membership after a newer departure observation. Membership is last observed, not continuously queried from ChatGPT history: an unobserved move cannot be discovered until that chat is opened again; Codex checks its metadata snapshot each run. Client/server clock alignment is assumed for observation ordering.

Stored: ChatGPT canonical conversation URL, title, last observation time, a user memo (up to 500 code points), user-closed time, monotonically increasing edit revision. No message body, session cookie, ChatGPT API key, share link, or user account identity is collected.

## Auth separation

Three independent secrets (32–256 chars; different values; no fallback):

- `READ_TOKEN`: only GET /chats.
- `WRITE_TOKEN`: POST /capture and PATCH /chats/:id. Available in the trusted Task Pulse browser bookmark fragment as `gptwrite`, not in a request URL.
- `CAPTURE_TOKEN`: only POST /capture. Stored in Chrome extension options (`chrome.storage.local`), sent to the *fixed* Worker. It cannot read the registry, edit memos, or explicitly close/reopen records. A capture with new instruction activity can resume a closed record as described below.

The taskPulse page uses `gptread` and `gptwrite` from its URL fragment only; values must never be committed. A browser bookmark with secrets is a bearer credential: device/browser sync and same-origin scripts can read it. Secure storage, rotation, share scope, and leaked tokens must be assessed before production.

The Chrome extension records only when a normal ChatGPT conversation is opened; it does not enumerate all history. An offline capture is retained locally and retried. Opening/focusing a chat or renaming it never reopens a manually closed chat. Sending a new instruction after closure resumes it; Chrome requires a trusted composer action followed by a new stable user-turn identifier, while Codex uses the source user-recency timestamp. Message bodies are not read. Instruction times are client-reported: ordering against closure assumes aligned client/server clocks. Future activity is ignored for resumption rather than clamped to receipt time. This is not a proof of distributed physical event ordering under clock skew. iPhone can **view and edit the same registry in Safari/Chrome** after the bookmark is configured; automatic monitoring of iPhone's ChatGPT app is NOT supported.

## API

- `GET /chats`: up to 1000 newest chats; returns `total` and `limited` (so excess never masquerades as a complete list).
- `POST /capture`: JSON `{url,title,observedAt,activityAt?,projectId?}` (Codex requires the allowed `projectId`); URL restricted to ChatGPT's own /c/:uuid or /g/g-.../c/:uuid. Shared links excluded. Newest observation wins. Preserves `memo`. If valid instruction activity is later than `closed_at`, clears closure and increments `revision`; ordinary observation preserves closure/revision.
- `POST /capture`: `{action:"leaveProject",url,observedAt}` removes an already tracked identity from the project scope; it never creates a new row.
- `PATCH /chats/:id`: JSON `{action:"memo"|"close"|"reopen",baseRevision,memo?}`. Database CAS; stale rev returns 409 and current row.

CORS: only `https://yuita-genecraft.github.io` for UI; for capture, scoped Chrome extension origins. Other origins and unknown credentials 404. Not a substitute for strong user authentication; bearer tokens still confer their listed capabilities.

## Before production (explicit approval required)

1. Independently review and run tests against **real local D1 / wrangler dev** (the code-level tests alone cannot prove D1 SQL correctness).
2. Provision a dedicated D1 and apply the migration. Approve exact database/account and any additional charges.
3. Set three new secrets through approved secure operator path, not chat / GitHub. Validate they are all distinct.
4. Approve the worker deployment after checking DNS, CORS and the actual Worker URL; update the fixed URL in UI+extension if required.
5. Validate signed-in Chrome capture → Cloudflare D1 → taskPulse PC → iPhone real browser E2E, including permission failure, offline retry, conflict 409, stale observation, and ordinary closed-chat non-reopen and new-instruction resume.
6. Only after real E2E and required review, accept as ready. **Do not merge/deploy based on this Draft alone.**

No tokens are shipped in this repository. GitHub merge, a successful unit test, Worker deploy and user acceptance are different statuses.

## Codex addition (2026-10-15)

The same dedicated Worker now has `/codex/capture`, `/codex/chats` and
`/codex/chats/:id`, backed by a separate `codex_chat` table from migration 0002.
The existing ChatGPT routes and rows are preserved. Strict Codex links accept
only `codex://threads/<uuid>`; queries, fragments, review links and other schemes
are rejected. Same UUIDs in ChatGPT and Codex remain separate records.

The UI adds a Codex tab with the same read/write permissions and CAS editing.
The native collector and installation details are in `../codex-sync/README.md`.
The public extension package has an empty `capture-config.json`; an operator can
prepare a private package with only CAPTURE_TOKEN preconfigured, so no key needs
to be copied through chat or pasted into a page.

Wrangler is now pinned to 4.151.0 with a lockfile. The prior host runtime could
not run the configured October compatibility date; the pinned runtime runs the
actual local D1 HTTP tests. This is still not a production acceptance result.

## Deployment evidence (2026-10-15)

The user approved independent review, dedicated Worker/D1 deployment and native
installation. Independent review found a late-name/rename timestamp issue; it
was fixed and the collector-to-Worker-to-local-D1 regression was added before
deployment. A follow-up review found no remaining source blocker.

Initial deployment applied migrations 0001/0002. The shared-project update requires migration 0003. Before project restriction, the native launchd collector uploaded 13
actual unarchived main chats, including the active task, and the authenticated
registry read returned the same current display name. A named API client
(`TaskPulseCodex/0.3`) is required because the default Python urllib identity
was rejected by Cloudflare. READ succeeds on both lists; WRITE cannot read, READ
cannot capture, CAPTURE cannot edit, and an unrelated Origin is rejected.

Worker config enables observability and sampled traces with query-string
redaction. Credentials remain in protected local files and Worker secrets,
not this repository. The public extension config remains empty.

These measurements do not by themselves prove real Chrome extension capture,
GitHub Pages deployment, or iPhone acceptance. Complete and report each real
client's readback separately.
