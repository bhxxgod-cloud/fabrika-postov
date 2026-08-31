// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
// BACKLOG BRIGADE — 2 акка отвечают на СТАРЫЕ неотвеченные просьбы промпта на ГЛАВНОМ посту (duty_url).
// Отдельный контур от дежурства (те ловят СВЕЖИЕ <2ч). Дедуп общий через post_answered → бэклог берёт
// тех, кому дежурные ещё НЕ ответили (то есть более старых/зарытых).
//
// РИТМ (по ТЗ владельца): 2 воркера по 5 ответов/час В ШАХМАТКУ — воркер A в первые ~30 мин, воркер B в
// следующие. Ротация LRU (кто дольше не работал) сама чередует A/B. Через ~час проверяем живость: забанен →
// замена из ОБЩЕГО пула (НЕ из дежурных). Поиск коммента ограничен глубиной скролла + жёстким таймаутом сессии.
//
// Запуск: node backlog_safe.cjs   (Ctrl+C — стоп). DRY=1 — без реального логина/ответа (проверка отбора).
// env: DB_PUBLIC_URL|/tmp/dburl.txt, OPENROUTER_API_KEY|/tmp/orkey.txt,
//      TICK_MIN(30) — период между заходами (шахматка), BACKLOG_TARGET(2), BACKLOG_PER_VISIT(5),
//      MAXPASS(35) — глубина скролла поиска (больше=глубже старые, но дольше), SESSION_MAX_SEC(420) — жёсткий
//      потолок сессии (≈5 ответов × ~60-80с поиска), CTA_WORDS — доп-слова спроса под конкретный пост.
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || (fs.existsSync('/tmp/orkey.txt') ? fs.readFileSync('/tmp/orkey.txt', 'utf8').trim() : '');
const TICK = Number(process.env.TICK_MIN || 60) * 60000;        // заход раз в час (реже — комментов много летит)
const TARGET = Number(process.env.BACKLOG_TARGET || 2);
const PER_VISIT = Number(process.env.BACKLOG_PER_VISIT || 2);    // 2 коммента за заход (было 5)
const MAXPASS = Number(process.env.MAXPASS || 35);
const SESSION_MAX = Number(process.env.SESSION_MAX_SEC || 420) * 1000;
const DRY = process.env.DRY === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

// Перед логином глушим ЛЮБУЮ активную GoLogin-сессию профиля — чтобы не столкнуться с фоновым warmup воркера
// (две сессии на одном профиле = крэш/риск). Пул слотов общий, так что чистим свой профиль перед заходом.
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
    await sleep(15000); // дать слоту освободиться перед своим коннектом
  } catch { /* best-effort */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

// Держим ровно TARGET годных бэклог-акков. Негодных (dead/пауза/бан) → в общий пул; недобор → из ОБЩЕГО пула,
// исключая И дежурных (watchdog) И бэклог (backlog) — двусторонняя изоляция ростеров. Это и есть «забанен → берём новые».
async function maintainRoster(c, code) {
  const BL = "(SELECT id FROM account_groups WHERE coalesce(backlog,false)=true ORDER BY id LIMIT 1)";
  const GEN = "(SELECT id FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)";
  await c.query(`UPDATE accounts SET group_id=${GEN} WHERE group_id=${BL} AND deleted_at IS NULL
     AND (coalesce(session_status,'')='dead' OR status IN ('paused','trash') OR coalesce(ig_status,'') IN ('challenge','bad_login','captcha','suspended'))`).catch(() => {});
  const cur = (await c.query(`SELECT count(*)::int AS n FROM accounts a WHERE a.group_id=${BL} AND a.deleted_at IS NULL`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  if (cur < TARGET) {
    const add = (await c.query(
      `UPDATE accounts SET group_id=${BL} WHERE id IN (
         SELECT a.id FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
           AND a.status NOT IN ('paused','trash') AND a.gologin_profile_id IS NOT NULL
           AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended')
           AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
           AND (a.commenting_at IS NULL OR a.commenting_at < now() - interval '15 minutes') -- НЕ выдёргиваем акк, занятый комментингом ПОСТИНГА (урок karter)
           AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
         ORDER BY a.last_commented_at ASC NULLS FIRST LIMIT $2)
       RETURNING slug`, [code, TARGET - cur]).catch(() => ({ rows: [] }))).rows;
    if (add.length) console.log(`[backlog] замена/добор до ${TARGET}: ${add.map((x) => x.slug).join(', ')}`);
  }
}

// Следующий бэклог-воркер на заход — из бэклог-группы, LRU (так A/B чередуются в шахматку).
async function pickWorker(c, code) {
  const r = await c.query(
    `SELECT a.slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE coalesce(g.backlog,false)=true AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
       AND a.status NOT IN ('paused','trash') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended')
       AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
     ORDER BY a.last_commented_at ASC NULLS FIRST LIMIT 1`, [code]);
  return r.rows[0] ? r.rows[0].slug : null;
}

// ТИХИЙ отчёт в Телеграм (disable_notification=true — без звука/уведомления). Best-effort, не роняет движок.
function tgReport(text) {
  try {
    const bot = fs.existsSync('/tmp/tg_bot.txt') ? fs.readFileSync('/tmp/tg_bot.txt', 'utf8').trim() : (process.env.TELEGRAM_BOT_TOKEN || '');
    const chat = fs.existsSync('/tmp/tg_chat.txt') ? fs.readFileSync('/tmp/tg_chat.txt', 'utf8').trim() : (process.env.TELEGRAM_CHAT_ID || '');
    if (!bot || !chat) return;
    fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_notification: true, disable_web_page_preview: true }) }).catch(() => {});
  } catch { /* noop */ }
}

