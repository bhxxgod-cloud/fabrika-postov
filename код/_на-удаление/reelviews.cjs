// ПРОСМОТРЫ СВОИХ РИЛСОВ. Снаружи Instagram цифры незалогиненным не отдаёт (проверено:
// og:description пустой и на странице рилса, и в embed), поэтому читаем из самого аккаунта:
// заходим по кукам (без пароля) и берём счётчики из сетки /reels/ профиля.
// Успех подтверждаем положительно: нашли хотя бы одну плитку с числом. Пустая сетка у аккаунта
// с постами = НЕ «ноль просмотров», а «не прочитали», и так и пишем.
// Запуск: node reelviews.cjs <slug>
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
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('акк не найден'); await c.end(); process.exit(1); }
  console.log(`ПРОСМОТРЫ @${row.h} (${row.persona || '—'})`);

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  try {
    const st = await gl.startLocal();
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    await page.goto(`https://www.instagram.com/${row.h}/reels/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(7000); await L.clearOverlays(page);
    const cls = await L.classifyScreen(ctx, page);
    if (cls.state !== 'logged_in') { console.log(`  ⛔ не залогинены: ${cls.state} (${cls.evidence})`); }

    // Плитка рилса: ссылка /reel/<code>/ + подпись с числом (просмотры) рядом с иконкой play
    const items = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
        const code = (a.getAttribute('href') || '').match(/\/reel\/([^/?]+)/);
        const txt = (a.innerText || '').trim().split('\n').filter(Boolean);
        if (code) out.push({ code: code[1], nums: txt });
      }
      return out;
    }).catch(() => []);

    if (!items.length) {
      console.log('  ⚠ плиток не нашли — цифры НЕ прочитаны (это про чтение, не про ноль просмотров)');
      await L.snap(page, '/tmp', `reels_${SLUG}`);
    } else {
      for (const it of items) console.log(`  ${it.code}: ${it.nums.join(' / ') || 'без числа'}`);
    }
    await b.close().catch(() => {});
  } catch (e) { console.log('  ⛔ ошибка:', e.message.slice(0, 160)); }
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
