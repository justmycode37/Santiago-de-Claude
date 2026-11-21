#!/usr/bin/env python3
"""Independent analytic camera renderer. No Swift estimator/projection code or truth seeds.
Own generated textures; PNGs are actual raster inputs to Apple's native registration.
"""
import json, math, random, pathlib, struct, zlib, hashlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'dist/workstream-C/C2/fixtures'
W,H=640,480

def png(path,pixels):
 def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 raw=b''.join(b'\0'+bytes(pixels[y*W:(y+1)*W]) for y in range(H))
 path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',W,H,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
def matmul(a,b):return [[sum(a[i][k]*b[k][j] for k in range(3)) for j in range(3)]for i in range(3)]
def inv(a):
 d=a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0])
 return [[(a[(j+1)%3][(i+1)%3]*a[(j+2)%3][(i+2)%3]-a[(j+1)%3][(i+2)%3]*a[(j+2)%3][(i+1)%3])/d for j in range(3)]for i in range(3)]
def texture(seed):
 r=random.Random(seed); p=[238]*(W*H)
 for _ in range(360):
  x,y=r.randrange(24,W-24),r.randrange(24,H-24);w,h=r.randrange(6,80),r.randrange(6,60);c=r.randrange(20,220)
  for yy in range(y,min(H-24,y+h)):
   for xx in range(x,min(W-24,x+w)):p[yy*W+xx]=c
 for y in range(H):
  for x in range(W):
   if min(x,y,W-1-x,H-1-y)<5:p[y*W+x]=15
 return p
def render(src,h,background=92):
 a=inv(h);p=[background]*(W*H)
 for y in range(H):
  for x in range(W):
   z=a[2][0]*x+a[2][1]*y+a[2][2];u=(a[0][0]*x+a[0][1]*y+a[0][2])/z;v=(a[1][0]*x+a[1][1]*y+a[1][2])/z
   if 0<=u<W-1 and 0<=v<H-1:
    i,j=int(u),int(v);du,dv=u-i,v-j
    p[y*W+x]=round((1-du)*(1-dv)*src[j*W+i]+du*(1-dv)*src[j*W+i+1]+(1-du)*dv*src[(j+1)*W+i]+du*dv*src[(j+1)*W+i+1])
 return p

