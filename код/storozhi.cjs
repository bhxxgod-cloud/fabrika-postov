// storozhi.cjs — АВТО-СЛЕЖКА за креаторами (апгрейд newpost_watch): пул-чтение + baseline + спайк-детект.
// ОДИН ТИК: читает конфиг (radar_config), берёт креаторов по каденсу, читает грид РОТАЦИЕЙ облачных работяг
// (не один акк = страховка), считает baseline комментов, ловит спайк, пишет здоровье. Действия (бренд/мобилизация)
// в storozhi_act.cjs. Гейт storozhi_enabled. usage: node storozhi.cjs [--dry]
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const DRY = process.argv.includes('--dry');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = () => new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 25000 });
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// читать грид креатора ОДНИМ облачным работягой (по его профилю). Возвращает [{code}] или null (не смог).
async function readGridVia(driver, username) {
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect');
  u.searchParams.set('token', driver.tok); u.searchParams.set('profile', driver.pid);
  let b = null;
  for (let k = 0; k < 3 && !b; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 45000 }); } catch { await sleep(k ? 12000 : 18000); } }
  // ВАЖНО (ревью 28.07): коннект отвалился по таймауту, но профиль GoLogin УЖЕ подняла → это и есть висящая
  // оплачиваемая сессия. Гасим её явно, иначе часы текут именно в этом сценарии.
  if (!b) { await fetch('https://api.gologin.com/browser/' + driver.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + driver.tok } }).catch(() => {}); return null; }
  if (!b) return null;
  try {
    const ctx = b.contexts()[0] || (await b.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(4500);
    const codes = await page.evaluate(() => {
      const seen = [];
      for (const el of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
        const m = (el.getAttribute('href') || '').match(/\/(p|reel)\/([^/?]+)/);
        if (m && !seen.includes(m[2])) seen.push(m[2]);
      }
      return seen.slice(0, 12);
    }).catch(() => []);
    // счётчик комментов ТОП-поста (первый в гриде) — открываем его быстро
    return codes.length ? { codes } : null;
  } catch { return null; } finally { await b.close().catch(() => {}); // сначала CDP…
      await fetch('https://api.gologin.com/browser/' + driver.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + driver.tok } }).catch(() => {}); // …потом гасим сам профиль (close() его не гасит)
  }
}

// прочитать comment_count поста (тем же драйвером, отдельный заход) — для baseline/спайка
async function readPostCC(driver, code) {
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect');
  u.searchParams.set('token', driver.tok); u.searchParams.set('profile', driver.pid);
  let b = null; try { b = await chromium.connectOverCDP(u.toString(), { timeout: 40000 }); } catch { return null; }
  try {
    const ctx = b.contexts()[0] || (await b.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`https://www.instagram.com/reel/${code}/`, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(4000);
    // 1) из встроенного JSON страницы ("comment_count":N) — самый надёжный
    const html = await page.content().catch(() => '');
    let cc = null;
    const mj = html.match(/"comment_count":\s*(\d+)/);
    if (mj) cc = parseInt(mj[1], 10);
    // 2) фолбэк: видимый текст «N comments / показать все N комментариев»
    if (cc == null) cc = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/(?:показать все|view all|all)\s*([\d\s.,]+)\s*(?:comments|комментари)/i) || t.match(/([\d\s.,]{1,9})\s*(?:comments|комментари)/i);
      return m ? (parseInt(m[1].replace(/\D/g, ''), 10) || 0) : null;
    }).catch(() => null);
    return cc;
  } catch { return null; } finally { await b.close().catch(() => {}); // сначала CDP…
      await fetch('https://api.gologin.com/browser/' + driver.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + driver.tok } }).catch(() => {}); // …потом гасим сам профиль (close() его не гасит)
  }
}

