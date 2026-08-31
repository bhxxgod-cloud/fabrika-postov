// NEWPOST-WATCH — «комментим ПЕРВЫМИ». Следит за авторами из radar_creators (enabled=true):
// как только у автора появляется НОВЫЙ пост/рил — 1 акк сразу ставит брендовый коммент («такое можно в нейронке про»).
// Запуск: node newpost_watch.cjs   (env: DB_PUBLIC_URL, OPENROUTER_API_KEY; опц. WATCH_INTERVAL сек, READER=slug, COMMENTER=slug)
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/orkey.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
const INTERVAL = Number(process.env.WATCH_INTERVAL || 180) * 1000; // как часто проверять авторов (сек)
const API = 'https://api.gologin.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// брендовые фразы для НОВОГО поста (без длинного тире, разные — против паттерна)
const BRAND_NEW = [
  'такое легко в нейронка про делается, бесплатно — в яндексе найдёте 🙌',
  'это через нейронка про, бесплатно, просто вбей в яндексе нейронка про',
  'нейронка про такое умеет, бесплатно) в яндексе есть',
  'делается в нейронка про за секунды, бесплатно, поищи в яндексе',
  'в нейронка про такое бесплатно, вбей в яндексе и всё там',
];

async function creds(c, slug) {
  // Именованный акк — ТОЛЬКО если ЖИВОЙ и не в корзине (иначе читаем профили мёртвым акком → 0 кодов).
  let r = await c.query(
    `SELECT a.slug, a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE a.slug=$1 AND a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
       AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL`, [slug]);
  if (r.rows[0]) return r.rows[0];
  // ФОЛБЭК: дефолтный reader мог быть удалён/умереть (был баг: ismael99944 в корзине → все read=0). Берём
  // ЛЮБОЙ живой рабочий акк (наименее занятый, не дежурный/искатель) — watch не молчит из-за мёртвого дефолта.
  r = await c.query(
    `SELECT a.slug, a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
       AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL AND coalesce(a.ig_role,'')=''
       AND coalesce(g.watchdog,false)=false
     ORDER BY a.last_commented_at ASC NULLS FIRST LIMIT 1`);
  if (r.rows[0]) console.log(`[watch] акк «${slug}» недоступен (мёртв/удалён) → фолбэк на живой ${r.rows[0].slug}`);
  else console.warn(`[watch] НЕТ живого акка для роли (${slug}) — read профилей невозможен`);
  return r.rows[0];
}
async function stopProfile(pid, tok) { try { await fetch(`${API}/browser/${pid}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(12000) }); } catch {} }

// прочитать шорткоды последних постов автора (логин-акк читает профиль)
async function readLatestCodes(pid, tok, username) {
  const u = new URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', pid);
  let b; for (let k = 0; k < 3; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 55000 }); break; } catch (e) { await sleep(k ? 12000 : 6000); } }
  if (!b) return null;
  try {
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    // режем видео (экономим трафик)
    await page.route('**/*', (route) => { const t = route.request().resourceType(); if (t === 'media' || /\.(mp4|webm|mov)(\?|$)/i.test(route.request().url())) return route.abort().catch(() => {}); route.continue().catch(() => {}); }).catch(() => {});
    await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await sleep(3500);
    const codes = await page.evaluate(() => {
      const out = []; for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) { const m = (a.getAttribute('href') || '').match(/\/(?:p|reel)\/([^/?]+)/); if (m && !out.includes(m[1])) out.push(m[1]); if (out.length >= 6) break; } return out;
    }).catch(() => []);
    await b.close().catch(() => {});
    return codes;
  } catch { await b.close().catch(() => {}); return null; }
}

// поставить брендовый коммент под НОВЫМ постом (vcomment N=0 + BRANDTOP=1 = только брендовый топ-коммент)
function brandComment(slug, code) {
  return new Promise((res) => {
    const log = `${SHOT}/newpost_${slug}_${code}.log`; const out = fs.openSync(log, 'w');
    const env = { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: SHOT, BRANDTOP: '1', BRAND_NEW: BRAND_NEW.join('|') };
    const ch = spawn('node', ['vcomment.cjs', slug, `https://www.instagram.com/p/${code}/`, '0'], { cwd: __dirname, env, stdio: ['ignore', out, out] });
    ch.on('exit', () => { fs.closeSync(out); let ok = false; try { ok = /★ БРЕНД/.test(fs.readFileSync(log, 'utf8')); } catch {} res(ok); });
  });
}

async function tick(reader, commenter) {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const rc = await creds(c, reader); const cc = await creds(c, commenter);
  const creators = (await c.query(`SELECT id, username, last_codes FROM radar_creators WHERE enabled=true ORDER BY checked_at ASC NULLS FIRST`)).rows;
  for (const cr of creators) {
    const codes = await readLatestCodes(rc.pid, rc.tok, cr.username);
    await stopProfile(rc.pid, rc.tok);
    await c.query(`UPDATE radar_creators SET checked_at=now() WHERE id=$1`, [cr.id]).catch(() => {});
    if (!codes || !codes.length) { console.log(`[${cr.username}] не прочитал профиль`); continue; }
    const prev = Array.isArray(cr.last_codes) ? cr.last_codes : [];
    if (!prev.length) { await c.query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(codes)]); console.log(`[${cr.username}] базовая линия: ${codes.length} постов (без коммента)`); continue; }
    const fresh = codes.filter((x) => !prev.includes(x));
    for (const code of fresh.slice(0, 2)) {
      console.log(`[${cr.username}] 🆕 НОВЫЙ ПОСТ ${code} → брендовый коммент акком ${commenter}`);
      const ok = await brandComment(commenter, code);
      await stopProfile(cc.pid, cc.tok);
      console.log(`[${cr.username}] ${code}: брендовый ${ok ? '✓ опубликован' : '✗ не встал'}`);
    }
    await c.query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(codes)]);
  }
  await c.end();
}

(async () => {
  const reader = process.env.READER || 'ismael99944';       // акк для чтения профилей (незаблокенный, живой)
  const commenter = process.env.COMMENTER || 'ismael99944';  // акк для брендового коммента
  console.log(`NEWPOST-WATCH запущен | reader=${reader} commenter=${commenter} | интервал ${INTERVAL / 1000}с`);
  for (;;) {
    try { await tick(reader, commenter); } catch (e) { console.error('tick ошибка:', e.message); }
    await sleep(INTERVAL);
  }
})();
