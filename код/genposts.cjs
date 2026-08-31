// ЗАКАЗ ФОТОПОСТОВ НА ФАБРИКЕ (neironka.pro/admin/promo) → ЗАПАС В ПОСТЕРЕ.
//
// Зачем: владелец жмёт в панели «сгенерировать 1/2/3/10 постов» под девочку, и у нас копится
// склад готового контента, а не «генерим ровно перед публикацией и молимся».
//
// Почему через браузер, а не curl: админка фабрики закрыта httpOnly-кукой сессии, сервисный ключ
// она не принимает (проверено: 404 и на x-service-key, и на Bearer). Поэтому держим ОТДЕЛЬНЫЙ
// постоянный профиль хрома: владелец логинится в него ОДИН раз, дальше скрипт ходит сам.
// Профиль лежит в ~/.neironka-admin-profile и к ферме IG отношения не имеет (никаких акков там нет).
//
// Контракт фабрики (снят с живых запросов 03.08):
//   PATCH /api/admin/promo/posts  {templateId}                       → {hookText, captionText}
//   POST  /api/admin/promo/posts  {personaId, templateId, hookText, captionText} → создаёт задание
//   GET   /api/admin/promo/posts                                     → {posts:[{id,status,stage,
//            imageUrls,personaId,templateId,error,providerCostKopecks}]}
//   статусы: queued/rendering → done | error. imageUrls — 3 картинки на публичном R2.
//
// Что кладём в БД: посты со status='backlog' (склад). Это НЕ 'draft': черновики всплывают у
// владельца в «Черновики на одобрение», а склад должен лежать тихо, пока его не запланируют.
// Уникализация НЕ здесь: сид фотоуникализатора привязан к аккаунту, поэтому картинки прогоняются
// в момент, когда пост встаёт на конкретный акк (иначе два акка получат одинаковые пиксели).
//
// Запуск:  node genposts.cjs <персона> <сколько> [templateId]
//          node genposts.cjs Полина 3
//          node genposts.cjs Дарья 2 img-haircut-match
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');
// Контракт шаблонов: отсюда читаем disabled. Свой список групп ниже это ПОДБОРКА для ротации,
// а правда о том, жив ли шаблон, живёт только в templates.cjs.
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const BASE = 'https://neironka.pro';
const LOGIN_WAIT_MS = 5 * 60 * 1000;    // сколько ждём, пока владелец залогинится в открытом окне
const RENDER_WAIT_MS = 15 * 60 * 1000;  // фабрика рисует 3 картинки, это небыстро
const ORDER_GAP_MS = 4000;              // не долбим фабрику залпом

