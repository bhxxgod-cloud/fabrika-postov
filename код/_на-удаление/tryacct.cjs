// ПРОВЕРКА НОВОГО АККА: поднять профиль → войти (loginInline) → вердикт по ПОЛОЖИТЕЛЬНЫМ признакам.
// Успех = живая кука сессии (тогда сразу сохраняем куки, вход больше не нужен).
// Бан = URL /accounts/suspended/ («Confirm you're human» на этом адресе = форма ОБЖАЛОВАНИЯ, не капча).
// usage: node tryacct.cjs <slug1> [slug2 ...]     env: STOP_AFTER=2 — хватит N рабочих и выходим
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const { loginInline } = require('./iglogin.cjs');
const L = require('./iglib.cjs');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const STOP_AFTER = Number(process.env.STOP_AFTER || 0);
const SHOT = process.env.SHOT_DIR || '/tmp';

global.__GL = null; let __closing = false;
async function closeLocal(why) {
  const gl = global.__GL; global.__GL = null; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { __closing = true; await closeLocal(sig); process.exit(0); });

async function tryOne(c, slug) {
  const a = (await c.query(
    `SELECT a.id, a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) ig_login, a.ig_password, a.ig_email,
            a.ig_email_password, a.totp_secret, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL LIMIT 1`, [slug])).rows[0];
  if (!a) return { slug, state: 'нет в БД' };
  if (!a.pid) return { slug, state: 'нет профиля GoLogin (сначала addacct.cjs)' };

  const { default: GoLogin } = await import('gologin');
  // glOpts гасит нативный менеджер паролей Chrome («Sign in as X» поверх формы блокировал ввод, 01.08)
  const gl = global.__GL = new GoLogin(L.glOpts({ token: a.tok, profile_id: a.pid }));
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('профиль не поднялся');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(4000); await L.clearOverlays(page);

    // 1) вдруг профиль уже залогинен или предлагает вход в один клик — это дешевле пароля
    let cls = await L.classifyScreen(ctx, page);
    if (cls.state !== 'logged_in') { await L.oneTapContinue(page, ctx, 2).catch(() => {}); cls = await L.classifyScreen(ctx, page); }
    // 2) иначе обычный вход паролём (наша штатная логика)
    if (cls.state !== 'logged_in' && cls.state !== 'suspended') {
      await loginInline(page, ctx, a, { log: (m) => console.log("    " + m), shot: async () => {} }).catch(() => {});
      await L.sleep(3000);
      cls = await L.classifyScreen(ctx, page);
    }

    if (cls.state === 'logged_in') {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', ig_status='login_ok',
          health_state='ok', health_checked_at=now(), session_checked_at=now() WHERE id=$1`, [a.id, JSON.stringify(fresh)]);
      await b.close().catch(() => {});
      return { slug, state: 'РАБОЧИЙ', cookies: fresh.length, dsUserId: cls.dsUserId };
    }
    await L.snap(page, SHOT, `try_${slug}`);
    if (cls.state === 'suspended') {
      await c.query(`UPDATE accounts SET ig_status='suspended', session_status='dead', status='paused',
          health_state='suspended', health_note='url /accounts/suspended/ — пришёл забаненным', health_checked_at=now() WHERE id=$1`, [a.id]);
    } else {
      await c.query(`UPDATE accounts SET health_state=$2, health_note=$3, health_checked_at=now() WHERE id=$1`,
        [a.id, cls.state, String(cls.evidence || '').slice(0, 200)]);
    }
    await b.close().catch(() => {});
    return { slug, state: cls.state === 'suspended' ? 'ЗАБАНЕН' : cls.state, evidence: cls.evidence };
  } finally { await closeLocal('one'); }
}

(async () => {
  const slugs = process.argv.slice(2);
  if (!slugs.length) { console.log('usage: node tryacct.cjs <slug1> [slug2 ...]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, statement_timeout: 25000 }); await c.connect();
  console.log(`ПРОВЕРЯЮ ВХОД: ${slugs.length} акк(ов)${STOP_AFTER ? `, стоп после ${STOP_AFTER} рабочих` : ''}\n`);
  let ok = 0;
  for (const s of slugs) {
    if (__closing) break;
    let r; try { r = await tryOne(c, s); } catch (e) { r = { slug: s, state: 'ошибка: ' + String(e.message).slice(0, 80) }; }
    const icon = r.state === 'РАБОЧИЙ' ? '✅' : r.state === 'ЗАБАНЕН' ? '⛔' : '🟡';
    console.log(`${icon} @${r.slug}: ${r.state}${r.cookies ? ` (кук ${r.cookies})` : ''}${r.evidence ? ' · ' + String(r.evidence).slice(0, 60) : ''}`);
    if (r.state === 'РАБОЧИЙ') { ok++; if (STOP_AFTER && ok >= STOP_AFTER) break; }
    await L.sleep(4000);
  }
  console.log(`\nИТОГ: рабочих ${ok} из ${slugs.length} проверенных`);
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
