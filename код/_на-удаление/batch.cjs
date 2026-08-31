// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
//
// BATCH — разовый прогон бэклога по МНОГИМ аккам подряд, когда нужен объём быстро (движок backlog_safe даёт
// ~9 комм/час, этого мало). Идём СТРОГО ПОСЛЕДОВАТЕЛЬНО (CONC=1): параллельный подъём профилей ловит
// cloud-штормы GoLogin — проверено, гоняем по одному.
//
// Запуск: DB_PUBLIC_URL=… OPENROUTER_API_KEY=… node batch.cjs [сколько_комм_на_акк] [сколько_акков]
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawn } = require('child_process');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/orkey.txt', 'utf8').trim();
const PER = Number(process.argv[2] || 3);          // комментов на акк (3 = наш потолок подряд с одного)
const LIMIT = Number(process.argv[3] || 14);       // сколько акков прогнать
const URL = process.env.TARGET_URL || 'https://www.instagram.com/reel/DZQe5pIIP-C/';
const CODE = (URL.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
const MAXPASS = process.env.MAXPASS || '45';
const GAP = Number(process.env.GAP_SEC || 45) * 1000; // пауза между акками
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

// Берём ЖИВЫХ, не заблокированных автором поста, обкатанных (кто уже комментил и выжил — устойчивее нулёвок).
// Дежурных исключаем: они на смене, их трогает duty_safe (иначе два движка полезут в один профиль).
async function pick(c) {
  const r = await c.query(
    `SELECT a.slug FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND a.deleted_at IS NULL
       AND coalesce(a.session_status,'')='live'
       AND a.status NOT IN ('paused','trash') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha')
       AND coalesce(g.watchdog,false)=false
       AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
     ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at ASC NULLS FIRST
     LIMIT $2`, [CODE, LIMIT]);
  return r.rows.map((x) => x.slug);
}

// Гасим облачную сессию профиля перед заходом — иначе «профиль занят» (тот же обход, что в duty/backlog).
async function stopSession(slug) {
  let c;
  try {
    c = await db();
    const r = (await c.query(`SELECT a.gologin_profile_id AS pid, coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
      FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [slug])).rows[0];
    await c.end(); c = null;
    if (r && r.pid && r.tok) {
      await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {});
      await sleep(12000);
    }
  } catch { /* noop */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

function run(slug) {
  return new Promise((res) => {
    let out = '';
    const p = spawn('node', [path.join(DIR, 'vcomment.cjs'), slug, URL, String(PER)], {
      cwd: DIR,
      env: { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: process.env.SHOT_DIR || '/tmp', MAXPASS },
    });
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    // Жёсткий потолок на акк, чтобы один зависший не съел весь прогон.
    const killer = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* noop */ } }, 11 * 60000);
    p.on('exit', () => {
      clearTimeout(killer);
      const m = out.match(/RESULT done=(\d+) brand=(\d+) blocked=(\d+)/);
      res(m ? { done: +m[1], brand: +m[2], blocked: +m[3] } : { done: 0, brand: 0, blocked: 0 });
    });
    p.on('error', () => { clearTimeout(killer); res({ done: 0, brand: 0, blocked: 0 }); });
  });
}

(async () => {
  const c = await db();
  const slugs = await pick(c);
  const before = (await c.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [CODE])).rows[0].n;
  await c.end();
  console.log(`[batch] акков: ${slugs.length} × до ${PER} комм = потолок ${slugs.length * PER} | post_answered сейчас ${before}`);
  console.log(`[batch] очередь: ${slugs.join(', ')}\n`);

  let done = 0, brand = 0, blocked = 0, i = 0;
  for (const slug of slugs) {
    i++;
    console.log(`\n===== [${i}/${slugs.length}] ${slug} =====`);
    await stopSession(slug);
    const r = await run(slug);
    done += r.done; brand += r.brand; blocked += r.blocked;
    console.log(`--- ${slug}: ответов ${r.done}, бренд ${r.brand}${r.blocked ? ', ЗАБЛОКИРОВАН' : ''} | ИТОГО ответов ${done} ---`);
    if (i < slugs.length) await sleep(GAP);
  }

  const c2 = await db();
  const after = (await c2.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [CODE])).rows[0].n;
  await c2.end();
  console.log(`\n[batch] ГОТОВО. ответов ${done}, бренд ${brand}, заблокировано акков ${blocked}`);
  console.log(`[batch] post_answered: ${before} → ${after} (+${after - before})`);
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 160)));
