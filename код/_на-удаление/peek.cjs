// Визуальный осмотр комментов рилса: заходим аккаунтом, открываем панель, снимаем серию скринов + дампим
// видимые комменты (ник+текст) на каждой глубине скролла. Чтобы ГЛАЗАМИ увидеть, есть ли неотвеченные «Промт».
// usage: node peek.cjs "<slug>" "<reel_url>" [scrolls]
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const SLUG = process.argv[2]; const URL = process.argv[3]; const SCROLLS = Number(process.argv[4] || 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loadDb() {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect();
      const a = (await c.query(`SELECT a.gologin_profile_id, g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0];
      const ans = (await c.query(`SELECT username FROM post_answered WHERE code=$1`, [(URL.match(/(?:reel|p)\/([^/?]+)/) || [, ''])[1]])).rows.map(r => r.username.toLowerCase());
      await c.end(); return { a, answered: new Set(ans) };
    } catch (e) { await c.end().catch(() => {}); await sleep(2500); }
  }
  throw new Error('db');
}
(async () => {
  const { a, answered } = await loadDb();
  console.log('answered в БД:', answered.size);
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', a.gologin_token); u.searchParams.set('profile', a.gologin_profile_id);
  let b; for (let k = 0; k < 4; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 55000 }); break; } catch { console.log('коннект try' + k); await sleep(k === 0 ? 20000 : 12000); } }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  const snap = async (n) => { try { if (SHOT) require('fs').writeFileSync(`${SHOT}/peek_${n}.png`, await page.screenshot({ type: 'png', timeout: 12000 })); } catch {} };
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    // грузим рилс с ретраем на сплэш
    for (let g = 0; g < 4; g++) {
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(g === 0 ? 5000 : 4000);
      const ok = await page.locator('svg[aria-label*="omment" i], svg[aria-label*="оммент" i], svg[aria-label*="omentar" i]').count().catch(() => 0);
      const bad = /страница недоступна|isn.?t available|page.{0,20}(unavailable|removed)|недоступна/i.test(await page.evaluate(() => document.body.innerText).catch(() => ''));
      if (bad) { console.log('РИЛС НЕДОСТУПЕН этому акку (блок автора?)'); await snap('unavail'); return; }
      if (ok) break;
      console.log('рилс не догрузился, релоад ' + g);
    }
    await snap('0_loaded');
    // открыть панель комментов: клик по svg-иконке коммента (мультиязычно), иначе фикс-координата
    let opened = false;
    for (const sel of ['svg[aria-label*="omment" i]', 'svg[aria-label*="оммент" i]', 'svg[aria-label*="omentar" i]', 'svg[aria-label*="oment" i]']) {
      const ic = page.locator(sel).first();
      if (await ic.isVisible().catch(() => false)) { await ic.click({ timeout: 4000 }).catch(() => {}); await sleep(3500);
        if (await page.getByText(/^(Ответить|Reply|Responder|Yanıtla|Responder)$/i).first().isVisible().catch(() => false)) { opened = true; break; } }
    }
    if (!opened) { await page.mouse.click(Math.round(1280 * 0.689), Math.round(900 * 0.647)).catch(() => {}); await sleep(3500); }
    await snap('1_panel');
    // дамп видимых комментов + скрин на каждой глубине
    const dumpAndScroll = async (i) => {
      const items = await page.evaluate(() => {
        const RX = /^(Ответить|Reply|Responder|Yanıtla|Répondre|Rispondi|Antworten)$/i;
        const btns = Array.from(document.querySelectorAll('*')).filter(e => RX.test((e.textContent || '').trim()) && e.childElementCount === 0);
        const out = [];
        for (const el of btns.slice(0, 400)) {
          let user = '', text = '', node = el;
          for (let up = 0; up < 8 && node; up++) { node = node.parentElement; if (!node) break;
            if (!user) { const aa = node.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"]):not([href*="/explore/"])'); const m = aa && (aa.getAttribute('href') || '').match(/^\/([\w.][\w.]+)\/?$/); if (m) user = m[1].toLowerCase(); }
            if (!text && up >= 2) { const t = (node.innerText || '').replace(/\n+/g, ' ').trim(); if (t.length >= 3) text = t; }
            if (user && text) break; }
          if (user) out.push({ user, text: text.slice(0, 70) });
        }
        return out;
      }).catch(() => []);
      const uniq = []; const seen = new Set();
      for (const it of items) { if (!seen.has(it.user)) { seen.add(it.user); uniq.push(it); } }
      const prom = uniq.filter(x => /пром|промпт|как сдела|подскаж/i.test(x.text));
      const promUnans = prom.filter(x => !answered.has(x.user));
      console.log(`\n[скролл ${i}] видимых уник-комментов: ${uniq.length} | «пром»-подобных: ${prom.length} | из них НЕотвечено: ${promUnans.length}`);
      promUnans.slice(0, 12).forEach(x => console.log(`   СВЕЖ @${x.user}: «${x.text}»`));
      await snap(`s${i}`);
      // скролл вниз
      await page.evaluate(() => { const els = Array.from(document.querySelectorAll('div')).filter(e => e.scrollHeight > e.clientHeight + 200 && /Ответить|Reply|Responder/i.test(e.innerText || '')).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (els) els.scrollTop = els.scrollHeight; });
      await sleep(1600);
    };
    for (let i = 0; i < SCROLLS; i++) await dumpAndScroll(i);
  } catch (e) { console.log('ОШИБКА', String(e.message).slice(0, 80)); await snap('err'); }
  finally { await fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.gologin_token } }).catch(() => {}); await b.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
