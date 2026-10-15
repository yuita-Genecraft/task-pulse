# Codex chat registration

Task Pulse gains a separate Codex tab. A per-user launchd service reads only the
local Codex `threads` metadata and uploads changed records to
`https://taskpulse-chatgpt.gooooerer.workers.dev/codex/capture`.

The collector selects `id`, `name`, creation and user-recency timestamps. It does
not select the database's `title` field (which can contain the first prompt),
`first_user_message`, rollout contents, cwd, authentication files, or logs.
Subagent/guardian and archived rows are excluded. An unnamed main chat is shown
as `Codex 新しいチャット` until the app's display name becomes available.

SQLite is opened with `mode=ro`. The service watches the database and WAL,
throttles starts to ten seconds, and retries once per minute for missed events or
offline failures. Unchanged records produce no request. It never wakes a model.
Remote captures preserve memos and explicit closure. Archiving/deleting a local
chat does not automatically close its Task Pulse record.

## Prepare and install

First deploy the separately approved registry and apply both SQL migrations.
Use three distinct credentials for READ, WRITE and CAPTURE. Native sync and the
Chrome extension receive only CAPTURE; Task Pulse receives READ/WRITE in its
bookmark fragment (`gptread`/`gptwrite`). No credential belongs in source control.

After approving native installation:

```sh
python3 codex-sync/install.py --credential-file /private/path/registry-secrets.json
```

This installs `~/Library/LaunchAgents/com.yuita.taskpulse-codex.plist` and stores
the collector/config/status under `~/Library/Application Support/TaskPulseCodex`.
The config is mode 0600 and its directory is mode 0700. The service does not
modify any existing Claude service or the Codex app's own settings.

The collector depends on the app's local SQLite metadata schema. If that schema
changes, it stops sending and records `sync_failed`; it never falls back to
reading message bodies. Disable with `launchctl bootout gui/$(id -u)
~/Library/LaunchAgents/com.yuita.taskpulse-codex.plist`.

## Limits and validation

Browser ChatGPT uses the Chrome extension; this collector covers local Codex
main chats. It cannot observe the iPhone ChatGPT app or cloud-only ChatGPT chats.
Codex deep links open only on a machine with the registered Codex URL handler.

Tests: `python3 -m unittest discover -s codex-sync -p 'test_*.py'`,
`node --test tests/chatgpt_url.cjs chatgpt-sync/test/worker.test.mjs`, and the
Wrangler local-D1 HTTP tests. Local tests and a preview are not a production
deployment or proof that a real Chrome extension has been installed.
