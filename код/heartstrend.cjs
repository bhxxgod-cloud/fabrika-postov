// ТРЕНД «ВОЛОСЫ СЕРДЕЧКАМИ» (05.08, от чата аватаров, согласовано начальником).
//
// Карусель из 4 слайдов В ЭТОМ ПОРЯДКЕ:
//   1) обычный лайфстайл-кадр девочки из АВАТАРЫ/;
//   2) ч/б арт «волосы сердечками» (генерится по её базовому портрету);
//   3) локскрин: телефон на пледе, на экране блокировки этот арт (генерится по слайду 2);
//   4) тот же арт с подписью строчными «нейронка про» внизу — НАКЛАДЫВАЕМ ТЕКСТОМ, не генерим:
//      генерация текста даёт глюки и опечатки, а тут он должен быть чистым.
//
// Важно: здесь НЕ используется наш обычный 4-й кадр с промптом — у этого тренда свой порядок.
//
// Запуск: node heartstrend.cjs <Имя> [--ready art,lock,brand]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const RGKEY = (process.env.RENDERGRID_KEY || fs.readFileSync('/tmp/.rgkey', 'utf8')).trim();
const RG = 'https://api.rendergrid.io/api/public/v1';
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const AVA_ROOT = '/Users/qq/Desktop/АВАТАРЫ ';
const FOLDER = { 'Дарья': 'Даша', 'Анечка': 'аня', 'Аня': 'аня', 'Марина': 'Мариша' };
const PERSONA = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P_ART = 'Сделай из моего фото драматичный чёрно-белый арт-портрет в стиле тренда «волосы сердечками». ЛИЦО: черты, брови и форму губ сохрани ТОЧНО как на референсе: тот же человек, мгновенно узнаваемый, черты не искажай. Веснушки рисуй ТОЛЬКО если они есть на референсе, сами по себе не добавляй. КОЖА идеально чистая и ухоженная, ровный тон, дорогая ретушь, без пятен,высыпаний и грязной текстуры. КОМПОЗИЦИЯ: девушка лежит на смятой светлой ткани постели, снято строго сверху; лицо в правой трети кадра, видно на три четверти, томный спокойный взгляд в камеру; длинные волосы красиво разложены по ткани влево и вверх от лица и закручены в ТРИ или ЧЕТЫРЕ явных СЕРДЦА из глянцевых прядей: каждое сердце из волос читается чётко и сразу, контуры сердец плавные и завершённые. СВЕТ И ЦВЕТ: полностью чёрно-белое изображение, мягкий рассеянный свет как из окна, глубокие бархатные тени, лёгкое плёночное зерно, кожа чистая и ухоженная с лёгкой живой текстурой, дорогая художественная ретушь, без несовершенств, настроение мечтательной меланхолии. Макияж: распахнутые ресницы, тёмные губы (в ч/б читаются глубоким серым). ОДЕЖДА: девушка ОДЕТА, плечи и грудь закрыты одеждой или тканью, никакой обнажённости, тонкая цепочка с кулоном на шее. ЗАПРЕЩЕНО: любой цвет, текст и водяные знаки, пластиковая кожа, изменение черт лица, аниме и 3D. Вертикальный кадр.';
const P_LOCK = 'Реалистичное фото для соцсетей: смартфон лежит на тёмном стёганом пледе, экран включён и показывает ЭКРАН БЛОКИРОВКИ. Обои экрана: ЭТО изображение с референса, перенеси его на экран точно и целиком, не искажая и не перерисовывая (чёрно-белый портрет девушки с волосами, уложенными сердечками). Поверх обоев в верхней части экрана крупные тонкие белые цифры часов 18:51, над ними мелкая строка даты на английском Tuesday, August 5; внизу экрана две маленькие круглые полупрозрачные иконки фонарика и камеры и тонкая белая полоска-индикатор. Лёгкий естественный блик на стекле, тонкая тёмная рамка телефона, телефон лежит под небольшим углом, приглушённый уютный вечерний свет, снято на телефон, лёгкий шум камеры. Кроме часов и строки даты никакого текста, без водяных знаков. Вертикальный кадр.';

// Генерация — через sitegen.cjs: он опознаёт СВОЮ генерацию по id и промпту в /api/generations,
// поэтому параллельные генерации начальника больше не могут подменить результат.
const { siteGenerate } = require('./sitegen.cjs');
async function siteGen(page, prompt, refFile, out) {
  const r = await siteGenerate(page, { prompt, refFile, out });
  return r.out;
}

