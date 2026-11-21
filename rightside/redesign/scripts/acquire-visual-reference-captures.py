#!/usr/bin/env python3
"""Bounded HTTP-range ZIP extraction of three HPatches v_busstop real captures.
Official HPatches README links the author's HF dataset; pinned card declares MIT.
Never downloads the 1.3GB archive. No credentials. 20MB network/12MB file/20 requests.
"""
import io,json,hashlib,pathlib,urllib.request,zipfile,datetime,struct,zlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'dist/workstream-C/C2/public-hpatches'
REV='594f211e80b75081ad84a396c93960c8653235f8'
URL=f'https://huggingface.co/datasets/vbalnt/hpatches/resolve/{REV}/hpatches-sequences-release.zip'
def stop():assert not json.load(open(ROOT.parent/'docs/hill-climb/STATE.json'))['stopRequested']
class RemoteZip(io.RawIOBase):
 def __init__(self,initialBytes=0):
  self.position=0;self.total=initialBytes;self.requests=0;self.events=[]
  _,headers=self.fetch('bytes=-65536',65536);self.size=int(headers['content-range'].split('/')[-1])
 def readable(self):return True
 def seekable(self):return True
 def tell(self):return self.position
 def seek(self,offset,whence=0):
  self.position=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
  if not 0<=self.position<=self.size:raise ValueError('invalid range')
  return self.position
 def fetch(self,range_,maximum):
  stop();self.requests+=1
  if self.requests>20 or maximum>12_000_000 or self.total+maximum>20_000_000:raise ValueError('acquisition budget exceeded')
  request=urllib.request.Request(URL,headers={'Range':range_,'User-Agent':'RightSide-bounded-reference-research/1'})
  with urllib.request.urlopen(request,timeout=25)as response:
   if response.status!=206:raise ValueError('Server did not honor range; full archive refused')
   data=response.read(maximum+1);headers={k.lower():v for k,v in response.headers.items()}
   if len(data)>maximum:raise ValueError('range size exceeded')
  self.total+=len(data);self.events.append({'range':range_,'bytes':len(data),'contentRange':headers.get('content-range'),'etag':headers.get('etag')})
  return data,headers
 def read(self,n=-1):
  if n<0:n=self.size-self.position
  if n==0:return b''
  n=min(n,self.size-self.position);data,_=self.fetch(f'bytes={self.position}-{self.position+n-1}',n);self.position+=len(data);return data
def convert_ppm(data,path):
 position=0;tokens=[]
 while len(tokens)<4:
  while data[position:position+1].isspace():position+=1
  if data[position:position+1]==b'#':
   position=data.index(b'\n',position)+1;continue
  end=position
  while not data[end:end+1].isspace():end+=1
  tokens.append(data[position:end]);position=end
 if tokens[0]!=b'P6' or tokens[3]!=b'255':raise ValueError('Only 8-bit RGB PPM supported')
 width,height=map(int,tokens[1:3]);position+=2 if data[position:position+2]==b'\r\n' else 1
 pixels=data[position:]
 if width*height>4_000_000 or len(pixels)!=width*height*3:raise ValueError('PPM dimensions/buffer invalid')
 def chunk(kind,body):return struct.pack('>I',len(body))+kind+body+struct.pack('>I',zlib.crc32(kind+body)&0xffffffff)
 raw=b''.join(b'\0'+pixels[y*width*3:(y+1)*width*3]for y in range(height))
 output=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
 path.write_bytes(output);return {'file':path.name,'width':width,'height':height,'sha256':hashlib.sha256(output).hexdigest(),'derivation':'lossless RGB PPM to PNG; same decoded pixels'}
stop();OUT.mkdir(parents=True,exist_ok=True)
manifest={'source':URL,'datasetRevision':REV,'officialLink':'https://github.com/hpatches/hpatches-dataset','license':'MIT per author HF dataset card; retain upstream notice','sequence':'v_busstop (introduced by HPatches authors)','citation':'Balntas, Lenc, Vedaldi, Mikolajczyk. HPatches, CVPR 2017.','purpose':'independent real-image registration only; no calibrated metric/Swiss/field pose truth','retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':[]}
try:
 stop()
 cardURL=f'https://huggingface.co/datasets/vbalnt/hpatches/raw/{REV}/README.md'
 with urllib.request.urlopen(cardURL,timeout=15)as response:card=response.read(100001)
 if len(card)>100000 or b'license: mit'not in card:raise ValueError('Pinned author dataset license unavailable')
 (OUT/'UPSTREAM-DATASET-CARD.md').write_bytes(card)
 manifest['licenseSource']={'url':cardURL,'sha256':hashlib.sha256(card).hexdigest()}
 remote=RemoteZip(initialBytes=len(card))
 with zipfile.ZipFile(remote)as archive:
  wanted=['1.ppm','2.ppm','6.ppm','H_1_2','H_1_6']
  for name in wanted:
   candidates=[info for info in archive.infolist()if info.filename.endswith('/v_busstop/'+name)]
   if len(candidates)!=1:raise ValueError('expected exact sequence entry')
   info=candidates[0]
   if info.file_size>12_000_000:raise ValueError('uncompressed file budget exceeded')
   data=archive.read(info);(OUT/name).write_bytes(data)
   manifest['files'].append({'archivePath':info.filename,'file':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
   if name.endswith('.ppm'):manifest.setdefault('decodedImages',[]).append(convert_ppm(data,OUT/name.replace('.ppm','.png')))
 manifest['networkBytes']=remote.total;manifest['requests']=remote.events;manifest['status']='acquired'
except Exception as e:
 manifest['status']='blocked';manifest['error']=f'{type(e).__name__}: {e}'
 if 'remote'in globals():manifest['networkBytes']=remote.total;manifest['requests']=remote.events
finally:
 (OUT/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
