#!/usr/bin/env python3
"""Freeze a previously unevaluated bus encounter. No recognition inference."""
from pathlib import Path
import json,hashlib,re,shutil,datetime
ROOT=Path(__file__).resolve().parents[1];r=ROOT/'redesign/evaluation/vehicle-v3';stage=ROOT/'dist/ios/indoor-lab/IndoorLab';dest=stage/'vehicle-reserve';dest.mkdir(exist_ok=True)
files=sorted((r/'reserve').glob('frame-*.png'));log=(r/'reserve-decode.log').read_text();pts=[float(x) for x in re.findall(r'n:\s*\d+ pts:\s*\d+ pts_time:([\d.]+)',log)][:len(files)]
assert len(files)==8 and len(pts)==8
boxes=[[.46,.32,.22,.44],[.52,.20,.32,.61],[.47,.22,.28,.61],[.42,.14,.29,.68],[.39,.18,.36,.77],[.35,.25,.27,.51],[.30,.17,.34,.64],[.20,.10,.49,.88]]
rows=[]
for i,(p,t,b) in enumerate(zip(files,pts,boxes)):
 path='vehicle-reserve/'+p.name;shutil.copyfile(p,stage/path)
 rows.append(dict(id=f'miami-route1-{i}',path=path,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),sourcePTS=t,encounter='miami-broward-route1',split='fresh-heldout-encounter',kind='bus',line='1',destination='Central Terminal' if i in [0,3,6] else 'Intl Airport',destinationStatus='readable',box=b))
pack=dict(version=1,id='miami-route1-stills-v1',frozenAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),photos=rows,
 attribution='Bradley78 (BusFilmer785), same publicly archived Miami terminal recording. No explicit redistribution licence. Private research evaluation only; not app-bundled.',
 sampling='Eight original-resolution decoded frames at120-source-frame intervals,72.072–86.086seconds. One previously unevaluated bus encounter. Expected labels manually transcribed before inference. No model receives labels. Same camera/site as route3 footage, not unseen-domain validation.',
 limitation='Display alternates CENTRAL TERMINAL and airplane icon + INTL AIRPORT. Labels are the visible text only, not inferred final destination or service direction. Still-image evaluation resets tracking; no temporal claim from these sparse frames.')
p=r/'reserve-manifest.json';assert not p.exists(),'Do not overwrite a frozen reserve';p.write_text(json.dumps(pack,indent=2)+'\n');shutil.copyfile(p,stage/'vehicle-reserve.json');print(hashlib.sha256(p.read_bytes()).hexdigest())
