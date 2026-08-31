// SMARTRUN — комментинг по правилу «аккаунт-расходник + быстрый фейловер по постам».
// Каждый акк идёт по ПРИОРИТЕТНОМУ списку постов: не может закомментить на посту (блок/шб-подозрение/0 за FAILFAST)
// → берёт следующий пост; 2 поста подряд мимо → это трабл САМОГО акка (шб/рестрикт) → меняем акк.
// Приоритет: закомментить как можно больше. Параллель по токенам (у каждого свой лимит GoLogin).
// Пишет статистику в account_run_stats для обучения (сколько комментов до трабла в среднем).
//
// Запуск: node smartrun.cjs <DIR>   (DIR/smartjobs.json = {accounts:[slug...], posts:[code...], perPost:5, brandtop:1})
const { spawn } = require('child_process');
const { Client } = require('pg');
const fs = require('fs');
// env сначала (прод), файлы /tmp — фолбэк (локальный мак).
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/orkey.txt', 'utf8').trim();
const API = 'https://api.gologin.com';
const DIR = process.argv[2];
const CFG = JSON.parse(fs.readFileSync(DIR + '/smartjobs.json', 'utf8'));
const POSTS = CFG.posts;                    // приоритетный список кодов постов
const PERPOST = Number(CFG.perPost || 5);   // сколько ответов пытаться на одном посту
const BRANDTOP = CFG.brandtop ? '1' : '';   // ставить ли брендовый топ-коммент
const FAILFAST = String(CFG.failfast || 6); // проходов без коммента → выход с поста
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (c) => 'https://www.instagram.com/p/' + c + '/';
const TARGET = Number(CFG.target || 0);   // глобальный таргет комментов (0 = без лимита); достигли — не запускаем новых
const MAXRETRY = Number(CFG.maxRetry || 2); // ретраи акка на no_connect (транзиентный флап слота ≠ мёртвый акк)
let globalTotal = 0;                       // всего комментов+бренд за заход (для таргета и замера)
let RUN_T0 = 0;                            // старт замера (ставим в main)
const retries = {};                        // slug -> сколько раз переставляли в очередь
const donePairs = new Map();               // "slug|code" → ts последнего захода (акк уже комментил пост; в бэклоге можно повторно после 12ч)
const restrictedPosts = new Set();         // коды постов, где автор ОГРАНИЧИЛ комменты (постить нельзя никому) → скип всем аккам волны
// БЭКЛОГ-ЛОГИКА (2026-07-21): пост, где УЖЕ есть наши комменты → только добор неотвеченного спроса (промпт/гайд),
// БЕЗ бренда, суммарно ≤BACKLOG_CAP ответов на пост в день (10-15 по ТЗ). Новые посты — полный цикл как раньше.
const workedPosts = new Set();             // коды постов, где наши комменты уже стоят (account_post_done)
const backlogToday = {};                   // code → сколько бэклог-ответов пост получил СЕГОДНЯ (кап)
const BACKLOG_CAP = Number(process.env.BACKLOG_CAP || 15); // максимум ответов на отработанный пост в день (env для блиц-режима «максимум на 5 постов»)
const REVISIT_H = Number(process.env.REVISIT_H || 6); // через сколько часов акк ПОВТОРНО заходит на отработанный пост за НОВЫМ спросом (владелец: раз в 6ч проверяем новые комменты)
const DAILYCAP = Number(CFG.dailyCap || 12); // максимум комментов на акк ЗА ДЕНЬ (не за заход) — не жжём акки повторными заходами
const dayCount = {};                       // slug -> сколько акк уже дал комментов сегодня (из account_run_stats + текущий заход)
// БРЕНД-ГЕЙТ (анти-бан): бренд-топ разрешён акку ТОЛЬКО после наработки ответами + редко.
const BRAND_MIN_REPLIES = Number(CFG.brandMinReplies || 10); // порог: ≥N ответов людям за всё время, потом можно промо
const BRAND_COOLDOWN_H = Number(CFG.brandCooldownH || 12);   // кулдаун между бренд-комментами (часы)
const lifeReplies = {};                    // slug -> суммарно ответов людям за всё время (для порога)
const brandLast = {};                      // slug -> Date последнего бренд-коммента (кулдаун)
const brandToday = {};                     // slug -> сколько бренд-комментов уже сегодня (кап 1/день)

