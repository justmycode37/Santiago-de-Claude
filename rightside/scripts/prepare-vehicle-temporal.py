#!/usr/bin/env python3
"""Freeze real decoded video pixels and exact source PTS. No app/model inference."""
import hashlib,json,re,subprocess,datetime,shutil
from fractions import Fraction
from pathlib import Path
import imageio_ffmpeg
ROOT=Path(__file__).resolve().parents[1]
r=ROOT/'redesign/evaluation/vehicle-v2'; out=r/'miami-temporal';out.mkdir(exist_ok=True)
source=r/'miami-original.mp4'
# Permit fixture decoding of the already-downloaded prefix; final manifest requires the complete source hash.
input_path=source if source.exists() else r/'miami-original.part'
args=[imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-threads','1','-i',str(input_path),'-t','44',
      '-vf',"select='between(t,24,44)*not(mod(n,15))',showinfo",'-fps_mode','passthrough',
      '-threads','1','-compression_level','3',str(out/'frame-%03d.png')]
if not list(out.glob('frame-*.png')):
 result=subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=100)
 (out/'decode.log').write_bytes(result.stderr)
 if result.returncode:raise RuntimeError('Frame decode failed; inspect decode.log')
log=(out/'decode.log').read_text()
tb=re.search(r'config in time_base: (\d+/\d+)',log);assert tb
base=Fraction(tb.group(1));rows=re.findall(r'n:\s*(\d+) pts:\s*(\d+) pts_time:([\d.]+).*?s:(\d+)x(\d+)',log)
files=sorted(out.glob('frame-*.png')); rows=rows[:len(files)]
assert len(files)==80 and len(rows)==80 and all(int(x[3])==1920 and int(x[4])==1080 for x in rows)
# Sparse coarse manual full-vehicle extents, visually labelled before any recognition run.
boxes={0:[.38,.24,.18,.36],16:[.54,.17,.17,.35],32:[.43,.27,.18,.33],48:[.31,.20,.18,.37],64:[.02,.17,.93,.72],76:[0,.10,.84,.75]}
frames=[]
for i,(path,row) in enumerate(zip(files,rows)):
 frames.append(dict(path='vehicle-temporal/'+path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
  sourcePTSValue=int(row[1]),sourceTimeBase=str(base),pts=float(int(row[1])*base),box=boxes.get(i),
  displayLabel='readable' if i in boxes else 'unscored'))
assert all(a['pts']<b['pts'] for a,b in zip(frames,frames[1:]))
(out/'decoded-frames.json').write_text(json.dumps(frames,indent=2)+'\n')
if not source.exists():
 print('Decoded80 frames; full source hash pending. No frozen manifest written.');raise SystemExit(0)
acq=json.loads((r/'miami-acquisition-resume.json').read_text());digest=hashlib.sha256(source.read_bytes()).hexdigest();assert digest==acq['sha256']
pack=dict(version=1,id='miami-route3-temporal-v1',frozenAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 sourceSHA256=digest,sourcePage=acq['sourcePage'],attribution='Bradley78 (BusFilmer785), Miami Dade Transit Aventura Mall Terminal Bus Spotting Part1; public Internet Archive copy; no explicit redistribution licence. Private research evaluation; not app-bundled or used to train weights.',
 expectedLine='3',expectedDestination='Downtown Miami',frames=frames,
 scope='One continuous actual bus encounter,24.024–43.79375 seconds of the source.80original-resolution decodedPNGframes at15-source-frame intervals; no synthesized movement or OCR enhancement. Source PTS retained exactly as integer/time-base. Six sparse readable-display boxes manually labelled; other frames unscored for text accuracy. Same encounter throughout; not80independent trials. No geographic pose or authoritative live-trip binding.',
 contract='Freeze before inference. Compare all three pipeline modes. Report positive temporal candidate availability, correct/incorrect sparse readings, busy drops, tracking gaps, wrong-service states, and measured processing time. Any verified-service output is unsupported. Keep this first sequence separate from still-image holdout; once inspected for tuning it is development evidence.')
manifest=out/'manifest.json'
if manifest.exists():
 existing=json.loads(manifest.read_text())
 assert existing['frames']==frames and existing['sourceSHA256']==digest, 'Frozen media changed; create a new version instead'
else:manifest.write_text(json.dumps(pack,indent=2)+'\n')
stage=ROOT/'dist/ios/indoor-lab/IndoorLab';dest=stage/'vehicle-temporal';dest.mkdir(exist_ok=True)
for p in files:shutil.copyfile(p,dest/p.name)
shutil.copyfile(manifest,stage/'vehicle-temporal.json')
print(json.dumps({'manifestSHA256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'frames':len(frames),'bytes':sum(p.stat().st_size for p in files),'sourceSHA256':digest},indent=2))
