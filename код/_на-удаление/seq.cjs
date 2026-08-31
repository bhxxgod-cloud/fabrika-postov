// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА pkill/kill -9. 2) Один профиль — одна сессия. 3) Ручной акк не трогать.
// 4) Не висим >60с. 5) Успех = композер очистился.
//
// SEQ — последовательный бэклог-прогон под постом Алины (приказ владельца). ПО ОДНОМУ акку: открыл → до PER
// ответов неотвеченным за окно свежести → закрыл → следующий. Цель GOAL уникальных. Окно: 24ч, при исчерпании → 48ч.
//
// БЕЗОПАСНОСТЬ (урок karter): акки берём ТОЛЬКО из выделенных групп (watchdog/backlog). Нехватка → добираем
// свежих из общего пула В группу, но ТОЛЬКО не занятых комментингом ПОСТИНГА (commenting_at пуст). Так не бьёмся.
//
// Запуск: DB_PUBLIC_URL=… OPENROUTER_API_KEY=… GL_LOCAL=1 node seq.cjs
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawn } = require('child_process');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/orkey.txt', 'utf8').trim();
const URL = process.env.TARGET_URL || 'https://www.instagram.com/p/DZQe5pIIP-C/'; // /p/ — панель рендерится надёжнее
const CODE = (URL.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
const PER = Number(process.env.PER || 5);
const GOAL = Number(process.env.GOAL || 50);
const MAXPASS = process.env.MAXPASS || '70';
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 40); // предохранитель
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }
const skip = new Set();
let freshH = 24;        // окно свежести: старт 24ч
let dryStreak = 0;      // подряд «залогинен, но целей в окне нет» → расширяем окно
let used = 0, degraded = 0, dry = 0;

async function goalCount() { const c = await db(); const n = (await c.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [CODE])).rows[0].n; await c.end(); return n; }

// PATROL-СЛОТ (П1.2): claim перед облачным connect, release после. Пул patrol cap=3 (дежурство/бэклог/newpost).
async function claimPatrol(slug) {
  let c; try { c = await db(); const r = await c.query("SELECT claim_gologin_slot('patrol', $1, 3, 15) AS id", [slug]); return (r.rows[0] && r.rows[0].id) || null; }
  catch { return null; } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}