// Шаблоны, которые реально заходят на женской аудитории (вирусные тренды с «примерь на себя»).
// Ротируем их, чтобы лента одной девочки не выглядела как один и тот же пост в цикле.
// ГРУППЫ ШАБЛОНОВ. На фабрике их под шестьдесят, и добрая половина не про девушку вовсе:
// еда в стиле Minecraft, карточки для маркетплейса, фасады домов, логотипы. Такое в ленту модели
// попадать не должно — поэтому берём не «все подряд», а нужную группу (просьба владельца 03.08).
const TEMPLATE_GROUPS = {
  // БЬЮТИ — ядро: разборы внешности, то, что женская аудитория примеряет на себя и просит повторить.
  beauty: [
    'img-face-report',       // оценка привлекательности
    'img-makeup-colortype',  // макияж по цветотипу
    'img-nose-verdict',      // твой носик
    'img-beauty-guide',      // бьюти-гайд по фото
    'img-haircut-match',     // какая стрижка идёт
    'img-boyfriend-match',   // парень по типажу
    // «ТВОЙ ЛУЧШИЙ РАЗМЕР» ДОБАВЛЕН 15.08. Владелец назвал его одним из ТРЁХ основных шаблонов
    // фермы — а он не входил НИ В ОДНУ группу, то есть генератор не заказывал его ни разу.
    // Описан в templates.cjs:112 давно, промпт рабочий, но из ротации выпадал молча: списки групп
    // и карта шаблонов живут в разных файлах и никем не сверялись. Ровно та же болезнь, что у
    // pixar-3d, только тот хотя бы лежал в looks. Ставим в бьюти: по жанру это такой же
    // постер-разбор «примерь на себя», как гайд и носик.
    'img-new-forms',         // твой лучший размер
  ],
  // ФОТО — красивые съёмки той же девушки: держат ленту живой между разборами.
  photo: [
    'img-canon-g7x',         // фото как на Canon G7X
    'img-retro-90s',         // плёнка 90-х
    'img-magazine-cover',    // обложка глянца
    'img-bw-editorial',      // чёрно-белый портрет
    'img-golden-portrait',   // портрет в золотой час
    'img-double-exposure',   // двойная экспозиция
    'img-bw-fingers',        // взгляд сквозь пальцы
    'img-flower-cloud',      // в облаке букетов
  ],
  // ОБРАЗЫ — стилизации в персонажа: заходят как развлечение, но лицо меняется, поэтому
  // держим их отдельно и подмешиваем реже.
  looks: [
    'img-winx-fairy', 'img-anime', 'img-pixar-3d', 'img-popart',
    'img-fantasy-char', 'img-sketch-collage', 'img-gta',
  ],
};
// ОБРАЗЫ ВКЛЮЧЕНЫ В РОТАЦИЮ (15.08, прямой ответ владельца «включай всю» на вопрос, брать ли
// группу looks целиком).
//
// ЗАЧЕМ. В ту же ночь он назвал ТРИ ОСНОВНЫХ шаблона фермы: аниме-портрет, 3D-мультяшный
// (pixar-3d) и «твой лучший размер». Первые два лежат ровно здесь, в looks. А looks в ротацию не
// входил — строка была «бьюти + фото», и комментарий рядом честно писал «образы владелец включает
// явно». Явно их не включали НИ РАЗУ: владелец спрашивал, почему не видит 3D-мультяшных постов, и
// ответ был не «шаблона нет» (он есть, с фабричным промптом), а «группа не заказывалась».
// То есть два будущих главных шаблона фермы полгода лежали мёртвым грузом из-за одной строки.
//
// ЧТО НАДО ЗНАТЬ ПРО ЭТУ ГРУППУ. Стилизации меняют лицо сильнее прочих, и два её шаблона имеют
// известный брак: у аниме промпт печатается прямо на кадре (гейт этого не ловит — textguard не
// смотрит середину кадра, а «отдел качества», которому он делегирует такие надписи, не
// существует), у феи в одном посте выходят два разных персонажа. Владелец включил группу целиком,
// зная про это; брак чиним, а не прячем отключением.
const GIRL_TEMPLATES = [...TEMPLATE_GROUPS.beauty, ...TEMPLATE_GROUPS.photo, ...TEMPLATE_GROUPS.looks];
// ЯДРО ЛЕНТЫ — бьюти-гайд. Решение владельца 03.08: он идёт КАЖДЫЙ ДЕНЬ, остальное вокруг него.
// Чтобы ежедневный пост не выглядел копиркой, фабрике каждый раз нужен другой опорный кадр —
// это обеспечивают фото-шаблоны, которые рисуют модель в новой одежде и локации.
const DAILY_CORE = 'img-beauty-guide';
// Шаблоны, дающие стабильный брак, в ротацию не берём (перепроверяются вручную).
const BROKEN = new Set(String(process.env.BROKEN_TEMPLATES || 'img-haircut-match').split(',').filter(Boolean));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ОЧЕРЕДЬ НА ПРОФИЛЬ. Профиль Chrome — ресурс на одного: второй процесс с тем же каталогом просто
// присоединяется к чужому окну и падает («Opening in existing browser session»). Раньше это
// выглядело как «перегенерация молча не сработала». Теперь ждём своей очереди честно.
const LOCK = '/tmp/genposts.lock';
async function takeLock(waitMs = 20 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    // PID с переводом строки (13.08): cat по нескольким замкам слипал номера в кашу, и проверка
    // «держит ли процесс замок» молча ошибалась. Сегодня за это убили две работавшие сборки.
    try { fs.writeFileSync(LOCK, `${process.pid}\n`, { flag: 'wx' }); return; }
    catch {
      // Лок от умершего процесса снимаем сами, иначе один упавший запуск блокирует всё навсегда.
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false;
      // pid ноль или мусор это не живой держатель: kill(0, 0) сигналит своей же группе процессов
      // и всегда отвечает «жив», пустой файл замка держал бы очередь до протухания.
      try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch {}
      // Лок держит СМОТРИТЕЛЬ окна (правило начальника 06.08: хром с нейронкой всегда открыт,
      // когда конвейер свободен) — просим его уступить и ждём.
      try { if (String(pid) === fs.readFileSync('/tmp/genkeeper.pid','utf8').trim()) fs.writeFileSync('/tmp/genkeeper.stop',''); } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      // TTL: генерация не живёт дольше 45 минут, всё старше = зависший лок (06.08 конвейер
      // дважды вставал из-за вечного лока после жёсткого убийства процесса).
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('не дождался освобождения профиля (20 мин)');
      console.log(`  ⏳ профиль занят процессом ${pid}, жду…`);
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

// Открывает админку в постоянном профиле. Если сессии нет — просит владельца войти и ждёт.
async function openAdmin() {
  await takeLock();
  // playwright-core без своих браузеров, поэтому берём системный Chrome. Профиль — ОТДЕЛЬНЫЙ
  // каталог: личный профиль владельца не трогаем (и не блокируем ему браузер).
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find((p) => fs.existsSync(p));
  if (!CHROME) throw new Error('не нашёл Chrome, задай CHROME_BIN');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: CHROME,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`${BASE}/admin/promo`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const authed = async () => page.evaluate(async () => {
    try { const r = await fetch('/api/admin/promo/posts'); return r.status === 200; } catch { return false; }
  });

  if (!(await authed())) {
    console.log('\n  ⚠ НУЖЕН ВХОД: в открывшемся окне войди в админку neironka.pro.');
    console.log('    Это делается ОДИН раз, дальше профиль помнит сессию. Жду до 5 минут…\n');
    const until = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < until) {
      await sleep(5000);
      if (await authed()) { console.log('  ✓ вход есть, продолжаю'); break; }
    }
    if (!(await authed())) { await ctx.close(); throw new Error('не дождался входа в админку'); }
  }
  return { ctx, page };
}

// id личности на фабрике по имени (Полина/Дарья/…). Имена там совпадают с accounts.persona.
async function personaId(page, name) {
  const list = await page.evaluate(async () => {
    const r = await fetch('/api/admin/promo');
    if (!r.ok) return null;
    const j = await r.json();
    return j.personas || j.items || j;
  });
  const arr = Array.isArray(list) ? list : (list && list.personas) || [];
  const hit = arr.find((p) => String(p.name || p.title || '').toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`на фабрике нет личности «${name}» (есть: ${arr.map((p) => p.name).join(', ')})`);
  return hit.id;
}

// Один заказ: сначала просим фабрику написать текст под шаблон, потом ставим пост в рендер.
async function orderOne(page, pid, templateId) {
  return page.evaluate(async ({ pid, templateId }) => {
    const patch = await fetch('/api/admin/promo/posts', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId }),
    });
    if (!patch.ok) return { error: `текст: HTTP ${patch.status}` };
    const t = await patch.json();
    const hookText = t.hookText || t.hook || '';
    const captionText = t.captionText || t.caption || '';
    if (!hookText && !captionText) return { error: 'фабрика не вернула текст' };

    const post = await fetch('/api/admin/promo/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: pid, templateId, hookText, captionText }),
    });
    if (!post.ok) return { error: `заказ: HTTP ${post.status}` };
    const j = await post.json().catch(() => ({}));
    return { id: j.id || j.postId || (j.post && j.post.id) || null, hookText, captionText };
  }, { pid, templateId });
}

