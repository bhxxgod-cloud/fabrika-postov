// Проверяет РЕАЛЬНОЕ состояние IG-акков (не флаг в БД): заходит в профиль, классифицирует экран.
// usage: node statecheck.cjs "slug1" "slug2" ...   (или без аргументов — все comments-акки группы yotbonly)
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const YOTBONLY = '5393d525-3bc1-4092-bbfc-28a7216f961b';
async function db(q, p) {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); const r = await c.query(q, p); await c.end(); return r; }
    catch (e) { await c.end().catch(() => {}); await sleep(2000); }
  }
  throw new Error('db');
}
function classify(txt, url) {
  const t = (txt || '').toLowerCase();
  if (/suspend|suspensa|suspendi|приостановлен|disabled your account|account (has been )?disabled|деактивирован|нарушил|foi desativ/i.test(t)) return 'SUSPENDED/БАН';
  if (/we (suspect|detected) automated|подозрительн|unusual activity|подтвердите, что это вы|confirm it.?s you|help us confirm|подтверди/i.test(t)) return 'CHALLENGE/чекпойнт';
  if (/enter the code|введите код|verification code|код подтвержд/i.test(t)) return 'CHALLENGE/код';
  if (/the login information you entered is incorrect|неверн|incorrect/i.test(t)) return 'LOGIN-форма (incorrect/кулдаун)';
  if (/log in|войти|log into instagram|phone number, username|телефон, имя пользователя/i.test(t) && !/home|для вас/i.test(t)) return 'LOGIN-форма (разлогинен)';
  if (/\/(reels|explore)\/|home|для вас|new post|создать|messages|сообщения|profile|what.?s on your mind/i.test(t) || /accounts\/edit/.test(url)) return 'ЗАЛОГИНЕН ✓';
  return 'НЕЯСНО (' + t.replace(/\s+/g, ' ').slice(0, 60) + ')';
}
(async () => {
  let slugs = process.argv.slice(2);
  if (!slugs.length) slugs = (await db(`SELECT slug FROM accounts WHERE group_id=$1 AND platform='comments' AND deleted_at IS NULL ORDER BY slug`, [YOTBONLY])).rows.map(r => r.slug);
  for (const slug of slugs) {
    let line = slug.padEnd(20) + ' ';
    try {
      const a = (await db(`SELECT a.gologin_profile_id, g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [slug])).rows[0];
      if (!a || !a.gologin_profile_id) { console.log(line + 'НЕТ ПРОФИЛЯ'); continue; }
      const tok = a.gologin_token;
      const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', a.gologin_profile_id);
      let b;
      for (let k = 0; k < 4; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 55000 }); break; } catch { await sleep(k === 0 ? 20000 : 12000); } }
      if (!b) { console.log(line + 'НЕ ПОДКЛЮЧИЛСЯ (профиль занят/прокси)'); continue; }
      const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
      try {
        await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(7000);
        const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
        const st = classify(txt, page.url());
        if (SHOT) require('fs').writeFileSync(`${SHOT}/state_${slug.replace(/[^a-z0-9]/gi, '_')}.png`, await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)));
        console.log(line + st + '   [' + page.url().replace('https://www.instagram.com', '').slice(0, 30) + ']');
      } finally {
        await fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {});
        await b.close().catch(() => {});
      }
    } catch (e) { console.log(line + 'ОШИБКА ' + String(e.message).slice(0, 40)); }
    await sleep(1500);
  }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
