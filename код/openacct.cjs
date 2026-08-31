// ОТКРЫТЬ ПРОФИЛЬ АККА И ОСТАВИТЬ ОКНО ВЛАДЕЛЬЦУ (никаких действий скриптом).
// Зачем: IG на вход паролём показывает «Confirm you're human» — проверку на человека проходит ТОЛЬКО
// владелец, автоматике это запрещено. Скрипт лишь поднимает профиль локально (Orbita) и держит окно,
// печатая текущий экран. Владелец жмёт Continue → после этого: node igsnapcookies.cjs <slug>.
//
// usage: node openacct.cjs <slug>          (Ctrl+C — закрыть окно и выйти)
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const L = require('./iglib.cjs');
const SLUG = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

global.__GL = null; let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`\n⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });

(async () => {
  if (!SLUG) { console.log('usage: node openacct.cjs <slug>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) h, a.ig_cookies, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL LIMIT 1`, [SLUG])).rows[0];
  if (!row) { console.log('акк не найден'); await c.end(); process.exit(1); }

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  const st = await gl.startLocal();
  if (!st || !st.wsUrl) { console.log('профиль не поднялся'); await closeLocal('no-ws'); process.exit(1); }
  const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
  await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
  try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}
  await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  console.log(`\n🖥  ОКНО ОТКРЫТО: @${row.h}`);
  console.log('   Пройди проверку на человека руками (кнопка Continue).');
  console.log(`   Как войдёшь — я увижу сессию сам. Закрыть: Ctrl+C\n`);

  // Ждём появления живой сессии, печатая текущий экран. Никаких кликов скриптом.
  for (let i = 0; i < 120; i++) { // до ~20 минут
    await L.sleep(10000);
    const cls = await L.classifyScreen(ctx, page).catch(() => ({ state: 'error' }));
    if (cls.state === 'logged_in') {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', ig_status='login_ok', health_state='ok', session_checked_at=now() WHERE slug=$1`,
        [SLUG, JSON.stringify(fresh)]);
      console.log(`✅ ВОШЁЛ: сессия живая, куки сохранены (${fresh.length}). Дальше вход не нужен.`);
      break;
    }
    if (i % 3 === 0) console.log(`   … жду (${cls.state})`);
  }
  await c.end();
  console.log('Окно оставляю открытым. Ctrl+C — закрыть.');
  setInterval(() => {}, 1 << 30);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
