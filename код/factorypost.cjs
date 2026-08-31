// ПОСТ ЧЕРЕЗ ФАБРИКУ, СОБРАННЫЙ ПО НАШЕЙ ЛОГИКЕ (06.08, решение начальника: «давай попробуем
// через фабрику, она норм работает, а ты будешь собирать 4 фотки по нашей логике»).
//
// Почему фабрика: её ветка держит лицо и стабильно проходит валидатор (залп 05.08 дал 12/12
// без брака), тогда как своя генерация за ночь дала 100% брака.
//
// Фабрика отдаёт ТРИ кадра: [фото с хуком, инфографика, результат]. Нам нужно четыре разных,
// поэтому шаблон заказывается ДВАЖДЫ по одному референсу: из первого заказа берём хук-фото,
// инфографику и результат, из второго — второй результат. Тогда слайды 3 и 4 действительно
// разные снимки, а не один кадр с подписью (претензия начальника 06.08).
//
// Сборка: 1 фото с хуком · 2 инфографика · 3 результат · 4 второй результат + призыв.
// Запуск: node factorypost.cjs <Имя> <шаблон>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45, to45smart, ctaSlide, lockMock, reframe, hookSlide, factoryHook, postCaption } = require('./slidekit.cjs');
const { coverUsed, registerCover } = require('./coverguard.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
// ЛОК КОНВЕЙЕРА НУЖЕН ТОЛЬКО ДВИЖКУ САЙТА (07.08, замечание начальника: «конвейер на сайте
// имеет бесконечное количество слотов, там API, проверь свою логику»). Лок родился из-за кнопки
// генерации на странице: она блокируется на время рендера, поэтому два движковых процесса
// толкались. ФАБРИКА это HTTP API, она принимает заказы параллельно и очередь держит на сервере,
// то есть держать её под общим локом значило сериализовать то, что и так параллельно: пачка из
// шести постов шла по одному вместо всех сразу. Фабричный путь лок больше НЕ берёт.
// Оставляем возможность включить обратно (FACTORY_LOCK=1) на случай, если понадобится
// подружить его с движковыми прогонами.
const LOCK = '/tmp/genposts.lock';
const USE_LOCK = /^(1|true|yes)$/i.test(String(process.env.FACTORY_LOCK || ''));
const PERSONA = process.argv[2];
const TEMPLATE = process.argv[3];
const START_MS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// СТОРОЖ (07.08). Один пост через фабрику это 25 минут по-максимуму: рендер заказа плюс вёрстка
// плюс заливка. Дольше = либо фабрика встала, либо мы висим на сокете, и оба случая надо ВИДЕТЬ,
// а не узнавать через 45 минут (инцидент fix4.cjs). Отдельно замер шага: 10 минут без смены шага
// это уже висяк, даже если общий лимит ещё не вышел.
const wd = armWatchdog({ minutes: 25, stallMinutes: 10, label: `фабричный пост ${PERSONA || '?'}/${TEMPLATE || '?'}` });

async function takeLock(waitMs = 30 * 60000) {
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

// Заказ шаблона на фабрике по нашему референсу, БЕЗ ожидания рендера. Возвращает {id, hook, cap}.
// Фабрика требует hookText 20–140 знаков, а PATCH текстов больше не отдаёт — без запасного
// хука каждый заказ падал в HTTP 400 (ночь 06.08).
async function placeOrder(page, refUrl, template) {
  // Фабрика рисует хук одной строкой, поэтому переносы из нашего пула склеиваем: иначе на кадре
  // получается набор в одну строку с торчащими словами (пул писался под свою вёрстку в 2 строки).
  const fallbackHook = factoryHook(template).replace(/\s*\n\s*/g, ' ').trim();
  const res = await page.evaluate(async ({ refUrl, template, fallbackHook }) => {
    const t = await (await fetch('/api/admin/promo/posts', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: template }),
    })).json().catch(() => ({}));
    // ХУК ВСЕГДА НАШ (07.08, брак девочки26: фабричный хук печатается на кадре, а я накладывал
    // свой поверх — вышел текст поверх текста). Фабричный текст берём только как аварийный:
    // свой пул уже отфильтрован от «попросила ИИшку» и прочих упоминаний нейросети в лоб.
    let hookText = fallbackHook;
    if (hookText.length < 20 || hookText.length > 140) {
      hookText = String(t.hookText || t.hook || '').trim();
    }
    const captionText = t.captionText || t.caption || '';
    const r = await fetch('/api/admin/promo/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customPhotoUrl: refUrl, templateId: template, hookText, captionText }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { id: j.id || j.postId || (j.post && j.post.id), hook: hookText, cap: captionText }
                : { err: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
  }, { refUrl, template, fallbackHook });
  if (!res || res.err || !res.id) throw new Error(`фабрика не приняла заказ: ${(res && res.err) || 'нет id'}`);
  return res;
}

// Ожидание готовности заказа. Заказы отдаём пачкой ДО ожидания: фабрика рендерит их
// параллельно, а последовательное «заказал-дождался-заказал» удваивало время поста
// (претензия начальника «очень долго» 06.08).
async function waitOrder(page, id, what = 'заказ') {
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    await sleep(6000);
    // СЕРДЦЕБИЕНИЕ ФАЗЫ ОПРОСА (07.08): без него ожидание рендера снаружи выглядит как висяк, и
    // именно в этой фазе прошлый залп простоял, пока чат докладывал прогресс, которого не было.
    wd.poke(`жду рендер ${what} ${String(id).slice(0, 8)}, опрос ${i + 1} из 100`);
    const p = await page.evaluate(async (id) => {
      const r = await fetch('/api/admin/promo/posts');
      if (!r.ok) return null;
      const x = ((await r.json()).posts || []).find((z) => z.id === id);
      return x ? { st: x.status, urls: x.imageUrls || [] } : null;
    }, id);
    if (p && p.st === 'done' && p.urls.length >= 3) return { urls: p.urls };
    if (p && p.st === 'error') throw new Error('рендер фабрики упал');
  }
  throw new Error(`таймаут рендера фабрики (${what} ${String(id).slice(0, 8)}, 10 мин опроса)`);
}