// Ждём, пока заказанные задания дорисуются. Возвращаем только те, что реально дали картинки.
async function waitDone(page, ids) {
  const left = new Set(ids);
  const done = [];
  const until = Date.now() + RENDER_WAIT_MS;
  let lastNote = '';
  while (left.size && Date.now() < until) {
    const posts = await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo/posts');
      return r.ok ? (await r.json()).posts || [] : [];
    });
    for (const p of posts) {
      if (!left.has(p.id)) continue;
      if (p.status === 'done' && Array.isArray(p.imageUrls) && p.imageUrls.length) {
        left.delete(p.id); done.push(p);
        console.log(`  ✓ готов ${p.id.slice(0, 8)} · ${p.imageUrls.length} фото · ${(p.providerCostKopecks || 0) / 100} ₽`);
      } else if (p.status === 'error') {
        left.delete(p.id);
        console.log(`  ✗ ошибка ${p.id.slice(0, 8)}: ${p.error || 'без причины'}`);
      } else {
        const note = `${p.id.slice(0, 8)}: ${p.stage || p.status}`;
        if (note !== lastNote) { console.log(`  … ${note}`); lastNote = note; }
      }
    }
    if (left.size) await sleep(10000);
  }
  if (left.size) console.log(`  ⚠ не дождался ${left.size} шт. (лежат в рендере, подберём следующим запуском)`);
  return done;
}

