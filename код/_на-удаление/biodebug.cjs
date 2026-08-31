// ДЕБАГ СЕЙВА БИО (05.08): у всех 5 акков био пусто, хотя скрипты рапортовали успех.
// Инструментируем на одном акке: перехват сетевых ответов IG, скрины до/после, перечитка поля.
// Запуск: node biodebug.cjs <slug> "текст био"
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const BIO = process.argv[3] || 'бьюти-эксперименты и находки 🤍';
const sleep = L.sleep;

async function closeLocal() {
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (gl.killBrowser) gl.killBrowser(); } catch {}
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await closeLocal(); process.exit(0); });

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const row = (await c.query(`SELECT a.id, coalesce(a.ig_login,a.slug) h, a.ig_cookies, a.gologin_profile_id pid, g.gologin_token tok
    FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [SLUG])).rows[0];
  await c.end();
  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  try {
    const st = await gl.startLocal();
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    // перехват ответов эндпоинтов правки профиля
    page.on('response', async (r) => {
      if (/accounts\/edit|web\/accounts/i.test(r.url()) && r.request().method() === 'POST') {
        const body = await r.text().catch(() => '');
        console.log(`  NET ${r.status()} ${r.url().replace('https://www.instagram.com', '')} :: ${body.slice(0, 300)}`);
      }
    });

    await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);
    await L.clearOverlays(page);
    await page.screenshot({ path: `/tmp/biodbg_${SLUG}_1.png` });

    const bio = page.locator('textarea#pepBio, textarea[aria-label*="Bio" i], textarea[name="biography"]').first();
    if (!(await bio.isVisible({ timeout: 8000 }).catch(() => false))) { console.log('поле био не нашлось'); return; }
    await bio.click(); await sleep(500);
    // печатаем как человек, а не fill: возможно, форма не «замечает» programmatic fill и Submit не активируется
    await bio.pressSequentially(BIO, { delay: 35 });
    await sleep(1500);
    const submit = page.getByRole('button', { name: /Submit|Save|Отправить|Сохранить/i }).first();
    const enabled = await submit.isEnabled().catch(() => null);
    console.log('  Submit виден/активен:', await submit.isVisible().catch(() => false), enabled);
    await page.screenshot({ path: `/tmp/biodbg_${SLUG}_2.png` });
    if (enabled) { await submit.click(); await sleep(6000); }
    else { console.log('  Submit неактивен — пробую blur+Enter'); await bio.press('Tab'); await sleep(1500); if (await submit.isEnabled().catch(() => false)) { await submit.click(); await sleep(6000); } }
    const toast = await page.evaluate(() => (document.body.innerText.match(/problem saving[^.]*|Profile saved|Профиль сохранён/i) || [])[0] || '');
    console.log('  тост:', toast || 'нет');
    await page.screenshot({ path: `/tmp/biodbg_${SLUG}_3.png` });

    // ПОЗИТИВНАЯ ПРОВЕРКА: перезагрузка и перечитка
    await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);
    const after = await page.locator('textarea#pepBio, textarea[aria-label*="Bio" i], textarea[name="biography"]').first().inputValue().catch(() => 'н/д');
    console.log('ИТОГ: био после перезагрузки =', JSON.stringify(after));
    await page.screenshot({ path: `/tmp/biodbg_${SLUG}_4.png` });
  } finally { await closeLocal(); }
})().catch(async (e) => { console.error('ОШИБКА:', e.message); await closeLocal(); process.exit(1); });