async function tick() {
  const c = db(); await c.connect();
  try {
  const cfg = (await c.query(`SELECT storozhi_enabled, creator_poll_min, spike_mult, spike_workers, brand_new_post, mobilize_spike, tier1_burn_fresh FROM radar_config WHERE id=1`)).rows[0] || {};
  if (!cfg.storozhi_enabled && !DRY) { console.log('⏸ storozhi_enabled=false — слежка выключена (тумблер в панели)'); await c.end(); return; }
  const pollMin = Number(cfg.creator_poll_min) || 60;
  const spikeMult = Number(cfg.spike_mult) || 2.5;
  // пул драйверов-читателей (живые работяги с профилем) — РОТАЦИЯ, не один
  const drivers = (await c.query(`SELECT a.slug, a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live' AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
     ORDER BY coalesce(a.comments_today,0) ASC LIMIT 8`)).rows;
  if (!drivers.length) { console.log('⛔ нет живых драйверов-читателей'); await c.end(); return; }
  // креаторы по каденсу: checked_at старше poll ИЛИ hot_until активен (чекать чаще)
  const creators = (await c.query(`SELECT id, username, last_codes, post_history, baseline_cc, read_fails FROM radar_creators
     WHERE enabled=true AND cr_status<>'banned'
       AND (checked_at IS NULL OR checked_at < now() - ($1||' minutes')::interval OR (hot_until IS NOT NULL AND hot_until > now() AND checked_at < now() - interval '15 minutes'))
     ORDER BY checked_at ASC NULLS FIRST`, [pollMin])).rows;
  console.log(`СТОРОЖИ тик: креаторов к проверке ${creators.length} | драйверов ${drivers.length} | каденс ${pollMin}м | спайк ×${spikeMult}${DRY ? ' | DRY' : ''}`);
  let di = 0;
  const newPosts = []; // {creatorId, username, code, cc, spike}
  for (const cr of creators) {
    // ротация драйвера + фолбэк на следующего при фейле
    let grid = null;
    for (let t = 0; t < Math.min(3, drivers.length) && !grid; t++) { grid = await readGridVia(drivers[(di++) % drivers.length], cr.username); }
    if (!grid) {
      const rf = (cr.read_fails || 0) + 1;
      const status = rf >= 4 ? 'unreadable' : 'ok';
      await c.query(`UPDATE radar_creators SET read_fails=$2, cr_status=$3, checked_at=now() WHERE id=$1`, [cr.id, rf, status]).catch(() => {});
      console.log(`  [${cr.username}] ✗ не прочитан (fail ${rf}${rf >= 4 ? ', unreadable' : ''})`);
      continue;
    }
    await c.query(`UPDATE radar_creators SET read_fails=0, cr_status='ok', checked_at=now() WHERE id=$1`, [cr.id]).catch(() => {});
    const prev = Array.isArray(cr.last_codes) ? cr.last_codes : [];
    const fresh = grid.codes.filter((x) => !prev.includes(x));
    if (!prev.length) { await c.query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(grid.codes)]).catch(() => {}); console.log(`  [${cr.username}] базовая линия ${grid.codes.length}`); continue; }
    if (!fresh.length) { await c.query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(grid.codes)]).catch(() => {}); console.log(`  [${cr.username}] нового нет`); continue; }
    // новый пост(ы): читаем comment_count самого свежего, обновляем baseline, детектим спайк
    const hist = Array.isArray(cr.post_history) ? cr.post_history : [];
    for (const code of fresh.slice(0, 2)) {
      const cc = await readPostCC(drivers[(di++) % drivers.length], code);
      const base = cr.baseline_cc != null ? Number(cr.baseline_cc) : median(hist.map((h) => h.cc).filter((x) => x != null));
      const spike = base != null && cc != null && cc > base * spikeMult;
      hist.push({ code, cc, ts: Date.now() });
      const newBase = median(hist.slice(-10).map((h) => h.cc).filter((x) => x != null));
      await c.query(`UPDATE radar_creators SET post_history=$2, baseline_cc=$3, last_post_at=now()${spike ? ", hot_until=now()+interval '4 hours'" : ''} WHERE id=$1`,
        [cr.id, JSON.stringify(hist.slice(-20)), newBase]).catch(() => {});
      newPosts.push({ creatorId: cr.id, username: cr.username, code, cc, base, spike });
      console.log(`  [${cr.username}] 🆕 ${code} · комментов ${cc ?? '?'} · база ${base ?? '?'} ${spike ? '🔥 СПАЙК' : ''}`);
    }
    await c.query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(grid.codes)]).catch(() => {});
  }
  // очередь действий → в radar_posts (source=creator), бренд/мобилизацию делает storozhi_act
  for (const np of newPosts) {
    await c.query(`INSERT INTO radar_posts (code, tag, url, status, source, score, comment_count, taken_at)
       VALUES ($1,$2,$3,'new','creator',$4,$5,now())
       ON CONFLICT (code) DO UPDATE SET status='new', source='creator', score=greatest(radar_posts.score,$4), comment_count=$5`,
      [np.code, `креатор @${np.username}${np.spike ? ' 🔥' : ''}`, `https://www.instagram.com/reel/${np.code}/`, np.spike ? 95 : 90, np.cc || 0]).catch(() => {});
  }
  // === СЛОЙ ДЕЙСТВИЙ (не в DRY): бренд на новый пост + мобилизация работяг на спайк ===
  const { execFileSync } = require('child_process');
  const brandAcc = async () => (await c.query(`SELECT slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live'
       AND coalesce(a.ig_status,'') NOT IN ('action_block','soft_block','captcha','challenge','bad_login','suspended','profile_lost')
       AND (a.shadow_at IS NULL OR a.shadow_at < now()-interval '2 days') AND coalesce(a.comments_today,0) < 8
       AND a.last_commented_at IS NOT NULL
     ORDER BY coalesce(a.comments_today,0) ASC, random() LIMIT 1`)).rows[0]?.slug;
  const spawn = (args, env) => { try { execFileSync('node', args, { cwd: '/Users/qq/Desktop/neironka-poster', encoding: 'utf8', timeout: 340000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); return true; } catch { return false; } };
  for (const np of newPosts) {
    if (DRY) { console.log(`  [DRY] ${np.code}: бренд${np.spike ? ' + мобилизация ' + cfg.spike_workers : ''}`); continue; }
    const url = `https://www.instagram.com/reel/${np.code}/`;
    if (cfg.brand_new_post) {
      const acc = await brandAcc();
      if (acc) { const ok = spawn(['vcomment.cjs', acc, url, '0'], { BRANDTOP: '1' }); console.log(`  [${np.username}] бренд ${np.code} акком ${acc}: ${ok ? '✓' : '✗'}`); }
      else console.log(`  [${np.username}] бренд ${np.code}: нет свободного акка`);
    }
    if (np.spike && cfg.mobilize_spike) {
      const n = Number(cfg.spike_workers) || 6;
      console.log(`  [${np.username}] 🔥 СПАЙК ${np.code} → мобилизация ${n} работяг (runtask)`);
      spawn(['runtask.cjs', url, String(n), '2', '0'], { CTA_POST: '1', FRESH_MAX: '168' });
    }
  }
  console.log(`ИТОГ: новых постов ${newPosts.length}, спайков ${newPosts.filter((x) => x.spike).length}`);
  } finally { await c.end().catch(() => {}); }
}

// главный цикл движка: engines.cjs держит процесс живым, тик по STOROZHI_LOOP_MIN (per-креатор каденс в SQL-фильтре)
(async () => {
  if (DRY) { await tick().catch((e) => console.log('FATAL', e.message)); return; }
  const LOOP = Number(process.env.STOROZHI_LOOP_MIN || 10) * 60000;
  console.log(`[storozhi] движок запущен, тик каждые ${LOOP / 60000}м`);
  for (;;) { try { await tick(); } catch (e) { console.log('[storozhi] тик упал:', e.message); } await sleep(LOOP); }
})();
