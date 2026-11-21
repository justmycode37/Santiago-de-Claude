#!/usr/bin/env python3
"""Predeclared independent captures3/5. Bounded7range requests,15MB, no whole archive."""
import pathlib,json,urllib.request,io,zipfile,zlib,struct,hashlib,datetime
root=pathlib.Path(__file__).resolve().parents[1];base=root/'dist/workstream-C/C2/public-20261121T054230Z/captures';out=root/'dist/workstream-C/C2/heldout-hpatches';out.mkdir(parents=True,exist_ok=True)
prior=json.load(open(base/'provenance.json'));events=[];total=0;etag=prior['requests'][0]['etag']
manifest={'source':prior['source'],'datasetRevision':prior['datasetRevision'],'license':prior['license'],'licenseSource':prior['licenseSource'],'citation':prior['citation'],'files':[],'decodedImages':[],'evidenceKind':'independent_captures_same_site_not_independent_site','reservedPairs':[['1','3'],['1','5']],'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def fetch(range_,size):
 global total
 assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
 if len(events)>=10 or total+size>15000000:raise ValueError('bounded acquisition budget exceeded')
 request=urllib.request.Request(prior['source'],headers={'Range':range_,'User-Agent':'RightSide-bounded-reference-research/1'})
 with urllib.request.urlopen(request,timeout=25)as response:
  headers={k.lower():v for k,v in response.headers.items()}
  if response.status!=206 or headers.get('etag')!=etag:raise ValueError('range/archive changed')
  data=response.read(size+1)
  if len(data)!=size:raise ValueError('range length mismatch')
 total+=len(data);events.append({'range':range_,'bytes':len(data),'contentRange':headers['content-range'],'etag':etag});return data,headers

def png(data,path):
 position=0;tokens=[]
 while len(tokens)<4:
  while data[position:position+1].isspace():position+=1
  if data[position:position+1]==b'#':position=data.index(b'\n',position)+1;continue
  end=position
  while not data[end:end+1].isspace():end+=1
  tokens.append(data[position:end]);position=end
 assert tokens[0]==b'P6'and tokens[3]==b'255'
 width,height=map(int,tokens[1:3]);position+=2 if data[position:position+2]==b'\r\n'else 1;pixels=data[position:]
 assert width*height<=4000000 and len(pixels)==width*height*3
 def chunk(kind,body):return struct.pack('>I',len(body))+kind+body+struct.pack('>I',zlib.crc32(kind+body)&0xffffffff)
 raw=b''.join(b'\0'+pixels[y*width*3:(y+1)*width*3]for y in range(height))
 encoded=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'');path.write_bytes(encoded)
 return {'file':path.name,'width':width,'height':height,'sha256':hashlib.sha256(encoded).hexdigest(),'derivation':'lossless PPM RGB to PNG'}
try:
 for name in ['1.ppm','1.png','UPSTREAM-DATASET-CARD.md']:
  data=(base/name).read_bytes();(out/name).write_bytes(data)
  manifest.setdefault('reusedFiles',[]).append({'file':name,'sha256':hashlib.sha256(data).hexdigest(),'sourceSnapshot':str(base)})
 tail,headers=fetch('bytes=-200000',200000);size=int(headers['content-range'].split('/')[-1])
 assert headers['content-range']==f'bytes {size-200000}-{size-1}/{size}'
 with zipfile.ZipFile(io.BytesIO(tail))as archive:entries={i.filename:i for i in archive.infolist()}
 for name in ['3.ppm','5.ppm','H_1_3','H_1_5']:
  info=entries['hpatches-sequences-release/v_busstop/'+name];offset=info.header_offset+size-len(tail)
  block,headers=fetch(f'bytes={offset}-{offset+4095}',4096)
  assert headers['content-range']==f'bytes {offset}-{offset+4095}/{size}'
  header=struct.unpack('<IHHHHHIIIHH',block[:30]);assert header[0]==0x04034b50
  nameLength,extraLength=header[-2:];assert block[30:30+nameLength].decode()==info.filename
  start=30+nameLength+extraLength
  if start+info.compress_size<=len(block):compressed=block[start:start+info.compress_size]
  else:
   compressed,headers=fetch(f'bytes={offset+start}-{offset+start+info.compress_size-1}',info.compress_size)
   assert headers['content-range']==f'bytes {offset+start}-{offset+start+info.compress_size-1}/{size}'
  assert info.file_size<=12000000
  data=zlib.decompress(compressed,-15)if info.compress_type==zipfile.ZIP_DEFLATED else compressed
  assert len(data)==info.file_size and zlib.crc32(data)&0xffffffff==info.CRC
  (out/name).write_bytes(data);manifest['files'].append({'archivePath':info.filename,'file':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
  if name.endswith('.ppm'):manifest['decodedImages'].append(png(data,out/name.replace('.ppm','.png')))
 manifest['status']='acquired'
except Exception as error:manifest['status']='blocked';manifest['error']=f'{type(error).__name__}: {error}'
finally:
 manifest['requests']=events;manifest['networkBytes']=total;(out/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
raise SystemExit(0 if manifest['status']=='acquired'else 2)
