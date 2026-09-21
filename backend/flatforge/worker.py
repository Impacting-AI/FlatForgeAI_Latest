"""Durable database queue; atomic claims, heartbeat, bounded retries, isolated CAD jobs."""
import os, time, uuid, json, tempfile, subprocess, sys, signal
from pathlib import Path
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from .db import Session, Job, Panel, Setting, init
from .storage import store
TIMEOUT=int(os.getenv('CAD_TIMEOUT_SECONDS','600'))
OWNER=str(uuid.uuid4())
def heartbeat():
 try: _heartbeat()
 except IntegrityError: _heartbeat()
def _heartbeat():
 with Session.begin() as s:
  row=s.get(Setting,'worker_heartbeat')
  if row:row.value=str(time.time())
  else:s.add(Setting(key='worker_heartbeat',value=str(time.time())))
def claim():
 now=time.time()
 with Session.begin() as s:
  stale=list(s.scalars(select(Job).where(Job.status=='RUNNING',Job.heartbeat<now-TIMEOUT-30).with_for_update(skip_locked=True)))
  for job in stale:
   job.status='QUEUED' if job.attempts<2 else 'FAILED';job.log+='Worker lease expired. '+job.status+'\n'
   panel=s.get(Panel,job.panel_id)
   if panel and panel.revision==job.revision:panel.status=job.status;panel.error='Worker lease expired' if job.status=='FAILED' else ''
  job=s.scalar(select(Job).where(Job.status=='QUEUED').order_by(Job.created).with_for_update(skip_locked=True).limit(1))
  if not job:return None
  result=s.execute(update(Job).where(Job.id==job.id,Job.status=='QUEUED').values(status='RUNNING',owner=OWNER,heartbeat=now,attempts=Job.attempts+1))
  if result.rowcount!=1:return None
  panel=s.get(Panel,job.panel_id)
  if not panel or panel.revision!=job.revision:job.status='SUPERSEDED';return None
  panel.status='CONVERTING' if panel.filename.lower().endswith('.dwg') else 'EXTRACTING';panel.updated=now
  return job.id

def process(id):
 with Session() as s:
  job=s.get(Job,id);p=s.get(Panel,job.panel_id);snapshot={'id':p.id,'filename':p.filename,'source':p.source_key,'settings':json.loads(p.settings),'overrides':json.loads(p.overrides),'revision':p.revision}
 with tempfile.TemporaryDirectory(prefix='ff-cad-') as tmp:
  root=Path(tmp);source=root/('input'+Path(snapshot['filename']).suffix.lower());out=root/'output';out.mkdir();store.get(snapshot['source'],source)
  config=root/'job.json';config.write_text(json.dumps({'source':str(source),'output':str(out),'settings':snapshot['settings'],'overrides':snapshot['overrides']}))
  logpath=root/'log.txt'
  def limits():
   if sys.platform.startswith('linux'):
    import resource
    memory=int(os.getenv('CAD_MEMORY_MB','4096'))*1024*1024;resource.setrlimit(resource.RLIMIT_AS,(memory,memory));resource.setrlimit(resource.RLIMIT_CPU,(TIMEOUT,TIMEOUT+5))
  with logpath.open('w') as log:
   proc=subprocess.Popen([sys.executable,'-m','flatforge.engine',str(config)],stdout=log,stderr=log,env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1'},start_new_session=True,preexec_fn=limits if os.name=='posix' else None)
   start=time.monotonic()
   while proc.poll() is None:
    time.sleep(1);heartbeat()
    with Session.begin() as s:
     j=s.get(Job,id);j.heartbeat=time.time();p=s.get(Panel,j.panel_id)
     if (out/'extraction.svg').exists() and p.status!='BUILDING':p.status='BUILDING';p.updated=time.time()
    if time.monotonic()-start>TIMEOUT:
     if os.name=='posix':os.killpg(proc.pid,signal.SIGKILL)
     else:proc.kill()
     proc.wait();log.write('\nConversion exceeded its execution time limit.\n');break
  resultfile=out/'result.json'
  result=json.loads(resultfile.read_text()) if resultfile.exists() else {'status':'FAILED','report':{'error':'Conversion process stopped or exceeded resource limits.','issues':[]},'artifacts':{}}
  artifacts={}
  for name in result.get('artifacts',{}):
   path=out/name
   if path.is_file() and path.parent==out:artifacts[name]=store.put(path,f'panels/{snapshot["id"]}/{id}/{name}')
  text=logpath.read_text(errors='replace')[-50000:]
  with Session.begin() as s:
   j=s.get(Job,id);p=s.get(Panel,j.panel_id)
   j.status='DONE' if result['status']!='FAILED' else 'FAILED';j.heartbeat=time.time();j.log+='DXF inspection and section mapping completed.\n'+text+'\nResult: '+result['status']
   if p.revision==snapshot['revision']:
    p.status=result['status'];p.report=json.dumps(result['report']);p.artifacts=json.dumps(artifacts);p.error=result['report'].get('error','');p.updated=time.time()
def main():
 init();once='--once' in sys.argv
 while True:
  heartbeat();id=claim()
  if id:
   try:process(id)
   except Exception as e:
    with Session.begin() as s:
     j=s.get(Job,id);j.status='FAILED';j.log+=f'\nWorker error: {type(e).__name__}: {e}';p=s.get(Panel,j.panel_id);p.status='FAILED';p.error=str(e);p.updated=time.time()
  if once:break
  time.sleep(2)
if __name__=='__main__':main()