// Скачивание кадра ВСЕГДА с таймаутом (07.08): fetch без сигнала к r2.dev ждёт бесконечно.
const grab = (url, out) => fetchToFile(url, out, { what: 'кадр', ms: 90000, min: 20000 });

(async () => {
  if (!PERSONA || !TEMPLATE) { console.log('usage: node factorypost.cjs <Имя> <img-шаблон>'); process.exit(1); }
  const ref = path.join(__dirname, 'refs', `${PERSONA}.jpg`);
  if (!fs.existsSync(ref)) { console.log(`ИТОГ: ✗ нет референса ${ref}`); process.exit(1); }
  // Имя файлов с PID: две параллельные сборки одной персоны писали в ОДНИ /tmp-файлы и
  // подменяли друг другу кадры (06.08: у постов Дарьи и Полины совпали кадры побитово).
  const tag = `${PERSONA.toLowerCase()}_${TEMPLATE.replace('img-', '')}_${process.pid}`;

  if (USE_LOCK) await takeLock();
  // Статичный хром начальника: работаем СВОЕЙ вкладкой в постоянном окне, браузер не трогаем.
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  let files = [], urls = [], hook = '';
  // ПОДПИСЬ считается ОДИН РАЗ и идёт И в базу, И в ТГ-карточку. ЖЕЛЕЗНОЕ ПРАВИЛО начальника
  // 06.08: текст на кадре 1 (хук) и подпись/заголовок ВСЕГДА РАЗНЫЕ; в карточку хук не слать.
  // СЧИТАЕМ ПОСЛЕ ЗАКАЗА (07.08): здесь стояло postCaption(TEMPLATE, { hook }) ДО того, как hook
  // получен от фабрики, то есть в отсев подписи всегда уходила пустая строка и правило «подпись
  // не равна хуку» проверяло воздух.
  let capText = postCaption(TEMPLATE);
  try {
    wd.stage('открываю админку и заливаю референс');
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const b64 = fs.readFileSync(ref).toString('base64');
    const refUrl = await page.evaluate(async ({ b64, name }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
      const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error('референс не залился');
      return j.url;
    }, { b64, name: `ref_${PERSONA}.jpg` });

    // ОДИН заказ на пост (начальник 06.08: «какого хуя по 2 генерации на 1 девочку»).
    // 4-й кадр собираем локальным мокапом телефона из арта — бесплатно. Старый режим с двумя
    // заказами остался за флагом TWO_ORDERS=1 (для шаблонов, где мокап не к месту).
    // Для трендовых шаблонов второй заказ ЗАПРЕЩЁН: это независимая генерация, и лицо на ней
    // другое (06.08 проверка агентом: у Дарьи и Полины в одном посте оказалось ТРИ девушки).
    // 4-й кадр только своим мокапом из нашего же арта, там лицо гарантированно совпадает.
    // Тренд опознаёт КОНТРАКТ: поиск подстроки «heart» не видел старый шаблон hearts-trend, и на
    // нём второй заказ был разрешён, то есть в один пост могли попасть два разных лица.
    const twoOrders = process.env.TWO_ORDERS === '1' && !TPL.isHearts(TEMPLATE);
    console.log(`${PERSONA}/${TEMPLATE}: ${twoOrders ? 'заказы 1 и 2' : 'ОДИН заказ'} на фабрике`);
    wd.stage('отдаю заказ на фабрику');
    const oa = await placeOrder(page, refUrl, TEMPLATE);
    const ob = twoOrders ? await placeOrder(page, refUrl, TEMPLATE) : null;
    const a = { ...(await waitOrder(page, oa.id, 'заказ 1')), hook: oa.hook, cap: oa.cap };
    const b = ob ? await waitOrder(page, ob.id, 'заказ 2') : null;
    hook = a.hook || '';
    capText = postCaption(TEMPLATE, { hook });
    wd.stage('фабрика отдала кадры, скачиваю');

    const f1 = await grab(a.urls[0], `/tmp/fp_${tag}_1src.jpg`);
    const f2 = await grab(a.urls[1], `/tmp/fp_${tag}_2src.jpg`);
    const f3 = await grab(a.urls[2], `/tmp/fp_${tag}_3src.jpg`);

    // Кадр 1 приходит от фабрики УЖЕ с нашим хуком (мы передали его в заказ), поэтому сверху
    // ничего не рисуем: иначе получается текст поверх текста, как на забракованной девочке26.
    const s1 = to45(f1, `/tmp/fp_${tag}_1.jpg`);
    // Инфографика ВЫШЕ 4:5 — вписываем целиком; арт и фото наоборот кропаем.
    // РАНЬШЕ здесь стояло бинарное деление /heart/i: «сердечки значит арт, всё остальное значит
    // инфографика». Из-за него КАЖДЫЙ не-сердечковый шаблон обрабатывался как карточка, и живой
    // арт (чб сквозь пальцы, двойная экспозиция, ретро) вписывался с полями вместо кропа.
    // Теперь спрашиваем контракт: что именно лежит на втором кадре этого шаблона.
    // ПОЛЯ НЕ БЕЛЫЕ (09.08): to45fit рисует белый letterbox, а белых полей по краям быть не должно.
    // to45smart вписывает карточку с полями ПОД ЦВЕТ её бумаги, а фото режет без полей вообще.
    const s2 = to45smart(f2, `/tmp/fp_${tag}_2.jpg`, { topBias: TPL.frame2Kind(TEMPLATE) === 'card' });
    const s3 = to45(f3, `/tmp/fp_${tag}_3.jpg`);
    // ЧЕТВЁРТЫЙ КАДР = ОБЫЧНОЕ ФОТО ПЛЮС ФИРМЕННОЕ ОПИСАНИЕ (стандарт начальника 07.08:
    // «заказываем 3 фото у фабрики, 4-ю рисуем: накладываем описание фирменное на обычную фотку,
    // НЕ телефон»). Мокап телефона здесь больше не используем: он читался рисованным, а на
    // сгенерированном варианте движок вообще подставлял чужие картинки на экран.
    let s4raw;
    if (b) {
      const f4 = await grab(b.urls[2], `/tmp/fp_${tag}_4src.jpg`);
      s4raw = to45(f4, `/tmp/fp_${tag}_4raw.jpg`);
    } else {
      // ЧЕТВЁРТЫЙ КАДР ЭТО ОБЫЧНОЕ ФОТО, А НЕ ТЕЛЕФОН (07.08). Берём ИСХОДНЫЙ кадр начальника из
      // refs, а не первый фабричный: на фабричном уже НАПЕЧАТАН хук, и поверх него фирменный блок
      // давал текст поверх текста (брак девочки30). Исходник чистый, поэтому перекадрируем его
      // (другой зум, поворот, центр) и кладём блок на пустое место.
      // Берём АРТ (второй кадр), перекадрируем и кладём блок: на первом кадре уже напечатан хук,
      // а исходное фото давало дубль обложки (приказ 07.08: «меняй 2 фото под 4 кадр, а не 1»).
      s4raw = reframe(s2, `/tmp/fp_${tag}_4raw.jpg`, `${PERSONA}_4`);
    }
    const s4 = (await ctaSlide(s4raw, `/tmp/fp_${tag}_4.jpg`, { seed: tag })).out || `/tmp/fp_${tag}_4.jpg`;
    files = [s1, s2, s3, s4];
    console.log(`${PERSONA}: 1 фото+хук · 2 инфографика · 3 результат · 4 фото + фирменное описание`);

    // ГЕЙТ ОБЛОЖКИ (06.08, ревизия начальника: один и тот же кадр стоял на 6 постах). Заглавная
    // фотка живёт ровно в одном посте, поэтому повтор ловим ДО заливки: залитый кадр уже мусор
    // в R2, а пост со старой обложкой всё равно пойдёт под нож. Сверка по ПИКСЕЛЯМ: у каждой
    // заливки свой uuid, поэтому проверка по ссылке повтора не видела.
    const cu = await coverUsed(s1, PERSONA);
    // Подсказка про чужую персону: иначе id поста ищут в постах этой девочки и не находят.
    if (cu.used && cu.crossPersona) console.log(`  ⚠ обложка занята другой персоной (${cu.persona})`);
    if (cu.used) throw new Error(`ГЕЙТ: обложка уже использована в посте ${String(cu.postId).slice(0, 8)}, нужен другой кадр`);
    console.log(`  ✓ обложка новая (ближайшая чужая на ${cu.dist} бит из 256)`);

    wd.stage('заливаю 4 кадра в хранилище');
    for (const f of files) {
      const b64f = fs.readFileSync(f).toString('base64');
      urls.push(await page.evaluate(async ({ b64f, name }) => {
        const bin = Uint8Array.from(atob(b64f), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
        const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error('кадр не залился');
        return j.url;
      }, { b64f, name: path.basename(f) }));
      await sleep(900);
    }
  } finally { wd.poke('отцепляюсь от хрома'); await done(); freeLock(); }

  // ГЕЙТ: тот же, что в своей сборке.
  wd.stage('гейт кадров и валидатор');
  const crypto = require('node:crypto');
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  if (new Set(files.map(md5)).size !== 4) throw new Error('ГЕЙТ: дубли кадров');
  for (const f of files) {
    const st = fs.statSync(f);
    if (st.mtimeMs < START_MS) throw new Error(`ГЕЙТ: старый файл ${f}`);
  }
  console.log('  ✓ гейт кадров пройден');

  let verdict = 'unknown', problems = [];
  try {
    const V = require('./validatepost.cjs');
    // frame4Art: кадр 4 у нас это кадр 2 в другом кадрировании плюс фирменный блок, и валидатор
    // обязан знать, что это задумано, иначе рубит пост как дубль (девочки 36, 37, 40, 43 07.08).
    const vr = await V.validateCarousel(files, { template: TEMPLATE, frame4Art: true });
    verdict = vr.verdict; problems = vr.problems || [];
    console.log(`  проверка: ${verdict}${problems.length ? ' — ' + problems.slice(0, 2).join('; ') : ''}`);
  } catch (e) { console.log('  ⚠ валидатор не отработал: ' + String(e.message).slice(0, 60)); }

  wd.stage('кладу пост на склад');
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  // ЗАКРЫТИЕ СОЕДИНЕНИЯ ГАРАНТИРОВАНО (07.08): живой сокет pg держит event loop так же, как
  // сокет playwright, то есть незакрытая база это ещё один способ повиснуть с готовой работой.
  process.on('exit', () => { try { c.end(); } catch {} });
  await c.connect();
  // Привязываем пост к акку СВОЕЙ модели (06.08): раньше был ORDER BY random(), и посты
  // расползались по чужим аккам, ломая легенду. Если своего акка нет, вешаем на любой живой,
  // но публиковать его планировщик не даст: там жёсткий гейт персоны.
  const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
    AND deleted_at IS NULL AND slug NOT LIKE 'FOL%'
    ORDER BY (persona = $1) DESC, random() LIMIT 1`, [PERSONA])).rows[0];
  if (!acc) { await c.end(); throw new Error('нет живого аккаунта'); }
  const ins = await c.query(
    `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
     VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
    [acc.id, capText, urls[0], 'https://neironka.pro',
     JSON.stringify({ template: TEMPLATE, persona: PERSONA, image_urls: urls,
       frame4: true, refit4: true, cleanplate: true, factory_build: true,
       validation: { verdict, problems, at: new Date().toISOString() } }),
     verdict === 'reject' ? 'rejected' : 'backlog']);
  const id = ins.rows[0].id;
  await c.end();
  // Обложку закрепляем за постом сразу: следующий прогон обязан её отбить. Брак (rejected)
  // кадр НЕ занимает, такую обложку можно переиспользовать. Сбой записи не рушит уже созданный
  // пост: coverUsed докачает эту обложку из базы на следующем прогоне.
  if (verdict !== 'reject') {
    try { registerCover(files[0], PERSONA, id); }
    catch (e) { console.log('  ⚠ обложка не записалась в журнал: ' + String(e.message).slice(0, 60)); }
  }
  console.log(`ИТОГ: ${verdict === 'reject' ? '⛔ БРАК' : '✅'} ${PERSONA}/${TEMPLATE} — пост ${String(id).slice(0, 8)}`);
  if (verdict !== 'reject') {
    wd.stage('карточка в телеграм');
    try {
      execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
        '--key', String(id), '--persona', PERSONA, '--type', TEMPLATE.replace('img-', '') + ' · фабрика',
        '--template', TEMPLATE, '--note', capText], { cwd: __dirname, encoding: 'utf8', stdio: 'inherit',
        timeout: 4 * 60000 });
    } catch { console.log('  ⚠ в ТГ не ушло'); }
  }
  // ЯВНЫЙ ВЫХОД: после CDP живут сокеты playwright и нода сама не завершается (инцидент 07.08).
  wd.done(0);
})().catch((e) => { freeLock(); wd.fail(e); });