def main():
 assert not json.load(open(ROOT.parent/'docs/hill-climb/STATE.json'))['stopRequested']
 OUT.mkdir(parents=True,exist_ok=True);src=texture(62813);png(OUT/'reference.png',src)
 cases=[]
 for name,tx,ty,z,yaw,pitch,roll in [('identity',0,0,2.5,0,0,0),('translation',.055,-.04,2.5,0,0,0),('projective',.035,.025,2.55,3,-2,1),('oblique',-.08,.035,2.7,-7,4,-2),('physical-roll180',0,0,2.5,0,0,180)]:
  ay,ax,az=map(math.radians,[yaw,pitch,roll]);cy,sy,cx,sx,cz,sz=math.cos(ay),math.sin(ay),math.cos(ax),math.sin(ax),math.cos(az),math.sin(az)
  R=matmul(matmul([[cy,0,sy],[0,1,0],[-sy,0,cy]],[[1,0,0],[0,cx,-sx],[0,sx,cx]]),[[cz,-sz,0],[sz,cz,0],[0,0,1]])
  Rt=[list(v)for v in zip(*R)];t=[tx,ty,z];tc=[-sum(Rt[i][j]*t[j] for j in range(3)) for i in range(3)]
  # plane pixel -> plane metric -> camera right/up/back -> top-left calibrated sensor
  plane=[[1/320,0,-1],[0,-1/320,.75],[0,0,1]]
  camera=[[Rt[i][0],Rt[i][1],tc[i]]for i in range(3)]
  K=[[800,0,-320],[0,-800,-240],[0,0,-1]]
  h=matmul(matmul(K,camera),plane)
  pixels=render(src,h);png(OUT/(name+'.png'),pixels)
  siteR=matmul([[1,0,0],[0,0,-1],[0,1,0]],R);siteT=[tx,-z,1.5+ty]
  pose=[siteR[row][col] if row<3 and col<3 else siteT[row] if col==3 and row<3 else 1 if row==col else 0 for col in range(4)for row in range(4)]
  captureRotation=[R[row][col] if row<3 and col<3 else 1 if row==col else 0 for col in range(4)for row in range(4)]
  cases.append(dict(id=name,image=name+'.png',expectedMatch=True,captureWorldFromCamera=captureRotation,truthPose=pose,homography=[h[row][col]for col in range(3)for row in range(3)]))
 png(OUT/'mismatch.png',texture(41492));cases.append(dict(id='mismatch',image='mismatch.png',expectedMatch=False))
 # Challenge images are not independent captures. Declared harsh corruptions should abstain.
 for name,pixels in [('flat',[127]*(W*H)),('repeated',[30 if (x//20+y//20)%2 else 230 for y in range(H)for x in range(W)]),('rotated180',list(reversed(src)))]:
  png(OUT/(name+'.png'),pixels);cases.append(dict(id=name,image=name+'.png',expectedMatch=False))
 occluded=list(src)
 for y in range(H):
  for x in range(W//2):occluded[y*W+x]=92
 png(OUT/'occlusion50.png',occluded);cases.append(dict(id='occlusion50',image='occlusion50.png',expectedMatch=False))
 # Separable box blur, radius 12: harsh blur is a negative usability case.
 radius=12;temporary=[]
 for y in range(H):
  prefix=[0]
  for value in src[y*W:(y+1)*W]:prefix.append(prefix[-1]+value)
  temporary.extend(round((prefix[min(W,x+radius+1)]-prefix[max(0,x-radius)])/(min(W,x+radius+1)-max(0,x-radius)))for x in range(W))
 blurred=[0]*(W*H)
 for x in range(W):
  prefix=[0]
  for y in range(H):prefix.append(prefix[-1]+temporary[y*W+x])
  for y in range(H):blurred[y*W+x]=round((prefix[min(H,y+radius+1)]-prefix[max(0,y-radius)])/(min(H,y+radius+1)-max(0,y-radius)))
 png(OUT/'blur25.png',blurred);cases.append(dict(id='blur25',image='blur25.png',expectedMatch=False))
 for case in cases:
  case.setdefault('captureWorldFromCamera',[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])
  case['captureMetadata']='simulated relative VIO rotation and gravity only; no absolute site camera position used by estimator; corrupted images retain original capture metadata'
 data=dict(evidenceKind='synthetic_projective_pixels_not_independent_capture',seed=62813,reference='reference.png',calibration=dict(width=W,height=H,fx=800,fy=800,cx=320,cy=240,imageOrientation='raw_sensor'),plane=dict(id='generated-plane',widthMeters=2,heightMeters=1.5,siteFromPlane=[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,1.5,1]),cases=cases)
 (OUT/'manifest.json').write_text(json.dumps(data,indent=2)+'\n')
 # Two separate physical planes/textures in one sensor frame; proposals must come from pixels.
 other=texture(99427);png(OUT/'reference-B.png',other)
 references=[]
 for name,cx in [('A',-.8),('B',.8)]:
  references.append(dict(id=name,image='reference.png' if name=='A' else 'reference-B.png',plane=dict(id=name,widthMeters=1.3,heightMeters=.975,siteFromPlane=[1,0,0,0,0,0,1,0,0,-1,0,0,cx,0,1.5,1])))
 scenes=[]
 for i,(tx,ty,z)in enumerate([(0,0,3.8),(.025,.015,3.82),(-.035,-.02,3.78)]):
  pixels=[92]*(W*H);truths={}
  for reference,texture_ in zip(references,[src,other]):
   cx=reference['plane']['siteFromPlane'][12];sx=800*1.3/(W*z);sy=800*.975/(H*z)
   h=[[sx,0,320+800*(cx-tx)/z-sx*W/2],[0,sy,240+800*ty/z-sy*H/2],[0,0,1]]
   part=render(texture_,h,background=-1)
   pixels=[a if b<0 else b for a,b in zip(pixels,part)]
   truths[reference['id']]=[h[row][col]for col in range(3)for row in range(3)]
  name=f'two-plane-{i}';png(OUT/(name+'.png'),pixels)
  scenes.append(dict(id=name,image=name+'.png',truthPose=[1,0,0,0,0,0,1,0,0,-1,0,0,tx,-z,1.5+ty,1],homographies=truths))
 (OUT/'scenes.json').write_text(json.dumps(dict(evidenceKind='synthetic_two_distinct_planes_actual_pixels',calibration=data['calibration'],references=references,scenes=scenes),indent=2)+'\n')
 print(json.dumps({'fixtureCount':len(cases),'manifestSHA256':hashlib.sha256((OUT/'manifest.json').read_bytes()).hexdigest()}))
if __name__=='__main__':main()
