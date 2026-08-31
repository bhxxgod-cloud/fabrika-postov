// Проверка: держит ли модель лицо с исходника. nano-banana-2 его проигнорировала (вышла другая
// девушка), пробуем nano-banana-pro. Один кадр = 2.5 цента, дешевле, чем гнать десятку вслепую.
const fs = require('node:fs');
const KEY = fs.readFileSync('/tmp/.rgkey', 'utf8').trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const SRC = process.argv[2];
const MODEL = process.argv[3] || 'nano-banana-pro';
const OUT = process.argv[4];
const b64 = `data:image/jpeg;base64,${fs.readFileSync(SRC).toString('base64')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const prompt = 'Use the attached photo as the reference for the person. Keep the SAME woman: identical face, '
    + 'same dark brown long hair, same eyes and features. Only change the setting and outfit: she is sitting in a '
    + 'cozy coffee shop wearing an oversized beige sweater, holding a cup, soft window light. '
    + 'Shot on iphone, natural candid photo, no retouch, realistic skin texture.';
  const gen = await fetch(`${BASE}/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, prompt, aspect_ratio: '3:4', images: [b64] }),
    signal: AbortSignal.timeout(60000),
  });
  const txt = await gen.text();
  console.log(`${MODEL}: HTTP ${gen.status} ${txt.slice(0, 200)}`);
  if (!gen.ok) return;
  const { id } = JSON.parse(txt);
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const p = await fetch(`${BASE}/creations/${id}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => null);
    if (!p || !p.ok) continue;
    const d = await p.json();
    if (d.status === 'completed' && d.result_urls?.length) {
      const img = await fetch(d.result_urls[0]);
      fs.writeFileSync(OUT, Buffer.from(await img.arrayBuffer()));
      console.log(`✓ сохранено: ${OUT}`);
      return;
    }
    if (d.status === 'failed' || d.status === 'error') { console.log('упало:', JSON.stringify(d).slice(0, 200)); return; }
  }
  console.log('не завершилось за 200с');
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
