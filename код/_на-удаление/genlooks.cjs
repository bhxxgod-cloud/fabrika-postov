// ОБРАЗЫ МОДЕЛИ ИЗ ОДНОГО ФОТО (image-to-image, RenderGrid nano-banana-2).
// Зачем именно image-to-image: текстовая генерация даёт каждый раз ДРУГУЮ девушку, и «10 образов
// модели» превращаются в 10 разных людей. Исходное фото уходит в поле `images` (проверено: image_urls
// ждёт настоящий URL и на data: отвечает 400, а `images` принимает base64 и ставит задачу в очередь).
// Стиль намеренно «снято на телефон»: живая съёмка с мелкими несовершенствами читается как человек,
// глянцевый рендер выдаёт нейросеть — ровно то, чего мы избегаем.
// Запуск: node genlooks.cjs <исходник.jpg> <папка-назначения> [сколько=10]
const fs = require('node:fs');
const path = require('node:path');

const KEY = fs.readFileSync('/tmp/.rgkey', 'utf8').trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const SRC = process.argv[2];
const DIR = process.argv[3];
const N = Number(process.argv[4]) || 10;

const REAL = 'shot on iphone, natural candid photo, slightly imperfect, authentic, no studio look, no retouch, realistic skin texture, natural lighting';
const KEEP = 'keep the exact same face, same girl, same facial features and hair color';
const LOOKS = [
  ['кафе', `${KEEP}, sitting in a cozy coffee shop, oversized beige sweater, holding a cup, soft window light, ${REAL}`],
  ['зеркало', `${KEEP}, mirror selfie in a hallway, casual jeans and white top, phone in hand, ${REAL}`],
  ['улица', `${KEEP}, walking on a city street in autumn, trench coat, scarf, candid full body shot, ${REAL}`],
  ['спорт', `${KEEP}, after workout in a gym, sporty top, hair in a ponytail, slightly flushed, ${REAL}`],
  ['вечер', `${KEEP}, evening out, simple black dress, restaurant background with warm bokeh lights, ${REAL}`],
  ['дом', `${KEEP}, at home on a couch, cozy hoodie, messy bun, blanket, lamp light, ${REAL}`],
  ['лето', `${KEEP}, summer day near the river, light sundress, sunglasses on head, sunny, ${REAL}`],
  ['машина', `${KEEP}, sitting in a car passenger seat, seatbelt on, denim jacket, daylight, ${REAL}`],
  ['парк', `${KEEP}, in a park with green trees, casual t-shirt and jeans, sitting on a bench, ${REAL}`],
  ['ночь', `${KEEP}, night city street, leather jacket, neon signs behind, phone flash light, ${REAL}`],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(prompt, b64) {
  const gen = await fetch(`${BASE}/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'nano-banana-2', prompt, aspect_ratio: '3:4', images: [b64] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!gen.ok) throw new Error(`generate HTTP ${gen.status}: ${(await gen.text()).slice(0, 140)}`);
  const { id } = await gen.json();
  if (!id) throw new Error('нет id задачи');
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const p = await fetch(`${BASE}/creations/${id}`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!p || !p.ok) continue;
    const d = await p.json();
    if (d.status === 'completed' && d.result_urls?.length) return d.result_urls[0];
    if (d.status === 'failed' || d.status === 'error') throw new Error(`генерация упала: ${JSON.stringify(d).slice(0, 140)}`);
  }
  throw new Error('генерация не завершилась за 200с');
}

(async () => {
  const b64 = `data:image/jpeg;base64,${fs.readFileSync(SRC).toString('base64')}`;
  fs.mkdirSync(DIR, { recursive: true });
  console.log(`ОБРАЗЫ ИЗ ${path.basename(SRC)} → ${DIR} (${N} шт, ~$${(N * 0.03).toFixed(2)})`);
  let ok = 0;
  for (const [i, [name, prompt]] of LOOKS.slice(0, N).entries()) {
    const dest = path.join(DIR, `${String(i + 1).padStart(2, '0')}_${name}.jpg`);
    if (fs.existsSync(dest)) { console.log(`  = ${path.basename(dest)} (уже есть)`); ok++; continue; }
    try {
      const url = await generate(prompt, b64);
      const img = await fetch(url, { signal: AbortSignal.timeout(90000) });
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length < 10000) throw new Error(`подозрительно мало байт: ${buf.length}`);
      fs.writeFileSync(dest, buf);
      console.log(`  ✓ ${path.basename(dest)} (${(buf.length / 1024).toFixed(0)} КБ)`);
      ok++;
    } catch (e) {
      // Молчать нельзя: «сгенерил 10» при трёх реальных файлах — это враньё отчёта.
      console.log(`  ⛔ ${name}: ${e.message}`);
    }
  }
  console.log(`\nготово: ${ok} из ${Math.min(N, LOOKS.length)}`);
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
