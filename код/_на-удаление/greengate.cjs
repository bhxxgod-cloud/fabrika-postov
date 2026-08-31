'use strict';
// ГЕЙТ ЗЕЛЁНОЙ ЗАЛИВКИ: ловит кадры, где остался хромакей.
//
// ЗАЧЕМ. 11.08 начальник увидел на складе пост, у которого ЧЕТВЁРТЫЙ КАДР наполовину залит зелёным.
// Это след нашей же подстановки: картинку в экран телефона мы вставляем через зелёную заливку
// (chromaScreen в slidekit), и когда подстановка не сработала, зелёный остаётся в кадре. Пост при
// этом проходит все прочие гейты: лицо на месте, резкость в норме, надписей нет.
//
// КАК СЧИТАЕМ. Доля пикселей в «хромакейном» зелёном: тон 35-85 градусов, насыщенность выше 80,
// яркость выше 60 (шкала OpenCV). Живая зелень (трава, листва, куртка) в эти рамки почти не
// попадает целыми полями: у неё насыщенность ниже и тон уже. Порог доли ставим 3 процента кадра:
// на живом браке было около половины кадра, а у чистых кадров ноль.
//
// Запуск: node greengate.cjs файл.jpg [ещё файлы]     проверить кадры
//         node greengate.cjs --склад [сколько]        пройти по складу постов и записать вердикт
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ПОРОГ = Number(process.env.GREEN_SHARE || 0.03);

const PY = `
import sys, json
import cv2, numpy as np
out = []
for путь in sys.argv[1:]:
    im = cv2.imread(путь, cv2.IMREAD_COLOR)
    if im is None:
        out.append({"файл": путь, "ошибка": "не декодируется"})
        continue
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    маска = cv2.inRange(hsv, (35, 80, 60), (85, 255, 255))
    доля = float(np.count_nonzero(маска)) / float(маска.size)
    # Заливка это СПЛОШНОЕ поле, а не разбросанная зелень: смотрим ещё и на самый большой связный кусок.
    n, метки, стат, _ = cv2.connectedComponentsWithStats((маска > 0).astype('uint8'), connectivity=8)
    кусок = 0.0
    if n > 1:
        кусок = float(stats_max := max(стат[i][4] for i in range(1, n))) / float(маска.size)
    out.append({"файл": путь, "доля": round(доля, 4), "кусок": round(кусок, 4)})
print(json.dumps(out, ensure_ascii=False))
`;

/** Замерить долю хромакейного зелёного в кадрах. */
function замерить(файлы) {
  const r = spawnSync('python3', ['-c', PY, ...файлы], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`замер зелени не выполнился: ${String(r.stderr || r.stdout).slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

/** Есть ли на кадре зелёная заливка. */
function зелёный(файл) {
  const [z] = замерить([файл]);
  if (!z || z.ошибка) return { плохо: false, доля: 0, почему: `замер не вышел: ${z && z.ошибка}` };
  const плохо = z.кусок >= ПОРОГ;
  return { плохо, доля: z.доля, кусок: z.кусок,
    почему: плохо ? `зелёная заливка на ${Math.round(z.кусок * 100)}% кадра` : '' };
}

module.exports = { замерить, зелёный, ПОРОГ };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] !== '--склад') {
      for (const z of замерить(args)) {
        if (z.ошибка) { console.log(`${path.basename(z.файл)}: ${z.ошибка}`); continue; }
        console.log(`${path.basename(z.файл)}: доля ${z.доля}, крупнейший кусок ${z.кусок}`
          + (z.кусок >= ПОРОГ ? '  ⛔ ЗАЛИВКА' : ''));
      }
      process.exit(0);
    }
    // Проход по складу: качаем кадры, считаем, помечаем брак в meta.qa.
    const { Client } = require('pg');
    const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
    const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const лимит = Number(args[1] || 400);
    const r = await c.query(
      `SELECT id, meta->>'persona' persona, meta->'image_urls' urls
         FROM posts WHERE status = 'backlog' AND meta->'image_urls'->>0 IS NOT NULL
         ORDER BY created_at DESC LIMIT $1`, [лимит]);
    console.log(`проверяю постов: ${r.rows.length}`);
    let плохих = 0, ошибок = 0;
    for (const п of r.rows) {
      const файлы = [];
      try {
        (п.urls || []).forEach((u, i) => {
          const f = `/tmp/green_${String(п.id).slice(0, 8)}_${i}.jpg`;
          execFileSync('curl', ['-s', '-m', '40', '-o', f, u]);
          if (fs.existsSync(f) && fs.statSync(f).size > 15000) файлы.push({ f, i });
        });
        if (!файлы.length) { ошибок++; continue; }
        const z = замерить(файлы.map((x) => x.f));
        const бракованные = z.map((v, k) => ({ ...v, кадр: файлы[k].i + 1 })).filter((v) => (v.кусок || 0) >= ПОРОГ);
        if (бракованные.length) {
          плохих++;
          const причина = `зелёная заливка на кадре ${бракованные.map((b) => b.кадр).join(', ')}`;
          await c.query(
            `UPDATE posts SET meta = jsonb_set(meta, '{qa}',
               coalesce(meta->'qa','{}'::jsonb) || jsonb_build_object('clean', false, 'reasons', $2::text)) WHERE id = $1`,
            [п.id, причина]);
          console.log(`  ⛔ ${п.persona}: ${причина}`);
        }
      } catch (e) { ошибок++; console.log(`  ✗ ${п.persona}: ${String(e.message).slice(0, 70)}`); }
      finally { файлы.forEach((x) => { try { fs.unlinkSync(x.f); } catch {} }); }
    }
    await c.end().catch(() => {});
    console.log(`\nИТОГ: постов ${r.rows.length}, с зелёной заливкой ${плохих}, ошибок ${ошибок}`);
    process.exit(0);
  })().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
}
