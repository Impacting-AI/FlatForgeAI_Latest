"""Disposable real CAD/API server for the assembly browser regression."""
import json
import os
import time
from pathlib import Path

if os.environ.get('FLATFORGE_ASSEMBLY_TEST') != '1':
    raise RuntimeError('This fixture server must only run from the test harness')

from flatforge.db import init, Session, Project, Panel, Setting
from flatforge.storage import store
from flatforge.parameters import DEFAULTS

root = Path(__file__).resolve().parents[2]
sample = json.loads((root/'lib/sample-data.json').read_text())
init()
with Session.begin() as session:
    session.add(Setting(key='defaults', value=json.dumps(DEFAULTS)))
    session.add(Setting(key='worker_heartbeat', value=str(time.time())))
    for project in sample['projects']:
        session.add(Project(**project))
    session.add(Project(id='other-project', name='Assembly isolation test', client='Regression', created=1))
    session.flush()
    for index, record in enumerate(sample['panels']):
        folder = root/'public'/record['asset_base'].lstrip('/')
        artifacts = {path.name: store.put(path, f'panels/{record["id"]}/test-job/{path.name}') for path in folder.iterdir() if path.is_file()}
        panel = Panel(id=record['id'], project_id=record['project_id'], filename=record['filename'],
                      source_key=artifacts['flat.dxf'], settings=json.dumps(record['settings']),
                      report=json.dumps(record['report']), status='PASS', artifacts=json.dumps(artifacts), created=index+1)
        session.add(panel)
        if index == 0:
            session.add(Panel(id='other-panel', project_id='other-project', filename='Other panel.dxf',
                              source_key=artifacts['flat.dxf'], settings=panel.settings, report=panel.report,
                              status='PASS', artifacts=panel.artifacts, created=10))

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('flatforge.api:app', host='127.0.0.1', port=int(os.environ['FLATFORGE_TEST_API_PORT']), log_level='warning')
