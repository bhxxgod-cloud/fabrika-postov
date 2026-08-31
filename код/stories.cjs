// stories.cjs — ИСТОРИЯ СО ССЫЛКОЙ НА СЕРВИС + ЗАКРЕП В ХАЙЛАЙТС (задача 31, приказ 11.08).
//
// ЗАЧЕМ. Ссылка в БИО режет аккаунт (проверено, см. память проекта), поэтому путь на neironka.pro
// даём через ИСТОРИИ, а историю живёт 24 часа — значит её надо ЗАКРЕПИТЬ в хайлайтс, тогда путь
// становится постоянным и виден с профиля.
//
// ПОЧЕМУ СВОИМ СКРИПТОМ, А НЕ МАГОСОМ. В рецепте магоса публикация истории есть, а добавления в
// хайлайтс и доступа к архиву историй НЕТ вообще. Закреп умеем только мы, поэтому весь путь
// (история → закреп) держим в одном месте: иначе история от магоса истечёт раньше, чем кто-то
// доберётся до архива.
//
// КОНТУР. Обычный наш: GoLogin startLocal (локальная Orbita на маке) + playwright по CDP, куки из
// базы, весь интерфейс через iglib (строй всплывашек, клик только по элементу, Escape в IG не
// работает). Один акк за прогон. Профиль закрываем ВСЕГДА через gl.stopLocal, никогда pkill:
// pkill снёс бы и личные окна начальника, а stopLocal ещё и синхронизирует профиль, без него акк
// вылогинивается.
//
// ═══ ЧТО ИЗМЕРЕНО НА ЖИВОМ АККЕ 11.08 (bryan436344) — читать до правок ═══════════════════════
//   1. ИНТЕРФЕЙСА создания истории в вебе НЕТ: «+» открывает сразу «Create new post», пункта
//      «Story» в меню нет, /create/story/ уводит на ленту. Зато СВОИ РУЧКИ веб-приложения живы:
//      rupload_igphoto + /api/v1/web/create/configure_to_story/ историю публикуют. Ими и работаем.
//   2. НАКЛЕЙКА ССЫЛКИ ЕСТЬ, И ОНА РАБОТАЕТ (начальник был прав, первый вывод «нет» был неполным).
//      Дело не в праве аккаунта и не в пороге подписчиков: наклейка встала на акке с 0
//      подписчиков и типом «личный» (account_type 1, is_business false). Дело было В ФОРМЕ
//      НАГРУЗКИ, и ошибок там оказалось две:
//        · МОЛЧА ВЫБРАСЫВАЛОСЬ, пока слали `story_link: {url}` вложенным объектом и до кучи
//          story_cta с link_urls. Принимается ДРУГОЕ: link_type и url ПЛОСКО на самом стикере,
//          полная геометрия (x, y, z, width, height, rotation) и `story_sticker_ids`;
//        · СТИКЕР БЫЛ НЕВИДИМ (is_hidden:1, is_pinned:1 в ответе), пока флаги слались СТРОКАМИ
//          '0': строка читается как «истина». Флаги обязаны быть ЧИСЛАМИ 0.
//      Рабочая форма целиком лежит ниже в conf() — она же сверена с чужой живой историей
//      (@goar_avetisyan): у неё ровно такие поля и is_hidden:0, is_pinned:0.
//      Адрес словами на кадре оставляем всё равно: он работает и там, где наклейку не тапнут.
//      ПОРОГА НА НАКЛЕЙКУ НЕТ (сверено с открытыми источниками 11.08): старый «свайп вверх» был
//      закрыт порогом 10 тысяч подписчиков и верификацией, но в октябре 2021 инстаграм заменил его
//      наклейкой ссылки и раскатал на ВСЕ аккаунты — личные, авторские и бизнес, без порога. Наш
//      опыт это подтверждает: встало на акке с 0 подписчиков и account_type=1. Единственная
//      известная оговорка — у совсем свежих аккаунтов наклейка иногда появляется не сразу
//      (антиспам), так что на новом акке отказ надо перепроверить через несколько дней, а не
//      считать приговором.
//   3. ЗАКРЕП ЧЕРЕЗ ИНТЕРФЕЙС НЕВОЗМОЖЕН: диалог «New Highlight» после Next показывает пустую
//      панель «Stories», потому что архив пуст (истории приходят с story_is_saved_to_archive:false,
//      /api/v1/archive/reel/day_shells/ отдаёт пустое тело), а включить автоархив из веба нечем.
//      Работает /api/v1/highlights/create_reel/ — берёт АКТИВНУЮ историю по pk, минуя архив.
//   4. ПРОСМОТРЩИК ИСТОРИЙ в вебе на наших акках не открывается вообще (ни /stories/<ник>/<pk>/,
//      ни /stories/highlights/<id>/, ни клик по аватару и по кружку) — доказательства собираем
//      из ответов Instagram и со скрина профиля, а не изнутри просмотрщика.
//
// ЗАПУСК
//   node stories.cjs --slug bryan436344                     собрать картинку, опубликовать, закрепить
//   node stories.cjs --slug X --img /tmp/s.jpg               своя картинка 1080x1920
//   node stories.cjs --slug X --label ПРОМПТЫ                название хайлайтса (по умолчанию оно же)
//   node stories.cjs --slug X --build-only                   только собрать картинку, в IG не ходить
//   node stories.cjs --slug X --probe                        ТОЛЬКО ОСМОТР: что вообще даёт интерфейс
//   node stories.cjs --slug X --no-highlight                 опубликовать историю, не закреплять
//   node stories.cjs --slug X --link-mode sticker|text|auto  наклейка ссылки / только текстом / как получится
//   node stories.cjs --slug X --force                       обойти гейт «одна история на акк за 20ч»
//   node stories.cjs --slug X --link https://…              свой адрес вместо персональной ссылки
//   node stories.cjs --slug X --trim [--keep <pk>]          ОСТАВИТЬ В КРУЖКЕ ОДНУ историю (открепить
//                                                           лишние), ничего не публикуя
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const FF = require('ffmpeg-static');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp/stories';
const W = 1080, H = 1920;
const SITE = 'neironka.pro';
const sleep = L.sleep;

