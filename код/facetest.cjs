// Подбор формулировки, при которой модель СОХРАНЯЕТ лицо с исходника, а не рисует похожую девушку.
// Гоняем несколько промптов ОДНОВРЕМЕННО (задачи асинхронные) и складываем результаты рядом,
// чтобы сравнить глазами. Иначе каждый вариант это +10 минут ожидания в очереди.
const fs = require('node:fs');
const path = require('node:path');
const KEY = fs.readFileSync('/tmp/.rgkey', 'utf8').trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const SRC = process.argv[2];
const OUTDIR = process.argv[3] || '/tmp/facetest';
const b64 = `data:image/jpeg;base64,${fs.readFileSync(SRC).toString('base64')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENE = 'sitting in a cozy coffee shop, oversized beige sweater, holding a cup, soft window light';
const VARIANTS = [
  ['edit', `EDIT the attached photo. This is a photo of a real specific person — preserve her identity EXACTLY: `
    + `do not change her face, bone structure, nose, eyes, eyebrows, lips, skin tone or hair. `
    + `Only replace the background and her clothes: ${SCENE}. Keep it a natural iphone snapshot, no retouch.`],
  ['identity', `The attached image is the identity reference. Generate a new photo of THE SAME PERSON — `
    + `100% identical facial identity, same face shape, same nose, same eyes, same long dark brown hair. `
    + `New scene: ${SCENE}. Candid iphone photo, natural skin texture, no beautification, no makeup added.`],
  ['same-person', `Same girl as in the reference photo, exactly the same face — this is a consistent character. `
    + `Scene: ${SCENE}. Photorealistic amateur phone photo.`],
];

async function run(name, prompt) {
  const gen = await fetch(`${BASE}/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'nano-banana-pro', prompt, aspect_ratio: '3:4', images: [b64] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!gen.ok) { console.log(`  ${name}: HTTP ${gen.status} ${(await gen.text()).slice(0, 120)}`); return; }
  const { id } = await gen.json();
  console.log(`  ${name}: задача ${String(id).slice(0, 8)} поставлена`);
  for (let i = 0; i < 90; i++) {
    await sleep(8000 + Math.floor(i % 3) * 1000);      // >5с, иначе API режет по частоте
    const p = await fetch(`${BASE}/creations/${id}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => null);
    if (!p || !p.ok) continue;
    const d = await p.json();
    if (d.status === 'completed' && d.result_urls?.length) {
      const img = await fetch(d.result_urls[0]);
      const dest = path.join(OUTDIR, `${name}.jpg`);
      fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
      console.log(`  ✓ ${name} → ${dest}`);
      return;
    }
    if (d.status === 'failed' || d.status === 'error') { console.log(`  ⛔ ${name}: ${JSON.stringify(d).slice(0, 120)}`); return; }
  }
  console.log(`  ⏳ ${name}: не дождались`);
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`ПОДБОР ПРОМПТА (${VARIANTS.length} варианта, nano-banana-pro)`);
  await Promise.all(VARIANTS.map(([n, p]) => run(n, p)));
  console.log('готово');
})();