async function releasePatrol(id) {
  if (!id) return; let c; try { c = await db(); await c.query('SELECT release_gologin_slot($1)', [id]); }
  catch { /* TTL 15мин подстрахует */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

// Кандидат из ВЫДЕЛЕННЫХ групп (watchdog/backlog): live, не блок Алины, не suspended, commenting_at пуст, не в skip.
async function pickFromDedicated() {
  const c = await db();
  try {
    const ex = [...skip]; const exArr = ex.length ? ex : ['__none__'];
    const r = await c.query(
      `SELECT a.slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
       WHERE (coalesce(g.watchdog,false) OR coalesce(g.backlog,false)) AND a.deleted_at IS NULL
         AND coalesce(a.session_status,'')='live' AND a.status NOT IN ('paused','trash','suspended')
         AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended','action_block')
         AND a.gologin_profile_id IS NOT NULL
         AND (a.commenting_at IS NULL OR a.commenting_at < now() - interval '15 minutes')
         AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
         AND a.slug <> ALL($2)
       ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at ASC NULLS FIRST LIMIT 1`, [CODE, exArr]);
    return r.rows[0] ? r.rows[0].slug : null;
  } finally { await c.end(); }
}

// Добор свежих из общего пула В группу «Бэклог» (безопасно: commenting_at пуст → не выдёргиваем из-под ПОСТИНГА).
async function refillDedicated(n) {
  const c = await db();
  try {
    const bk = (await c.query("SELECT id FROM account_groups WHERE coalesce(backlog,false)=true ORDER BY id LIMIT 1")).rows[0];
    if (!bk) return 0;
    const moved = (await c.query(
      `UPDATE accounts SET group_id=$1 WHERE id IN (
         SELECT a.id FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
           AND a.status NOT IN ('paused','trash','suspended')
           AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended','action_block')
           AND a.gologin_profile_id IS NOT NULL
           AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
           AND (a.commenting_at IS NULL OR a.commenting_at < now() - interval '15 minutes')
           AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$2 AND b.blocked)
         ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at ASC NULLS FIRST LIMIT $3)
       RETURNING slug`, [bk.id, CODE, n])).rows.map((x) => x.slug);
    if (moved.length) console.log(`[seq] добрал в выделенную группу: ${moved.join(', ')}`);
    return moved.length;
  } finally { await c.end(); }
}

async function stopSession(slug) {
  let c;
  try {
    c = await db();
    const r = (await c.query(`SELECT a.gologin_profile_id AS pid, coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
      FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [slug])).rows[0];
    await c.end(); c = null;
    if (r && r.pid && r.tok) { await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {}); await sleep(8000); }
  } catch { /* noop */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

function runOne(slug) {
  return new Promise((res) => {
    let out = '';
    const env = { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: process.env.SHOT_DIR || '/tmp',
      GL_LOCAL: '', MAXPASS, FRESH_H: String(freshH), FRESH_RELAX_PASS: '999' }; // GL_LOCAL='' → ОБЛАКО (шторм снят); 999 = ЖЁСТКОЕ окно
    const p = spawn('node', [path.join(DIR, 'vcomment.cjs'), slug, URL, String(PER)], { cwd: DIR, env });
    p.stdout.on('data', (d) => { out += d; process.stdout.write(`[${slug}] ` + String(d).replace(/\n$/, '').split('\n').join(`\n[${slug}] `) + '\n'); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    const killer = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* noop */ } }, 13 * 60000);
    p.on('exit', () => {
      clearTimeout(killer);
      const m = out.match(/RESULT done=(\d+)/); const d = m ? +m[1] : 0;
      const degr = d === 0 && /недоступн|панель не открылась|РАЗЛОГИН|logged_out|ограничение времени|блок автора|suspended|заблокирован|ACTION_BLOCK|action.?block|Couldn.?t post|коммент НЕ сел|We restrict/i.test(out);
      res({ done: d, degraded: degr });
    });
    p.on('error', () => { clearTimeout(killer); res({ done: 0, degraded: true }); });
  });
}

(async () => {
  const before = await goalCount();
  console.log(`[seq] 🎯 ПРОГОН | пост ${CODE} | цель ${GOAL} уник | по одному акку, до ${PER}/акк | окно 24ч→48ч | старт post_answered ${before}`);
  for (;;) {
    const grew = (await goalCount()) - before;
    if (grew >= GOAL) { console.log(`[seq] ✅ ЦЕЛЬ ${GOAL} достигнута (в БД +${grew})`); break; }
    if (used >= MAX_ACCOUNTS) { console.log(`[seq] предохранитель MAX_ACCOUNTS=${MAX_ACCOUNTS} — стоп`); break; }
    let slug = await pickFromDedicated();
    if (!slug) { const got = await refillDedicated(6); slug = got ? await pickFromDedicated() : null; }
    if (!slug) { console.log(`[seq] 🔴 выделенных акков не осталось (и добор пуст) — нужны свежие патроны. Сделано +${grew}/${GOAL}`); break; }
    // PATROL-слот перед облачным заходом (П1.2). Пул полон (3/3) — ждём, акк НЕ занимаем.
    const slotId = await claimPatrol(slug);
    if (!slotId) { console.log('[seq] patrol-пул полон (3/3) — жду слот 20с, не логинюсь'); await sleep(20000); continue; }
    used++;
    console.log(`\n[seq] ▶ акк ${used}: ${slug} | окно ${freshH}ч | в БД +${grew}/${GOAL} | деград ${degraded}, пусто ${dry}`);
    let r;
    try { await stopSession(slug); r = await runOne(slug); }
    finally { await releasePatrol(slotId); } // release ВСЕГДА (П1.2), даже если заход упал
    if (r.degraded) { degraded++; skip.add(slug); dryStreak = 0; console.log(`[seq] ⚠ ${slug} деградировал (разлогин/блок/action) → skip, следующий`); }
    else if (r.done === 0) {
      dry++; dryStreak++; skip.add(slug); // залогинен, но целей в окне нет
      console.log(`[seq] · ${slug}: залогинен, но неотвеченных по спросу за ${freshH}ч не нашёл (dryStreak ${dryStreak})`);
      if (dryStreak >= 2) {
        if (freshH === 24) { freshH = 48; dryStreak = 0; skip.clear(); console.log(`[seq] 🕐 окно 24ч исчерпано → РАСШИРЯЮ до 48ч`); }
        else { console.log(`[seq] 🔴 и за 48ч неотвеченного спроса не осталось — СТОП (пост старый, свежих аскеров нет). Доложу владельцу.`); break; }
      }
    } else { dryStreak = 0; console.log(`[seq] ✓ ${slug}: ответов ${r.done}`); }
    await sleep(5000);
  }
  const after = await goalCount();
  console.log(`\n[seq] СТОП. акков ${used}, деград ${degraded}, пусто ${dry}. post_answered ${before}→${after} (+${after - before} уникальных)`);
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 160)));
