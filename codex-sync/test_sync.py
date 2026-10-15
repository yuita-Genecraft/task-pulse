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
    def test_filters_metadata_and_retries_without_duplicate_uploads(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder);db=p/'state.sqlite'
            c=sqlite3.connect(db)
            c.execute('CREATE TABLE threads(id,name,created_at,created_at_ms,recency_at,recency_at_ms,archived,has_user_event,thread_source,source,first_user_message)')
            def insert(id,source,archived=0):
                c.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)',(id,'題\n名',1792000000,None,1792000010,None,archived,0,source,'vscode','DO NOT TRANSMIT'))
            insert(ID,'user');insert('11234567-89ab-4cde-8fab-0123456789ab','subagent');insert('21234567-89ab-4cde-8fab-0123456789ab','user',1)
            c.commit();c.close()
            config=p/'config.json';config.write_text(json.dumps({'database':str(db),'captureToken':'c'*40}))
            result=list(sync.records(db))
            self.assertEqual(len(result),1)
            self.assertEqual(set(result[0]),{'url','title','observedAt'})
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
                c=sqlite3.connect(db);c.execute('UPDATE threads SET name=? WHERE id=?',('新しい題',ID));c.commit();c.close()
                self.assertEqual(sync.synchronize(config),1)
            self.assertEqual(len(requests),2)
            self.assertGreater(requests[0]['observedAt'], result[0]['observedAt'])

if __name__=='__main__': unittest.main()