// Ответ через готовый vcomment.cjs (реплай в ветку, дедуп по post_answered). MAXPASS ограничивает глубину
// поиска; жёсткий таймаут убивает сессию. Перехватываем вывод → на КАЖДЫЙ ответ шлём тихий отчёт в ТГ.
function replyVia(slug, url, n) {
  return new Promise((res) => {
    const p = spawn('node', [path.join(DIR, 'vcomment.cjs'), slug, url, String(n)], {
      cwd: DIR,
      env: { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: process.env.SHOT_DIR || '/tmp', MAXPASS: String(MAXPASS) },
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let buf = '', cnt = 0;
    p.stdout.on('data', (d) => {
      process.stdout.write(d); // лог как раньше
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/✓ ВЕТКА (@\S+)\s*\|\s*(.+)/);
        if (m) { cnt++; tgReport(`🗄 БЭКЛОГ · ${slug}\n→ ${m[1]}\n«${m[2].trim()}»`); }
      }
    });
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); console.log('[backlog] сессия превысила лимит — прервал'); } catch { /* noop */ } }, SESSION_MAX);
    p.on('exit', () => { clearTimeout(killer); if (cnt) tgReport(`🗄 БЭКЛОГ · ${slug}: заход завершён, ответов ${cnt}`); res(); });
    p.on('error', () => { clearTimeout(killer); res(); });
  });
}

(async () => {
  console.log(`[backlog] старт. заход раз в ${TICK / 60000}мин, ${PER_VISIT} коммента/заход, LRU-чередование 2 воркеров | restart-safe | MAXPASS=${MAXPASS} | сессия<=${SESSION_MAX / 1000}с | забанен→замена из пула${DRY ? ' | DRY-RUN' : ''}`);
  for (;;) {
    let c;
    try {
      c = await db();
      const cfg = (await c.query('SELECT duty_url FROM radar_config WHERE id=1')).rows[0];
      const code = (String(cfg && cfg.duty_url || '').match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
      if (!code) { console.log('[backlog] duty_url не задан — жду'); await c.end(); await sleep(TICK); continue; }
      await maintainRoster(c, code);
      // RESTART-SAFE: не запускаем заход, если бэклог уже отрабатывал за последний TICK (защита от бурста
      // при перезапуске движка — иначе каждый рестарт даёт немедленный лишний заход). last_commented_at
      // бэклог-акков обновляется ТОЛЬКО их заходами (группа исключена из общего комментинга).
      const lastRow = (await c.query(`SELECT max(a.last_commented_at) AS t FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE coalesce(g.backlog,false)=true AND a.deleted_at IS NULL`).catch(() => ({ rows: [{}] }))).rows[0];
      if (lastRow && lastRow.t && (Date.now() - new Date(lastRow.t).getTime()) < TICK) {
        const agoMin = Math.round((Date.now() - new Date(lastRow.t).getTime()) / 60000);
        console.log(`[backlog] заход был ${agoMin}мин назад (< ${TICK / 60000}мин) — жду, не частим`);
        await c.end(); await sleep(TICK); continue;
      }
      const slug = await pickWorker(c, code);
      await c.end();
      if (!slug) { console.log('[backlog] нет годного бэклог-акка (все заняты/на лимите) — жду'); await sleep(TICK); continue; }
      console.log(`[backlog] ${slug} → отрабатывает старые комменты (до ${PER_VISIT})`);
      if (DRY) { console.log('[backlog] DRY: логин пропущен'); await sleep(TICK); continue; }
      await stopSession(slug); // сначала гасим возможный warmup на этом профиле
      await replyVia(slug, cfg.duty_url, PER_VISIT);
      console.log(`[backlog] ${slug} завершил заход`);
    } catch (e) {
      console.log('[backlog] ошибка:', String((e && e.message) || e).slice(0, 140));
      try { if (c) await c.end(); } catch { /* noop */ }
    }
    await sleep(TICK);
  }
})();
