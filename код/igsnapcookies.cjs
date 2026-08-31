// СНЯТИЕ КУК с уже залогиненного профиля Orbita → в accounts.ig_cookies.
// Зачем: постер igpost2 стартует только при наличии кук сессии в БД. Профиль может быть залогинен
// (сессия внутри Orbita), но ig_cookies пуст → постер не откроет. Этот скрипт замыкает круг:
// открывает профиль, ПОЛОЖИТЕЛЬНО подтверждает вход (classifyScreen=logged_in) и сохраняет куки.
// Логику НЕ дублируем — берём из iglib. Запуск: node igsnapcookies.cjs "<slug>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const L = require('./iglib.cjs');
const SLUG = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';

global.__GL = null;
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });

(async () => {
  if (!SLUG) { console.log('usage: node igsnapcookies.cjs <slug>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT a.id, a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) h, a.persona, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug=$1 AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL
      ORDER BY (coalesce(a.ig_password,'')<>'') DESC LIMIT 1`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден / нет профиля'); await c.end(); process.exit(1); }
  console.log(`СНИМАЮ КУКИ с @${row.h}${row.persona ? ` (${row.persona})` : ''}`);

  const { default: GoLogin } = await import('gologin');
  // HEADLESS по умолчанию (правило начальника 06.08: окна Chrome не открывать). SHOW=1 — видимое окно.
  const extra = process.env.SHOW === '1' ? [] : ['--headless=new'];
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid, extra }));
  let ok = false, err = null;
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(6000); await L.clearOverlays(page);
    // ВХОД В ОДИН КЛИК: «Continue as X» = сохранённая сессия профиля, пароль не нужен → нет капчи.
    const tap = await L.oneTapContinue(page, ctx);
    console.log(`  🔓 one-tap Continue: ${tap.ok ? `вошли (кликов ${tap.clicks})` : 'нет — ' + tap.reason}`);
    await L.clearOverlays(page);
    const cls = await L.step(page, SHOT, 'подтверждение входа', async () => {
      const r = await L.classifyScreen(ctx, page);
      if (r.state !== 'logged_in') throw new Error(`экран=${r.state} (${r.evidence}) — профиль НЕ залогинен, куки снимать нечего`);
      return r;
    });
    const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
    if (!fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) throw new Error('в контексте нет живой sessionid');
    await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', session_checked_at=now() WHERE id=$1`, [row.id, JSON.stringify(fresh)]);
    console.log(`  💾 куки сохранены (${fresh.length}, ds_user_id=${cls.dsUserId})`);
    ok = true;
    await b.close().catch(() => {});
  } catch (e) { err = String(e.message).slice(0, 200); }
  console.log(`ИТОГ: ${ok ? '✅ куки сняты и сохранены' : '✗ не вышло: ' + err}`);
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
