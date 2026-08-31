// ТРЕНД «АКВАРЕЛЬНЫЙ ДУДЛ» (05.08, из чата аватаров, Threads-тренд).
//
// Идёт по ОБЩЕЙ утверждённой логике карусели:
//   1 — оригинал (лайфстайл-кадр) + байтовая надпись-хук (накладываем сами)
//   2 — сам промпт (плашка)
//   3 — результат: дудл
//   4 — ещё один дудл-кадр + подпись «бесплатно сделала на neironka.pro …»
// Вирусность тренда именно в паре «дудл + оригинал», поэтому оригинал стоит первым.
//
// Надписи НЕ генерим, а накладываем рендером: генерация текста даёт опечатки и глюки.
// Запуск: node doodletrend.cjs <Имя> --slide1 <оригинал> --doodle <дудл> [--doodle2 <второй дудл>]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const PERSONA = process.argv[2];

const DOODLE_PROMPT = 'Перерисуй моё фото в стиле минималистичного hand-drawn дудла с акварелью. ГЛАВНОЕ ПРАВИЛО: сохрани сюжет и композицию кадра полностью: та же поза и одежда человека, те же ключевые объекты и фон — зритель должен сразу узнать свой кадр. ПЕРСОНАЖ: милый наивный дудл-человечек с простыми детскими формами, точки-глаза, крошечная улыбка, лёгкий румянец, причёска и одежда узнаваемо с фото; вокруг всего персонажа тонкая белая обводка-ореол как у наклейки. ЛИНИЯ: простые контуры кистевой ручкой brush-pen, слегка дрожащие несовершенные штрихи, минимум деталей. ЦВЕТ: лёгкие полупрозрачные акварельные заливки поверх туши, широкие небрежные мазки (охра, тёплый серый, приглушённые тона), местами краска выходит за контур, бумажно-белая база, много воздуха. НАСТРОЕНИЕ: наивный скетчбук, играюче и трогательно, очаровательные несовершенства ручной работы. ЗАПРЕЩЕНО: фотореализм, 3D, аниме, жёсткие векторные линии, плотная заливка всего кадра, текст и водяные знаки.';

// Хуки: первое лицо, разговорно, без рекламы — как обычная девочка рассказывает про находку.
const HOOKS = [
  'закинула своё фото в нейросеть\nи получила вот такой дудл 🥹',
  'нашла тренд, где твоё фото\nстановится акварельным рисунком',
  'перерисовала своё фото\nв милый дудл за пару минут',
  'этот тренд из threads\nя теперь не могу остановиться 🎨',
];
function pickHook(seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HOOKS[h % HOOKS.length];
}

const { to45, hookSlide, ctaSlide } = require('./slidekit.cjs');

async function takeLock(waitMs = 20 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      // Лок держит СМОТРИТЕЛЬ окна (правило начальника 06.08: хром с нейронкой всегда открыт,
      // когда конвейер свободен) — просим его уступить и ждём.
      try { if (String(pid) === fs.readFileSync('/tmp/genkeeper.pid','utf8').trim()) fs.writeFileSync('/tmp/genkeeper.stop',''); } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      // TTL: генерация не живёт дольше 45 минут, всё старше = зависший лок (06.08 конвейер
      // дважды вставал из-за вечного лока после жёсткого убийства процесса).
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('админ-профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);

(async () => {
  const slide1src = arg('--slide1'), doodle = arg('--doodle'), doodle2 = arg('--doodle2') || doodle;
  if (!PERSONA || !slide1src || !doodle) {
    console.log('usage: node doodletrend.cjs <Имя> --slide1 <оригинал> --doodle <дудл> [--doodle2 <ещё дудл>]');
    process.exit(1);
  }
  for (const f of [slide1src, doodle, doodle2]) if (!fs.existsSync(f)) { console.log(`ИТОГ: ✗ нет файла ${f}`); process.exit(1); }
  const tag = PERSONA.toLowerCase();

  console.log(`${PERSONA}: собираю слайды (все кадры приводятся к 4:5)`);
  const s1 = await hookSlide(slide1src, `/tmp/doodle_${tag}_1.jpg`, pickHook(PERSONA));
  const s2 = `/tmp/doodle_${tag}_2.jpg`;
  execFileSync('node', [path.join(__dirname, 'frame4.cjs'), '--text', DOODLE_PROMPT, s2], { encoding: 'utf8', timeout: 150000 });
  // Результат от генератора приходит 1:1 — режем в 4:5, иначе карусель в ленте пляшет.
  const s3 = to45(doodle, `/tmp/doodle_${tag}_3.jpg`);
  const s4 = await ctaSlide(doodle2, `/tmp/doodle_${tag}_4.jpg`);
  const files = [s1, s2, s3, s4];
  console.log(`${PERSONA}: 1 хук · 2 промпт · 3 дудл · 4 дудл+подпись`);

  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1200, height: 860 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const urls = [];
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (const f of files) {
      const b64 = fs.readFileSync(f).toString('base64');
      const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
      urls.push(await page.evaluate(async ({ b64, name, mime }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: mime }));
        const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await x.json().catch(() => ({}));
        if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
        return j.url;
      }, { b64, name: path.basename(f), mime }));
      await sleep(1200);
    }
  } finally { await ctx.close().catch(() => {}); freeLock(); }

  // Теги про ИИ убраны (ревизия 14.08): #ии и #нейросеть стояли на 67% опубликованных
  // и работали как самоопознание AI-контента. Правило из slidekit.cjs:332 от 09.08.
  const caption = 'нашла тренд, где обычное фото превращается в акварельный дудл 🎨 своё перерисовала за пару минут\n#тренд #иллюстрация #акварель #арт';
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
    AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
  const ins = await c.query(
    `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
     VALUES ($1,'instagram','promo','backlog',$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
    [acc.id, caption, urls[0], 'https://neironka.pro',
     JSON.stringify({ template: 'doodle-trend', persona: PERSONA, image_urls: urls, frame4: true, refit4: true, manual_ok: true })]);
  const id = ins.rows[0].id;
  await c.end();
  console.log(`ИТОГ: ✅ ${PERSONA} — дудл-пост ${String(id).slice(0, 8)} на складе`);
  try {
    execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
      '--key', String(id), '--persona', PERSONA, '--type', 'акварельный дудл', '--note', caption],
      { cwd: __dirname, encoding: 'utf8', stdio: 'inherit' });
  } catch (e) { console.log('  ⚠ в ТГ не ушло: ' + String(e.message).slice(0, 70)); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
