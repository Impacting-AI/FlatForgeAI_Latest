"""Build the portable source download without secrets or generated build trees."""
from pathlib import Path
import zipfile, shutil
root=Path(__file__).resolve().parents[2]
out=root/'public/downloads';out.mkdir(exist_ok=True)
shutil.copyfile(root/'ARCHITECTURE.md',out/'ARCHITECTURE.md')
excluded={'node_modules','.git','.next','.wrangler','.sites-runtime','dist','dist-spa','__pycache__','.pytest_cache','downloads','data'}
with zipfile.ZipFile(out/'FlatForge-source.zip','w',zipfile.ZIP_DEFLATED) as z:
 for directory,folders,files in __import__('os').walk(root):
  folders[:]=sorted(f for f in folders if f not in excluded)
  for name in sorted(files):
   p=Path(directory)/name;rel=p.relative_to(root)
   if name.endswith('.tsbuildinfo') or (name.startswith('.env') and name!='.env.example') or name=='.dev.vars':continue
   if '.openai' in rel.parts and name!='hosting.json':continue
   z.write(p,'FlatForge/'+str(rel))
print(out/'FlatForge-source.zip')
