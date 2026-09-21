"""Explicit ODA adapter. No proprietary binary is bundled or simulated."""
import os, subprocess, shutil
from pathlib import Path
class ConverterUnavailable(ValueError):pass
def available():return bool(os.getenv('ODA_FILE_CONVERTER') and Path(os.environ['ODA_FILE_CONVERTER']).is_file())
def convert(source:Path,target_dir:Path,output_type='DXF'):
 if not available():raise ConverterUnavailable('DWG conversion requires ODA File Converter on the CAD worker. DXF files can be processed now.')
 target_dir.mkdir(parents=True,exist_ok=True)
 incoming=target_dir/'oda-input';outgoing=target_dir/'oda-output';incoming.mkdir(exist_ok=True);outgoing.mkdir(exist_ok=True)
 shutil.copyfile(source,incoming/source.name)
 args=[os.environ['ODA_FILE_CONVERTER'],str(incoming),str(outgoing),'ACAD2018',output_type,'0','1']
 if os.getenv('ODA_XVFB')=='1':args=['xvfb-run','-a',*args]
 p=subprocess.run(args,capture_output=True,text=True,timeout=120)
 matches=list(outgoing.glob('*.'+output_type.lower()))+list(outgoing.glob('*.'+output_type.upper()))
 if p.returncode or not matches:raise ValueError('ODA conversion failed; inspect the file in a CAD application or upload an exported DXF.')
 return matches[0]