let creds = {};
async function loadCreds() {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  // ТОЛЬКО реально-пригодные акки: dead/suspended/challenge/paused не грузим (vcomment метит их по СТРАНИЦЕ,
  // след. проход loadCreds их пропустит; разлогиненных-dead подхватит ЛОГГЕР на релогин — коорд. через session_status).
  const r = await c.query(
    `SELECT a.slug, a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE a.slug = ANY($1) AND a.platform='comments'
       AND coalesce(a.session_status,'')='live'
       AND coalesce(a.ig_status,'') NOT IN ('suspended','challenge','captcha','bad_login','profile_lost','action_block')
       AND coalesce(a.status,'') <> 'paused'
       AND (a.shadow_at IS NULL OR a.shadow_at < now() - interval '2 days')`, [CFG.accounts]);
  for (const x of r.rows) creds[x.slug] = { pid: x.pid, tok: x.tok };
  // таблица обучения
  await c.query(`CREATE TABLE IF NOT EXISTS account_run_stats (
      id bigserial PRIMARY KEY, slug text, comments int, brand int, posts_tried int,
      retire_reason text, elapsed int, ts timestamptz DEFAULT now())`).catch(() => {});
  // ПАМЯТЬ АКК×ПОСТ: какой наш акк уже комментил какой пост → не гоняем его туда повторно.
  await c.query(`CREATE TABLE IF NOT EXISTS account_post_done (slug text, code text, ts timestamptz DEFAULT now(), PRIMARY KEY(slug, code))`).catch(() => {});
  const dp = await c.query(`SELECT slug, code, ts FROM account_post_done`).catch(() => ({ rows: [] }));
  for (const x of dp.rows) { donePairs.set(x.slug + '|' + x.code, x.ts ? new Date(x.ts).getTime() : 0); workedPosts.add(x.code); }
  // ПОСТ-РЕСТРИКТ (правило владельца): посты с закрытыми комментами («Комментарии ограничены») грузим из БД и
  // скипаем СРАЗУ на каждом проходе — иначе первый акк каждого прохода снова тычется в закрытый пост впустую.
  await c.query(`CREATE TABLE IF NOT EXISTS post_restricted (code text PRIMARY KEY, ts timestamptz DEFAULT now())`).catch(() => {});
  const pr = await c.query(`SELECT code FROM post_restricted`).catch(() => ({ rows: [] }));
  for (const x of pr.rows) restrictedPosts.add(x.code);
  // бэклог-кап: сколько ответов каждый отработанный пост уже получил сегодня (из post_answered)
  const bt = await c.query(`SELECT code, count(*) n FROM post_answered WHERE ts::date=(now() at time zone 'Europe/Warsaw')::date GROUP BY code`).catch(() => ({ rows: [] }));
  for (const x of bt.rows) backlogToday[x.code] = Number(x.n) || 0;
  // дневной расход на акк (за сегодня, по Варшаве) — чтобы не гнать акк, который уже отработал норму
  const dc = await c.query(`SELECT slug, coalesce(sum(comments),0)+coalesce(sum(brand),0) n FROM account_run_stats WHERE ts::date=(now() at time zone 'Europe/Warsaw')::date GROUP BY slug`).catch(() => ({ rows: [] }));
  for (const x of dc.rows) dayCount[x.slug] = Number(x.n) || 0;
  // БРЕНД-ГЕЙТ: журнал бренд-комментов (для кулдауна и капа 1/день) + суммарные ответы людям за всё время (порог наработки)
  await c.query(`CREATE TABLE IF NOT EXISTS brand_posted (slug text, ts timestamptz DEFAULT now())`).catch(() => {});
  const lr = await c.query(`SELECT slug, coalesce(sum(comments),0) reps FROM account_run_stats GROUP BY slug`).catch(() => ({ rows: [] }));
  for (const x of lr.rows) lifeReplies[x.slug] = Number(x.reps) || 0; // ответов людям всего (не считая бренд)
  const bl = await c.query(`SELECT slug, max(ts) last, count(*) FILTER (WHERE ts::date=(now() at time zone 'Europe/Warsaw')::date) today FROM brand_posted GROUP BY slug`).catch(() => ({ rows: [] }));
  for (const x of bl.rows) { brandLast[x.slug] = x.last ? new Date(x.last) : null; brandToday[x.slug] = Number(x.today) || 0; }
  console.log(`память акк×пост: ${donePairs.size} пар | дневной кап ${DAILYCAP}/акк (на капе: ${Object.values(dayCount).filter((v) => v >= DAILYCAP).length}) | бренд-гейт: 1/день, кулдаун ${BRAND_COOLDOWN_H}ч`);
  await c.end();
}
async function stopProfile(slug) { const cr = creds[slug]; if (!cr) return; try { await fetch(`${API}/browser/${cr.pid}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${cr.tok}` }, signal: AbortSignal.timeout(15000) }); } catch {} }
async function recordStat(slug, comments, brand, postsTried, reason, elapsed) {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(`INSERT INTO account_run_stats(slug,comments,brand,posts_tried,retire_reason,elapsed) VALUES($1,$2,$3,$4,$5,$6)`, [slug, comments, brand, postsTried, reason, elapsed]); } catch {} finally { await c.end().catch(() => {}); }
}
// журнал бренд-коммента (для кулдауна 12ч и капа 1/день) — пишем, когда бренд реально ушёл
async function recordBrand(slug) {
  brandLast[slug] = new Date(); brandToday[slug] = (brandToday[slug] || 0) + 1;
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(`INSERT INTO brand_posted(slug) VALUES($1)`, [slug]); } catch {} finally { await c.end().catch(() => {}); }
}
// можно ли этому акку бренд СЕЙЧАС: не больше 1/день + кулдаун 12ч (порог «≥10 ответов» удалён по решению владельца)
function brandAllowed(slug) {
  if (!BRANDTOP) return false;
  if ((brandToday[slug] || 0) >= 1) return false;                       // уже был бренд сегодня
  const last = brandLast[slug];
  if (last && (Date.now() - last.getTime()) < BRAND_COOLDOWN_H * 3600000) return false; // кулдаун не прошёл
  return true;
}
// запомнить, что акк откомментил пост (повторный заход обновляет ts — для 12ч-паузы бэклога)
async function recordDone(slug, code) {
  donePairs.set(slug + '|' + code, Date.now()); workedPosts.add(code);
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(`INSERT INTO account_post_done(slug,code) VALUES($1,$2) ON CONFLICT(slug,code) DO UPDATE SET ts=now()`, [slug, code]); } catch {} finally { await c.end().catch(() => {}); }
}
// ТЕРМИНАЛЬНЫЙ no_connect (профиль не открывается после MAXRETRY) → пометка на само-лечение web-циклом (ЛОГГЕР
// читает ig_status='profile_lost' и пересоздаёт профиль). Согласованное поле. ГАРДРЕЙЛ: помечаем только на ПОВТОРНЫЙ
// no_connect (≥2 события за 3ч у одного акка) — чтобы облачный шторм GoLogin не пометил пол-фермы разом.
// status ОСТАВЛЯЕМ 'warming' (НЕ paused) — иначе лечащий цикл его пропустит.
async function flagNoConnect(slug, code) {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    await c.query(`INSERT INTO account_events(account_id, slug, platform, kind, detail)
      SELECT id, slug, platform, 'no_connect', $2::jsonb FROM accounts WHERE slug=$1 AND platform='comments'`,
      [slug, JSON.stringify({ code, source: 'smartrun' })]).catch(() => {});
    // РАЗЛИЧАЕМ причину (Main 22.07, слотов 15): no_connect у комментинга = В ОСНОВНОМ реально мёртвые профили →
    // profile_lost PRIMARY. Только ЯВНЫЙ ШТОРМ overcommit (≥8 РАЗНЫХ акков за 10 мин) = нехватка слотов, тогда lost НЕ
    // ставим (зря пересоздадим живой). Порог высокий, чтобы не глушить основной кейс мёртвого профиля.
    const sys = Number((await c.query(`SELECT count(DISTINCT slug) n FROM account_events WHERE kind='no_connect' AND created_at > now() - interval '10 minutes'`)).rows[0].n) || 0;
    if (sys >= 8) { console.log(`  ⏸ ${slug}: no_connect ШТОРМ (${sys} акков/10мин = overcommit слотов GoLogin) → profile_lost отложен, ждём слот/семафор`); return; }
    const n = Number((await c.query(`SELECT count(*) n FROM account_events WHERE slug=$1 AND kind='no_connect' AND created_at > now() - interval '3 hours'`, [slug])).rows[0].n) || 0;
    // ПРОКСИ ВИНОВАТ ЧАЩЕ, ЧЕМ ПРОФИЛЬ (07.08). profile_lost запускает ПЕРЕСОЗДАНИЕ профиля GoLogin,
    // а это потеря кук, фингерпринта и прогрева, то есть необратимо. Штормовой гейт выше ловит только
    // массовый случай (≥8 разных акков за 10 минут), а «мой прокси лежит третий час» даёт всего 2
    // события за 3 часа и проходит как «изолированный». Поэтому: если канал акка не подтверждён
    // живым (proxy_status не 'ok'), no_connect объясняется прокси, и профиль мы не хороним.
    const pst = String(((await c.query(`SELECT coalesce(proxy_status,'') p FROM accounts WHERE slug=$1 AND platform='comments'`, [slug])).rows[0] || {}).p || '');
    if (n >= 2 && pst !== 'ok') {
      console.log(`  ⏸ ${slug}: no_connect ${n}×/3ч, но прокси не подтверждён живым (proxy_status='${pst || '—'}') → profile_lost НЕ ставлю, сначала канал`);
      return;
    }
    if (n >= 2) {
      await c.query(`UPDATE accounts SET ig_status='profile_lost', session_status='dead' WHERE slug=$1 AND platform='comments'`, [slug]).catch(() => {});
      console.log(`  💀 ${slug}: ИЗОЛИРОВАННЫЙ повторный no_connect (${n}×/3ч, не системно) → ig_status='profile_lost' (ЛОГГЕР пересоздаст профиль)`);
    } else {
      console.log(`  ⚠ ${slug}: no_connect 1× — событие записано, profile_lost отложен (страховка от шторма GoLogin)`);
    }
  } catch (e) { console.log('  (flagNoConnect err:', (e.message || '').slice(0, 40) + ')'); } finally { await c.end().catch(() => {}); }
}

