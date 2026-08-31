# Подпись на аву. Героиню слегка поднимаем, подпись компактная, всё внутри круга.
import sys, os, math
from PIL import Image, ImageDraw, ImageFont
SRC=sys.argv[1]; OUT=sys.argv[2]; FONT=sys.argv[3]; MODE=sys.argv[4] if len(sys.argv)>4 else 'two'
S=1024
im=Image.open(SRC).convert('RGB').resize((S,S), Image.LANCZOS)
# зум 12% и сдвиг вверх: освобождаем низ под подпись, жест остаётся видимым
z=1.12; big=im.resize((int(S*z),int(S*z)), Image.LANCZOS)
ox=(big.width-S)//2; oy=int((big.height-S)*0.30)
im=big.crop((ox,oy,ox+S,oy+S))
d=ImageDraw.Draw(im,'RGBA')
lines=(['СПРОСИ','У КАТИ'] if MODE=='two' else ['КАТЯ'])
def chord(yc):
    dy=abs(yc-S/2)/(S/2)
    return 2*(S/2)*math.sqrt(max(0.0,1-dy*dy))
band_cy=int(S*0.815)
maxw=chord(band_cy)*0.78
size=int(S*0.105) if MODE=='two' else int(S*0.17)
while size>12:
    f=ImageFont.truetype(FONT,size)
    if max(d.textbbox((0,0),l,font=f)[2] for l in lines)<=maxw: break
    size-=2
f=ImageFont.truetype(FONT,size)
lh=int(size*1.0); total=lh*len(lines); top=band_cy-total//2
pad_x=int(size*0.5); pad_y=int(size*0.22)
w=max(d.textbbox((0,0),l,font=f)[2] for l in lines)
x0=(S-w)//2-pad_x; x1=(S+w)//2+pad_x; y0=top-pad_y; y1=top+total+pad_y
d.rounded_rectangle([x0,y0,x1,y1], radius=int((y1-y0)*0.28), fill=(17,17,20,210))
for i,l in enumerate(lines):
    bb=d.textbbox((0,0),l,font=f)
    d.text(((S-(bb[2]-bb[0]))//2-bb[0], top+i*lh-bb[1]), l, font=f, fill=(255,255,255,255))
im.save(OUT,'JPEG',quality=94)
