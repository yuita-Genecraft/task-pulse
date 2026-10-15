"""Collector -> real Wrangler local D1 regression. Public dummy keys only."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import urllib.request

spec = importlib.util.spec_from_file_location('sync', Path(__file__).with_name('sync.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
sync.API = 'http://127.0.0.1:8798'
ID = 'b1234567-89ab-4cde-8fab-0123456789ab'

def stored():
    request = urllib.request.Request(sync.API + '/codex/chats', headers={
        'Authorization': 'Bearer local-test-read-token-aaaaaaaaaaaaaaaaaa'})
    with urllib.request.urlopen(request) as response:
        return next(row for row in json.load(response)['chats'] if row['id'] == ID)

with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    database = root / 'state.sqlite'
    db = sqlite3.connect(database)
    db.execute('CREATE TABLE threads(id,name,created_at,created_at_ms,recency_at,recency_at_ms,archived,thread_source,source)')
    db.execute('INSERT INTO threads VALUES (?,?,?,NULL,?,NULL,0,?,?)',
               (ID, None, 1792000000, 1792000000, 'user', 'vscode'))
    db.commit()
    config = root / 'config.json'
    config.write_text(json.dumps({'database': str(database),
        'captureToken': 'local-test-capture-token-cccccccccccccccccc'}))
    assert sync.synchronize(config) == 1
    first = stored()
    assert first['title'] == 'Codex 新しいチャット'
    time.sleep(0.02)
    db.execute('UPDATE threads SET name=? WHERE id=?', ('後から付いた題名', ID))
    db.commit()
    assert sync.synchronize(config) == 1
    second = stored()
    assert second['title'] == '後から付いた題名', second
    assert second['observedAt'] > first['observedAt']
    assert sync.synchronize(config) == 0
    time.sleep(0.02)
    db.execute('UPDATE threads SET name=? WHERE id=?', ('リネーム後', ID))
    db.commit()
    assert sync.synchronize(config) == 1
    assert stored()['title'] == 'リネーム後'
    assert sync.synchronize(config) == 0
    db.close()
print('PASS collector -> Worker -> real local D1: late name, rename, deduplication')
