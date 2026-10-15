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
    db.execute('CREATE TABLE threads(id,name,created_at,created_at_ms,recency_at,recency_at_ms,archived,thread_source,source,project_id,cwd)')
    db.execute('INSERT INTO threads VALUES (?,?,?,NULL,?,NULL,0,?,?,?,NULL)',
               (ID, None, 1792000000, 1792000000, 'user', 'vscode',sync.PROJECT_ID))
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
    def close_current():
        request=urllib.request.Request(sync.API+'/codex/chats/'+ID,
            data=json.dumps({'action':'close','baseRevision':stored()['revision']}).encode(),
            headers={'Authorization':'Bearer local-test-write-token-bbbbbbbbbbbbbbbbbb','Content-Type':'application/json'},method='PATCH')
        with urllib.request.urlopen(request) as response: assert response.status==200
    close_current()
    db.execute('UPDATE threads SET name=? WHERE id=?',('題名だけ変更',ID));db.commit()
    assert sync.synchronize(config)==1
    assert stored()['closedAt'], 'rename alone must keep the chat closed'
    time.sleep(0.02)
    db.execute('UPDATE threads SET recency_at_ms=? WHERE id=?',(int(time.time()*1000),ID));db.commit()
    assert sync.synchronize(config)==1
    assert stored()['closedAt'] is None, 'a new user instruction resumes the chat'
    assert sync.synchronize(config)==0
    db.execute('UPDATE threads SET project_id=NULL WHERE id=?',(ID,));db.commit()
    assert sync.synchronize(config)==1
    try:
        stored()
        raise AssertionError('out-of-project chat remains visible')
    except StopIteration:
        pass
    assert sync.synchronize(config)==0
    db.execute('UPDATE threads SET cwd=? WHERE id=?',(sync.PROJECT_MIRROR,ID));db.commit()
    assert sync.synchronize(config)==1
    assert stored()['projectId']==sync.PROJECT_ID, 'exact app project mirror auto-registers without selection'
    assert sync.synchronize(config)==0
    db.execute('UPDATE threads SET cwd=? WHERE id=?',(sync.PROJECT_MIRROR+'-other',ID));db.commit()
    assert sync.synchronize(config)==1
    try:
        stored();raise AssertionError('lookalike mirror remains visible')
    except StopIteration:
        pass
    assert sync.synchronize(config)==0
    value=json.loads(config.read_text());value['includedThreadIds']=[ID];config.write_text(json.dumps(value))
    assert sync.synchronize(config)==1
    assert stored()['projectId']==sync.PROJECT_ID, 'explicitly selected unassigned chat enters Task Pulse shared group'
    assert sync.synchronize(config)==0
    value['includedThreadIds']=[];config.write_text(json.dumps(value))
    assert sync.synchronize(config)==1
    try:
        stored();raise AssertionError('deselected unassigned chat remains visible')
    except StopIteration:
        pass
    assert sync.synchronize(config)==0
    db.close()
print('PASS collector -> Worker -> real local D1: late name, rename, deduplication, instruction resume, project departure, automatic project mirror/departure, explicit selection/removal')