// один прогон vcomment на КОНКРЕТНОМ посту; парсим RESULT-строку
// brand=true → на ЭТОМ посту разрешён брендовый топ-коммент (бюджет 1/акк, тратится когда бренд реально запостился)
// backlog=true → пост уже отработан: только добор спроса (промпт/гайд), БЕЗ бренда, скролл глубже
function runOne(slug, code, brand, backlog) {
  const log = `${DIR}/${slug}_${code}.log`;
  const out = fs.openSync(log, 'w');
  return new Promise((res) => {
    const env = { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: DIR, FAILFAST, DBGPROM: '1' };
    if (BRANDTOP && brand && !backlog) env.BRANDTOP = '1';
    if (backlog) env.BACKLOG = '1';
    if (CFG.cta) env.CTA_WORDS = CFG.cta; // CTA-триггеры поста (Стиль/Фон/Взгляд) → тоже целевые аскеры
    if (CFG.dest === 'bot') env.POOL_DEST = 'bot'; // пул фраз: тг-бот @gener7_bot вместо сайта нейронка про
    const ch = spawn('node', ['vcomment.cjs', slug, P(code), String(PERPOST)], { cwd: __dirname, env, stdio: ['ignore', out, out] });
    ch.on('exit', () => {
      fs.closeSync(out);
      let r = { done: 0, brand: 0, blocked: 0, nofirst: 0, restricted: 0, fails: 0, elapsed: 0, connected: false };
      try {
        const t = fs.readFileSync(log, 'utf8');
        r.connected = !/НЕ ПОДКЛЮЧИЛСЯ/.test(t);
        const m = t.match(/RESULT done=(\d+) brand=(\d+) blocked=(\d+) nofirst=(\d+) restricted=(\d+) fails=(\d+) elapsed=(\d+)/);
        if (m) { r.done = +m[1]; r.brand = +m[2]; r.blocked = +m[3]; r.nofirst = +m[4]; r.restricted = +m[5]; r.fails = +m[6]; r.elapsed = +m[7]; }
      } catch {}
      res(r);
    });
  });
}

