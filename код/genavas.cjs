// НЕЙТРАЛЬНЫЕ АВЫ ДЛЯ МУЛЬТИ-АККОВ (05.08, начальник: «у нас аниме авы ебаные стоят»).
//
// Корень проблемы: dressup брал авы из ~/Desktop/авы, а там лежали скачанные аниме-картинки
// (10 файлов, удалены). На vibe.mood.daily так и стоял аниме-парень с красными глазами при
// имени «Карина». Мульти-аккам нельзя лицо модели (они постят РАЗНЫХ девочек), поэтому пул
// должен быть БЕЗ ЛИЦ: эстетика, предметка, фактуры — то, что ставят обычные девушки.
//
// Запуск: node genavas.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const OUT = path.join(os.homedir(), 'Desktop', 'авы');
const KEY = (process.env.RENDERGRID_KEY || fs.readFileSync('/tmp/.rgkey', 'utf8')).trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMON = ' Реалистичное фото на телефон, естественный свет, лёгкая зернистость, как настоящее фото из галереи девушки. Лицо НЕ ВИДНО и не узнаётся. Без текста и логотипов. Квадратный кадр.';
// ДЕВОЧКА В ТРЕНДЕ, НО БЕЗ ЛИЦА (начальник 05.08: «сделай девчонку в тренде лучше каком то»,
// до этого забракованы аниме, стоковый «телефон с кофе» и раскладка образцов).
// Логика: акк мультиаккаунтный, узнаваемое лицо привязало бы его к одной модели, поэтому берём
// ровно те кадры, что реально ставят девушки: зеркало с телефоном у лица, со спины, силуэт.
const IDEAS = [
  ['mirror', 'Девушка снимает себя в зеркале, телефон полностью закрывает лицо, стильный образ, светлая комната.' + COMMON],
  ['back', 'Девушка со спины, длинные волосы, идёт по вечерней улице в огнях, лица не видно совсем.' + COMMON],
  ['silhouette', 'Двойная экспозиция: тёмный силуэт профиля девушки, внутри просвечивает хвойный лес, белый фон.' + COMMON],
  ['hair', 'Девушка отвернулась к окну, волосы закрывают лицо, мягкий контровой свет, уютный интерьер.' + COMMON],
  ['flowers', 'Девушка держит перед лицом большой букет пионов, лицо полностью скрыто цветами, светлый фон.' + COMMON],
  ['shadow', 'Тень девушки на песчаной стене в закатном свете, самой девушки в кадре нет, только силуэт тени.' + COMMON],
];

async function one(name, prompt) {
  const g = await (await fetch(`${BASE}/images/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'nano-banana-2', prompt, aspect_ratio: '1:1' }),
  })).json();
  if (!g.id) return `${name}: не заказалось (${JSON.stringify(g).slice(0, 80)})`;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const r = await fetch(`${BASE}/creations/${g.id}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => null);
    if (!r || !r.ok) continue;
    const d = await r.json();
    if (d.status === 'completed' && (d.result_urls || []).length) {
      const img = await fetch(d.result_urls[0]);
      const dest = path.join(OUT, `girl_${name}.jpg`);
      fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
      return `${name}: ✓ ${Math.round(fs.statSync(dest).size / 1024)} КБ`;
    }
    if (d.status === 'failed') return `${name}: упало`;
  }
  return `${name}: таймаут`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Все заказы уходят разом — рендерятся на стороне сервиса параллельно.
  const res = await Promise.all(IDEAS.map(([n, p]) => one(n, p).catch((e) => `${n}: ошибка ${e.message}`)));
  res.forEach((r) => console.log('  ' + r));
  console.log(`ИТОГ: нейтральный пул в ${OUT}`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
