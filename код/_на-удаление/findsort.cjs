// Быстро: открыть комменты рилса, НАЙТИ контрол сортировки (Most recent) — дампим все короткие кликабельные
// тексты в области панели + шапку рилса. usage: node findsort.cjs "<slug>" "<reel>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const SLUG = process.argv[2]; const URL = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 }); await c.connect();
  const a = (await c.query(`SELECT a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0]; await c.end();
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', a.tok); u.searchParams.set('profile', a.pid);
  let b; for (let k = 0; k < 4; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 55000 }); break; } catch { await sleep(k === 0 ? 18000 : 12000); } }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    for (let g = 0; g < 4; g++) { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(g === 0 ? 5000 : 4000);
      if (await page.locator('svg[aria-label*="omment" i],svg[aria-label*="оммент" i],svg[aria-label*="omentar" i]').count().catch(() => 0)) break; }
    // открыть панель
    for (const sel of ['svg[aria-label*="omment" i]', 'svg[aria-label*="оммент" i]', 'svg[aria-label*="omentar" i]']) {
      const ic = page.locator(sel).first(); if (await ic.isVisible().catch(() => false)) { await ic.click().catch(() => {}); await sleep(3500);
        if (await page.getByText(/^(Répondre|Ответить|Reply|Responder)$/i).first().isVisible().catch(() => false)) break; } }
    await sleep(1500);
    if (SHOT) require('fs').writeFileSync(`${SHOT}/findsort_panel.png`, await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)));
    // дамп: все кликабельные/короткие текстовые узлы во всём документе, где текст похож на сортировку/фильтр
    const cand = await page.evaluate(() => {
      const out = [];
      const els = Array.from(document.querySelectorAll('div[role="button"], button, span, a, [role="tab"], select, [aria-haspopup]'));
      for (const e of els) {
        const t = (e.textContent || '').trim();
        if (t && t.length <= 30 && /recent|récent|recientes|nouveau|newest|new|sort|trier|ordenar|top|pertinent|relevant|популяр|нов|сначала|сортир|all comments|tous/i.test(t)) {
          const r = e.getBoundingClientRect();
          out.push({ t: t.slice(0, 30), tag: e.tagName, role: e.getAttribute('role') || '', x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
      // + всё в шапке диалога (первые узлы диалога)
      const dlg = document.querySelector('div[role="dialog"]');
      const head = dlg ? Array.from(dlg.querySelectorAll('span, div, button')).slice(0, 40).map(e => (e.textContent || '').trim()).filter(t => t && t.length < 25) : [];
      return { cand: out.slice(0, 30), headSample: [...new Set(head)].slice(0, 20) };
    }).catch(() => ({ cand: [], headSample: [] }));
    console.log('КАНДИДАТЫ-СОРТИРОВКА:', JSON.stringify(cand.cand));
    console.log('ШАПКА диалога (тексты):', JSON.stringify(cand.headSample));
  } catch (e) { console.log('ОШИБКА', String(e.message).slice(0, 80)); }
  finally { await fetch('https://api.gologin.com/browser/' + a.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.tok } }).catch(() => {}); await b.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
