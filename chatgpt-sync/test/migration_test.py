"""Verify scope backfill on legacy rows without touching a service or credential."""
from pathlib import Path
import sqlite3
migrations = Path(__file__).resolve().parents[1] / 'migrations'
db = sqlite3.connect(':memory:')
for name in ['0001.sql','0002_codex.sql']:
    db.executescript((migrations/name).read_text())
project='g-p-6ab08ead99b88191ab18129fe14730d9'
for index,url in enumerate([
    'https://chatgpt.com/g/'+project+'-shared/c/',
    'https://chatgpt.com/g/'+project+'0/c/',
    'https://chatgpt.com/c/',
]):
    ident=f'{index}1234567-89ab-4cde-8fab-0123456789ab'
    db.execute('INSERT INTO gpt_chat(id,url,title,observed_at,memo) VALUES(?,?,?,?,?)',
               (ident,url+ident,'legacy','2026-10-10T00:00:00.000Z','preserved'))
ident='a1234567-89ab-4cde-8fab-0123456789ab'
db.execute('INSERT INTO codex_chat(id,url,title,observed_at,memo) VALUES(?,?,?,?,?)',
           (ident,'codex://threads/'+ident,'legacy Codex','2026-10-10T00:00:00.000Z','preserved'))
db.executescript((migrations/'0003_project_scope.sql').read_text())
assert db.execute('SELECT count(*) FROM gpt_chat').fetchone()[0]==3
assert db.execute('SELECT count(*) FROM codex_chat').fetchone()[0]==1
assert db.execute('SELECT count(*) FROM gpt_chat WHERE project_id=?',(project,)).fetchone()[0]==1
assert db.execute('SELECT project_id FROM codex_chat').fetchone()[0] is None
assert all(r[0]=='preserved' for r in db.execute('SELECT memo FROM gpt_chat UNION ALL SELECT memo FROM codex_chat'))
print('PASS legacy migration: correct project backfill; unscoped rows hidden; rows and memos preserved')
