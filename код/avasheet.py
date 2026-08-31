# ЛИСТ С АВАТАРКАМИ, КОТОРЫЕ РЕАЛЬНО СТОЯТ НА АККАУНТАХ (09.08, приказ: «дай скриншот большой с
# авами, что стоят щас на акках, на 20-30 ав на скриншот, с номерами»).
#
# ЗАЧЕМ СНАРУЖИ. Можно нарисовать лист из нашего ZIP-пула, но это будет лист НАШИХ картинок, а не
# того, что видит прохожий: инстаграм мог файл не принять, обрезать иначе или откатить на дефолтный
# силуэт. Поэтому качаем profile_pic_url анонимной публичной ручкой, без входа в аккаунты.
#
# ГРАБЛЯ. Инстаграм режет по IP и отвечает «Please wait a few minutes» даже по аккаунтам, которые
# читались минуту назад. Ходим ЧЕРЕЗ ПРОКСИ из пула, меняем прокси на каждом запросе, держим паузу.
# «Лимит» и «профиля нет» это разные диагнозы, путать нельзя.
#
# Запуск: python3 avasheet.py <файл-со-списком-ников> [сколько-на-лист]
import sys, os, json, subprocess, time, shutil
from PIL import Image, ImageDraw, ImageFont

FILE = sys.argv[1]
PER = int(sys.argv[2]) if len(sys.argv) > 2 else 30
OUT = '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/ava_sheets'
UA = 'Instagram 219.0.0.12.117 Android'
CELL, PAD, LABEL, COLS = 300, 8, 34, 6

def proxies():
    out = []
    for f in ('/tmp/px/kz_sous_100.txt', '/tmp/px/kz_magos_100.txt'):
        try:
            for l in open(f):
                p = l.strip().split(':')
                if len(p) == 4:
                    out.append(f'http://{p[2]}:{p[3]}@{p[0]}:{p[1]}')
        except FileNotFoundError:
            pass
    return out

def profile(nick, proxy):
    args = ['curl', '-s', '--max-time', '25', '-H', f'User-Agent: {UA}', '-H', 'X-IG-App-ID: 936619743392459',
            f'https://i.instagram.com/api/v1/users/web_profile_info/?username={nick}']
    if proxy:
        args += ['--proxy', proxy]
    body = subprocess.run(args, capture_output=True, text=True).stdout
    if 'wait a few minutes' in body.lower():
        return {'лимит': True}
    try:
        u = json.loads(body, strict=False)['data']['user']
        return {'url': u.get('profile_pic_url_hd') or u['profile_pic_url'],
                'постов': u['edge_owner_to_timeline_media']['count']}
    except Exception:
        return {'нет': True}

def font(size):
    for p in ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/System/Library/Fonts/Helvetica.ttc'):
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except Exception: pass
    return ImageFont.load_default()

nicks = [l.strip() for l in open(FILE) if l.strip()]
px = proxies()
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT, exist_ok=True)
print(f'ников {len(nicks)}, прокси {len(px)}, на лист по {PER}')

got, lim, none = [], 0, 0
for i, n in enumerate(nicks):
    r = None
    for a in range(3):
        r = profile(n, px[(i * 3 + a) % len(px)] if px else None)
        if r.get('url'):
            break
        time.sleep(2)
    if r.get('url'):
        dst = f'{OUT}/raw_{len(got)+1:02d}.jpg'
        subprocess.run(['curl', '-s', '--max-time', '25', '-A', 'Mozilla/5.0', '-o', dst, r['url']])
        if os.path.exists(dst) and os.path.getsize(dst) > 1000:
            got.append((n, dst, r.get('постов')))
            print(f'  {len(got)} {n}: ава есть, постов {r.get("постов")}')
    else:
        if r.get('лимит'): lim += 1
        else: none += 1
        print(f'  {n}: {"лимит инстаграма" if r.get("лимит") else "профиль не отдаётся"}')
    time.sleep(1)

sheets = 0
for s in range(0, len(got), PER):
    part = got[s:s + PER]
    rows = (len(part) + COLS - 1) // COLS
    W = COLS * (CELL + PAD) + PAD
    H = rows * (CELL + LABEL + PAD) + PAD
    sheet = Image.new('RGB', (W, H), (10, 10, 12))
    d = ImageDraw.Draw(sheet)
    f = font(22)
    for j, (n, p, posts) in enumerate(part):
        col, row = j % COLS, j // COLS
        x = PAD + col * (CELL + PAD)
        y = PAD + row * (CELL + LABEL + PAD)
        try:
            im = Image.open(p).convert('RGB').resize((CELL, CELL), Image.LANCZOS)
            sheet.paste(im, (x, y))
        except Exception:
            d.rectangle([x, y, x + CELL, y + CELL], fill=(40, 40, 40))
        d.text((x + 4, y + CELL + 4), f'{s + j + 1}  {n}', fill=(255, 220, 90), font=f)
    sheets += 1
    out = f'{OUT}/ava_sheet_{sheets}.jpg'
    sheet.save(out, quality=88)
    print(f'лист {sheets}: {out} ({len(part)} ав)')

for _, p, _ in got:
    os.remove(p)
print(f'\nИТОГ: ав скачано {len(got)} из {len(nicks)}, лимит {lim}, профиль не отдаётся {none}, листов {sheets}')
print(f'папка: {OUT}')