// ── аргументы ───────────────────────────────────────────────────────────────
function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);
const SLUG = arg('slug') || process.argv.slice(2).find((x) => !x.startsWith('--'));
const LABEL = arg('label', 'ПРОМПТЫ');
const IMG_IN = arg('img');
const LINK_MODE = arg('link-mode', 'auto');       // sticker | text | auto
const PROBE = has('probe');
// Приказ начальника 11.08: ОДНА история на аккаунт за прогон. Три истории подряд на bryan436344 —
// это следы разбора, и так работать нельзя: частота действий и есть то, что жжёт акки, а полоска
// из пяти одинаковых историй ещё и выглядит спамом. Гейт ниже (свежая история за 20 часов = отказ)
// снимается ТОЛЬКО руками флагом --force, и только когда что-то разбираем.
const FORCE = has('force');
// Режим уборки кружка: оставить в хайлайтсе ОДНУ, самую свежую историю. Стандарт начальника
// 11.08: «1 история в закрепе». Ничего не публикует.
const TRIM = has('trim');
// Адрес для наклейки. По умолчанию НЕ общий домен, а ПЕРСОНАЛЬНАЯ трекинг-ссылка аккаунта из нашей
// админки (golink.cjs): общая ссылка не даёт понять, какой акк приводит людей, а /go/<код> ставит
// utm_campaign=<код> и разводит акки по строкам в «Источниках». --link перебивает вручную.
const LINK_IN = arg('link');
const FRESH_HOURS = Number(process.env.STORY_FRESH_HOURS || 20);
const BUILD_ONLY = has('build-only');
const NO_HIGH = has('no-highlight');

// ═══ КАРТИНКА ИСТОРИИ ════════════════════════════════════════════════════════════════════════
// Берём готовый кадр из НАШИХ опубликованных постов (склад в базе, meta.image_urls) и приводим к
// 9:16 тем же способом, что тикток-путь (ttkit.to916: фото целиком по ширине, остаток закрыт
// размытой копией — ни обрезки по бокам, ни белых полей). Поверх — наша плашка в стиле plates.cjs.
//
// БЕЗОПАСНАЯ ЗОНА ИСТОРИИ (не тиктоковская): сверху ~250 px это полоски прогресса, аватар и ник,
// снизу ~250 px это «Отправить сообщение». Плашку держим между ними, поближе к низу, чтобы
// наклейка ссылки (её Instagram кладёт по центру) не села на текст.
const STORY_BOTTOM = 330;
const SIDE = 80;

