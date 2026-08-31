// ГЕНЕРАЦИЯ ДЕВУШЕК ПОД ТРЕНД (text-to-image) + отправка в ТГ.
//
// Зачем отдельно от genlooks: тот делает образы ОДНОЙ модели из её фото (image-to-image, лицо
// сохраняется). Здесь наоборот — нужны РАЗНЫЕ девушки по текстовому описанию, каждая новая.
// Это заготовки под мультиаккаунты: одна лента, разные лица.
//
// Почему промпты именно такие: вирусные посты в этом жанре выглядят как обычное селфи на телефон.
// Студийная вылизанность убивает доверие — зритель должен думать «это девочка, как я», а не
// «это рендер». Поэтому в каждом промпте: живая кожа, зернистость, бытовой фон.
//
// Запуск: node gentrend.cjs [сколько=12] [--no-tg]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const KEY = fs.readFileSync('/tmp/.rgkey', 'utf8').trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const OUT = '/tmp/trend_girls';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Общий хвост: без него модель сваливается в глянец, и кадр перестаёт читаться как настоящий.
const REAL = 'selfie shot on iphone front camera, natural candid photo, realistic skin texture with pores, '
  + 'slight grain, natural lighting, no studio look, no retouch, no beauty filter, vertical 9:16';

// Четыре типажа со скринов вирусных постов, по три сцены на каждый.
// Сцены нарочно разные: если снимать всё в одной комнате, лента схлопывается в одинаковые кадры.
const PROMPTS = [
  // 1. блондинка с прямыми волосами, кепка, дерзкий взгляд
  ['blonde-cap-1', 'young woman 19, very long straight warm blonde hair with grown-out roots, black MLB baseball cap with embroidery, oversized black longsleeve, grey-blue eyes, long lash extensions, dark defined brows, nude matte lips, standing in a concrete stairwell with pipes and fluorescent light, direct camera gaze, slightly indifferent expression'],
  ['blonde-cap-2', 'young woman 19, long straight warm blonde hair, black cap worn backwards, short black top, grey-blue eyes, long lashes, dark brows, lip gloss, selfie in an elevator with mirrored wall, metal panels, warm ceiling light, phone visible in reflection'],
  ['blonde-cap-3', 'young woman 19, long straight light blonde hair, centre parting, black tank top, grey-blue eyes with eyeliner, long lashes, nude lips, by a dark window at night with city lights behind, face lit by phone screen'],
  // 2. тёмные волосы, восточные черты, мягкий взгляд
  ['dark-mall-1', 'young woman 20, very dark almost black wavy hair, white ribbed short-sleeve top, dark brown eyes, thick lashes, wide dark brows, full lips in warm nude, resting chin on hand, shopping mall background with escalator and blurred people, bright mall lighting'],
  ['dark-mall-2', 'young woman 20, dark almost black hair loosely tied up, beige hoodie, dark brown almond eyes, thick brows, caramel nude lips, sitting in a car, seatbelt visible, sunlight through side window with lens flare'],
  ['dark-mall-3', 'young woman 20, long dark hair with big waves, black strappy top, dark brown eyes with bronze eyeshadow, thick brows, glossy lips, in a cafe with wooden table, coffee cup and plants, warm evening light, looking slightly away from camera'],
  // 3. русая, естественная, домашняя
  ['nat-home-1', 'young woman 18, long dark blonde hair with sun-bleached strands, black sleeveless top, green-grey eyes, mascara only, medium natural brows, pink nude lips, at home with kitchen visible behind, daylight from window, calm direct gaze'],
  ['nat-home-2', 'young woman 18, long dark blonde hair loose and slightly messy, grey t-shirt, green-grey eyes no makeup, natural brows, bare lips, in a bedroom in the morning, unmade bed and white curtains, soft morning light'],
  ['nat-home-3', 'young woman 18, long dark blonde hair, black tank top and jeans, green-grey eyes with light liner, natural brows, nude lips, mirror selfie in a hallway with coat rack, warm lamp light, phone in hand'],
  // 4. блондинка с волной, глянцевые губы, кукольный взгляд
  ['glam-wave-1', 'young woman 19, long honey blonde hair with soft waves, black t-shirt, blue-grey eyes close up, long lashes, light straight brows, clear lip gloss, in a decorated room with heart wreaths on the wall, warm evening light, slight pout'],
  ['glam-wave-2', 'young woman 19, long honey blonde hair with big waves, black top, blue-grey eyes, long lashes, glossy lips, on a balcony in the evening, railing and city lights behind, blue dusk, face lit by phone screen'],
  ['glam-wave-3', 'young woman 19, long honey blonde hair slightly damp at roots, white tank top, blue-grey eyes, long lashes, light brows, glossy lips, classic bathroom mirror selfie, white tiles, towel, light above the mirror'],
];

