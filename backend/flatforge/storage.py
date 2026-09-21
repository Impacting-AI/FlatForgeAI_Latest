import os, shutil
from pathlib import Path, PurePosixPath
from .db import DATA
class Storage:
 def __init__(self):
  self.root=DATA/'objects';self.root.mkdir(exist_ok=True);self.bucket=os.getenv('S3_BUCKET')
  if self.bucket:
   import boto3
   self.s3=boto3.client('s3',endpoint_url=os.getenv('S3_ENDPOINT') or None)
 def safe(self,key):
  p=PurePosixPath(key)
  if p.is_absolute() or '..' in p.parts:raise ValueError('Invalid object key')
  return str(p)
 def put(self,path,key):
  key=self.safe(key)
  if self.bucket:self.s3.upload_file(str(path),self.bucket,key)
  else:
   dest=self.root/key;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,dest)
  return key
 def get(self,key,dest):
  key=self.safe(key)
  if self.bucket:self.s3.download_file(self.bucket,key,str(dest))
  else:shutil.copyfile(self.root/key,dest)
 def delete(self,key):
  key=self.safe(key)
  if self.bucket:self.s3.delete_object(Bucket=self.bucket,Key=key)
  else:
   path=self.root/key
   if path.is_file():path.unlink()
 def stream(self,key):
  key=self.safe(key)
  if self.bucket:
   body=self.s3.get_object(Bucket=self.bucket,Key=key)['Body']
   try:
    for chunk in iter(lambda:body.read(1024*1024),b''):yield chunk
   finally:body.close()
  else:
   with open(self.root/key,'rb') as f:
    while chunk:=f.read(1024*1024):yield chunk
store=Storage()
