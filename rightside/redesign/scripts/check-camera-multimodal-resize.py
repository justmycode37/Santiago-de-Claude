#!/usr/bin/env python3
"""Resize-only preflight; no OCR, model import, compilation or expected text."""
import hashlib,json,math,resource,time
from pathlib import Path
import numpy as np
root=Path(__file__).resolve().parents[1]
assert not json.loads((root.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
base=root/'dist/hill-climb-b3/swift-parity.l_0l63c9';original=root/'dist/hill-climb-b3/conversion.zhizqi_c'
out=root/'dist/hill-climb-b3/resize-source/resize-kleidi-preflight2.json'
started=time.monotonic();results=[]
previous=json.loads((base/'native-parity.json').read_text())['pixelRows']
for crop in json.loads((base/'crop-manifest.json').read_text()):
 i,w,h=crop['index'],crop['width'],crop['height'];dw=min(320,math.ceil(48*w/h));dh=48
 pixels=np.fromfile(base/('crop-'+str(i)+'.bgr'),dtype=np.uint8).reshape(h,w,3).astype(np.int64)
 # Pinned KleidiCV26.09 generic uint8 path: Q16 half-pixel coordinates,
 # high15-bit fractions, rounded signed multiply-high at EACH axis (not one final round).
 def coords(nom,denom):
  q=(((np.arange(denom,dtype=np.int64)*65536+32768)*nom+denom//2)//denom)-32768+1
  return q>>16,(q&65535)>>1
 # Mirror generic3-channel NEON lane coordinate generation, including Q32 anchors
 # for full16-byte vectors and Q16 stepping in final8-byte tails.
 def div(n,d):return (n+d//2)//d
 full=(dw*3//32)*2 if w*3 >= (16 if w<=dw else 32 if w<=dw*2 else 48) else 0
 qs=np.zeros(dw*3,np.int64)
 initial=div(w<<31,dw)-(1<<31)+(3<<15);step32=div((w*16)<<32,dw)
 for e in range(full*16):
  group=e//48;local=(e%48)//3
  qs[e]=((initial+group*step32)>>16)+div((local*w)<<16,dw)
 cursor=full*16
 for _ in range((dw*3-cursor+7)//8):
  cursor=min(cursor,dw*3-8);dx=cursor//3
  anchor=div(((dx<<16)+32768)*w,dw)-32768+1
  step=div(w<<16,dw)
  for e in range(cursor,cursor+8):qs[e]=anchor+((e//3)-dx)*step
  cursor+=8
 sx=(qs>>16).reshape(dw,3);fx=((qs&65535)>>1).reshape(dw,3);sy,fy=coords(h,dh)
 a=pixels[np.clip(sy,0,h-1)[:,None,None],np.clip(sx,0,w-1)[None,:,:],np.arange(3)[None,None,:]]
 b=pixels[np.clip(sy,0,h-1)[:,None,None],np.clip(sx+1,0,w-1)[None,:,:],np.arange(3)[None,None,:]]
 c=pixels[np.clip(sy+1,0,h-1)[:,None,None],np.clip(sx,0,w-1)[None,:,:],np.arange(3)[None,None,:]]
 d=pixels[np.clip(sy+1,0,h-1)[:,None,None],np.clip(sx+1,0,w-1)[None,:,:],np.arange(3)[None,None,:]]
 top=a+(((b-a)*fx[None,:,:]+16384)>>15)
 bottom=c+(((d-c)*fx[None,:,:]+16384)>>15)
 resized=top+(((bottom-top)*fy[:,None,None]+16384)>>15)
 tensor=np.zeros((1,3,48,320),np.float32);tensor[0,:,:,:dw]=resized.astype(np.float32).transpose(2,0,1)/127.5-1
 reference=np.fromfile(original/('input-'+str(i)+'.float32'),dtype='<f4').reshape(tensor.shape)
 errors=np.abs(tensor-reference)
 results.append({'index':i,'shape':[w,h],'oldMaxError':previous[i]['inputMaxError'],'newMaxError':float(errors.max()),'newMeanError':float(errors.mean()),'differentElements':int(np.count_nonzero(errors)),'passed':bool(np.array_equal(tensor,reference))})
report={'sourceSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'seconds':time.monotonic()-started,'peakResidentBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'algorithm':'KleidiCV26.09 Q32 full-vector anchors/Q16 tail stepping, Q15 fractions, signed rounding multiply-high at each axis, replicated borders','rows':results,'passed':all(r['passed'] for r in results)}
out.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2));raise SystemExit(0 if report['passed'] else 1)
