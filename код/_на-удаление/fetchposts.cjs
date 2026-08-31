// Вытащить последние N шорткодов постов/рилсов профиля (залогиненным акком через GoLogin cloud).
// Запуск: node fetchposts.cjs <slug_акка> <username_профиля> [N]
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SLUG = process.argv[2], PROFILE = (process.argv[3] || '').replace(/^@/, ''), N = Number(process.argv[4] || 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const a = (await c.query(`SELECT gologin_profile_id FROM accounts WHERE slug=$1 AND platform='comments'`, [SLUG])).rows[0];
  const gt = (await c.query(`SELECT g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0].gologin_token;
  await c.end();
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', gt); u.searchParams.set('profile', a.gologin_profile_id);
  let b;
  for (let k = 0; k < 4; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch { console.log('коннект try' + k); await sleep(k ? 12000 : 20000); } }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.route('**/*', (r) => { const t = r.request().resourceType(); if (t === 'media' || /\.(mp4|webm)(\?|$)/i.test(r.request().url())) return r.abort().catch(() => {}); r.continue().catch(() => {}); });
    await page.goto(`https://www.instagram.com/${PROFILE}/?hl=ru`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(5000);
    const codes = new Set();
    for (let s = 0; s < 10 && codes.size < N; s++) {
      const found = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
          const m = (a.getAttribute('href') || '').match(/\/(p|reel)\/([^/?]+)/); if (m) out.push(m[2]);
        }
        return out;
      }).catch(() => []);
      found.forEach(x => codes.add(x));
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
      await sleep(1800);
    }
    const list = [...codes].slice(0, N);
    console.log('PROFILE_POSTS ' + JSON.stringify({ profile: PROFILE, count: list.length, codes: list }));
    list.forEach((code, i) => console.log(`  ${i + 1}. ${code}`));
  } catch (e) { console.log('ОШИБКА', e.message.slice(0, 80)); }
  finally {
    await fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + gt } }).catch(() => {});
    await b.close().catch(() => {});
  }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