// Кладём готовое на склад. Аккаунт: основной живой акк модели — чтобы пост был готов к планированию.
async function toBacklog(db, persona, posts) {
  // Лесенка фолбэков: живой основной → любой живой → любой акк модели. account_id NOT NULL,
  // поэтому «без привязки» не бывает — а публикация всё равно перепланирует акк по здоровью.
  const acc = await db.query(
    `SELECT id, coalesce(ig_login,slug) h FROM accounts
      WHERE persona=$1 AND deleted_at IS NULL
      ORDER BY (session_status='live' AND is_spare=false) DESC, (session_status='live') DESC,
               acc_no NULLS LAST LIMIT 1`, [persona]);
  const a = acc.rows[0];
  if (!a) { console.log(`  ✗ у «${persona}» вообще нет акков — склад некуда писать`); return { added: 0, handle: null }; }

  let n = 0, rejected = 0;
  for (const p of posts) {
    // Дедуп: одно задание фабрики = один пост на складе, повторный запуск не плодит копии.
    const dup = await db.query(`SELECT 1 FROM posts WHERE meta->>'factory_id'=$1 LIMIT 1`, [p.id]);
    if (dup.rowCount) continue;

    // ПРОВЕРКА ДО СКЛАДА. Смысл склада — «бери и постись», поэтому брак сюда попадать не должен:
    // 03.08 из 23 постов фабрики 4 оказались с битым текстом и подменой лица. Забракованное
    // кладём со статусом rejected — видно, за что заплатили, и есть что перезаказать.
    let vr = { verdict: 'unknown', problems: [] };
    if (process.env.VALIDATE_OFF !== '1') {
      try { vr = await require('./validatepost.cjs').validateCarousel(p.imageUrls, { template: p.templateId }); }
      catch (e) { vr = { verdict: 'unknown', problems: [String(e.message).slice(0, 80)] }; }
      if (vr.verdict === 'reject') {
        console.log(`  ⛔ брак, на склад НЕ кладу: ${p.templateId} — ${(vr.problems || []).slice(0, 2).join('; ')}`);
        rejected++;
      }
    }
    // Хештег с именем модели: по нему собирается её собственная лента и подписчики находят
    // остальные посты. Ставим последним и только если фабрика его ещё не проставила.
    const nameTag = `#${String(persona).toLowerCase().replace(/\s+/g, '')}`;
    let caption = [p.hookText, p.captionText].filter(Boolean).join('\n\n');
    // «тутор в закрепе» отсылает в пустоту: закрепа у этих акков нет, и фраза выглядит рекламной.
    // «кому сделать?)» зовёт писать в комменты — это и есть нужное нам действие (решение владельца).
    caption = caption.replace(/тутор в закрепе/gi, 'кому сделать?)');
    if (!caption.toLowerCase().includes(nameTag)) caption = `${caption} ${nameTag}`.trim();
    // Брак пишем как 'rejected': на складе лежит только то, что можно брать и постить не глядя.
    await db.query(
      `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
       VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb)`,
      [a ? a.id : null, caption, p.imageUrls[0], 'https://neironka.pro',
       JSON.stringify({
         factory_id: p.id, template: p.templateId, image_urls: p.imageUrls, persona,
         validation: { verdict: vr.verdict, problems: vr.problems || [], checks: vr.checks || null, at: new Date().toISOString() },
       }),
       vr.verdict === 'reject' ? 'rejected' : 'backlog']);
    if (vr.verdict !== 'reject') n++;
  }
  return { added: n, handle: a ? a.h : null };
}

