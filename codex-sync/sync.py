#!/usr/bin/python3
"""Read local Codex metadata, upload changed rows. No message/log/auth reads."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import urllib.request

PROJECT_ID = 'g-p-6ab08ead99b88191ab18129fe14730d9'
API = 'https://taskpulse-chatgpt.gooooerer.workers.dev'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def records(database, include_departures=False):
    # SQLite opens read-only; explicit columns exclude message bodies and paths.
    db = sqlite3.connect(Path(database).as_uri() + '?mode=ro', uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    try:
        db.execute("BEGIN")
        rows = db.execute('''SELECT id,name,created_at,created_at_ms,recency_at,recency_at_ms,project_id
            FROM threads WHERE archived=0 AND project_id=?
            AND (thread_source IN ('user','voice_chat') OR
                 (thread_source IS NULL AND source IN ('vscode','cli','exec')))
            ORDER BY created_at ASC''', (PROJECT_ID,)).fetchall()
        departures = db.execute('SELECT id FROM threads WHERE project_id IS NULL OR project_id <> ?', (PROJECT_ID,)).fetchall() if include_departures else []
    finally:
        db.close()
    for row in rows:
        if not UUID.fullmatch(row['id']):
            continue
        # A real user activity time, not the time this observer happened to run.
        millis = row['recency_at_ms'] or (row['recency_at'] or 0) * 1000
        millis = millis or row['created_at_ms'] or row['created_at'] * 1000
        when = dt.datetime.fromtimestamp(millis / 1000, dt.timezone.utc)
        # `title` in this database can be the first user message. Only `name`
        # is the app's display name; never fall back to the message-backed field.
        title = re.sub(r'[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]', ' ', row['name'] or 'Codex 新しいチャット')
        title = re.sub(r'https?://\S+', '[リンク]', title)
        yield {'projectId': PROJECT_ID, 'url': 'codex://threads/' + row['id'],
               'title': ' '.join(title.split())[:120],
               'observedAt': when.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
               'activityAt': when.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                   if (row['recency_at_ms'] or row['recency_at']) else None}

    for row in departures:
        if UUID.fullmatch(row['id']):
            yield {'url':'codex://threads/'+row['id'], 'action':'leaveProject'}


def atomic(path, value):
    tmp = path.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        os.chmod(tmp, 0o600)
        json.dump(value, f, ensure_ascii=False)
    tmp.replace(path)


def synchronize(config_path):
    config_path = Path(config_path)
    config = json.loads(config_path.read_text())
    token = config['captureToken']
    if not isinstance(token, str) or not 32 <= len(token) <= 256:
        raise ValueError('capture credential missing')
    storage = config_path.parent
    with open(storage / 'sync.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        state_path = storage / 'sync-state.json'
        try:
            state = json.loads(state_path.read_text())
        except (FileNotFoundError, ValueError):
            state = {}
        sent = 0
        for record in records(config['database'], include_departures=True):
            if record.get('action') == 'leaveProject' and record['url'] not in state:
                continue  # Never send metadata for an unrelated, never-tracked chat.
            # Keep existing fingerprints stable; activity is already represented
            # by the source-recency value in observedAt.
            encoded = json.dumps({k:v for k,v in record.items() if k != 'activityAt'},
                                 ensure_ascii=False, sort_keys=True).encode()
            signature = hashlib.sha256(encoded).hexdigest()
            key = record['url']
            if state.get(key) == signature:
                continue
            # The signature above tracks source activity/name changes. The
            # server timestamp describes this observation, so a late display
            # name can supersede an earlier unnamed observation at the same
            # user-recency time. Merely polling does not change the signature.
            upload = dict(record, observedAt=dt.datetime.now(dt.timezone.utc)
                          .isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
            request = urllib.request.Request(API + '/codex/capture',
                data=json.dumps(upload, ensure_ascii=False).encode(),
                headers={'Content-Type':'application/json', 'Authorization':'Bearer ' + token,
                         'User-Agent':'TaskPulseCodex/0.3', 'Accept':'application/json'}, method='POST')
            # No raw network errors are logged: they can contain credentials or metadata.
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
                if response.status != 200 or result.get('ok') is not True:
                    raise RuntimeError('capture rejected')
            state[key] = signature
            atomic(state_path, state)
            sent += 1
        atomic(storage / 'status.json', {'ok': True, 'sent': sent,
            'at': dt.datetime.now(dt.timezone.utc).isoformat()})
        return sent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        count = synchronize(args.config)
        print('Codex registry: %d changed chats synchronized' % count)
    except Exception:
        path = Path(args.config).parent / 'status.json'
        atomic(path, {'ok': False, 'error': 'sync_failed',
            'at': dt.datetime.now(dt.timezone.utc).isoformat()})
        print('Codex registry: sync unavailable; will retry')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