// Тон подложки берём с самого кадра (как в plates.cjs), иначе на светлом кадре белый текст исчезнет.
function tone(src) {
  try {
    const r = spawnSync(FF, ['-hide_banner', '-i', src, '-vf', 'crop=iw:ih*0.34:0:ih*0.66,scale=1:1',
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
    const b = r.stdout;
    if (b && b.length >= 3) {
      const lum = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
      const k = lum > 1 ? Math.min(1, 34 / lum) : 1;
      return [Math.round(b[0] * k), Math.round(b[1] * k), Math.round(b[2] * k)];
    }
  } catch {}
  return [10, 10, 12];
}
const rgba = (t, a) => `rgba(${t[0]},${t[1]},${t[2]},${a})`;

// Плашка: слово-маркер («нейронка про промпты» для инстаграма — по нему мы различаем, с какой
// площадки пришёл человек) плюс адрес сайта СЛОВАМИ, без http.
// ПОЧЕМУ АДРЕС ОБЯЗАТЕЛЬНО НА КАДРЕ, А НЕ ТОЛЬКО В НАКЛЕЙКЕ. Наклейка работает, но по ней надо
// ТАПНУТЬ, а промотал историю пальцем — и ссылки не было. Адрес словами читается и без тапа, а
// слово-маркер ещё и приводит через поиск. Наклейка и текст не спорят, они про разных людей.
// ПОДСКАЗКА НА КАДРЕ НЕ ОБЕЩАЕТ КНОПКУ, ЕСЛИ КНОПКИ МОЖЕТ НЕ БЫТЬ (11.08).
// Здесь стояло «ссылка на кнопке выше, или набери в поиске», а начальник открыл историю и кнопки не
// увидел: текст обещал то, чего на кадре нет, и это хуже, чем не обещать ничего. Наклейку мы ставим
// отдельным шагом и подтверждаем ЧТЕНИЕМ своей же истории, поэтому в момент отрисовки кадра мы ещё
// не знаем, встанет ли она. Пишем то, что верно всегда, а про кнопку говорим только когда она
// подтверждена (STORY_HINT_LINK=1 ставит вызывающий после успешной проверки).
const ПОДСКАЗКА = process.env.STORY_HINT_LINK === '1'
  ? 'ссылка на кнопке выше, или набери в поиске'
  : 'просто набери это в поиске';

function storyHtml(b64, mime, t, marker) {
  return `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#000;
      font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
    img{width:${W}px;height:${H}px;object-fit:cover;display:block}
    .fade{position:absolute;left:0;right:0;bottom:0;height:820px;
      background:linear-gradient(to top,${rgba(t, 0.9)} 0%,${rgba(t, 0.72)} 34%,
        ${rgba(t, 0.4)} 66%,${rgba(t, 0)} 100%)}
    .wrap{position:absolute;left:${SIDE}px;right:${SIDE}px;bottom:${STORY_BOTTOM}px;color:#fff}
    .lead{font-size:34px;line-height:1.32;font-weight:500;color:rgba(255,255,255,.92);
      text-shadow:0 2px 12px rgba(0,0,0,.7);margin-bottom:22px}
    .big{font-size:74px;line-height:1.06;font-weight:800;letter-spacing:-1.6px;
      text-shadow:0 4px 22px rgba(0,0,0,.7)}
    .big span{color:#c9a6ff}
    .line{height:3px;width:150px;background:rgba(255,255,255,.5);margin:26px 0 20px;border-radius:2px}
    .site{font-size:44px;font-weight:700;letter-spacing:-.4px;color:#fff;
      text-shadow:0 3px 16px rgba(0,0,0,.7)}
    .hint{margin-top:16px;font-size:26px;color:rgba(255,255,255,.82);
      text-shadow:0 2px 10px rgba(0,0,0,.7)}
  </style><img src="data:${mime};base64,${b64}"><div class="fade"></div>
  <div class="wrap">
    <div class="lead">делала себе тут, бесплатно:</div>
    <div class="big">нейронка<br>про <span>${marker}</span></div>
    <div class="line"></div>
    <div class="site">${SITE}</div>
    <div class="hint">${ПОДСКАЗКА}</div>
  </div>`;
}

// Сборка картинки 1080x1920. src — любой наш кадр (4:5 из склада или что дали руками).
async function buildStory(src, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 9:16 делаем ЕДИНЫМ способом проекта (ttkit.to916), своей обрезки не заводим.
  const base = out.replace(/(\.\w+)$/, '_base$1');
  require('./ttkit.cjs').to916(src, base);
  const b64 = fs.readFileSync(base).toString('base64');
  const mime = /\.png$/i.test(base) ? 'image/png' : 'image/jpeg';
  // Слово-маркер отдаёт контракт шаблонов, руками его не пишем: по нему считаем, откуда человек.
  const marker = require('./templates.cjs').frame4Marker('reels');
  await require('./plates.cjs').renderHtml(storyHtml(b64, mime, tone(base), marker), out, W, H);
  try { fs.unlinkSync(base); } catch {}
  return out;
}

// Кадр со склада: последний НАШ опубликованный пост этого акка, кадр 3 (домашнее селфи — самый
// «сторисный» из четырёх). Нет своих постов — берём у любого нашего, чтобы прогон не встал.
async function frameFromStock(c, accId) {
  const q = `SELECT meta->'image_urls' u FROM posts
              WHERE status='published' AND meta ? 'image_urls' AND ($1::uuid IS NULL OR account_id=$1)
              ORDER BY published_at DESC LIMIT 1`;
  let r = await c.query(q, [accId]);
  if (!r.rowCount) r = await c.query(q, [null]);
  if (!r.rowCount) return null;
  const urls = r.rows[0].u || [];
  const url = urls[2] || urls[0];
  if (!url) return null;
  const out = `${SHOT}/src_${Date.now()}.jpg`;
  fs.mkdirSync(SHOT, { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`кадр со склада не скачался: HTTP ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

// ═══ СЕССИЯ ══════════════════════════════════════════════════════════════════════════════════
// ОДИН ПРОГОН = ОДНО ОКНО (приказ начальника 11.08). Мои пробы накопили у него в доке 13 окон
// Orbita на одном профиле: каждый прогон делал свой startLocal, а окна от прошлых оставались.
// Правило теперь железное: ПЕРЕД startLocal ищем живое окно этого профиля и работаем В НЁМ, а в
// конце закрываем за собой в любом случае. Повторный подъём профиля это ещё и лишний вход в
// аккаунт, а вход — главный убийца акков.
//
// Окно ищем ровно так же, как closeone.cjs: по строкам процессов, где есть и gologin_profile_<pid>,
// и remote-debugging-port. Порт уникален на окно, поэтому задеть чужое или личное окно невозможно.
function findLiveWindow(profileId) {
  try {
    const out = require('node:child_process').execSync('ps -Ao command 2>/dev/null',
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    for (const line of out.split('\n')) {
      if (!line.includes(`gologin_profile_${profileId}`)) continue;
      const port = (line.match(/remote-debugging-port=(\d+)/) || [])[1];
      if (port) return port;
    }
  } catch {}
  return null;
}

global.__GL = null;
global.__PORT = null;
global.__PID = null;   // profile_id открытого профиля: нужен, чтобы ПРОВЕРИТЬ закрытие фактом
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL;
  try {
    if (gl) {
      // Окно поднимали мы → ТОЛЬКО stopLocal. pkill по Orbita/Chrome запрещён: у начальника в этих
      // окнах личные профили, а без синхронизации профиля акк вылогинивается.
      await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(8000)]);
      if (typeof gl.killBrowser === 'function') gl.killBrowser();
      console.log(`  ⏹ профиль закрыт через stopLocal (${why})`);
    } else if (global.__PORT) {
      // Подсели в чужое живое окно → закрываем его тем же способом, что closeone.cjs: по ПОРТУ,
      // то есть ровно одно окно. Оставлять открытым нельзя, иначе окна снова начнут копиться.
      // ЗАКРЫВАТЬ НАДО СНАЧАЛА ВКЛАДКИ, ПОТОМ БРАУЗЕР (11.08, поймано фактом). Один b.close() на
      // CDP-соединении только ОТЦЕПЛЯЕТСЯ: окно на порту 28223 после него осталось жить, и я
      // отчитался «закрыто», когда оно висело. Chrome завершается, когда у него не осталось
      // вкладок — ровно так и делает closeone.cjs, поэтому повторяем его порядок.
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${global.__PORT}`, { timeout: 8000 }).catch(() => null);
      let closed = false;
      if (b) {
        for (const ctx of b.contexts()) { for (const pg of ctx.pages()) await pg.close().catch(() => {}); }
        await b.close().catch(() => {});
        closed = true;
      }
      // ПРОВЕРЯЕМ ФАКТОМ, а не верим себе: окна на этом порту не должно остаться в процессах.
      await sleep(2500);
      const still = global.__PID ? findLiveWindow(global.__PID) : null;
      console.log(closed
        ? `  ⏹ окно закрыто по порту ${global.__PORT} (${why})${still ? ' — ВНИМАНИЕ: окно профиля ещё живо, порт ' + still : ''}`
        : `  ⚠ окно на порту ${global.__PORT} не отозвалось по CDP (${why}) — закрой руками: node closeone.cjs ${global.__PORT}`);
    }
  } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT ' + e.message); await closeLocal('uncaught'); process.exit(1); });

async function openSession(row) {
  const cks = L.normCookies(row.ig_cookies);
  global.__PID = row.pid;
  let b = null, reused = false;
  // ШАГ 0: НЕ ПОДНИМАТЬ ВТОРОЕ ОКНО. Живое окно этого профиля уже есть → работаем в нём.
  const port = findLiveWindow(row.pid);
  if (port) {
    b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 }).catch(() => null);
    if (b) {
      global.__PORT = port; reused = true;
      console.log(`  ♻ подсел в живое окно профиля (порт ${port}) — второе не поднимаю`);
    } else console.log(`  ⚠ окно на порту ${port} есть, но CDP не ответил — поднимаю своё`);
  }
  if (!b) {
    const { default: GoLogin } = await import('gologin');
    L.dropBrokenProfileZip(row.pid);   // пустой архив профиля = браузер без кук (разбор 07.08)
    const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
    let st = null;
    for (let t = 1; t <= 3 && !st; t++) {
      try { st = await gl.startLocal(); if (!st || !st.wsUrl) { st = null; throw new Error('startLocal без wsUrl'); } }
      catch (e) { console.log(`  ⚠ GoLogin попытка ${t}/3: ${String(e.message).slice(0, 90)}`); if (t < 3) await sleep(45000); }
    }
    if (!st) throw new Error('GoLogin не поднял профиль (3 попытки)');
    b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
  }
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
  await L.hardenContext(ctx);
  await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
  // В ПЕРЕИСПОЛЬЗОВАННОМ ОКНЕ КУКИ НЕ ПОДСТАВЛЯЕМ: сессия там уже живая, а лишняя подстановка это
  // лишнее касание аккаунта. Ставим только язык интерфейса.
  await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
  if (!reused && cks.length) { await ctx.addCookies(cks); console.log(`  🍪 сессия подставлена (${cks.length} кук)`); }
  // Если окно уже на инстаграме — просто ПЕРЕЗАГРУЖАЕМ страницу, а не гоняем профиль заново.
  if (reused && /instagram\.com/.test(page.url())) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  else await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000); await L.dismissDialogs(page);
  // Экран выбора профиля («Continue» / «Use another profile») — сессия живая, надо подтвердить.
  for (let t = 0; t < 3; t++) {
    let cont = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
    if (!(await cont.isVisible({ timeout: 2000 }).catch(() => false))) {
      cont = page.locator('div[role="button"], button').filter({ hasText: /^(Continue|Продолжить)$/i }).first();
      if (!(await cont.isVisible({ timeout: 2000 }).catch(() => false))) break;
    }
    await cont.click({ timeout: 5000 }).catch(() => {});
    await sleep(7000); await L.dismissDialogs(page);
  }
  // КТО МЫ. Правило проекта: положительная классификация + сверка ds_user_id, чтобы не публиковать
  // ссылку на чужом аккаунте.
  const cls = await L.classifyScreen(ctx, page);
  if (cls.state !== 'logged_in') throw new Error(`экран=${cls.state} (${cls.evidence}) — сессия не подтверждена`);
  const expected = (cks.find((x) => x.name === 'ds_user_id') || {}).value;
  if (expected && String(cls.dsUserId) !== String(expected)) {
    throw new Error(`в браузере ds_user_id=${cls.dsUserId}, у акка ${expected} — ЧУЖАЯ сессия, стоп`);
  }
  console.log('  ✓ в нужном аккаунте');
  return { b, ctx, page, reused, port: global.__PORT };
}