// Фирменный слайд: арт + строчными «нейронка про» внизу по центру. Только наложение.
async function brandSlide(artFile, out) {
  const b64 = fs.readFileSync(artFile).toString('base64');
  const mime = /\.png$/i.test(artFile) ? 'image/png' : 'image/jpeg';
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0}body{width:1080px;height:1350px;position:relative;overflow:hidden;background:#000}
    img{width:1080px;height:1350px;object-fit:cover;display:block}
    .t{position:absolute;left:0;right:0;bottom:52px;text-align:center;
      font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-size:40px;font-weight:600;
      color:#fff;letter-spacing:.5px;text-shadow:0 2px 18px rgba(0,0,0,.55)}
  </style><img src="data:${mime};base64,${b64}"><div class="t">нейронка про</div>`;
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const b = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const page = await b.newPage({ viewport: { width: 1080, height: 1350 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const png = out.replace(/\.jpe?g$/i, '.png');
    await page.screenshot({ path: png });
    if (png !== out) { execFileSync(require('ffmpeg-static'), ['-y', '-i', png, '-q:v', '2', out], { stdio: 'ignore' }); fs.unlinkSync(png); }
  } finally { await b.close().catch(() => {}); }
  return out;
}

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
  if (!PERSONA) { console.log('usage: node heartstrend.cjs <Имя> [--ready art,lock,brand]'); process.exit(1); }
  const dir = path.join(AVA_ROOT, FOLDER[PERSONA] || PERSONA);
  if (!fs.existsSync(dir)) { console.log(`ИТОГ: ✗ нет папки ${dir}`); process.exit(1); }
  // ЖЁСТКОЕ ПРАВИЛО НАЧАЛЬНИКА (05.08): слайд 1 — ТОЛЬКО живой лайфстайл-кадр, НИКОГДА выход
  // другого шаблона. Раньше брался просто последний файл по алфавиту, и первым слайдом уезжали
  // постер «ОЦЕНКА ПРИВЛЕКАТЕЛЬНОСТИ» у Ани и кадр «под дождём» у Даны.
  // Фильтр из двух частей: чёрный список выходов шаблонов + белый список лайфстайл-сцен.
  const TEMPLATE_OUT = /report_|_rain_reels_|_hearts_|_doodle_|_glam_|_art|lockscreen|_brand|slide4|canon|neironka\.pro-gen/i;
  const LIFESTYLE = /street|cafe|mirror|selfie|dress|walk|home|lifestyle|park|photo_|model_/i;
  const all = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f) && !TEMPLATE_OUT.test(f));
  const photos = all.filter((f) => LIFESTYLE.test(f)).sort();
  const portraits = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f) && !/_hearts_|_art|lockscreen|_brand|slide4/i.test(f)).sort();
  if (!portraits.length) { console.log('ИТОГ: ✗ нет фото девочки'); process.exit(1); }
  if (!photos.length) {
    console.log(`ИТОГ: ✗ у ${PERSONA} НЕТ лайфстайл-кадра для слайда 1 (в папке только портреты и выходы шаблонов).`);
    console.log('     Нужен живой кадр цикла 1 — запроси его в чате аватаров, постить нельзя.');
    process.exit(2);
  }

  const tag = PERSONA.toLowerCase();
  // Слайд 1 — из белого списка лайфстайла; --slide1 позволяет задать кадр явно.
  const si = process.argv.indexOf('--slide1');
  let slide1 = si >= 0 ? process.argv[si + 1] : path.join(dir, photos[photos.length - 1]);
  let art, lock, brand;
  const ri = process.argv.indexOf('--ready');
  const files = [];

  // ОДНА браузерная сессия на всё: генерация обоих слайдов движком сайта и заливка.
  // Открывать окно по разу на шаг — это и лишние минуты, и драка за админ-профиль.
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const urls = [];
  try {
    if (ri >= 0) {
      [art, lock, brand] = String(process.argv[ri + 1] || '').split(',');
      console.log(`${PERSONA}: беру готовый пак`);
    } else {
      // Референс арта — базовый портрет (первый по алфавиту в очищенном пуле).
      const base = path.join(dir, portraits[0]);
      console.log(`${PERSONA}: генерю арт по ${path.basename(base)} (движок сайта)`);
      art = await siteGen(page, P_ART, base, `/tmp/hearts_${tag}_art.png`);
      console.log(`${PERSONA}: генерю локскрин по арту`);
      lock = await siteGen(page, P_LOCK, art, `/tmp/hearts_${tag}_lock.png`);
    }
    if (!brand) { brand = await brandSlide(art, `/tmp/hearts_${tag}_brand.jpg`); console.log(`${PERSONA}: фирменный слайд собран наложением`); }
    files.push(slide1, art, lock, brand);
    for (const f of files) if (!fs.existsSync(f)) throw new Error(`нет файла ${f}`);

    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (const f of files) {
      const b64 = fs.readFileSync(f).toString('base64');
      const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
      const u = await page.evaluate(async ({ b64, name, mime }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: mime }));
        const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await x.json().catch(() => ({}));
        if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
        return j.url;
      }, { b64, name: path.basename(f), mime });
      urls.push(u);
      await sleep(1200);
    }
  } finally { await ctx.close().catch(() => {}); freeLock(); }

  // ТЕГОВ ПРО ИИ ЗДЕСЬ БОЛЬШЕ НЕТ (ревизия 14.08). Замер по базе: #ии и #нейросеть стояли
  // на 60 из 90 опубликованных постов (67%). Это самоопознание как AI-контент — прямой
  // вычет из охвата, и Instagram по правилам оригинальности тянет такой пост вниз.
  // Гейт кадров эти теги ловит (framegate.cjs:432), но публикация вердикт гейта не читала,
  // поэтому они спокойно уезжали в ленту. Правило «тегов про ИИ нет ни в одном пуле»
  // записано в slidekit.cjs:332 ещё 09.08 — сюда оно просто не дошло.
  const caption = 'сделала тренд с волосами, парень сразу на обои поставил 🖤\n#тренд #волосы #прическа #бьюти';
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
    AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
  const ins = await c.query(
    `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
     VALUES ($1,'instagram','promo','backlog',$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
    [acc.id, caption, urls[0], 'https://neironka.pro',
     JSON.stringify({ template: 'hearts-trend', persona: PERSONA, image_urls: urls, frame4: true, manual_ok: true })]);
  const id = ins.rows[0].id;
  await c.end();
  console.log(`ИТОГ: ✅ ${PERSONA} — пост ${String(id).slice(0, 8)} на складе, ${urls.length} слайда`);

  try {
    execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
      '--key', String(id), '--persona', PERSONA, '--type', 'волосы сердечками', '--note', caption],
      { cwd: __dirname, encoding: 'utf8', stdio: 'inherit' });
  } catch (e) { console.log('  ⚠ в ТГ не ушло: ' + String(e.message).slice(0, 70)); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
