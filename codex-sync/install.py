#!/usr/bin/python3
"""Install an explicitly configured, per-user metadata sync service."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--credential-file',required=True,help='protected JSON with CAPTURE_TOKEN')
args=parser.parse_args()
credentials=json.loads(Path(args.credential_file).read_text())
token=credentials['CAPTURE_TOKEN']
if not isinstance(token,str) or not 32<=len(token)<=256: raise SystemExit('invalid credential')
base=Path.home()/'Library/Application Support/TaskPulseCodex'
base.mkdir(parents=True,exist_ok=True);os.chmod(base,0o700)
shutil.copy2(Path(__file__).with_name('sync.py'),base/'sync.py')
config=base/'config.json'
config.write_text(json.dumps({'database':str(Path.home()/'.codex/state_5.sqlite'),'captureToken':token}));os.chmod(config,0o600)
agent=Path.home()/'Library/LaunchAgents/com.yuita.taskpulse-codex.plist'
content={'Label':'com.yuita.taskpulse-codex',
 'ProgramArguments':['/usr/bin/python3',str(base/'sync.py'),'--config',str(config)],
 'RunAtLoad':True,'StartInterval':60,'ThrottleInterval':10,
 'WatchPaths':[str(Path.home()/'.codex/state_5.sqlite'),str(Path.home()/'.codex/state_5.sqlite-wal')],
 'StandardOutPath':str(base/'sync.log'),'StandardErrorPath':str(base/'sync.err')}
agent.write_bytes(plistlib.dumps(content));os.chmod(agent,0o600)
subprocess.run(['launchctl','bootout','gui/'+str(os.getuid()),str(agent)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['launchctl','bootstrap','gui/'+str(os.getuid()),str(agent)],check=True)
print('Installed com.yuita.taskpulse-codex; read-only metadata, 60-second offline retry')
