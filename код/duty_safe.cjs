// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
// SAFE DUTY — дежурство, которое НЕ жжёт акки.
// Принцип: детект новых комментов АНОНИМНО через IG-embed (БЕЗ логина, БЕЗ акка), а логинимся ТОЛЬКО
// когда счётчик реально вырос — и то редко, СТАРЫМ обкатанным акком, по паре ответов, широкой ротацией.
// Это убирает главный убийца прошлого дежурства: холостые логин-визиты по расписанию каждые 20-30 мин.
//
// Запуск (локально, как smartrun/vcomment):  node duty_safe.cjs
// Останов: Ctrl+C (сам процесс = вкл/выкл дежурства; worker в проде остаётся с duty_enabled=false).
// env: DB_PUBLIC_URL (или /tmp/dburl.txt), OPENROUTER_API_KEY (или /tmp/orkey.txt),
//      CHECK_EVERY_MIN (деф 5)  — как часто анонимно щупаем embed (акк не трогается),
//      MIN_LOGIN_GAP_MIN (деф 30) — минимум между ЛЮБЫМИ логинами (глобальный throttle),
//      AGE_MIN_DAYS (деф 2)  — дежурят только акки СТАРШЕ N дней (фреши НЕ пускаем — они и мёрли),
//      DAILY_CAP (деф 6)     — не больше N ответов с акка в сутки,
//      DRY=1                 — только детект+лог, без реального логина/ответа (для проверки).
const { Client } = require('pg');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || (fs.existsSync('/tmp/orkey.txt') ? fs.readFileSync('/tmp/orkey.txt', 'utf8').trim() : '');
// Адаптивный интервал анонимного чека: ДНЁМ аудитория активна (комменты пачками) — чек чаще; НОЧЬЮ тихо — реже.
const CHECK_DAY = Number(process.env.CHECK_DAY_MIN || 5) * 60000;    // днём каждые 5 мин
const CHECK_NIGHT = Number(process.env.CHECK_NIGHT_MIN || 20) * 60000; // ночью каждые 20 мин
const TZ = process.env.DUTY_TZ || 'Europe/Moscow';                    // по времени РФ-аудитории
const DAY_FROM = Number(process.env.DAY_FROM || 8);                   // «день» = [8:00, 23:00)
const DAY_TO = Number(process.env.DAY_TO || 23);
function checkEvery() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
  return (hour >= DAY_FROM && hour < DAY_TO) ? CHECK_DAY : CHECK_NIGHT;
}
const MIN_LOGIN_GAP = Number(process.env.MIN_LOGIN_GAP_MIN || 30) * 60000;
const AGE_MIN_DAYS = Number(process.env.AGE_MIN_DAYS || 2);
const DAILY_CAP = Number(process.env.DAILY_CAP || 6);
const MIN_NEW = Number(process.env.MIN_NEW || 2);        // логинимся только если новых комментов >= 2
const MAX_PER_VISIT = Number(process.env.MAX_PER_VISIT || 3); // не больше 3 ЛЮБЫХ комментов с 1 акка за заход
const BRAND_EVERY = Number(process.env.BRAND_EVERY || 10);   // ~каждые 10 новых комментов — 1 брендовый топ-коммент
const DUTY_TARGET = Number(process.env.DUTY_TARGET || 3);    // сколько АКТИВНЫХ дежурных держим (добор из пула)
// КАМПАНЕЙНЫЙ СЛОЙ. Если в duty_campaign есть открытая кампания — жмём ЕЁ пост (бюджет+темп+фронтлоад),
// иначе фолбэк на radar_config.duty_url (старое одно-постовое дежурство). Роутинг ботов на 1 горячий пост.
const CAMPAIGN_BOTS_MAX = Number(process.env.CAMPAIGN_BOTS_MAX || 10); // потолок ботов на кампанию (полная сила — после egress-гейта ЛОГГЕРа)
const DRY = process.env.DRY === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let baseline = null;    // число комментов на прошлой проверке (в памяти — на рестарте пере-базируемся без логина)
let lastLoginAt = 0;    // когда последний раз кого-то логинили (глобальный throttle)
let newSinceBrand = 0;  // сколько новых комментов накопилось с прошлого нашего брендового коммента

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