// Подбор трендов для девочки: сначала те, которыми её ещё НЕ постили. Лента должна быть разной,
// а не одним шаблоном в цикле.
async function pickTemplates(db, persona, count, forced, group) {
  // ВЫКЛЮЧЕННЫЕ КОНТРАКТОМ ШАБЛОНЫ НЕ ЗАКАЗЫВАЕМ НИКОГДА (13.08). Флаг disabled в templates.cjs
  // до этого дня не читал ни один раздатчик: обложку журнала выключили 12.08 за подмену лица, а
  // ротация здесь продолжала её брать, то есть «выключен» существовал только на бумаге. Явный
  // шаблон руками тоже не пропускаем: «выключен» значит выключен, включение делается в контракте.
  if (forced && TPL.isDisabled(forced)) {
    throw new Error(`шаблон «${forced}» выключен в контракте (disabled: true), заказывать его нельзя`);
  }
  if (forced) return Array.from({ length: count }, () => forced);
  const used = await db.query(
    `SELECT meta->>'template' t, count(*) n FROM posts
      WHERE meta->>'persona'=$1 AND meta ? 'template' GROUP BY 1`, [persona]);
  const usedN = new Map(used.rows.map((r) => [r.t, Number(r.n)]));
  // group: beauty | photo | looks | all. По умолчанию бьюти+фото — то, что подходит модели.
  const base = group && group !== 'all'
    ? (TEMPLATE_GROUPS[group] || GIRL_TEMPLATES)
    : (group === 'all' ? Object.values(TEMPLATE_GROUPS).flat() : GIRL_TEMPLATES);
  const pool = base.filter((t) => !BROKEN.has(t) && !TPL.isDisabled(t))
    .sort((a, b) => (usedN.get(a) || 0) - (usedN.get(b) || 0));
  const выключено = base.filter((t) => TPL.isDisabled(t));
  if (выключено.length) console.log(`  → выключены контрактом и в ротацию не идут: ${выключено.join(', ')}`);
  if (!pool.length) throw new Error(`в группе «${group || 'по умолчанию'}» не осталось рабочих шаблонов`);
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}

