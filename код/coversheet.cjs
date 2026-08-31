// coversheet.cjs — ОТЧЁТ ПО ОБЛОЖКАМ ОДНОЙ ДЕВУШКИ ОДНОЙ КАРТИНКОЙ (14.08).
//
// ЗАЧЕМ. Приказ владельца: «отчёт каждого кадра скинь мне в чат». Кадров будет 25 на девушку и
// 19 девушек — почти пятьсот. Слать их по одному значит похоронить чат: пролистать пятьсот
// сообщений и что-то в них сравнить нельзя. Лист на девушку показывает ВСЕ её кадры разом, под
// каждым номер и сходство лица, и брак виден сразу, потому что соседние кадры рядом.
//
// ЧТО НА ЛИСТЕ. Первой клеткой идёт ИСХОДНИК с зелёной пометкой — без него сравнивать не с чем:
// вопрос «похожа ли» требует, чтобы оригинал был на том же экране, а не в памяти.
//
// Запуск: node coversheet.cjs <папка_девушки> [исходник]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ПАПКА = process.argv[2];
const ИСХОДНИК = process.argv[3] || '';
if (!ПАПКА || !fs.existsSync(ПАПКА)) { console.log('нужна папка девушки'); process.exit(1); }

const обложки = fs.readdirSync(ПАПКА).filter((f) => /^обложка\d+.*\.jpg$/.test(f)).sort();
if (!обложки.length) { console.log('обложек нет'); process.exit(1); }

const имя = path.basename(ПАПКА);
const вход = [ИСХОДНИК && fs.existsSync(ИСХОДНИК) ? ИСХОДНИК : null, ...обложки.map((f) => path.join(ПАПКА, f))].filter(Boolean);
const подписи = [ИСХОДНИК && fs.existsSync(ИСХОДНИК) ? 'ИСХОДНИК' : null, ...обложки.map((f) => {
  const m = f.match(/лицо(0\.\d+)/);
  const н = (f.match(/обложка(\d+)/) || [])[1] || '';
  return `${Number(н)}${m ? `  ${m[1]}` : ''}`;
})].filter((x) => x !== null);

const выход = path.join(path.dirname(ПАПКА), `ЛИСТ_${имя}.jpg`);
const код = `
import sys, os, json
from PIL import Image, ImageDraw, ImageFont
файлы = json.loads(sys.argv[1]); подписи = json.loads(sys.argv[2])
выход = sys.argv[3]; заголовок = sys.argv[4]
КОЛ = 7; ЯЧ_Ш, ЯЧ_В, ПОЛЕ, ПОДП = 260, 340, 10, 34
ряды = (len(файлы) + КОЛ - 1) // КОЛ
лист = Image.new('RGB', (КОЛ*ЯЧ_Ш + ПОЛЕ*(КОЛ+1), ряды*(ЯЧ_В+ПОДП) + ПОЛЕ*(ряды+1) + 50), (18,18,20))
d = ImageDraw.Draw(лист)
def шр(р):
    for п in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf','/System/Library/Fonts/Helvetica.ttc']:
        if os.path.exists(п):
            try: return ImageFont.truetype(п, р)
            except Exception: pass
    return ImageFont.load_default()
Ф, Ф_З = шр(20), шр(30)
d.text((ПОЛЕ, 12), заголовок, font=Ф_З, fill=(255,255,255))
for i, (ф, п) in enumerate(zip(файлы, подписи)):
    x = ПОЛЕ + (i % КОЛ)*(ЯЧ_Ш+ПОЛЕ); y = 50+ПОЛЕ + (i//КОЛ)*(ЯЧ_В+ПОДП+ПОЛЕ)
    try:
        im = Image.open(ф).convert('RGB'); ш, в = im.size; нужн = ЯЧ_Ш/ЯЧ_В
        if ш/в > нужн:
            нш = int(в*нужн); im = im.crop(((ш-нш)//2, 0, (ш-нш)//2+нш, в))
        else:
            нв = int(ш/нужн); im = im.crop((0, 0, ш, min(нв, в)))
        лист.paste(im.resize((ЯЧ_Ш, ЯЧ_В), Image.LANCZOS), (x, y))
    except Exception:
        d.rectangle([x, y, x+ЯЧ_Ш, y+ЯЧ_В], fill=(60,30,30))
    цвет = (30,180,90) if п == 'ИСХОДНИК' else (230,30,60)
    ширина = 150 if п == 'ИСХОДНИК' else 96
    d.rectangle([x, y, x+ширина, y+30], fill=цвет)
    d.text((x+7, y+5), п, font=Ф, fill=(255,255,255))
лист.save(выход, quality=86)
print(выход)
`;
console.log(execFileSync('python3', ['-c', код, JSON.stringify(вход), JSON.stringify(подписи), выход,
  `${имя} — обложек ${обложки.length}`], { encoding: 'utf8' }).trim());
