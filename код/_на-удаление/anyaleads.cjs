// ЗАГЛАВНЫЕ КАДРЫ АНИ ПОД ТРЕНДЫ (image-to-image от канона).
//
// Зачем: владелец 04.08 забраковал автосцены фабрики («эти слабые») и зафиксировал канон Ани
// (АВАТАРЫ /аня/anya_ideal_canon.jpg: каре, ухоженное лицо, офисный лоск). Заглавное фото тренда
// (кадр 1, «до») должно быть той же девушкой с тем же каре, натуральной, но НЕ хуже «после»:
// архетип «природная красота, которую ещё нужно раскрыть». Дорабатываем слабые сцены каноном.
//
// Запуск: node anyaleads.cjs [сколько=4]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KEY = fs.readFileSync('/tmp/.rgkey', 'utf8').trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const SRC = '/Users/qq/Desktop/АВАТАРЫ /аня/anya_ideal_canon.jpg';
const OUT = '/tmp/anya_leads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// v2: жёсткий фейс-лок. Первый заход держал причёску и сцену, но лицо дрейфовало (круглее,
// губы тоньше — «другая девушка»). Перечисляем конкретные черты канона и запрещаем их менять.
const KEEP = 'this is the SAME woman from the reference photo: identical face, do not change any facial features, '
  + 'same striking blue-grey eyes, same defined eyebrows, same full lips, same nose, same face shape, '
  + 'same short blonde bob haircut with middle parting, photorealistic identity preservation';
// Натурально, но дорого: тёплый свет и чистая композиция вместо «сырых» автосцен.
const REAL = 'shot on iphone, natural candid photo, realistic skin texture, soft flattering light, '
  + 'clean composition, no heavy makeup, fresh natural beauty, vertical 3:4';

const SCENES = [
  ['cafe-evening', `${KEEP}, sitting in a warm cozy cafe in the evening, black top, golden bokeh lights behind, holding a glass, gentle smile, ${REAL}`],
  ['autumn-street', `${KEEP}, walking on a beautiful autumn street in golden hour, beige trench coat, falling yellow leaves, warm sunlight on face, ${REAL}`],
  ['window-mug', `${KEEP}, sitting by a large bright window with a ceramic mug, cream knit sweater, soft daylight, calm cozy mood, ${REAL}`],
  ['park-forest', `${KEEP}, standing in a green sunlit park with tall trees, light summer dress, sun rays through leaves, natural fresh look, ${REAL}`],
];

async function gen(prompt, srcB64) {
  const r = await fetch(`${BASE}/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'nano-banana-2', prompt, images: [srcB64], aspect_ratio: '3:4' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`generate HTTP ${r.status}`);
  const g = await r.json();
  if (!g.id) throw new Error('нет id');
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const p = await fetch(`${BASE}/creations/${g.id}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => null);
    if (!p || !p.ok) continue;
    const d = await p.json();
    if (d.status === 'completed' && d.result_urls?.length) return d.result_urls[0];
    if (d.status === 'failed' || d.status === 'error') throw new Error(d.error || 'упала');
  }
  throw new Error('не дождался');
}

(async () => {
  const want = Math.min(Number(process.argv[2]) || SCENES.length, SCENES.length);
  fs.mkdirSync(OUT, { recursive: true });
  const b64 = fs.readFileSync(SRC).toString('base64');
  let ok = 0;
  for (const [name, prompt] of SCENES.slice(0, want)) {
    const dest = path.join(OUT, `${name}.jpg`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 30000) { ok++; console.log(`  · ${name}: уже есть`); continue; }
    try {
      const url = await gen(prompt, b64);
      // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): fetch без сигнала висит вечно, а кадр уже оплачен.
      await require('./watchdog.cjs').fetchToFile(url, dest, { what: 'заглавная', ms: 90000 });
      ok++;
      console.log(`  ✓ ${name} (${Math.round(fs.statSync(dest).size / 1024)} КБ)`);
    } catch (e) { console.log(`  ✗ ${name}: ${String(e.message).slice(0, 70)}`); }
  }
  console.log(`ИТОГ: ${ok} из ${want} заглавных готово в ${OUT}`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
