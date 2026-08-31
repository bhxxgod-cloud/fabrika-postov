#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Плашка обложки v6 (спека 21.08): НИЗ кадра, адаптивная прозрачность, шрифт канала,
# цветной Apple-эмодзи. Аргументы: кадр выход "ЗАГОЛОВОК" эмодзи шрифт1 [шрифт2] [вес] [альфа]
import sys, os
from PIL import Image, ImageDraw, ImageFont
frame, out, title, emoji = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
f1 = sys.argv[5]
f2 = sys.argv[6] if len(sys.argv)>6 and sys.argv[6] else None
wght = int(sys.argv[7]) if len(sys.argv)>7 and sys.argv[7] else None
alpha = int(sys.argv[8]) if len(sys.argv)>8 and sys.argv[8] else 255
W,H = 1080,1920
img = Image.open(frame).convert('RGB').resize((W,H))
def load(fp,sz,w=None):
    f=ImageFont.truetype(fp,sz)
    if w:
        try: f.set_variation_by_axes([w])
        except Exception: pass
    return f
words = title.split()
l1, l2 = '', ''
for w in words:
    if not l2 and len((l1+' '+w).strip()) <= (len(title)//2)+2: l1=(l1+' '+w).strip()
    else: l2=(l2+' '+w).strip()
if not l1: l1,l2 = l2,''
lines=[l for l in (l1,l2) if l]
maxlen=max(len(l) for l in lines)
fsz=max(44,min(84,int(980/(0.74*maxlen))))
d0=ImageDraw.Draw(img)
fA=load(f1,fsz,wght); fB=load(f2 or f1,fsz,wght if not f2 else None)
emoji_pad=int(fsz*1.15)+18
while fsz>36:
    wide=max(d0.textlength(lines[0],font=fA), (d0.textlength(lines[-1],font=fB)+emoji_pad) if len(lines)>0 else 0)
    if wide<=W*0.92: break
    fsz-=4; fA=load(f1,fsz,wght); fB=load(f2 or f1,fsz,wght if not f2 else None); emoji_pad=int(fsz*1.15)+18
lineH=int(fsz*1.42); padV=52; padB=52  # плашка приподнята: снизу просвет фото 10% (правка 21.08 v2)
emoji_size=int(fsz*1.15)
bandH=padV+padB+lineH*len(lines)
band_bottom=H-int(H*0.10)   # просвет фото под плашкой
band_y=band_bottom-bandH
ov=Image.new('RGBA',(W,H),(0,0,0,0))
d=ImageDraw.Draw(ov)
d.rectangle([0,band_y,W,band_bottom],fill=(0,0,0,alpha))
y=band_y+padV
for i,line in enumerate(lines):
    fnt = fA if i==0 else fB
    last=(i==len(lines)-1)
    tw=d.textlength(line,font=fnt)
    total=tw+(emoji_size+18 if last and emoji else 0)
    x=(W-total)/2
    d.text((x,y),line,font=fnt,fill=(255,255,255,255))
    if last and emoji:
        try:
            ef=ImageFont.truetype('/System/Library/Fonts/Apple Color Emoji.ttc',160)
            e=Image.new('RGBA',(220,220),(0,0,0,0))
            ImageDraw.Draw(e).text((10,10),emoji,font=ef,embedded_color=True)
            box=e.getbbox()
            if box:
                e=e.crop(box)
                r=emoji_size/max(e.size)
                e=e.resize((int(e.width*r),int(e.height*r)))
                ov.paste(e,(int(x+tw+18),int(y+(fsz-e.height)//2+6)),e)
        except Exception:
            pass
    y+=lineH
img=Image.alpha_composite(img.convert('RGBA'),ov).convert('RGB')
img.save(out,quality=92)
print(out)