// один аккаунт проходит по приоритетным постам с фейловером
async function runAccount(slug, offset) {
  const t0 = Date.now();
  let total = 0, brand = 0, postFails = 0, tried = 0, reason = 'exhausted';
  const CAP = Number(CFG.accountCap || 0); // максимум комментов на акк за заход → потом ротация на следующий (не спамим одним)
  const MAXPOSTS = Number(CFG.maxPosts || 0); // на скольких РИЛСАХ акк реально комментит → потом ротация (естественнее: 1 человек = 2 креатора, а не 7)
  let productive = 0; // рилсов, где акк реально оставил коммент
  // БРЕНД-ГЕЙТ: разрешаем бренд ТОЛЬКО если акк наработал ≥N ответов, сегодня не постил и кулдаун прошёл (иначе только ответы).
  let brandLeft = brandAllowed(slug) ? 1 : 0;
  if (BRANDTOP && !brandLeft) console.log(`[${slug}] бренд СЕГОДНЯ нельзя (сегодня уже ${brandToday[slug] || 0}, кулдаун ${BRAND_COOLDOWN_H}ч) → только ответы`);
  const off = ((offset || 0) % POSTS.length + POSTS.length) % POSTS.length;
  const posts = off ? [...POSTS.slice(off), ...POSTS.slice(0, off)] : POSTS; // ротация старт-поста: акки не пилят один и тот же
  for (const code of posts) {
    if (restrictedPosts.has(code)) { console.log(`[${slug}] @${code} комменты ограничены автором → пропуск (не постфейл)`); continue; }
    // БЭКЛОГ: пост уже с нашими комментами → только добор спроса (без бренда), кап BACKLOG_CAP/день на пост.
    const backlog = workedPosts.has(code);
    if (backlog && (backlogToday[code] || 0) >= BACKLOG_CAP) { console.log(`[${slug}] @${code} бэклог-кап ${BACKLOG_CAP}/день исчерпан (${backlogToday[code]}) → пропуск`); continue; }
    const doneTs = donePairs.get(slug + '|' + code);
    if (doneTs !== undefined) {
      const ageH = (Date.now() - doneTs) / 3600000;
      if (!backlog || ageH < REVISIT_H) { console.log(`[${slug}] @${code} уже комментил ${ageH < 999 ? Math.round(ageH) + 'ч назад' : 'ранее'} → пропуск`); continue; }
      console.log(`[${slug}] @${code} повторный заход в БЭКЛОГ (прошло ${Math.round(ageH)}ч ≥ ${REVISIT_H}ч)`);
    }
    tried++;
    const r = await runOne(slug, code, !backlog && brandLeft > 0, backlog);
    if (backlog) backlogToday[code] = (backlogToday[code] || 0) + r.done;
    if (r.brand > 0) { brandLeft = 0; recordBrand(slug).catch(() => {}); console.log(`[${slug}] ★ бренд ушёл → журнал (1/день, кулдаун ${BRAND_COOLDOWN_H}ч)`); } // бюджет исчерпан
    lifeReplies[slug] = (lifeReplies[slug] || 0) + r.done; // копим наработку ответами (для порога в след. заходах)
    await stopProfile(slug); // ГАСИМ профиль после каждого поста (иначе слот забит)
    if (r.restricted) { restrictedPosts.add(code); console.log(`[${slug}] @${code} ⛔ комменты ОГРАНИЧЕНЫ автором → пост в скип для всей волны, НЕ постфейл`); continue; }
    if (!r.connected) {
      if (total === 0 && (retries[slug] || 0) < MAXRETRY) { console.log(`[${slug}] @${code} НЕ ПОДКЛ (флап слота) → в очередь на ретрай`); return { slug, requeue: true }; }
      reason = 'no_connect(мёртвый профиль?)'; console.log(`[${slug}] @${code} НЕ ПОДКЛ → стоп акка`); await flagNoConnect(slug, code).catch(() => {}); break;
    }
    total += r.done; brand += r.brand; globalTotal += r.done + r.brand;
    dayCount[slug] = (dayCount[slug] || 0) + r.done + r.brand; // дневной расход акка (для капа в след. волнах)
    const tag = `done=${r.done} brand=${r.brand} blk=${r.blocked} nofirst=${r.nofirst} ${r.elapsed}s`;
    if (r.done > 0) {
      postFails = 0; productive++;
      recordDone(slug, code).catch(() => {}); // запомнили: этот акк откомментил этот пост
      console.log(`[${slug}] @${code} ✓ ${tag} (итого ${total}, рилсов ${productive})`);
      if (MAXPOSTS && productive >= MAXPOSTS) { reason = `лимит рилсов/акк (${MAXPOSTS} — концентрируемся, не палимся)`; console.log(`[${slug}] откомментил ${productive} рилса → ротация на следующий акк`); break; }
    } else {
      postFails++;
      console.log(`[${slug}] @${code} ✗ ${tag} (постфейл ${postFails})`);
      if (postFails >= 2) { reason = r.nofirst ? 'шб/трабл_акка(2 поста 0 при откр.панели)' : 'блок_на_2_постах'; console.log(`[${slug}] 2 поста подряд мимо → трабл АККА → меняем акк`); break; }
    }
    if (r.fails >= 4) { reason = 'rate_limit(IG отклоняет)'; console.log(`[${slug}] IG отклоняет (rate-limit) → стоп акка`); break; }
    if (CAP && (total + brand) >= CAP) { reason = `кап_ротация (≥${CAP} → бережём акк)`; console.log(`[${slug}] достиг капа ${total + brand} комм → ротация на следующий акк`); break; }
    if ((dayCount[slug] || 0) >= DAILYCAP) { reason = `дневной кап (${DAILYCAP}/день — не жжём)`; console.log(`[${slug}] дневной кап ${dayCount[slug]} → отдыхает до завтра`); break; }
    await sleep(3000);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  await recordStat(slug, total, brand, tried, reason, elapsed);
  console.log(`[${slug}] ИТОГ: комментов ${total} (+${brand} бренд), постов ${tried}, причина стопа: ${reason}, ${elapsed}s`);
  return { slug, total, brand, reason };
}

(async () => {
  await loadCreds();
  const eligible = CFG.accounts.filter((slug) => { if (!creds[slug]) { console.log(`нет профиля (скип): ${slug}`); return false; } return true; });
  const results = [];
  const CONC = Number(CFG.conc || 7);        // ГЛОБАЛЬНО одновременных акков. Бюджет владельца (22.07): 15 слотов GoLogin =
  const STAGGER = Number(CFG.stagger || 9000); // комментинг 7 / патруль Алины 3 / логгер 3(до 5). Семафор пула 'commenting'=7 держит ЛОГГЕР в gologin.ts — мы потребитель.
  console.log(`SMARTRUN: акков ${eligible.length}, постов ${POSTS.length}, perPost ${PERPOST}, глоб.CONC ${CONC}, таргет ${TARGET || '∞'}`);
  RUN_T0 = Date.now();
  // ЕДИНАЯ глобальная очередь (не по токену: иначе conc×2токена > 10 слотов → шторм).
  const queue = [...eligible]; const active = new Set(); let launched = 0;
  const pump = async () => {
    while (queue.length && active.size < CONC && (!TARGET || globalTotal < TARGET)) {
      const slug = queue.shift();
      if ((dayCount[slug] || 0) >= DAILYCAP) { console.log(`[${slug}] уже дал ${dayCount[slug]} комментов сегодня (кап ${DAILYCAP}) → ОТДЫХАЕТ, пропуск`); continue; } // не жжём акк
      const p = runAccount(slug, launched++).then((r) => { // offset=launched → каждый акк стартует с др. поста (ротация)
        active.delete(p);
        if (r && r.requeue) { retries[slug] = (retries[slug] || 0) + 1; queue.push(slug); } // флап слота → назад в очередь
        else if (r) results.push(r);
      });
      active.add(p);
      await sleep(STAGGER); // аккуратный вход в слот, а не все разом
    }
    if (active.size) await Promise.race(active);
  };
  while ((queue.length && (!TARGET || globalTotal < TARGET)) || active.size) await pump();
  const totC = results.reduce((s, r) => s + (r.total || 0), 0), totB = results.reduce((s, r) => s + (r.brand || 0), 0);
  const wall = Math.round((Date.now() - RUN_T0) / 1000); const all = totC + totB;
  console.log(`\n=== SMARTRUN DONE === комментов ${totC} + бренд ${totB} = ${all} за ${wall}с (${(wall / 60).toFixed(1)}мин)`);
  console.log(`ЗАМЕР: ${all ? (wall / all).toFixed(1) : '-'}с/коммент | ${all ? (all / (wall / 60)).toFixed(1) : '-'} комм/мин | акков отработало ${results.length}`);
  for (const r of results) console.log(`  ${r.slug}: ${r.total}v +${r.brand}b (${r.reason})`);
  fs.writeFileSync(DIR + '/.smartdone', `C=${totC} B=${totB} wall=${wall}`);
})().catch((e) => { console.error('SMARTRUN FATAL', e.message); process.exit(1); });
