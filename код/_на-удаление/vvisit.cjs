// Зайти аккаунтом на произвольный URL, снять скрин, доложить состояние (доступно/недоступно/логин).
// usage: node vvisit.cjs "<slug>" "<url>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const SLUG = process.argv[2]; const URL = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loadDb() {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect();
      const a = (await c.query(`SELECT a.gologin_profile_id, g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0];
      await c.end(); return a;
    } catch (e) { await c.end().catch(() => {}); await sleep(2500); }
  }
  throw new Error('db');
}
(async () => {
  if (!SLUG || !URL) { console.log('usage: <slug> <url>'); return; }
  const a = await loadDb(); const tok = a.gologin_token || process.env.GOLOGIN_API_TOKEN;
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', a.gologin_profile_id);
  let b; for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch (e) { console.log('коннект try' + k); await sleep(k === 0 ? 22000 : 14000); } }
  if (!b) { console.log(`${SLUG}: НЕ ПОДКЛЮЧИЛСЯ (профиль занят/прокси)`); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000);
    const name = SLUG.replace(/\s+/g, '_') + '_' + (URL.match(/instagram\.com\/([^/?]+)/) || [, 'x'])[1];
    if (SHOT) require('fs').writeFileSync(`${SHOT}/visit_${name}.png`, await page.screenshot({ type: 'png' }));
    const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
    const unavail = /страница недоступна|isn.?t available|not be available|page( isn.?t| may not)|Sorry, this page/i.test(txt);
    const notfound = /User not found|Пользователь не найден|Sorry, this account/i.test(txt);
    const restricted = /ограничен|restricted|заблокир|blocked/i.test(txt);
    const followBtn = (await page.getByText(/^(Follow|Подписаться|Following|Подписки|Message|Написать)$/i).count().catch(() => 0)) > 0;
    console.log(`${SLUG} → ${URL.slice(0, 55)}`);
    console.log(`  url сейчас: ${page.url().slice(0, 60)}`);
    console.log(`  недоступно:${unavail} | не найден:${notfound} | ограничен/блок:${restricted} | есть Follow/Message:${followBtn}`);
    console.log(`  текст(80): ${txt.replace(/\s+/g, ' ').slice(0, 80)}`);
  } catch (e) { console.log(`${SLUG}: ОШИБКА ${String(e.message).slice(0, 60)}`); }
  finally { await fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {}); await b.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
