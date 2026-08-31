// РАЗВЕДКА ЭКРАНОВ СОЗДАНИЯ ПОСТА В IG. НИЧЕГО НЕ ПУБЛИКУЕТ: доходит до экрана с кнопкой Share и ОСТАНАВЛИВАЕТСЯ.
// Снимает скриншоты каждого шага и дампит кнопки — чтобы починить селекторы, не потратив пост.
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const SLUG = process.argv[2];
const VIDEO = process.argv[3] || '/tmp/masha_test.mp4';
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
global.__GL = null; let __c = false;
async function closeLocal(w) { if (__c) return; __c = true; const gl = global.__GL; if (!gl) return; try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (gl.killBrowser) gl.killBrowser(); console.log(`  ⏹ закрыто (${w})`); } catch {} }
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await closeLocal(s); process.exit(0); });
async function snap(page, n) { try { fs.writeFileSync(`${SHOT}/probe_${n}.png`, await page.screenshot({ type: 'jpeg', quality: 55, timeout: 12000 })); console.log(`  📸 probe_${n}.png`); } catch {} }
async function dumpDialog(page, label) {
  const d = await page.evaluate(() => {
    const dlg = document.querySelector('div[role="dialog"]') || document.body;
    const r = dlg.getBoundingClientRect();
    const items = [...dlg.querySelectorAll('button, div[role="button"], svg[aria-label], [role="tab"]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => { const b = e.getBoundingClientRect(); return {
        t: (e.textContent || '').trim().slice(0, 24), al: e.getAttribute('aria-label') || (e.querySelector('svg[aria-label]') ? e.querySelector('svg[aria-label]').getAttribute('aria-label') : '') || '',
        x: Math.round(b.x - r.x), y: Math.round(b.y - r.y), w: Math.round(b.width), h: Math.round(b.height) }; })
      .filter((i) => i.w > 8 && i.h > 8);
    return { dlg: { w: Math.round(r.width), h: Math.round(r.height) }, items: items.slice(0, 30) };
  }).catch(() => ({ dlg: {}, items: [] }));
  console.log(`  [${label}] диалог ${d.dlg.w}x${d.dlg.h}`);
  d.items.forEach((i) => console.log(`     «${i.t}» al="${i.al}" @${i.x},${i.y} ${i.w}x${i.h}`));
}
async function dumpUi(page, label) {
  const d = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, div[role="button"], [role="tab"]')]
      .filter((e) => e.offsetParent !== null).map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 22);
    const svgs = [...document.querySelectorAll('svg[aria-label]')].filter((e) => e.closest('body')).map((e) => e.getAttribute('aria-label')).slice(0, 18);
    return { btns: [...new Set(btns)], svgs: [...new Set(svgs)] };
  }).catch(() => ({ btns: [], svgs: [] }));
  console.log(`  [${label}] кнопки: ${JSON.stringify(d.btns)}`);
  console.log(`  [${label}] иконки: ${JSON.stringify(d.svgs)}`);
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const a = (await c.query(`SELECT a.gologin_profile_id pid, g.gologin_token tok, a.ig_cookies, coalesce(a.ig_login,a.slug) h FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [SLUG])).rows[0];
  await c.end();
  if (!a) { console.log('нет акка'); process.exit(1); }
  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 } });
  try {
    const st = await gl.startLocal(); if (!st?.wsUrl) throw new Error('no wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    if (a.ig_cookies) { try { const raw = typeof a.ig_cookies === 'string' ? JSON.parse(a.ig_cookies) : a.ig_cookies; const cks = (Array.isArray(raw) ? raw : []).filter((x) => x?.name && x?.value).map((x) => ({ name: x.name, value: String(x.value), domain: x.domain || '.instagram.com', path: x.path || '/', httpOnly: !!x.httpOnly, secure: x.secure !== false })); if (cks.length) await ctx.addCookies(cks); console.log(`  🍪 ${cks.length} кук`); } catch {} }
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000);
    for (let t = 0; t < 2; t++) { const cont = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first(); if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) { await cont.click().catch(() => {}); await sleep(7000); } else break; }
    const inFeed = await page.locator('a[href="/explore/"], svg[aria-label="New post" i], svg[aria-label="Home" i]').first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log(inFeed ? '  ✓ в аккаунте' : '  ✗ НЕ залогинен');
    if (!inFeed) { await snap(page, '0_nologin'); throw new Error('не залогинен'); }
    // открываем создание поста
    await page.goto('https://www.instagram.com/create/select/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(5000); await snap(page, '1_create'); await dumpUi(page, 'создание');
    // грузим файл
    const fi = page.locator('input[type="file"]').first();
    await fi.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    await fi.setInputFiles(VIDEO).catch((e) => console.log('  setInputFiles:', e.message.slice(0, 50)));
    console.log('  📤 файл отправлен, жду обработку 20с…');
    await sleep(20000); await snap(page, '2_uploaded'); await dumpUi(page, 'после загрузки');
    // ищем выбор формата (владелец: слева снизу выбрать 9:16)
    const crop = await page.evaluate(() => [...document.querySelectorAll('svg[aria-label], button')].filter((e) => e.offsetParent !== null).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter((t) => /crop|9:16|1:1|4:5|original|размер|формат/i.test(t)).slice(0, 10)).catch(() => []);
    await dumpDialog(page, 'после загрузки');
    // Кнопка кадрирования = кружок в НИЖНЕЙ ЛЕВОЙ части диалога (подсказка владельца). Ищем по позиции.
    const cand = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]'); if (!dlg) return null;
      const r = dlg.getBoundingClientRect();
      const all = [...dlg.querySelectorAll('button, div[role="button"], svg')].filter((e) => e.offsetParent !== null)
        .map((e) => { const b = e.getBoundingClientRect(); return { e, x: b.x - r.x, y: b.y - r.y, w: b.width, h: b.height,
          al: e.getAttribute('aria-label') || '' }; })
        .filter((i) => i.w >= 16 && i.w <= 60 && i.h >= 16 && i.h <= 60 && i.x < r.width * 0.35 && i.y > r.height * 0.6);
      if (!all.length) return null;
      const best = all[0];
      return { al: best.al, x: Math.round(best.x), y: Math.round(best.y), abs: { x: Math.round(best.e.getBoundingClientRect().x + best.w / 2), y: Math.round(best.e.getBoundingClientRect().y + best.h / 2) } };
    }).catch(() => null);
    console.log('  🔲 кандидат «кадрирование» (низ-лево):', JSON.stringify(cand));
    if (cand && cand.abs) {
      await page.mouse.click(cand.abs.x, cand.abs.y).catch(() => {});
      await sleep(1800); await snap(page, '2c_cropmenu');
      await dumpDialog(page, 'меню формата');
    }
    // шаги Next (НЕ жмём Share)
    for (let s = 0; s < 3; s++) {
      const next = page.getByRole('button', { name: /^(Next|Далее)$/i }).first();
      if (await next.isVisible({ timeout: 6000 }).catch(() => false)) { await next.click().catch(() => {}); await sleep(5000); await snap(page, `3_next${s + 1}`); await dumpUi(page, `next${s + 1}`); }
      else break;
    }
    const share = page.getByRole('button', { name: /^(Share|Поделиться|Опубликовать)$/i }).first();
    console.log(await share.isVisible({ timeout: 4000 }).catch(() => false) ? '  ✅ ДОШЁЛ ДО SHARE (не нажимаю)' : '  ⚠ Share не найден');
    await snap(page, '9_final');
    await b.close().catch(() => {});
  } catch (e) { console.log('  ✗', e.message.slice(0, 80)); }
  await closeLocal('finish');
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
