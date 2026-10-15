# Codex chat registration

Task Pulse gains a separate Codex tab. A per-user launchd service reads only the
local Codex `threads` metadata and uploads changed records to
`https://taskpulse-chatgpt.gooooerer.workers.dev/codex/capture`.

Automatic project matching covers only the **Claudeセカンドオピニオン** project (`g-p-6ab08ead99b88191ab18129fe14730d9`) is eligible. The collector selects `id`, `name`, project ID, creation and user-recency timestamps for matching rows. It reads only IDs for other memberships, solely to withdraw previously tracked records; never-tracked outside chats are not uploaded. Both queries share a read-only SQLite transaction. A missing row or failed database read is not treated as a project departure. It does
not select the database's `title` field (which can contain the first prompt),
`first_user_message`, rollout contents, cwd, authentication files, or logs.
Subagent/guardian and archived rows are excluded. An unnamed main chat is shown
as `Codex 新しいチャット` until the app's display name becomes available.

SQLite is opened with `mode=ro`. The service watches the database and WAL,
throttles starts to ten seconds, and retries once per minute for missed events or
offline failures. Unchanged records produce no request. It never wakes a model.
Each upload records the time the collector observed the changed metadata. Its
deduplication signature uses the source's name and user-recency instead, so an
unchanged poll does not upload and a late name is not lost behind an older
user-recency timestamp. The UI labels this time as “Macで確認”.
Remote captures preserve memos. Opening or renaming a chat preserves explicit closure; a new user-recency timestamp after closure resumes the record. Uploads include this source timestamp as `activityAt`, separately from metadata observation time. Ordering assumes aligned Mac/server clocks; future activity is ignored for resume. Archiving/deleting a local
chat does not automatically close its Task Pulse record.

## Prepare and install

First deploy the separately approved registry and apply all three SQL migrations.
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

Project scope is strict: on 2026-10-15 all 13 previously collected local main chats had `project_id=NULL`; these records remain preserved but are no longer displayed. Automatic membership matching requires the exact allowed project ID in app metadata. If the app does not expose membership there, an unselected chat stays excluded; the user can explicitly select an individual chat for the Task Pulse shared group as described below. Neither a title nor a directory is guessed into membership. Positive membership-to-native-upload behavior is covered by local fixtures; real app membership assignment is a separate acceptance item.

## Explicit Task Pulse selection

A user may explicitly select individual Codex chats for the shared Task Pulse group without changing their ChatGPT app membership. The protected collector config accepts `includedThreadIds`, a list of up to 200 exact lowercase UUIDs. Empty/missing selection preserves project-only behavior. Wildcards, strings and malformed IDs fail closed before network access. Main, unarchived chat filters still apply. Removing a selected chat with no matching app membership withdraws it on the next run. No unrelated chat is selected by default.

The installer preserves an existing selection on updates. For an explicitly requested selection, pass `--include-thread <uuid>` (repeatable); an explicit list replaces the previous list. This affects Task Pulse only, and does not assert that the app's ChatGPT project membership changed.