// ═══ ГЕЙТ «ОДНА ИСТОРИЯ НА АККАУНТ» ══════════════════════════════════════════════════════════
// Спрашиваем САМ ИНСТАГРАМ, а не свою базу: база про истории ничего не знает, а лоток знает точно
// и учитывает истории, выложенные не нами (магосом, руками с телефона). Правило проекта — судить
// по факту из первоисточника.
async function lastStoryAge() {
  const uid = (document.cookie.match(/ds_user_id=([^;]+)/) || [])[1];
  const r = await fetch(`/api/v1/feed/user/${uid}/story/`, {
    credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' },
  });
  if (r.status !== 200) return { known: false, why: `лоток своих историй ответил ${r.status}` };
  const d = await r.json().catch(() => null);
  if (!d) return { known: false, why: 'лоток отдал не JSON' };
  const items = ((d.reel || {}).items) || [];
  if (!items.length) return { known: true, count: 0, ageHours: null };
  const last = Math.max(...items.map((x) => Number(x.taken_at) || 0));
  return { known: true, count: items.length, ageHours: (Date.now() / 1000 - last) / 3600 };
}

// Вернёт причину отказа строкой либо null, если работать можно.
async function freshStoryBlock(page, log = console.log) {
  const st = await page.evaluate(lastStoryAge).catch(() => ({ known: false, why: 'проверку не выполнили' }));
  if (!st.known) {
    // ВЕРДИКТА НЕТ — НЕ ПУБЛИКУЕМ. Цена ошибки несимметрична: лишняя история это спам на акке,
    // а пропущенный прогон просто повторится позже. Тот же принцип, что у сторожа с «спрятан».
    return `не смог проверить, есть ли свежая история (${st.why}) — вторую вслепую не публикую`;
  }
  if (!st.count) { log('  🕓 активных историй нет — можно публиковать'); return null; }
  if (st.ageHours !== null && st.ageHours < FRESH_HOURS) {
    return `на акке уже ${st.count} актив. истори${st.count === 1 ? 'я' : 'и'}, последняя ${st.ageHours.toFixed(1)}ч назад `
      + `(порог ${FRESH_HOURS}ч) — одна история на аккаунт за прогон, второй не будет`;
  }
  log(`  🕓 последняя история ${st.ageHours.toFixed(1)}ч назад — старше порога ${FRESH_HOURS}ч, можно`);
  return null;
}

