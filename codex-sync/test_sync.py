import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('sync',Path(__file__).with_name('sync.py'))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
ID='01234567-89ab-4cde-8fab-0123456789ab'

class MetadataSync(unittest.TestCase):
    def test_exact_project_mirror_fallback_and_departures(self):
        with tempfile.TemporaryDirectory() as folder:
            database=Path(folder)/'state.sqlite';c=sqlite3.connect(database)
            c.execute('CREATE TABLE threads(id,name,created_at,created_at_ms,recency_at,recency_at_ms,archived,thread_source,source,project_id,cwd)')
            cases=[
                (None,sync.PROJECT_MIRROR,'user',0),
                (None,None,'user',0),
                (None,str(Path(sync.PROJECT_MIRROR).parent),'user',0),
                (None,sync.PROJECT_MIRROR+'-other','user',0),
                (None,sync.PROJECT_MIRROR+'/nested','user',0),
                (None,str(Path(sync.PROJECT_MIRROR).parent/'other-project'),'user',0),
                ('other-project',sync.PROJECT_MIRROR,'user',0),
                (None,sync.PROJECT_MIRROR,'subagent',0),
                (None,sync.PROJECT_MIRROR,'user',1),
                (sync.PROJECT_ID,None,'user',0)]
            ids=[]
            for i,(project,cwd,source,archived) in enumerate(cases):
                ident='%08x-89ab-4cde-8fab-0123456789ab'%i;ids.append(ident)
                c.execute('INSERT INTO threads VALUES (?,?,?,NULL,?,NULL,?,?,?,?,?)',
                    (ident,'safe title',1792000000,1792000010,archived,source,'vscode',project,cwd))
            c.commit()
            rows=list(sync.records(database,include_departures=True))
            captures=[r for r in rows if r.get('action')!='leaveProject']
            self.assertEqual({r['url'] for r in captures},{'codex://threads/'+ids[i] for i in (0,9)})
            self.assertNotIn(sync.PROJECT_MIRROR,json.dumps(rows))
            self.assertNotIn('codex://threads/'+ids[0],{r['url'] for r in rows if r.get('action')=='leaveProject'})
            c.execute('UPDATE threads SET cwd=NULL WHERE id=?',(ids[0],));c.commit()
            self.assertIn({'url':'codex://threads/'+ids[0],'action':'leaveProject'},list(sync.records(database,True)))
            c.execute('UPDATE threads SET cwd=? WHERE id=?',(sync.PROJECT_MIRROR,ids[0]));c.commit()
            self.assertIn('codex://threads/'+ids[0],{r['url'] for r in sync.records(database)})
            c.close()

    def test_filters_metadata_and_retries_without_duplicate_uploads(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);db=p/'state.sqlite'
            c=sqlite3.connect(db)
            c.execute('CREATE TABLE threads(id,name,created_at,created_at_ms,recency_at,recency_at_ms,archived,has_user_event,thread_source,source,first_user_message,project_id,cwd)')
            def insert(id,source,archived=0,project=sync.PROJECT_ID):
                c.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)',(id,'題\n名',1792000000,None,1792000010,None,archived,0,source,'vscode','DO NOT TRANSMIT',project))
            insert(ID,'user');insert('11234567-89ab-4cde-8fab-0123456789ab','subagent');insert('21234567-89ab-4cde-8fab-0123456789ab','user',1)
            insert('31234567-89ab-4cde-8fab-0123456789ab','user',project=None)
            insert('41234567-89ab-4cde-8fab-0123456789ab','user',project='other-project')
            c.commit();c.close()
            config=p/'config.json';config.write_text(json.dumps({'database':str(db),'captureToken':'c'*40}))
            result=list(sync.records(db))
            self.assertEqual(len(result),1)
            self.assertEqual(set(result[0]),{'url','title','observedAt','activityAt','projectId'})
            self.assertEqual(result[0]['title'],'題 名')
            self.assertNotIn('DO NOT TRANSMIT',json.dumps(result))
            requests=[]
            class Response:
                status=200
                def __enter__(self): return self
                def __exit__(self,*args): pass
                def read(self): return b'{"ok":true}'
            def send(request,timeout):
                requests.append(json.loads(request.data))
                self.assertEqual(request.full_url,sync.API+'/codex/capture')
                self.assertEqual(request.get_header('User-agent'),'TaskPulseCodex/0.3')
                return Response()
            with patch.object(sync.urllib.request,'urlopen',side_effect=OSError('offline')):
                with self.assertRaises(OSError): sync.synchronize(config)
            self.assertFalse((p/'sync-state.json').exists())
            with patch.object(sync.urllib.request,'urlopen',side_effect=send):
                self.assertEqual(sync.synchronize(config),1)
                self.assertEqual(sync.synchronize(config),0)
                # Selecting an already-acknowledged member still refreshes its scope.
                value=json.loads(config.read_text());value['includedThreadIds']=[ID];config.write_text(json.dumps(value))
                self.assertEqual(sync.synchronize(config),1)
                self.assertEqual(sync.synchronize(config),0)
                c=sqlite3.connect(db);c.execute('UPDATE threads SET name=? WHERE id=?',('新しい題',ID));c.commit();c.close()
                self.assertEqual(sync.synchronize(config),1)
            self.assertEqual(len(requests),3)
            self.assertGreater(requests[0]['observedAt'], result[0]['observedAt'])
            self.assertEqual(requests[0]['activityAt'],result[0]['observedAt'])
            value=json.loads(config.read_text());value['includedThreadIds']=[];config.write_text(json.dumps(value))
            c=sqlite3.connect(db);c.execute('UPDATE threads SET project_id=NULL WHERE id=?',(ID,));c.commit();c.close()
            with patch.object(sync.urllib.request,'urlopen',side_effect=send):
                self.assertEqual(sync.synchronize(config),1)
                self.assertEqual(sync.synchronize(config),0)
            self.assertEqual(requests[-1]['action'],'leaveProject')
            self.assertNotIn('title',requests[-1])

    def test_explicit_selection_is_narrow_and_removal_withdraws_the_record(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);database=p/'state.sqlite';c=sqlite3.connect(database)
            c.execute('CREATE TABLE threads(id,name,created_at,created_at_ms,recency_at,recency_at_ms,archived,thread_source,source,project_id,cwd)')
            outside='11234567-89ab-4cde-8fab-0123456789ab'
            agent='21234567-89ab-4cde-8fab-0123456789ab'
            for ident,kind in [(ID,'user'),(outside,'user'),(agent,'subagent')]:
                c.execute('INSERT INTO threads VALUES (?,?,?,NULL,?,NULL,0,?,?,NULL,NULL)',(ident,'safe title',1792000000,1792000010,kind,'vscode'))
            c.commit();c.close()
            self.assertEqual(list(sync.records(database)),[])
            selected=sync.validate_selection([ID,agent,ID])
            self.assertEqual([x['url'] for x in sync.records(database,selected_threads=selected)],['codex://threads/'+ID])
            config=p/'config.json';value={'database':str(database),'captureToken':'c'*40,'includedThreadIds':[ID]};config.write_text(json.dumps(value))
            uploads=[]
            class Response:
                status=200
                def __enter__(self): return self
                def __exit__(self,*args): pass
                def read(self): return b'{"ok":true}'
            def send(request,timeout): uploads.append(json.loads(request.data));return Response()
            with patch.object(sync.urllib.request,'urlopen',side_effect=send):
                self.assertEqual(sync.synchronize(config),1)
                self.assertEqual(sync.synchronize(config),0)
                self.assertEqual(len(uploads),1)
                self.assertEqual(uploads[0]['url'],'codex://threads/'+ID)
                value['includedThreadIds']=[];config.write_text(json.dumps(value))
                self.assertEqual(sync.synchronize(config),1)
                self.assertEqual(uploads[-1]['action'],'leaveProject')
                self.assertEqual(sync.synchronize(config),0)
                for bad in ['*',[outside,'*'],[None],[ID]*201]:
                    value['includedThreadIds']=bad;config.write_text(json.dumps(value))
                    with self.assertRaises(ValueError):sync.synchronize(config)
                self.assertEqual(len(uploads),2,'invalid selection must not send anything')

if __name__=='__main__': unittest.main()
