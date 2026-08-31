// ЗАМЕНА 4-го КАДРА фабричного поста Карины img-heart-hair 1616d1e8 (06.08, главный чат).
// Агент нашёл: на локскрине кадра 4 ЧУЖОЕ лицо с веснушками (фабрика подставила другой рендер),
// кадры 1-3 чёткие. Валидатор это пропустил (ещё один довод переписать его).
// Фикс: один свой арт по эталонному промпту (глаза прикрыты, 4 сердца, кожа чистая) + плашка
// призыва, замена image_urls[3]. Одна генерация вместо перезаказа фабрики.
// Запуск: node fix_karina4.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');
const { siteGenerate } = require('./sitegen.cjs');
const { to45, ctaSlide } = require('./slidekit.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const POST_ID = '1616d1e8-fd40-4fe1-be09-e67eadc7a5d4';
const REF = path.join(__dirname, 'refs', 'Карина.jpg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = 'Драматичный чёрно-белый арт-портрет в стиле тренда «волосы сердечками». ' +
  'ЛИЦО: черты, брови и форму губ сохрани ТОЧНО как на референсе, тот же человек, мгновенно узнаваемый. Глаза мягко прикрыты, спокойное умиротворённое лицо, лёгкая полуулыбка. КОЖА идеально чистая и ухоженная, ровный тон, дорогая художественная ретушь, без пятен и высыпаний, ВЕСНУШКИ НЕ РИСОВАТЬ. ' +
  'КОМПОЗИЦИЯ: девушка лежит на смятой светлой простыне, снято строго сверху, камера прямо над ней. Лицо в ПРАВОЙ ТРЕТИ кадра, КРУПНОЕ, занимает примерно треть ширины кадра, видно на три четверти, голова повёрнута набок, скула у подушки. ' +
  'ВОЛОСЫ: длинные густые волосы уходят от лица ВЛЕВО И ВВЕРХ и красиво разложены по простыне одной глянцевой массой. Из этой массы, уже лёжа ПЛАШМЯ НА ПРОСТЫНЕ, выложены ЧЕТЫРЕ КРУПНЫХ СЕРДЦА из свободных гладких прядей. Каждое сердце размером примерно с лицо девушки, с чётким ровным замкнутым контуром. Сердца лежат в левой половине кадра, рядом с волосяной массой, соединены с ней прядями. Сердца НЕ являются причёской: это свободные пряди на ткани, не косички, не плетение, ничего не выложено на самой голове. ' +
  'СВЕТ: полностью чёрно-белое изображение, мягкий рассеянный свет как из окна, глубокие бархатные тени, лёгкое плёночное зерно. ' +
  'ОДЕЖДА: девушка ОДЕТА, плечи и грудь закрыты, никакой обнажённости. ' +
  'ЗАПРЕЩЕНО: открытые глаза, веснушки, косички, плетение, сердца в причёске на голове, сердца над головой, поднятые руками волосы, девушка сидит или стоит; мелкие сердечки; сердца, разбросанные по всей кровати; мелкое лицо в углу; любой цвет, текст, водяные знаки, коллаж, рамки, несколько кадров в одной картинке, пластиковая кожа, изменение черт лица, аниме, 3D.';

async function takeLock(waitMs = 60 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
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
  if (!fs.existsSync(REF)) throw new Error(`нет референса ${REF}`);
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let url;
  try {
    console.log('Карина: свой арт для кадра 4 (глаза прикрыты, 4 сердца, чистая кожа)');
    const art = (await siteGenerate(page, { prompt: PROMPT, refFile: REF, out: '/tmp/fk4_art.png' })).out;
    const s4 = (await ctaSlide(to45(art, '/tmp/fk4_raw.jpg'), '/tmp/fk4_4.jpg')).out || '/tmp/fk4_4.jpg';
    const b64 = fs.readFileSync(s4).toString('base64');
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    url = await page.evaluate(async ({ b64 }) => {
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const fd = new FormData();
      fd.append('file', new File([bin], 'karina_hearts_4.jpg', { type: 'image/jpeg' }));
      const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
      const j = await x.json().catch(() => ({}));
      if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
      return j.url;
    }, { b64 });
  } finally { await page.close().catch(() => {}); await ctx.close().catch(() => {}); freeLock(); }

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`SELECT meta->'image_urls' urls FROM posts WHERE id=$1`, [POST_ID]);
  const urls = [...(r.rows[0].urls || [])];
  if (urls.length < 4) throw new Error('в посте нет 4 слайдов');
  urls[3] = url;
  await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('image_urls', $2::jsonb,
      'slide4_redo', 'own-art-vs-foreign-face 06.08') WHERE id=$1`, [POST_ID, JSON.stringify(urls)]);
  await c.end();
  console.log('ИТОГ: кадр 4 Карины заменён, файл /tmp/fk4_4.jpg');
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
