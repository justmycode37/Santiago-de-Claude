#!/usr/bin/env python3
"""Deterministic indoor image-localization board. Research fixture, no inference."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import hashlib,json
root=Path(__file__).resolve().parents[1];out=root/'dist/ios/indoor-lab/IndoorLab';out.mkdir(parents=True,exist_ok=True)
W,H=1600,1000
board=Image.new('RGB',(W,H),'#f4f3ed');d=ImageDraw.Draw(board)
font='/System/Library/Fonts/Supplemental/Arial.ttf'
large=ImageFont.truetype(font,46);small=ImageFont.truetype(font,25);tiny=ImageFont.truetype(font,20)
d.rectangle([2,2,W-3,H-3],outline='#161d23',width=6)
d.text((70,55),'RIGHTSIDE · AUTOMATIC ALIGNMENT TEST',font=large,fill='#161d23')
d.text((70,122),'Show the whole board. The phone finds both images and places the green ring itself.',font=small,fill='#161d23')
refs=[]
for name,x in [('bus',100),('tram',900)]:
 im=Image.open(root/f'redesign/evaluation/images/{name}.jpg').convert('RGB').resize((600,450),Image.Resampling.LANCZOS)
 p=out/f'reference-{name}.png';im.save(p);board.paste(im,(x,230))
 d.text((x,700),name.upper()+' REFERENCE',font=small,fill='#161d23')
 refs.append(dict(id=name,path=p.name,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),rectPixels=[x,230,600,450]))
center=(800,455)
d.ellipse([760,415,840,495],outline='#9b1486',width=5);d.line([745,455,855,455],fill='#9b1486',width=3);d.line([800,400,800,510],fill='#9b1486',width=3)
d.text((745,540),'TARGET',font=small,fill='#741366')
d.text((70,790),'The green ring should surround the purple target as you move left or right.',font=small,fill='#161d23')
d.text((70,835),'Screen size may vary. Measure the full outer border width only if testing metric scale.',font=small,fill='#161d23')
d.text((70,900),'Bus: S5A-0043 · CC BY-SA 4.0. Tram: Nicolapps · CC BY 4.0. Resized research derivatives.',font=tiny,fill='#3a4148')
d.text((70,935),'Source links and licences: Indoor lab → Sources & research licences. No station-location claim.',font=tiny,fill='#3a4148')
board.save(out/'reference-board.png')
layout=dict(version=1,id='indoor-reference-v1',widthPixels=W,heightPixels=H,nominalWidthMeters=.4,targetPixels=list(center),references=refs,boardSHA256=hashlib.sha256((out/'reference-board.png').read_bytes()).hexdigest(),purpose='Automatic two-image pose consensus and shared marker rendering. Nominal width is not measured. Screen tests establish visual registration only unless width supplied.')
(out/'reference-layout.json').write_text(json.dumps(layout,indent=2))
(root/'redesign/evaluation/indoor-lab/reference-contract.json').write_text(json.dumps(dict(layoutSHA256=hashlib.sha256((out/'reference-layout.json').read_bytes()).hexdigest(),**layout),indent=2))
print(out/'reference-board.png')
