#!/usr/bin/env python3
"""Bounded decode only; existing OpenCV FFmpeg native backend, no recognition."""
import os
os.environ['OMP_NUM_THREADS']='1'
os.environ['VECLIB_MAXIMUM_THREADS']='1'
import datetime,hashlib,json,resource,signal,sys,time
from pathlib import Path
import cv2
root=Path(__file__).resolve().parents[1]
assert not json.loads((root.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
source=Path(sys.argv[1]).resolve();out=source.parent/'frames';out.mkdir(exist_ok=False)
started=time.monotonic();record={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':str(source),'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'opencv':cv2.__version__,'operation':'native FFmpeg decode only; no model','capSeconds':60,'capPeakRSSBytes':512_000_000,'capFrames':48,'capSourceDuration':12,'frames':[]}
def timeout(*_):raise TimeoutError('60s decode cap')
signal.signal(signal.SIGALRM,timeout);signal.alarm(60)
cv2.setNumThreads(1)
try:
 cap=cv2.VideoCapture(str(source),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1,cv2.CAP_PROP_HW_ACCELERATION,cv2.VIDEO_ACCELERATION_NONE])
 assert cap.isOpened()
 fps=cap.get(cv2.CAP_PROP_FPS);assert 1<=fps<=120
 record.update(backend=cap.getBackendName(),decoderThreads=cap.get(cv2.CAP_PROP_N_THREADS),sourceFPS=fps,totalFrames=cap.get(cv2.CAP_PROP_FRAME_COUNT),width=cap.get(cv2.CAP_PROP_FRAME_WIDTH),height=cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
 next_sample=0.0;previous=-1.0;decoded=0
 while len(record['frames'])<48:
  ok,bgr=cap.read()
  if not ok:break
  decoded+=1;rawpts=cap.get(cv2.CAP_PROP_PTS);pts=rawpts/fps;msec=cap.get(cv2.CAP_PROP_POS_MSEC)
  assert pts>=0 and pts>previous,'missing/nonmonotonic original PTS';previous=pts
  assert abs(pts-msec/1000)<1/fps+1e-6,'PTS disagreement'
  if pts>=12:break
  assert resource.getrusage(resource.RUSAGE_SELF).ru_maxrss<512_000_000
  if pts+1e-6<next_sample:continue
  assert max(bgr.shape[:2])<=2560
  name=f'frame-{len(record["frames"]):03d}.png';path=out/name
  assert cv2.imwrite(str(path),bgr,[cv2.IMWRITE_PNG_COMPRESSION,2])
  record['frames'].append({'path':'frames/'+name,'sourcePTS':pts,'backendPTSTicks':rawpts,'backendPTSTimebaseDenominator':fps,'positionMilliseconds':msec,'decodedFrameOrdinal':decoded-1,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'decodedBGRSHA256':hashlib.sha256(bgr.tobytes()).hexdigest(),'width':bgr.shape[1],'height':bgr.shape[0]})
  next_sample+=0.25
 cap.release();record['decodedFrameCount']=decoded;record['status']='decoded';record['PTSNote']='FFmpeg presentation timestamps exposed by CAP_PROP_PTS in FPS timebase; crosschecked against CAP_PROP_POS_MSEC, not assigned from output index.'
except Exception as error:record.update(status='failed',error=str(error))
finally:
 signal.alarm(0);record.update(seconds=time.monotonic()-started,peakRSSBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,ended=datetime.datetime.now(datetime.timezone.utc).isoformat())
 (source.parent/'decode-manifest.json').write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps({k:v for k,v in record.items() if k!='frames'},indent=2));print('Extracted original PTS frames:',len(record['frames']))
 if record['status']!='decoded':sys.exit(1)
