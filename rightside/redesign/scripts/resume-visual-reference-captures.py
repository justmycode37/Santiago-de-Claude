#!/usr/bin/env python3
"""Explicitly authorized continuation: cumulative20→22 ranges, no image reselection."""
import pathlib,json,urllib.request,io,zipfile,zlib,struct,hashlib,datetime
root=pathlib.Path(__file__).resolve().parents[1];directory=root/'dist/workstream-C/C2/public-hpatches'
previous=json.load(open(directory/'provenance.json'))
assert previous['status']=='blocked'and len(previous['requests'])==20
for item in previous['files']+previous['decodedImages']:
 assert hashlib.sha256((directory/item['file']).read_bytes()).hexdigest()==item['sha256']
assert hashlib.sha256((directory/'UPSTREAM-DATASET-CARD.md').read_bytes()).hexdigest()==previous['licenseSource']['sha256']
events=[];total=previous['networkBytes'];etag=previous['requests'][0]['etag']
def fetch(range_,size):
 global total
 assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
 if len(events)>=2 or total+size>20000000:raise ValueError('cumulative acquisition budget exceeded')
 request=urllib.request.Request(previous['source'],headers={'Range':range_,'User-Agent':'RightSide-bounded-reference-research/1'})
 with urllib.request.urlopen(request,timeout=25)as response:
  headers={k.lower():v for k,v in response.headers.items()}
  if response.status!=206 or headers.get('etag')!=etag:raise ValueError('range/archive consistency rejected')
  data=response.read(size+1)
  if len(data)!=size:raise ValueError('range length mismatch')
 total+=len(data);events.append({'range':range_,'bytes':len(data),'contentRange':headers['content-range'],'etag':headers['etag']})
 return data,headers
try:
 tail,headers=fetch('bytes=-200000',200000);archiveSize=int(headers['content-range'].split('/')[-1])
 assert headers['content-range']==f'bytes {archiveSize-200000}-{archiveSize-1}/{archiveSize}'
 with zipfile.ZipFile(io.BytesIO(tail))as archive:
  entries=[i for i in archive.infolist()if i.filename=='hpatches-sequences-release/v_busstop/H_1_6']
  assert len(entries)==1;info=entries[0]
 offset=info.header_offset+archiveSize-len(tail)
 block,headers=fetch(f'bytes={offset}-{offset+4095}',4096)
 assert headers['content-range']==f'bytes {offset}-{offset+4095}/{archiveSize}'
 header=struct.unpack('<IHHHHHIIIHH',block[:30]);assert header[0]==0x04034b50
 nameLength,extraLength=header[-2:];assert block[30:30+nameLength].decode()==info.filename
 start=30+nameLength+extraLength;assert start+info.compress_size<=len(block)
 compressed=block[start:start+info.compress_size]
 if info.compress_type==zipfile.ZIP_DEFLATED:data=zlib.decompress(compressed,-15)
 elif info.compress_type==zipfile.ZIP_STORED:data=compressed
 else:raise ValueError('unsupported bounded entry encoding')
 assert len(data)==info.file_size and zlib.crc32(data)&0xffffffff==info.CRC
 assert len(data)<1000
 (directory/'H_1_6').write_bytes(data)
 previous['files'].append({'archivePath':info.filename,'file':'H_1_6','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 previous['status']='acquired';previous['priorFailure']=previous.pop('error')
except Exception as error:
 previous['status']='blocked';previous['continuationError']=f'{type(error).__name__}: {error}'
finally:
 previous['requests'].extend(events);previous['networkBytes']=total
 previous['budgetAmendment']={'maximumCumulativeRequests':22,'maximumCumulativeBytes':20000000,'reason':'manager explicitly approved exactly two missing-entry ranges after original20-request cap stopped acquisition','originalFailureRetained':'public-20261121T054025Z','at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 (directory/'provenance.json').write_text(json.dumps(previous,indent=2)+'\n');print(json.dumps(previous,indent=2))
raise SystemExit(0 if previous['status']=='acquired'else 2)
