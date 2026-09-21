"""Package verified fixture conversions; this script does not infer production bends.
Run the engine first for each fixture. The two PN_PL_1619 overrides are explicit
historical review decisions, not rules in the generic conversion service.
"""
from pathlib import Path
import json, zipfile
root=Path(__file__).resolve().parents[2]
data={'mode':'sample','settings':{'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'},'capabilities':{'connected':False,'worker_online':False,'dwg':False,'max_upload_mb':50,'exports':['step','glb','stl','dxf','csv','json']},'projects':[{'id':'reference-panels','name':'Façade panel collection','client':'Reference drawings','created':1789689600}],'panels':[]}
for n in ['1648','1570','1619']:
 folder=root/'public'/'samples'/n
 result=json.loads((folder/'result.json').read_text());assert result['status']=='PASS'
 overrides={'accept_partial_sections':True} if n=='1570' else {'bend_angles':{'299:F19:F18':90,'43D:F20:F21':-90}} if n=='1619' else {}
 result['report']['review_decisions']=overrides
 (folder/'report.json').write_text(json.dumps(result['report'],indent=2))
 data['panels'].append({'id':'reference-'+n,'project_id':'reference-panels','filename':'PN_PL_'+n+'.dxf','status':'PASS','settings':data['settings'],'overrides':overrides,'report':result['report'],'artifacts':list(result['artifacts']),'error':'','manual_value':None,'manual_axis':'flat_width','created':1789689600,'updated':1789689600,'revision':1,'sample':True,'asset_base':'/samples/'+n})
(root/'lib'/'sample-data.json').write_text(json.dumps(data,indent=2))
with zipfile.ZipFile(root/'public'/'samples'/'project.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in data['panels']:
  folder=root/'public'/p['asset_base'].lstrip('/')
  for name in p['artifacts']:z.write(folder/name,Path(p['filename']).stem+'/'+name)
print('Packaged',len(data['panels']),'verified reference panels')