(async () => {
  // Персон можно передать несколько через запятую: заказы уходят на фабрику ПОДРЯД и рисуются
  // параллельно, ждём потом всех разом. Так 4 девочки × 5 постов = один проход, а не четыре.
  const personas = String(process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const count = Math.max(1, Math.min(10, Number(process.argv[3] || 1)));
  // --group beauty|photo|looks|all — какую группу шаблонов брать (по умолчанию бьюти+фото).
  const gi = process.argv.indexOf('--group');
  const group = gi > 0 ? String(process.argv[gi + 1] || '').trim() : '';
  // Явный шаблон четвёртым аргументом (только если это не флаг).
  const a4 = process.argv[4];
  const forced = a4 && !a4.startsWith('--') ? a4 : null;
  const collectOnly = process.argv.includes('--collect');   // не заказывать, только забрать готовое
  if (!personas.length) { console.error('как звать: node genposts.cjs <персона[,персона…]> <1..10> [templateId] [--collect]'); process.exit(1); }

  const db = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const { ctx, page } = await openAdmin();
  try {
    const byId = new Map();     // id задания → персона, чтобы разложить готовое по девочкам
    const ids = [];

    if (!collectOnly) {
      for (const persona of personas) {
        const pid = await personaId(page, persona);
        const tpls = await pickTemplates(db, persona, count, forced, group);
        console.log(`\nЗАКАЗ: ${persona} × ${count}`);
        for (const [i, tpl] of tpls.entries()) {
          const r = await orderOne(page, pid, tpl);
          if (r.error || !r.id) { console.log(`  ✗ ${i + 1}/${count} (${tpl}): ${r.error || 'фабрика не вернула id'}`); continue; }
          console.log(`  → ${i + 1}/${count} · ${tpl} · ${r.id.slice(0, 8)}`);
          ids.push(r.id); byId.set(r.id, persona);
          await sleep(ORDER_GAP_MS);
        }
      }
      if (!ids.length) throw new Error('ни один заказ не прошёл');
    } else {
      // Режим сбора: подбираем всё готовое, чего ещё нет на складе.
      const posts = await page.evaluate(async () => {
        const r = await fetch('/api/admin/promo/posts');
        return r.ok ? (await r.json()).posts || [] : [];
      });
      const names = await page.evaluate(async () => {
        const r = await fetch('/api/admin/promo');
        const j = r.ok ? await r.json() : {};
        return (j.personas || []).map((p) => [p.id, p.name]);
      });
      const nameById = new Map(names);
      for (const p of posts) {
        const who = nameById.get(p.personaId);
        if (!who || !personas.includes(who)) continue;
        if (p.status !== 'done' || !(p.imageUrls || []).length) continue;
        const dup = await db.query(`SELECT 1 FROM posts WHERE meta->>'factory_id'=$1 LIMIT 1`, [p.id]);
        if (dup.rowCount) continue;
        ids.push(p.id); byId.set(p.id, who);
      }
      console.log(`СБОР: нашёл ${ids.length} готовых, которых ещё нет на складе`);
      if (!ids.length) { console.log('ИТОГ: собирать нечего'); return; }
    }

    console.log('\nЖДУ РЕНДЕР…');
    const done = await waitDone(page, ids);

    // Раскладываем готовое по девочкам и пишем на склад.
    let total = 0, spent = 0;
    for (const persona of personas) {
      const mine = done.filter((p) => byId.get(p.id) === persona);
      if (!mine.length) { console.log(`ИТОГ: ${persona} — пусто`); continue; }
      const res = await toBacklog(db, persona, mine);
      // В ТГ-группу «Traffic» — готовые карусели с номером, подписью и тегами (правило владельца).
      // ТОЛЬКО ГОДНЫЕ: раньше слали всё подряд, и владелец видел в группе забракованные посты как
      // готовые к работе. И подпись берём ФИНАЛЬНУЮ (с хештегом модели и «кому сделать?)»),
      // а не сырой текст фабрики — из группы её копируют и постят руками.
      // Тянем и id поста в базе: он идёт в tgsend как --key. Без ключа дедуп ТГ опирался только
      // на кадры, и один и тот же пост из повторного прогона уходил в группу второй раз (06.08).
      const okRows = (await db.query(
        `SELECT id::text AS id, meta->>'factory_id' fid, caption FROM posts
          WHERE meta->>'persona'=$1 AND status='backlog' AND meta ? 'factory_id'`, [persona])).rows;
      const okIds = new Set(okRows.map((r) => r.fid));
      const postIdByFid = new Map(okRows.map((r) => [r.fid, r.id]));
      const finalCaption = new Map((await db.query(
        `SELECT meta->>'factory_id' fid, caption FROM posts WHERE meta ? 'factory_id'`)).rows.map((r) => [r.fid, r.caption]));
      for (const p of mine.filter((x) => okIds.has(x.id))) {
        try {
          const dir = `/tmp/tgpack/${p.id.slice(0, 8)}`; fs.mkdirSync(dir, { recursive: true });
          const files = [];
          for (const [i, u] of p.imageUrls.entries()) {
            const f = path.join(dir, `${i + 1}.jpg`);
            if (!fs.existsSync(f)) { const rr = await fetch(u); fs.writeFileSync(f, Buffer.from(await rr.arrayBuffer())); }
            files.push(f);
          }
          const TOK = fs.existsSync('/tmp/tg_bot.txt') ? fs.readFileSync('/tmp/tg_bot.txt', 'utf8').trim() : '';
          require('node:child_process').execFileSync('node', ['tgsend.cjs', ...files, '--carousel',
            '--key', String(postIdByFid.get(p.id) || p.id),
            '--persona', persona, '--type', p.templateId,
            '--note', (finalCaption.get(p.id) || [p.hookText, p.captionText].filter(Boolean).join('\n')).slice(0, 900)],
            { cwd: __dirname, env: { ...process.env, TELEGRAM_BOT_TOKEN: TOK, TELEGRAM_CHAT_ID: (fs.existsSync('/tmp/.tgchat') ? fs.readFileSync('/tmp/.tgchat','utf8').trim() : '-5433303637') }, stdio: 'ignore' });
        } catch (e) { console.log(`  ⚠ ТГ не отправился (${String(e.message).slice(0, 60)}) — пост на складе, отправка не критична`); }
      }
      const cost = mine.reduce((s, p) => s + (p.providerCostKopecks || 0), 0) / 100;
      total += res.added; spent += cost;
      console.log(`ИТОГ: ${persona} — на склад ${res.added}/${mine.length}${res.handle ? ` (акк @${res.handle})` : ''}, ${cost} ₽`);
    }
    console.log(`\nВСЕГО на склад ${total} пост(ов), потрачено ${spent} ₽`);
  } finally {
    await ctx.close().catch(() => {});
    await db.end().catch(() => {});
  }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