// ═══ ОСМОТР ИНТЕРФЕЙСА (--probe) ═════════════════════════════════════════════════════════════
// Отдельный режим ровно потому, что про историю в вебе много догадок и мало факта: даёт ли меню
// создания пункт «Story», есть ли в редакторе наклейка ссылки, виден ли «+ New» в хайлайтсах.
// Ничего не публикует, только смотрит и снимает экраны.
async function probe(page, handle) {
  const out = {};
  fs.mkdirSync(SHOT, { recursive: true });
  await L.clearOverlays(page);
  // 1. Что в меню создания.
  const icon = page.locator('svg[aria-label="New post" i], div[role="button"]:has(svg[aria-label="New post" i]), svg[aria-label="Создать" i]').first();
  if (await icon.isVisible({ timeout: 5000 }).catch(() => false)) {
    await icon.click({ timeout: 6000 }).catch(() => {});
    await sleep(3000);
  }
  out.menu = await page.evaluate(() =>
    [...document.querySelectorAll('div[role="button"],button,[role="menuitem"],a')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 40).slice(0, 40)).catch(() => []);
  out.menuShot = await L.snap(page, SHOT, `probe_${handle}_menu`);
  console.log(`  меню создания: ${JSON.stringify(out.menu)}`);
  console.log(`  скрин: ${out.menuShot}`);
  // 2. Хайлайтсы на профиле: есть ли «+ New».
  await page.goto(`https://www.instagram.com/${handle}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000); await L.clearOverlays(page);
  out.profile = await page.evaluate(() =>
    [...document.querySelectorAll('div[role="button"],button,a,span')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 30).slice(0, 50)).catch(() => []);
  out.profShot = await L.snap(page, SHOT, `probe_${handle}_profile`);
  console.log(`  профиль: ${JSON.stringify(out.profile)}`);
  console.log(`  скрин: ${out.profShot}`);
  return out;
}

// ═══ ПУБЛИКАЦИЯ ИСТОРИИ ══════════════════════════════════════════════════════════════════════
// ФАКТ, ИЗМЕРЕННЫЙ 11.08 НА ЖИВОМ АККЕ (не догадка): в вебе ИНТЕРФЕЙСА создания истории НЕТ.
//   · клик по «+» на bryan436344 открывает сразу диалог «Create new post», пункта «Story» в меню
//     нет вообще (дамп всех видимых кнопок — в /tmp/stories/probe_*_menu.jpg);
//   · прямой адрес /create/story/ уводит редиректом на ленту (как и /create/select/, разбор 07.08);
//   · /stories/archive/ Instagram трактует как НИК и открывает ЧУЖОЙ профиль @archive.
// А вот СВОИ РУЧКИ веб-приложения живы и историю принимают: rupload_igphoto доставляет байты,
// /api/v1/web/create/configure_to_story/ собирает из них историю (проверено, ответ 200 с media.pk).
// Поэтому публикуем ими, ИЗНУТРИ живой страницы: fetch идёт сессией самого браузера, свои подписи
// и заголовки мы не изобретаем, прокси и фингерпринт профиля те же.
const APPID = '936619743392459';

// Заливка выполняется В КОНТЕКСТЕ СТРАНИЦЫ. Возвращает лог каждого шага с кодом и телом ответа:
// правило проекта — успех подтверждается положительным признаком (media.pk), а не «не упало».
async function uploadStory({ b64, link }) {
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const uploadId = String(Date.now());
  const name = uploadId + '_0_' + Math.floor(Math.random() * 1e9);
  const log = [];
  const r1 = await fetch('/rupload_igphoto/' + name, {
    method: 'POST', credentials: 'include', body: bin,
    headers: {
      'x-entity-type': 'image/jpeg', 'x-entity-name': name, 'x-entity-length': String(bin.length),
      offset: '0',
      'x-instagram-rupload-params': JSON.stringify({
        media_type: '1', upload_id: uploadId,
        upload_media_height: '1920', upload_media_width: '1080', xsharing_user_ids: '[]',
        image_compression: JSON.stringify({ lib_name: 'moz', lib_version: '3.1.m', quality: '80' }),
      }),
      'x-csrftoken': csrf, 'x-ig-app-id': '936619743392459',
      'content-type': 'application/octet-stream', 'x-requested-with': 'XMLHttpRequest',
    },
  });
  log.push({ step: 'доставка байтов', status: r1.status, body: (await r1.text()).slice(0, 200) });
  if (r1.status !== 200) return { ok: false, log };
  const conf = async (withLink) => {
    const p = new URLSearchParams({ upload_id: uploadId, source_type: 'library', caption: '' });
    if (withLink) {
      // РАБОЧАЯ ФОРМА НАКЛЕЙКИ ССЫЛКИ (выверена на живом акке 11.08, сверена с чужой историей).
      // Что здесь важно и почему (каждый пункт — отдельная провалившаяся попытка):
      //   · link_type и url лежат ПЛОСКО на стикере. Вложенный story_link:{url} инстаграм молча
      //     выбрасывает — вложенным он ОТДАЁТ, но не ПРИНИМАЕТ;
      //   · флаги is_pinned/is_hidden/is_sticker — ЧИСЛА. Строка '0' читается как «истина», и
      //     ссылка прикрепляется невидимой (is_hidden:1 в ответе);
      //   · геометрия нужна вся: без width/height/rotation стикеру негде встать;
      //   · story_sticker_ids обязателен, это заявка «в истории есть стикер такого типа»;
      //   · story_cta и link_urls НЕ слать: это старые способы, и вместе с ними ручка выбрасывала
      //     всю ссылку целиком.
      // y=0.55 — НАД нашей плашкой (она занимает низ кадра), иначе наклейка садится на текст.
      p.set('story_link_stickers', JSON.stringify([{
        x: 0.5, y: 0.55, z: 0, width: 0.53, height: 0.068, rotation: 0.0,
        is_pinned: 0, is_hidden: 0, is_sticker: 1,
        link_type: 'web', url: withLink,
      }]));
      p.set('story_sticker_ids', 'link_sticker_default');
    }
    const r = await fetch('/api/v1/web/create/configure_to_story/', {
      method: 'POST', credentials: 'include', body: p.toString(),
      headers: { 'x-csrftoken': csrf, 'content-type': 'application/x-www-form-urlencoded',
        'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
    });
    const body = await r.text();
    let pk = null;
    try { pk = (JSON.parse(body).media || {}).pk || null; } catch {}
    return { status: r.status, pk, body: body.slice(0, 300) };
  };
  let res = null;
  if (link) { res = await conf(link); log.push({ step: 'сборка истории со ссылкой', ...res }); }
  if (!res || res.status !== 200 || !res.pk) {
    const r2 = await conf(null); log.push({ step: 'сборка истории без ссылки', ...r2 }); res = r2;
  }
  return { ok: res.status === 200 && !!res.pk, pk: res.pk, log };
}

// ЖИВАЯ ЛИ ССЫЛКА В ИСТОРИИ. Единственное настоящее доказательство: читаем свою же историю
// ручкой reels_media и смотрим, лежит ли в ней story_cta / story_link_stickers. Именно здесь
// вскрылась правда 11.08: ручка сборки отвечает 200, а поля ссылки МОЛЧА выбрасывает.
async function checkLink(pk) {
  const uid = (document.cookie.match(/ds_user_id=([^;]+)/) || [])[1];
  const r = await fetch(`/api/v1/feed/reels_media/?reel_ids=${uid}`, {
    credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' },
  });
  if (r.status !== 200) return { known: false, why: `reels_media ответил ${r.status}` };
  const d = await r.json().catch(() => null);
  if (!d) return { known: false, why: 'reels_media отдал не JSON' };
  const reel = (d.reels_media || [])[0] || (d.reels || {})[uid] || {};
  const it = (reel.items || []).find((x) => String(x.pk) === String(pk));
  if (!it) return { known: false, why: 'своей истории в лотке не нашли' };
  const st = (it.story_link_stickers || [])[0] || null;
  const has = !!(st || it.story_cta);
  return {
    known: true, has,
    // is_hidden=1 значит «ссылка прикреплена, но стикера на кадре не видно» — для нас это брак,
    // поэтому видимость сообщаем отдельно от самого факта наличия.
    visible: st ? Number(st.is_hidden) === 0 : false,
    url: st && st.story_link ? st.story_link.url : null,
    shown: st && st.story_link ? st.story_link.display_url : null,
    // ГЕОМЕТРИЮ БЕРЁМ ИЗ ОТВЕТА ИНСТАГРАМА, А НЕ ИЗ СВОЕГО ЗАПРОСА: он её нормализует, и рисовать
    // макет надо по тому, что он реально запомнил.
    geo: st ? { x: st.x, y: st.y, width: st.width, height: st.height, rotation: st.rotation } : null,
    keys: Object.keys(it).filter((k) => /cta|link|sticker/i.test(k)),
  };
}

async function publishStory(page, img, { link, log = console.log } = {}) {
  const res = { shots: [], pk: null, link: null };
  const b64 = fs.readFileSync(img).toString('base64');
  const up = await L.step(page, SHOT, 'заливка истории', async () => {
    const r = await page.evaluate(uploadStory, { b64, link: LINK_MODE === 'text' ? null : link });
    for (const s of r.log) log(`    ${s.step}: ${s.status}${s.pk ? ' pk=' + s.pk : ''}`);
    if (!r.ok) throw new Error('Instagram не собрал историю: ' + JSON.stringify(r.log.slice(-1)[0] || {}).slice(0, 200));
    return r;
  });
  res.pk = up.pk;
  log(`  ✅ история опубликована, pk=${up.pk}`);
  await sleep(8000);
  // ПРАВДА ПРО НАКЛЕЙКУ ССЫЛКИ. Спрашиваем сам Instagram, а не свои ожидания.
  res.link = await page.evaluate(checkLink, up.pk).catch(() => ({ known: false, why: 'проверку не выполнили' }));
  if (res.link.known && res.link.has) {
    log(`  🔗 наклейка ссылки В ИСТОРИИ ЕСТЬ: показывает «${res.link.shown || '?'}»`
      + ` | видима: ${res.link.visible ? 'да (is_hidden=0)' : 'НЕТ (is_hidden=1) — форма нагрузки поехала'}`
      + (res.link.geo ? ` | место: x=${res.link.geo.x} y=${res.link.geo.y}` : ''));
    // Адрес инстаграм оборачивает в свой l.instagram.com — проверяем, что ВНУТРИ наша ссылка.
    const inside = decodeURIComponent(String(res.link.url || ''));
    log(inside.includes(link) ? `  ✅ внутри обёртки инстаграма наша персональная ссылка: ${link}`
      : `  ⚠ внутри обёртки НЕ наша ссылка: ${inside.slice(0, 120)}`);
  } else if (res.link.known) {
    log('  🔗 наклейки в истории НЕТ: Instagram ответил 200, но поля ссылки выбросил. Это ФОРМА '
      + 'нагрузки, а не право акка — сверь linkSticker() с рабочей формой в заголовке файла');
    log('  ↪ путь на сервис всё равно есть: адрес словами и слово-маркер нарисованы на кадре');
  } else log(`  🔗 про наклейку сказать нечего: ${res.link.why}`);
  if (LINK_MODE === 'sticker' && !(res.link.known && res.link.has)) {
    throw new Error('запрошен режим только-наклейка, а наклейки нет');
  }
  return res;
}

// МАКЕТ РАСПОЛОЖЕНИЯ НАКЛЕЙКИ. Зачем он нужен: свою историю веб не открывает (см. п.4 в шапке),
// то есть посмотреть глазами, куда села наклейка, нам нечем. Но геометрию инстаграм возвращает
// сам, поэтому рисуем её на том же кадре — видно, что наклейка стоит НАД плашкой и ни на что не
// налезает. Это не скрин из инстаграма и выдавать его за скрин нельзя: это чертёж по его данным.
async function mockSticker(img, geo, out, log = console.log) {
  if (!geo) return null;
  const b64 = fs.readFileSync(img).toString('base64');
  // x,y — ЦЕНТР наклейки в долях кадра, width/height — её размеры в тех же долях.
  const w = geo.width * W, h = geo.height * H;
  const left = geo.x * W - w / 2, top = geo.y * H - h / 2;
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#000;
      font-family:-apple-system,'Helvetica Neue',Arial,sans-serif}
    img{width:${W}px;height:${H}px;object-fit:cover;display:block;position:absolute;inset:0}
    .pill{position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;
      background:#fff;border-radius:${h / 2}px;display:flex;align-items:center;justify-content:center;
      box-shadow:0 6px 22px rgba(0,0,0,.35);color:#16181d;font-size:${Math.round(h * 0.42)}px;font-weight:600}
    .tag{position:absolute;left:${left}px;top:${top - 46}px;font-size:26px;color:#7dff9b;
      text-shadow:0 2px 8px rgba(0,0,0,.9)}
  </style><img src="data:image/jpeg;base64,${b64}">
  <div class="tag">наклейка ссылки: x=${geo.x} y=${geo.y}</div>
  <div class="pill">${SITE}</div>`;
  await require('./plates.cjs').renderHtml(html, out, W, H);
  log(`  📐 макет расположения наклейки: ${out}`);
  return out;
}

// Скрин-доказательство на профиле: кольцо вокруг аватара (значит активная история есть) плюс
// полка хайлайтсов с нашим кружком.
// ПОЧЕМУ НЕ СНИМАЕМ САМУ ИСТОРИЮ ИЗНУТРИ. Проверено 11.08 тремя способами, ни один не работает на
// наших акках: адрес /stories/<ник>/<pk>/ уводит на ленту, /stories/highlights/<id>/ тоже, а клик
// по аватару и по кружку хайлайтса просмотрщик не открывает (страница остаётся профилем). Веб на
// этих аккаунтах урезан — тот же расклад, что и с созданием истории. Поэтому доказательства
// собираем оттуда, где они есть: кадр, который мы залили, ответ Instagram с pk и его же полка
// хайлайтсов. Выдавать «скрин не снялся» за провал публикации нельзя, это разные вещи.
async function snapProfile(page, handle, log = console.log) {
  await page.goto(`https://www.instagram.com/${handle}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(7000); await L.clearOverlays(page);
  const ring = await page.evaluate(() => {
    // Кольцо истории вокруг аватара рисуется отдельным svg/canvas поверх картинки профиля.
    const h = document.querySelector('header') || document.body;
    return !!h.querySelector('canvas, svg circle[stroke]');
  }).catch(() => false);
  const shot = await L.snap(page, SHOT, `story_${handle}_profile`);
  log(`  📷 профиль: ${shot} (кольцо истории вокруг аватара: ${ring ? 'есть' : 'не разобрал'})`);
  return shot;
}

// ═══ ЗАКРЕП В ХАЙЛАЙТС ═══════════════════════════════════════════════════════════════════════
// ПОЧЕМУ НЕ ЧЕРЕЗ ИНТЕРФЕЙС (измерено на живом акке 11.08, а не предположено). Диалог «New
// Highlight» на профиле открывается и название принимает, но после «Next» показывает ПУСТУЮ
// панель «Stories»: закреплять веб даёт только из АРХИВА, а архив пуст — ручка архива
// /api/v1/archive/reel/day_shells/ отдаёт 200 с пустым телом, и сама история приходит с
// "story_is_saved_to_archive": false. Включить автоархив из веба нечем: /api/v1/users/reel_settings/
// отвечает «useragent mismatch», /api/v1/users/set_reel_settings/ — 404 (это ручки приложения, а
// подделывать мобильный user-agent живой веб-сессией мы не будем: за такое и жгут акки).
//
// ЧТО РАБОТАЕТ: /api/v1/highlights/create_reel/ принимает АКТИВНУЮ историю по её pk напрямую,
// минуя архив, и сразу берёт обложку из того же кадра (cover.media_id = pk). Проверено: хайлайтс
// «ПРОМПТЫ» появился на профиле с нашей картинкой на кружке.
//
// КРУЖОК С ТАКИМ ЖЕ НАЗВАНИЕМ НЕ ПЛОДИМ. Если «ПРОМПТЫ» уже есть, историю ДОБАВЛЯЕМ в него
// (edit_reel), иначе на профиле вырастет полка одинаковых кружков и путь на сервис перестанет
// читаться. Обложку при добавлении переносим на свежий кадр: в кружке всегда последняя история.
async function createHighlight({ pk, title }) {
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const uid = (document.cookie.match(/ds_user_id=([^;]+)/) || [])[1];
  const H = { 'x-csrftoken': csrf, 'content-type': 'application/x-www-form-urlencoded',
    'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' };
  // Есть ли уже кружок с таким названием.
  let exist = null;
  try {
    const tr = await fetch(`/api/v1/highlights/${uid}/highlights_tray/`, { credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' } });
    const td = await tr.json();
    exist = (td.tray || []).find((x) => String(x.title || '').trim() === title) || null;
  } catch {}
  const cover = JSON.stringify({ media_id: String(pk) });   // обложка = тот же кадр истории
  if (exist) {
    const r = await fetch(`/api/v1/highlights/${exist.id}/edit_reel/`, {
      method: 'POST', credentials: 'include', headers: H,
      body: new URLSearchParams({ added_media_ids: JSON.stringify([String(pk)]), title, cover }).toString(),
    });
    const t = await r.text();
    return { status: r.status, id: exist.id, mode: 'добавил в существующий', body: t.slice(0, 300) };
  }
  const r = await fetch('/api/v1/highlights/create_reel/', {
    method: 'POST', credentials: 'include', headers: H,
    body: new URLSearchParams({ media_ids: JSON.stringify([String(pk)]), title, source: 'self_profile', cover }).toString(),
  });
  const t = await r.text();
  let id = null;
  try { id = ((JSON.parse(t).reel || {}).id) || null; } catch {}
  return { status: r.status, id, mode: 'создал новый', body: t.slice(0, 300) };
}

// Полка хайлайтсов глазами инстаграма: чем подтверждаем закреп. Правило проекта — успех это
// ПОЛОЖИТЕЛЬНЫЙ признак (кружок с нашим названием в полке), а не «запрос не упал».
async function readHighlightTray() {
  const uid = (document.cookie.match(/ds_user_id=([^;]+)/) || [])[1];
  const r = await fetch(`/api/v1/highlights/${uid}/highlights_tray/`, {
    credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' },
  });
  if (r.status !== 200) return { known: false, why: `highlights_tray ответил ${r.status}` };
  const d = await r.json().catch(() => null);
  if (!d) return { known: false, why: 'highlights_tray отдал не JSON' };
  return { known: true, tray: (d.tray || []).map((x) => ({ id: x.id, title: x.title, media_count: x.media_count })) };
}

async function pinToHighlight(page, handle, label, pk, log = console.log) {
  const shots = [];
  const res = await L.step(page, SHOT, 'закреп в хайлайтс', async () => {
    const r = await page.evaluate(createHighlight, { pk, title: label });
    if (r.status !== 200 || !r.id) throw new Error(`Instagram не создал хайлайтс: ${r.status} ${r.body}`);
    return r;
  });
  log(`  📌 хайлайтс: ${res.mode} — ${res.id}`);
  await sleep(5000);
  // ДОКАЗАТЕЛЬСТВО №1: полка хайлайтсов отдаёт кружок с нашим названием.
  const tray = await page.evaluate(readHighlightTray).catch(() => ({ known: false, why: 'полку не прочитали' }));
  const inTray = tray.known && (tray.tray || []).some((x) => String(x.title || '').trim() === label);
  log(inTray ? `  ✅ полка хайлайтсов: ${JSON.stringify(tray.tray)}`
    : `  ⚠ в полке хайлайтсов нашего кружка нет: ${JSON.stringify(tray).slice(0, 200)}`);
  // ДОКАЗАТЕЛЬСТВО №2: он же виден на самом профиле, глазами.
  await page.goto(`https://www.instagram.com/${handle}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(8000); await L.clearOverlays(page);
  const seen = await page.evaluate((lbl) => (document.body.innerText || '').includes(lbl), label).catch(() => false);
  shots.push(await L.snap(page, SHOT, `high_${handle}_profile`));
  log(seen ? `  ✅ кружок «${label}» виден на профиле` : `  ⚠ кружка «${label}» на профиле НЕ вижу`);
  return { ok: !!(inTray && seen), id: res.id, shots };
}

// ═══ УБОРКА КРУЖКА: ОСТАВИТЬ ОДНУ ИСТОРИЮ ════════════════════════════════════════════════════
// ЭТО ОТКРЕП, А НЕ УДАЛЕНИЕ. edit_reel полем removed_media_ids вынимает историю ИЗ КРУЖКА; сама
// история остаётся жить и истекает своим чередом. Ничего не стираем.
async function readHighlight({ id }) {
  const r = await fetch(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(id)}`, {
    credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' },
  });
  if (r.status !== 200) return { known: false, why: `reels_media ответил ${r.status}` };
  const d = await r.json().catch(() => null);
  if (!d) return { known: false, why: 'reels_media отдал не JSON' };
  const reel = (d.reels_media || [])[0] || (d.reels || {})[id] || null;
  if (!reel) return { known: true, gone: true };
  return {
    known: true, gone: false, title: reel.title || null,
    items: (reel.items || []).map((x) => ({
      pk: String(x.pk), taken_at: x.taken_at,
      link: !!(x.story_link_stickers || x.story_cta),
    })),
  };
}

// Открепить РОВНО ОДНУ историю. Отдельным вызовом на каждую — чтобы после каждого шага сверять
// состав. Пачкой быстрее, но если пачка уронит кружок, разбирать будет уже нечего.
async function unpinOne({ id, pk, title, coverPk }) {
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const body = new URLSearchParams({ removed_media_ids: JSON.stringify([String(pk)]) });
  // Название и обложку передаём, чтобы правка не обнулила их. Обложка — ТА, КОТОРУЮ ОСТАВЛЯЕМ:
  // указать обложкой открепляемую историю значит сломать кружок своими руками.
  if (title) body.set('title', title);
  if (coverPk) body.set('cover', JSON.stringify({ media_id: String(coverPk) }));
  const r = await fetch(`/api/v1/highlights/${id}/edit_reel/`, {
    method: 'POST', credentials: 'include', body: body.toString(),
    headers: { 'x-csrftoken': csrf, 'content-type': 'application/x-www-form-urlencoded',
      'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
  });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 200) };
}

// Оставить в кружке одну историю. keepPk задаётся явно; если не задан — самая свежая по taken_at.
async function trimHighlight(page, handle, label, keepPk, log = console.log) {
  // Находим кружок по названию через полку — id руками не вбиваем.
  const tray = await page.evaluate(readHighlightTray);
  if (!tray.known) throw new Error(`полку хайлайтсов не прочитал: ${tray.why}`);
  const circle = (tray.tray || []).find((x) => String(x.title || '').trim() === label);
  if (!circle) throw new Error(`кружка «${label}» на акке нет (в полке: ${JSON.stringify(tray.tray)})`);
  log(`  📌 кружок «${label}»: ${circle.id}, историй внутри ${circle.media_count}`);

  let st = await page.evaluate(readHighlight, { id: circle.id });
  if (!st.known) throw new Error(`состав кружка не прочитал: ${st.why}`);
  if (st.gone) throw new Error('кружок не отдаётся по reels_media — работать вслепую не буду');
  log(`  состав до уборки (${st.items.length}):`);
  for (const it of st.items) {
    log(`    ${it.pk} | ${new Date(it.taken_at * 1000).toISOString().replace('T', ' ').slice(0, 19)}`
      + ` | наклейка ссылки: ${it.link ? 'есть' : 'нет'}`);
  }
  const keep = keepPk || st.items.slice().sort((a, b) => b.taken_at - a.taken_at)[0].pk;
  if (!st.items.some((x) => x.pk === String(keep))) {
    throw new Error(`истории ${keep}, которую велено оставить, в кружке нет — не трогаю ничего`);
  }
  log(`  оставляю: ${keep}`);
  const drop = st.items.filter((x) => x.pk !== String(keep)).map((x) => x.pk);
  if (!drop.length) { log('  лишних нет, кружок уже чистый'); return { ok: true, id: circle.id, left: st.items.length }; }

  for (const [i, pk] of drop.entries()) {
    const before = st.items.length;
    const r = await page.evaluate(unpinOne, { id: circle.id, pk, title: label, coverPk: keep });
    log(`  ↪ открепляю ${pk} (${i + 1}/${drop.length}): ответ ${r.status}`);
    if (r.status !== 200) throw new Error(`открепление ${pk} не прошло (${r.status}): ${r.body}`);
    await sleep(3500);
    // СВЕРКА ПОСЛЕ КАЖДОГО ШАГА. Останавливаемся на любом расхождении: чинить вслепую хуже, чем
    // остановиться и позвать человека.
    st = await page.evaluate(readHighlight, { id: circle.id });
    if (!st.known) throw new Error(`после открепления состав не читается (${st.why}) — СТОП`);
    if (st.gone) throw new Error('после открепления КРУЖОК ПРОПАЛ — СТОП, дальше не трогаю');
    if (st.items.length !== before - 1) {
      throw new Error(`после открепления в кружке ${st.items.length} историй, ждали ${before - 1} — СТОП`);
    }
    if (!st.items.some((x) => x.pk === String(keep))) {
      throw new Error('после открепления пропала история, которую велено оставить — СТОП');
    }
    log(`    сверка: осталось ${st.items.length}, нужная на месте`);
  }
  return { ok: true, id: circle.id, left: st.items.length, keep };
}

// ═══ ПРОГОН ══════════════════════════════════════════════════════════════════════════════════
(async () => {
  if (!SLUG) { console.log('нужен --slug <акк>'); process.exit(1); }
  L.setShotTag(`story_${String(SLUG).replace(/\W/g, '_')}`);
  fs.mkdirSync(SHOT, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(
    `SELECT a.id, a.slug, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies, a.gologin_profile_id pid,
            a.session_status ss, coalesce(a.ig_status,'-') ig, coalesce(a.health_state,'-') hs, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE a.deleted_at IS NULL AND (a.slug=$1 OR a.ig_login=$1)`, [SLUG]);
  if (!r.rowCount) { console.log(`акка «${SLUG}» нет в базе`); await c.end(); process.exit(1); }
  const row = r.rows[0];
  console.log(`\n[stories] @${row.h} (${row.slug}, ${row.persona || 'без персоны'}) | сессия ${row.ss} | ig ${row.ig} | health ${row.hs}`);

  // Картинка: своя из --img или собранная из кадра со склада. В режиме уборки кружка её не
  // собираем вовсе: публиковать нечего, а рендер и кадр со склада — лишняя работа.
  let img = IMG_IN;
  if (!img && !TRIM) {
    const src = await frameFromStock(c, row.id);
    if (!src) { console.log('на складе нет кадров (meta.image_urls) — дай картинку через --img'); await c.end(); process.exit(1); }
    img = `${SHOT}/story_${row.slug.replace(/\W/g, '_')}_${Date.now()}.jpg`;
    await buildStory(src, img);
    try { fs.unlinkSync(src); } catch {}
  }
  if (img) console.log(`  🖼 картинка истории: ${img}`);
  if (BUILD_ONLY) { await c.end(); process.exit(0); }

  // ПЕРСОНАЛЬНАЯ ССЫЛКА — ДО ОТКРЫТИЯ АККАУНТА. Если админка не отдаст ссылку, окно инстаграма
  // даже не поднимаем: история без своей ссылки нам не нужна, а лишний вход это износ аккаунта.
  let LINK = LINK_IN;
  if (!LINK && !TRIM) {
    const gl = await require('./golink.cjs').ensureLink(row.h).catch((e) => { throw new Error(`персональная ссылка не получена: ${e.message}`); });
    LINK = gl.url;
    console.log(`  🔗 ссылка аккаунта (${gl.mode}): ${LINK}`);
  } else if (LINK) console.log(`  🔗 ссылка задана руками: ${LINK}`);
  if (!row.pid || !row.ig_cookies) { console.log('нет профиля GoLogin или кук — работать нечем'); await c.end(); process.exit(1); }

  let out = null;
  try {
    const s = await openSession(row);
    if (PROBE) { await probe(s.page, row.h); }
    else if (TRIM) {
      const keep = arg('keep');
      const r = await trimHighlight(s.page, row.h, LABEL, keep);
      // ИТОГ ЧТЕНИЕМ, а не «команда прошла»: спрашиваем полку заново.
      await sleep(3000);
      const tray = await s.page.evaluate(readHighlightTray);
      console.log(`  ✅ полка после уборки: ${JSON.stringify((tray.tray || []).filter((x) => x.id === r.id))}`);
      const st = await s.page.evaluate(readHighlight, { id: r.id });
      console.log(`  ✅ состав: ${JSON.stringify(st.items)}`);
    }
    else {
      // ГЕЙТ ЧАСТОТЫ — до любой заливки, чтобы не тратить ни байта на лишнюю историю.
      const block = await freshStoryBlock(s.page);
      if (block && !FORCE) {
        console.log(`\nИТОГ: ⏭ пропускаю @${row.h}: ${block}`);
        console.log('  (осознанно повторить можно только флагом --force)');
        await closeLocal('гейт частоты');
        await c.end();
        process.exit(0);
      }
      if (block && FORCE) console.log(`  ⚠ --force: гейт частоты обойдён вручную (${block})`);
      out = await publishStory(s.page, img, { link: LINK });
      if (out.link && out.link.geo) {
        out.shots.push(await mockSticker(img, out.link.geo, img.replace(/(\.\w+)$/, '_макет$1')));
      }
      out.shots.push(await snapProfile(s.page, row.h));
      if (!NO_HIGH) {
        const hi = await pinToHighlight(s.page, row.h, LABEL, out.pk);
        console.log(`  📌 закреп: ${hi.ok ? 'есть' : 'НЕ подтверждён'}, скрины: ${hi.shots.filter(Boolean).join(' ')}`);
      }
    }
  } catch (e) {
    console.log(`\nИТОГ: ⛔ ${String(e.message).slice(0, 400)}`);
    // Аккаунт НЕ судим и в базу ничего не пишем: это утилита закрепа, а не сторож (правило iglib).
    if (/checkpoint|challenge|confirm your email|подтверд/i.test(String(e.message))) {
      console.log('  ⚠ похоже на чекпоинт/запрос почты — НЕ ломлюсь, разбирает человек');
    }
  } finally {
    await closeLocal('конец работы');
    await c.end();
  }
  process.exit(0);
})().catch(async (e) => {
  // Провал ДО открытия аккаунта (нет ссылки в админке, нет кадра, база не ответила) сюда и попадает.
  // Окно если и поднялось — закрываем, иначе оно останется висеть у начальника в доке.
  console.log(`\nИТОГ: ⛔ ${String(e.message).slice(0, 300)}`);
  await closeLocal('провал до работы').catch(() => {});
  process.exit(1);
});
