// grabgrid_cloud.cjs — собирает коды последних постов профиля ЧЕРЕЗ ОБЛАКО GoLogin (не локальный Chrome, не ноут владельца).
// Заходит залогиненным driver-аккам (его cloud-профиль) на instagram.com/<user>/, скроллит грид, тянет reel/p коды.
// usage: node grabgrid_cloud.cjs <username> <count> <driverSlug>
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER = String(process.argv[2] || '').replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/.*$/, '');
const COUNT = Number(process.argv[3] || 20);
const DRIVER = process.argv[4] || 'martin103340';
const OUT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/grid_' + USER + '.json';
(async () => {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000, query_timeout: 20000 });
  await c.connect();
  const a = (await c.query(`SELECT a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [DRIVER])).rows[0];
  await c.end();
  if (!a || !a.pid || !a.tok) { console.log('⛔ у драйвера нет профиля/токена:', DRIVER); process.exit(3); }
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', a.tok); u.searchParams.set('profile', a.pid);
  let b = null;
  for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch (e) { console.log('коннект try' + k); await sleep(k === 0 ? 22000 : 14000); } }
  if (!b) { console.log('⛔ облако не подключилось'); process.exit(4); }
  try {
    const ctx = b.contexts()[0] || (await b.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`https://www.instagram.com/${USER}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    let codes = [];
    for (let s = 0; s < 20 && codes.length < COUNT; s++) {
      codes = await page.evaluate(() => {
        const seen = [];
        for (const el of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
          const m = (el.getAttribute('href') || '').match(/\/(p|reel)\/([^/?]+)/);
          if (m && !seen.includes(m[2])) seen.push(m[2]);
        }
        return seen;
      });
      if (codes.length >= COUNT) break;
      await page.evaluate(() => window.scrollBy(0, 1600)); await sleep(1600);
    }
    codes = codes.slice(0, COUNT);
    console.log(`@${USER}: собрано кодов ${codes.length}/${COUNT} (драйвер ${DRIVER}, облако)`);
    codes.forEach((code, i) => console.log(`  ${i + 1}. ${code}`));
    fs.writeFileSync(OUT, JSON.stringify(codes));
    console.log('JSON → ' + OUT);
  } finally { await b.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); process.exit(1); });
