// ПЕРЕВОД АККАУНТА В PROFESSIONAL (нужно для официальной публикации через Graph API).
// Работает локально по сохранённым кукам. Идёт по настройкам, дампит экраны — путь у IG меняется.
// Запуск: DB_PUBLIC_URL=… node topro.cjs "<slug>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const SLUG = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
global.__GL = null; let __c = false;
async function closeLocal(w) { if (__c) return; __c = true; const gl = global.__GL; if (!gl) return; try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (gl.killBrowser) gl.killBrowser(); console.log(`  ⏹ закрыто (${w})`); } catch {} }
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await closeLocal(s); process.exit(0); });
async function snap(page, n) { try { fs.writeFileSync(`${SHOT}/pro_${SLUG.replace(/\W/g, '_')}_${n}.png`, await page.screenshot({ type: 'jpeg', quality: 55, timeout: 12000 })); } catch {} }
async function dismiss(page) {
  for (const rx of [/Allow all cookies|Разрешить все|Accept all/i, /^(Not now|Не сейчас|Позже|Dismiss|OK|Ок|Got it|Понятно)$/i]) {
    try { const b = page.getByRole('button', { name: rx }).first(); if (await b.isVisible({ timeout: 900 }).catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(700); } } catch {}
  }
}
async function dump(page, label) {
  const d = await page.evaluate(() => [...document.querySelectorAll('button,div[role="button"],a,span')].filter((e) => e.offsetParent !== null && (e.textContent || '').trim().length > 1 && (e.textContent || '').trim().length < 46).map((e) => (e.textContent || '').trim()).slice(0, 40)).catch(() => []);
  console.log(`  [${label}] ${JSON.stringify([...new Set(d)].slice(0, 26))}`);
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const a = (await c.query(`SELECT a.gologin_profile_id pid, g.gologin_token tok, a.ig_cookies, coalesce(a.ig_login,a.slug) h, a.persona FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [SLUG])).rows[0];
  await c.end();
  if (!a) { console.log('нет акка'); process.exit(1); }
  console.log(`ПЕРЕВОЖУ В PROFESSIONAL: ${SLUG} @${a.h} (${a.persona || '—'})`);
  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 } });
  try {
    const st = await gl.startLocal(); if (!st?.wsUrl) throw new Error('no wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    if (a.ig_cookies) { try { const raw = typeof a.ig_cookies === 'string' ? JSON.parse(a.ig_cookies) : a.ig_cookies; const cks = (Array.isArray(raw) ? raw : []).filter((x) => x?.name && x?.value).map((x) => ({ name: x.name, value: String(x.value), domain: x.domain || '.instagram.com', path: x.path || '/', httpOnly: !!x.httpOnly, secure: x.secure !== false })); if (cks.length) { await ctx.addCookies(cks); console.log(`  🍪 ${cks.length} кук`); } } catch {} }
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000); await dismiss(page);
    const ck = await ctx.cookies('https://www.instagram.com').catch(() => []);
    if (!ck.some((x) => x.name === 'sessionid' && x.value)) { await snap(page, 'nologin'); throw new Error('нет сессии — сначала вход'); }
    console.log('  ✓ в аккаунте');
    // Путь: Settings → Account type and tools → Switch to professional account
    await page.goto('https://www.instagram.com/accounts/settings/type/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await sleep(5000); await dismiss(page); await snap(page, '1_type'); await dump(page, 'страница типа');
    let sw = page.getByText(/Switch to professional account|Переключиться на профессиональный/i).first();
    if (!(await sw.isVisible({ timeout: 4000 }).catch(() => false))) {
      // запасной путь через общие настройки
      await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await sleep(4000); await dump(page, 'edit');
      sw = page.getByText(/Switch to professional account|профессиональный/i).first();
    }
    if (!(await sw.isVisible({ timeout: 4000 }).catch(() => false))) { await snap(page, 'noswitch'); await dump(page, 'не нашёл'); throw new Error('кнопка перевода не найдена'); }
    await sw.click({ timeout: 5000 }).catch(() => {});
    await sleep(4000); await snap(page, '2_wizard'); await dump(page, 'мастер');
    // Мастер: Next/Continue → выбрать категорию → Creator → Done
    for (let s = 0; s < 8; s++) {
      await dismiss(page);
      const next = page.getByRole('button', { name: /^(Next|Continue|Далее|Продолжить|Done|Готово|Get started)$/i }).first();
      const creator = page.getByText(/^(Creator|Автор|Digital creator)$/i).first();
      if (await creator.isVisible({ timeout: 2000 }).catch(() => false)) { await creator.click().catch(() => {}); console.log('  выбрал «Creator»'); await sleep(2500); continue; }
      if (await next.isVisible({ timeout: 2500 }).catch(() => false)) { const t = (await next.textContent().catch(() => '')) || ''; await next.click().catch(() => {}); console.log(`  шаг: ${t.trim()}`); await sleep(4000); continue; }
      break;
    }
    await snap(page, '3_result'); await dump(page, 'итог');
    const isPro = await page.getByText(/Professional dashboard|Профессиональный аккаунт|Creator|Insights/i).first().isVisible({ timeout: 4000 }).catch(() => false);
    console.log(isPro ? '  ✅ похоже, аккаунт стал профессиональным' : '  ⚠ подтверждения не увидел — смотри скрины pro_*');
    await b.close().catch(() => {});
  } catch (e) { console.log('  ✗', String(e.message).slice(0, 80)); }
  await closeLocal('finish');
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