async function generate(prompt) {
  const gen = await fetch(`${BASE}/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'nano-banana-2', prompt: `${prompt}, ${REAL}`, aspect_ratio: '3:4' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!gen.ok) throw new Error(`generate HTTP ${gen.status}`);
  const g = await gen.json();
  if (!g.id) throw new Error('нет id задачи');
  // Ждём до ~4 минут: очередь бывает длинной, но вечно висеть тоже нельзя.
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const p = await fetch(`${BASE}/creations/${g.id}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => null);
    if (!p || !p.ok) continue;
    const d = await p.json();
    if (d.status === 'completed' && d.result_urls?.length) return d.result_urls[0];
    if (d.status === 'failed' || d.status === 'error') throw new Error(d.error || 'генерация упала');
  }
  throw new Error('не дождался за 4 минуты');
}

(async () => {
  const want = Math.min(Number(process.argv[2]) || PROMPTS.length, PROMPTS.length);
  const noTg = process.argv.includes('--no-tg');
  fs.mkdirSync(OUT, { recursive: true });
  const done = [];

  for (const [name, prompt] of PROMPTS.slice(0, want)) {
    const dest = path.join(OUT, `${name}.jpg`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 30000) { done.push([name, dest]); console.log(`  · ${name}: уже есть`); continue; }
    try {
      const url = await generate(prompt);
      // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): fetch без сигнала висит вечно, а кадр уже оплачен.
      await require('./watchdog.cjs').fetchToFile(url, dest, { what: 'кадр', ms: 90000 });
      done.push([name, dest]);
      console.log(`  ✓ ${name} (${Math.round(fs.statSync(dest).size / 1024)} КБ)`);
    } catch (e) { console.log(`  ✗ ${name}: ${String(e.message).slice(0, 70)}`); }
  }

  console.log(`\nсгенерено: ${done.length} из ${want}`);
  if (noTg || !done.length) return;

  // В ТГ шлём по типажу: три сцены одной девушки одним альбомом, так удобнее выбирать.
  const groups = {};
  for (const [name, file] of done) {
    const key = name.replace(/-\d+$/, '');
    (groups[key] = groups[key] || []).push(file);
  }
  const TITLES = {
    'blonde-cap': 'блондинка с кепкой · дерзкий взгляд',
    'dark-mall': 'тёмные волосы · восточные черты',
    'nat-home': 'русая · естественная домашняя',
    'glam-wave': 'блонд с волной · глянцевые губы',
  };
  for (const [key, files] of Object.entries(groups)) {
    try {
      // --key НЕ передаём осознанно: поста в базе тут нет, это подборка типажей на выбор.
      // От повтора защищает дедуп tgsend по самим кадрам, придумывать искусственный ключ
      // нельзя — именно самодельные ключи и разводили дубли в группе (06.08).
      execFileSync('node', ['tgsend.cjs', ...files, '--carousel', '--persona', 'ТИПАЖИ',
        '--type', TITLES[key] || key,
        // Теги про ИИ убраны (ревизия 14.08): стояли на 67% опубликованных и опознавали
        // пост как AI-контент. Правило из slidekit.cjs:332 от 09.08 сюда не дошло.
        '--note', `тренд с глазами · ${TITLES[key] || key}\n\nя тоже сделала тренд с глазами, и парень даже на обои поставил ❤️\n#тренд #глоуап #glowup #взгляд #бьюти`],
        { cwd: __dirname, encoding: 'utf8' });
      console.log(`  → в ТГ: ${TITLES[key] || key} (${files.length} шт)`);
    } catch (e) { console.log(`  ✗ ТГ ${key}: ${String(e.message).slice(0, 60)}`); }
    await sleep(2500);
  }
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