// Перед логином глушим активную GoLogin-сессию профиля — чтобы не столкнуться с фоновым warmup воркера
// (две сессии на профиле = крэш/риск). ttcheck/sortcheck делают так же.
async function stopSession(slug) {
  let c;
  try {
    c = await db();
    const r = (await c.query(
      `SELECT a.gologin_profile_id AS pid,
              coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [slug])).rows[0];
    await c.end(); c = null;
    if (!r || !r.pid || !r.tok) return;
    await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {});
    await sleep(15000);
  } catch { /* best-effort */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

// curl вместо node-fetch: node-fetch (undici) палится TLS-отпечатком → IG отдаёт login-shell без счётчика.
// Через curl + резидентский прокси приходит нормальный embed. Прокси — чтобы IG не душил наш IP по частоте.
function curlText(url, proxy) {
  return new Promise((res) => {
    // ВАЖНО: короткий UA. Полный десктопный Chrome-UA IG отдаёт login-shell (598КБ, без счётчика),
    // а короткому/мобильному — нормальный embed со счётчиком (~126КБ). Проверено.
    const args = ['-s', '-m', '30', '-A', 'Mozilla/5.0 Chrome/124'];
    if (proxy) args.push('-x', 'http://' + proxy);
    args.push(url);
    execFile('curl', args, { maxBuffer: 20 * 1024 * 1024, timeout: 35000 }, (err, stdout) => res(err ? '' : String(stdout || '')));
  });
}

// Несколько случайных живых резидентских прокси для анонимного чека (без логина — трогаем только IP).
async function pickProxies(c, n) {
  const r = await c.query("SELECT ig_proxy FROM accounts WHERE ig_proxy LIKE '%@%' AND proxy_status='ok' AND deleted_at IS NULL ORDER BY random() LIMIT $1", [n]).catch(() => ({ rows: [] }));
  return r.rows.map((x) => x.ig_proxy);
}

// Анонимный чек числа комментов через embed (curl+прокси). Пробуем НЕСКОЛЬКО прокси — один флапнувший не ронял чек.
// НИ ОДИН акк не логинится — берём только IP прокси.
async function embedCount(code, proxies) {
  for (const proxy of (proxies && proxies.length ? proxies : [null])) {
    for (const kind of ['reel', 'p']) {
      const h = await curlText(`https://www.instagram.com/${kind}/${code}/embed/captioned/`, proxy);
      if (!h) continue;
      const m = h.match(/View all ([\d,]+)\s+comment/i) || h.match(/edge_media_to_comment[\\":{\s]*count[\\":\s]*(\d+)/i);
      if (m) return parseInt(m[1].replace(/[.,\s]/g, ''), 10);
    }
  }
  return null;
}

// РОСТЕР: держим ровно DUTY_TARGET активных дежурных в watchdog-группе «Сторожи». Гейты возраста/egress СНЯТЫ
// по просьбе владельца — добор из общего пула по рабочим условиям (не в бане, live, есть профиль, не блокнут
// на посту). Выпал один (блок/бан/dead/пауза) — тут же добираем следующего. Это и есть «всегда 3 активных».
async function maintainRoster(c, code, target) {
  const WD = "(SELECT id FROM account_groups WHERE coalesce(watchdog,false)=true ORDER BY id LIMIT 1)";
  const GEN = "(SELECT id FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)";
  // 1) НЕгодных из группы (dead / пауза / бан) — обратно в общий пул (блокнутых уже вернул dropBlockedFromDuty).
  await c.query(`UPDATE accounts SET group_id=${GEN} WHERE group_id=${WD} AND deleted_at IS NULL
     AND (coalesce(session_status,'')='dead' OR status IN ('paused','trash') OR coalesce(ig_status,'') IN ('challenge','bad_login','captcha','suspended'))`).catch(() => {});
  // 2) сколько ГОДНЫХ сейчас в дежурных.
  const cur = (await c.query(`SELECT count(*)::int AS n FROM accounts a WHERE a.group_id=${WD} AND a.deleted_at IS NULL`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  // 3) недобор → тянем лучших из общего пула (LRU) в дежурные, пока не станет target.
  if (cur < target) {
    const add = (await c.query(
      `UPDATE accounts SET group_id=${WD} WHERE id IN (
         SELECT a.id FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
           AND a.status NOT IN ('paused','trash') AND a.gologin_profile_id IS NOT NULL
           AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended')
           AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false -- НЕ трогаем бэклог-бригаду
           AND (a.commenting_at IS NULL OR a.commenting_at < now() - interval '15 minutes') -- НЕ выдёргиваем акк, занятый комментингом ПОСТИНГА (урок karter: 2 сессии на профиль = смерть)
           AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
         ORDER BY a.last_commented_at ASC NULLS FIRST LIMIT $2)
       RETURNING slug`, [code, target - cur]).catch(() => ({ rows: [] }))).rows;
    if (add.length) console.log(`[safe-duty] добрал в дежурные до ${target}: ${add.map((x) => x.slug).join(', ')}`);
  }
}

// Выбор ОДНОГО дежурного на заход — из ростера (watchdog-группы), с запасом суточного лимита, LRU.
async function pickAged(c, code) {
  const r = await c.query(
    `SELECT a.slug, round((extract(epoch from(now()-a.created_at))/86400)::numeric,1) AS age_d
     FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE coalesce(g.watchdog,false)=true AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
       AND a.status NOT IN ('paused','trash') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended')
       AND coalesce(a.comments_today,0) < $1
       AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$2 AND b.blocked)
     ORDER BY a.last_commented_at ASC NULLS FIRST
     LIMIT 1`, [DAILY_CAP, code]);
  return r.rows[0] || null;
}

// ПРАВИЛО: дежурный, попавший в блок КРЕАТОРА на дежурном посту, уходит из группы «Сторожи» в общий пул
// (РАБОЧИЕ АККИ). На смены больше не заходит (pickAged его и так исключает по пост-блоку), но продолжает
// комментить ДРУГИЕ посты как обычный работник (watchdog-группа из общего комментинга исключена, общий пул — нет).
async function dropBlockedFromDuty(c, code) {
  const r = await c.query(
    `UPDATE accounts SET group_id = (SELECT id FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)
     WHERE id IN (
       SELECT a.id FROM accounts a JOIN account_groups g ON g.id=a.group_id
       WHERE coalesce(g.watchdog,false)=true AND a.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked))
     RETURNING slug`, [code]).catch(() => ({ rows: [] }));
  if (r.rows.length) console.log(`[safe-duty] блок у креатора → из Сторожей в общий пул: ${r.rows.map((x) => x.slug).join(', ')}`);
}

// ── КАМПАНЕЙНЫЙ СЛОЙ ────────────────────────────────────────────────────────
// Истина по бюджету/темпу — общий post_answered(code, username): и дежурные, и бэклог, и мастер пишут туда,
// поэтому счётчики честные по ВСЕМ ботам, без своего учёта (не переизобретаем дедуп).
async function answeredForCode(c, code) {
  return (await c.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [code]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
}
async function answeredTodayForCode(c, code) {
  return (await c.query("SELECT count(*)::int n FROM post_answered WHERE code=$1 AND ts >= date_trunc('day', now())", [code]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
}
async function closeCampaign(c, code, reason) {
  await c.query("UPDATE duty_campaign SET status='done', note=coalesce(note,'')||$2 WHERE code=$1",
    [code, ` [закрыта: ${reason} @ ${new Date().toISOString().slice(0, 16)}]`]).catch(() => {});
  console.log(`[campaign] ${code} ЗАКРЫТА (${reason})`);
}
// Фронтлоад: свежий пост жмём интенсивнее, дальше затухание. Множитель к per_day И к числу ботов —
// на взлёте концентрируем силу, к концу окна сбавляем (пост тонет, спрос отвечен).
function frontloadMult(ageDays) {
  return ageDays <= 1 ? 1.6 : ageDays <= 2 ? 1.3 : ageDays <= 3 ? 1.0 : ageDays <= 4 ? 0.7 : 0.4;
}
// Выбор активной кампании: топ-приоритет, в окне, с остатком бюджета и не выбранным суточным темпом.
// Бюджет исчерпан → закрываем. Суточный темп выбран → сегодня этот пост пропускаем (берём следующий/фолбэк).
async function pickCampaign(c) {
  // ПОЛОСА: дежурство берёт только СВОИ кампании — lane='duty' или без метки (NULL). demand-полосу
  // (роутинг спроса, пишет ПОСТИНГ) работает commenter, не дежурство — иначе duty утащит ботов на чужой пост.
  const rows = (await c.query(
    `SELECT code, url, opened_at, window_days, budget, per_day, bots, priority,
            round((extract(epoch from (now()-opened_at))/86400)::numeric, 2) AS age_days
     FROM duty_campaign
     WHERE status='open' AND (lane IS NULL OR lane='duty')
       AND now() < opened_at + (window_days || ' days')::interval
     ORDER BY priority DESC, opened_at DESC LIMIT 8`).catch(() => ({ rows: [] }))).rows;
  let rateCapped = false; // была открытая кампания, но её суточный темп на сегодня выбран → надо ЖДАТЬ, не фолбэчить
  for (const camp of rows) {
    const total = await answeredForCode(c, camp.code);
    if (total >= camp.budget) { await closeCampaign(c, camp.code, `бюджет ${total}/${camp.budget}`); continue; }
    const age = Number(camp.age_days);
    const mult = frontloadMult(age);
    const effPerDay = Math.max(1, Math.round(camp.per_day * mult));
    const today = await answeredTodayForCode(c, camp.code);
    if (today >= effPerDay) { rateCapped = true; continue; } // темп выбран — этот пост сегодня не жмём
    const bots = Math.max(1, Math.min(CAMPAIGN_BOTS_MAX, Math.round(camp.bots * mult)));
    return { camp: { ...camp, total, today, effPerDay, bots, age }, rateCapped: false };
  }
  return { camp: null, rateCapped }; // camp=null: либо кампаний нет (fallback), либо все на суточном темпе (ждать)
}
// Закрываем окно у кампаний, которые вышли за window_days (пост протух) — чтобы не висели open вечно.
async function expireCampaigns(c) {
  const r = await c.query(
    "UPDATE duty_campaign SET status='done', note=coalesce(note,'')||' [окно вышло]' WHERE status='open' AND now() >= opened_at + (window_days || ' days')::interval RETURNING code"
  ).catch(() => ({ rows: [] }));
  if (r.rows.length) console.log(`[campaign] окно вышло → закрыты: ${r.rows.map((x) => x.code).join(', ')}`);
}

// ── PATROL-СЛОТЫ (общий семафор облачных сессий GoLogin, живёт в БД, делает ЛОГГЕР) ──────────────────
// Пул 'patrol' cap=3, общий потолок 15. Дежурство/бэклог/комментер/мастер все берут отсюда — так суммарно
// НЕ превышаем лимит облака (иначе cloud-шторм). Занимаем ПЕРЕД открытием профиля, освобождаем ПОСЛЕ закрытия.
// Протухшие слоты (умерший процесс) авто-реклеймятся семафором через 15 мин, но освобождаем и явно.
async function claimPatrolSlot(slug) {
  let c;
  try {
    c = await db();
    const r = await c.query("SELECT claim_gologin_slot('patrol', $1, 3, 15) AS id", [slug]);
    return (r.rows[0] && r.rows[0].id) || null; // null = свободных слотов в пуле нет
  } catch (e) { console.log('[slot] claim err:', String((e && e.message) || e).slice(0, 80)); return null; }
  finally { try { if (c) await c.end(); } catch { /* noop */ } }
}
async function releasePatrolSlot(id) {
  if (!id) return;
  let c;
  try { c = await db(); await c.query('SELECT release_gologin_slot($1)', [id]); }
  catch { /* TTL-реклейм через 15 мин подстрахует */ }
  finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

// Реальный ответ переиспользует готовый движок vcomment.cjs (логин → пауза рила → зрячий поиск спрашивающих
// → ответ в ветку → запись блоков/статов → закрытие сессии). Мы им только дирижируем.
// n = сколько спрашивающих ответить; brand=true → плюс 1 брендовый ТОП-коммент (BRANDTOP=1).
// ТИХИЙ отчёт в Телеграм (disable_notification=true). Best-effort.
function tgReport(text) {
  try {
    const bot = fs.existsSync('/tmp/tg_bot.txt') ? fs.readFileSync('/tmp/tg_bot.txt', 'utf8').trim() : (process.env.TELEGRAM_BOT_TOKEN || '');
    const chat = fs.existsSync('/tmp/tg_chat.txt') ? fs.readFileSync('/tmp/tg_chat.txt', 'utf8').trim() : (process.env.TELEGRAM_CHAT_ID || '');
    if (!bot || !chat) return;
    fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_notification: true, disable_web_page_preview: true }) }).catch(() => {});
  } catch { /* noop */ }
}

// ТИХИЙ отчёт СО СКРИНОМ (sendPhoto, без уведомления) — видно, кому именно ответили.
function tgPhoto(caption, filePath) {
  try {
    const bot = fs.existsSync('/tmp/tg_bot.txt') ? fs.readFileSync('/tmp/tg_bot.txt', 'utf8').trim() : (process.env.TELEGRAM_BOT_TOKEN || '');
    const chat = fs.existsSync('/tmp/tg_chat.txt') ? fs.readFileSync('/tmp/tg_chat.txt', 'utf8').trim() : (process.env.TELEGRAM_CHAT_ID || '');
    if (!bot || !chat || !fs.existsSync(filePath)) return false;
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('caption', String(caption).slice(0, 1000));
    form.append('disable_notification', 'true');
    form.append('photo', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), 'reply.png');
    fetch(`https://api.telegram.org/bot${bot}/sendPhoto`, { method: 'POST', body: form }).catch(() => {});
    return true;
  } catch { return false; }
}

function replyVia(slug, url, n, brand) {
  return new Promise((res) => {
    const p = spawn('node', [path.join(DIR, 'vcomment.cjs'), slug, url, String(n)], {
      cwd: DIR,
      env: { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: process.env.SHOT_DIR || '/tmp', BRANDTOP: brand ? '1' : '' },
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let buf = '', cnt = 0;
    p.stdout.on('data', (d) => {
      process.stdout.write(d);
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/✓ ВЕТКА (@\S+)\s*\|\s*(.+)/);
        if (m) {
          cnt++;
          const idx = cnt - 1; // vcomment пишет скрин vc_<slug>_<idx>_after.png ПОСЛЕ каждого ответа
          const cap = `🛡 ДЕЖУРНЫЙ · ${slug}\n→ ${m[1]}\n«${m[2].trim()}»`;
          const shot = `${process.env.SHOT_DIR || '/tmp'}/vc_${slug}_${idx}_after.png`;
          // ждём, пока скрин допишется, потом шлём фото; если не появился — уходит текстом
          setTimeout(() => { if (!tgPhoto(cap, shot)) tgReport(cap); }, 9000);
        }
      }
    });
    p.on('exit', () => { if (cnt) tgReport(`🛡 ДЕЖУРНЫЙ · ${slug}: заход завершён, ответов ${cnt}`); res(); });
    p.on('error', () => res());
  });
}

(async () => {
  console.log(`[safe-duty] старт. детект=embed(0 логинов) | чек: день ${CHECK_DAY / 60000}мин / ночь ${CHECK_NIGHT / 60000}мин (${DAY_FROM}-${DAY_TO}ч ${TZ}) | кампания(duty_campaign)→приоритет+бюджет+темп+фронтлоад, иначе фолбэк duty_url | дежурных ${DUTY_TARGET}/кампания до ${CAMPAIGN_BOTS_MAX} | логин от ${MIN_NEW}+ новых | до ${MAX_PER_VISIT} комм/акк | брендовый ~кажд.${BRAND_EVERY} | gap>=${MIN_LOGIN_GAP / 60000}мин | cap=${DAILY_CAP}/сутки${DRY ? ' | DRY-RUN' : ''}`);
  for (;;) {
    let c;
    try {
      c = await db();
      // КАМПАНИЯ vs ФОЛБЭК. Открытая кампания (топ-приоритет, в окне, с бюджетом и темпом) → жмём её пост.
      // Иначе старое одно-постовое дежурство по radar_config.duty_url.
      await expireCampaigns(c);
      const { camp, rateCapped } = await pickCampaign(c);
      let dutyUrl, code, rosterTarget;
      if (camp) {
        dutyUrl = camp.url; code = camp.code; rosterTarget = camp.bots;
        console.log(`[campaign] активна ${code} | приоритет ${camp.priority} | бюджет ${camp.total}/${camp.budget} | сегодня ${camp.today}/${camp.effPerDay} (фронтлоад ×${frontloadMult(camp.age)}) | возраст ${camp.age}д | ботов ${camp.bots}`);
      } else if (rateCapped) {
        // Открытая кампания есть, но суточный темп выбран — ЖДЁМ, НЕ фолбэчим (иначе долбим пост мимо лимита).
        console.log('[campaign] суточный темп активной кампании выбран — жду до завтра/следующего окна');
        await c.end(); await sleep(checkEvery()); continue;
      } else {
        const cfg0 = (await c.query('SELECT duty_url FROM radar_config WHERE id=1')).rows[0];
        dutyUrl = String(cfg0 && cfg0.duty_url || '');
        code = (dutyUrl.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
        rosterTarget = DUTY_TARGET;
        if (!code) { console.log('[safe-duty] нет открытой кампании и duty_url не задан — жду'); await c.end(); await sleep(checkEvery()); continue; }
      }
      // Единый объект cfg для остального кода (нижний код ждёт cfg.duty_url).
      const cfg = { duty_url: dutyUrl };

      await dropBlockedFromDuty(c, code);          // блокнутых креатором — из Сторожей в общий пул
      await maintainRoster(c, code, rosterTarget); // держим ростер под число ботов (кампания) / DUTY_TARGET (фолбэк)
      const proxies = await pickProxies(c, 3);
      const cnt = await embedCount(code, proxies);
      if (cnt === null) { console.log('[safe-duty] embed не отдал счётчик (все 3 прокси мимо) — НЕ логинюсь, жду'); await c.end(); await sleep(checkEvery()); continue; }

      if (baseline === null) { baseline = cnt; console.log(`[safe-duty] базовая линия ${cnt} комментов (без логина)`); await c.end(); await sleep(checkEvery()); continue; }
      if (cnt <= baseline) { if (cnt < baseline) baseline = cnt; console.log(`[safe-duty] новых нет (${cnt}) — НЕ логинюсь`); await c.end(); await sleep(checkEvery()); continue; }

      const grew = cnt - baseline;
      // ПОРОГ: заходим только когда накопилось >= MIN_NEW новых. baseline НЕ двигаем — копится до порога.
      if (grew < MIN_NEW) { console.log(`[safe-duty] +${grew} новых (порог ${MIN_NEW}) — жду ещё, не логинюсь`); await c.end(); await sleep(checkEvery()); continue; }
      const since = Date.now() - lastLoginAt;
      if (lastLoginAt && since < MIN_LOGIN_GAP) { console.log(`[safe-duty] +${grew} новых, но рано логиниться (${Math.round(since / 60000)}/${MIN_LOGIN_GAP / 60000}мин) — жду`); await c.end(); await sleep(checkEvery()); continue; }

      const acc = await pickAged(c, code);
      if (!acc) { console.log(`[safe-duty] +${grew} новых, но НЕТ годного акка (все на лимите/блокнуты на посту/не live) — пропускаю`); await c.end(); await sleep(checkEvery()); continue; }

      // Каждые ~BRAND_EVERY новых комментов — один брендовый ТОП-коммент. Он занимает 1 из MAX_PER_VISIT,
      // чтобы с одного акка за заход было НЕ БОЛЬШЕ MAX_PER_VISIT любых комментов (правило юзера).
      const doBrand = (newSinceBrand + grew) >= BRAND_EVERY;
      const replies = Math.max(1, MAX_PER_VISIT - (doBrand ? 1 : 0));
      console.log(`[safe-duty] +${grew} новых → ${acc.slug} (${acc.age_d}дн): до ${replies} ответов${doBrand ? ' + 1 брендовый топ' : ''} (макс ${MAX_PER_VISIT} с акка)`);
      await c.end();
      if (DRY) { console.log('[safe-duty] DRY: логин пропущен'); newSinceBrand += grew; if (doBrand) newSinceBrand -= BRAND_EVERY; baseline = cnt; await sleep(checkEvery()); continue; }

      // PATROL-СЛОТ: занимаем 1 из пула 'patrol' (cap=3, общий с бэклогом/комментером/мастером через семафор БД).
      // null = свободных нет → пропускаем тик, профиль НЕ открываем (иначе суммарно >3 облачных сессий = шторм).
      const slotId = await claimPatrolSlot(acc.slug);
      if (!slotId) { console.log('[safe-duty] patrol-пул полон — пропускаю тик, не логинюсь (другой воркер держит слоты)'); await sleep(checkEvery()); continue; }

      lastLoginAt = Date.now();
      try {
        await stopSession(acc.slug); // сначала гасим возможный warmup на этом профиле
        // ФОРСИРУЕМ hl=ru: у профилей случайная локаль UI (ловили японский «コメント»), и тогда селектор
        // панели комментов (omment/оммент) не матчится → «панель не найдена». С hl=ru открывается с первого раза.
        const urlRu = cfg.duty_url + (cfg.duty_url.includes('?') ? '&' : '?') + 'hl=ru';
        await replyVia(acc.slug, urlRu, replies, doBrand);
        newSinceBrand += grew;
        if (doBrand) newSinceBrand = Math.max(0, newSinceBrand - BRAND_EVERY);
        // Пере-базируемся по факту (учитываем и наши ответы, и чужие новые за время визита).
        const after = await embedCount(code, proxies);
        baseline = (after !== null) ? after : cnt;
        console.log(`[safe-duty] визит завершён, новая база ${baseline}, до брендового ещё ${Math.max(0, BRAND_EVERY - newSinceBrand)}`);
        // КАМПАНИЯ: добор бюджета мог его исчерпать этим визитом — закрываем сразу, чтобы след. тик не лез впустую.
        if (camp) {
          const c2 = await db();
          const total2 = await answeredForCode(c2, code);
          if (total2 >= camp.budget) await closeCampaign(c2, code, `бюджет ${total2}/${camp.budget}`);
          await c2.end();
        }
      } finally {
        await releasePatrolSlot(slotId); // освобождаем слот ВСЕГДА (даже если визит упал) — иначе пул забьётся
      }
    } catch (e) {
      console.log('[safe-duty] ошибка:', String((e && e.message) || e).slice(0, 140));
      try { if (c) await c.end(); } catch { /* noop */ }
    }
    await sleep(checkEvery());
  }
})();
