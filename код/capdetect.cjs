// capdetect.cjs — открыть акк в ОБЛАКЕ, задетектить капчу «Confirm you're human»/suspended, закрыть профиль,
// замерить тайминги (connect / detect / close / total). Для авто-детекта спалённых акков воркером.
// usage: node capdetect.cjs <slug>
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const NAV_URL = process.env.OPEN_URL || 'https://www.instagram.com/?hl=en';
const SHOT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  await c.connect();
  const a = (await c.query(
    `SELECT a.id, a.slug, a.gologin_profile_id pid, coalesce(g.gologin_token,(SELECT gologin_token FROM account_groups WHERE name='РАБОТЯГИ' LIMIT 1)) tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE lower(a.slug)=lower($1) LIMIT 1`, [SLUG])).rows[0];
  if (!a) { console.log('акк не найден'); await c.end(); return; }

  const T0 = Date.now();
  // 1) закрыть возможную зависшую cloud-сессию, затем cloud connect
  await fetch('https://api.gologin.com/browser/' + a.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.tok } }).catch(() => {});
  await sleep(2000);
  const wsu = new URL('wss://cloudbrowser.gologin.com/connect');
  wsu.searchParams.set('token', a.tok); wsu.searchParams.set('profile', a.pid);
  let b = null;
  for (let k = 0; k < 4; k++) { try { b = await chromium.connectOverCDP(wsu.toString(), { timeout: 60000 }); break; } catch (e) { await sleep(k === 0 ? 15000 : 10000); } }
  if (!b) { console.log('cloud connect не удался'); await c.end(); return; }
  const tConnect = ((Date.now() - T0) / 1000).toFixed(1);
  const page = b.contexts()[0].pages()[0] || await b.contexts()[0].newPage();

  // 2) навигация + детект-петля
  const tNav = Date.now();
  await page.goto(NAV_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  let verdict = 'unknown', tDetect = 0;
  for (let i = 0; i < 25; i++) {
    const url = page.url();
    const body = (await page.evaluate(() => (document.body.innerText || '').slice(0, 1200)).catch(() => '')).toLowerCase();
    const captcha = /accounts\/suspended|challenge|checkpoint/i.test(url)
      || /confirm you'?re human|подтвердите,? что вы человек|verify you'?re human|подтвердите что вы человек/i.test(body);
    const home = await page.locator('svg[aria-label="Home" i],svg[aria-label="Главная" i]').first().isVisible().catch(() => false);
    if (captcha) { verdict = 'CAPTCHA'; tDetect = ((Date.now() - tNav) / 1000).toFixed(1); break; }
    if (home) { verdict = 'FEED (жив)'; tDetect = ((Date.now() - tNav) / 1000).toFixed(1); break; }
    await sleep(1000);
  }
  if (!tDetect) tDetect = ((Date.now() - tNav) / 1000).toFixed(1);
  await page.screenshot({ path: `${SHOT}/cap_${a.slug}.png` }).catch(() => {});
  const finalUrl = page.url();

  // 3) закрыть профиль (cloud DELETE /web) — быстро
  const tCl = Date.now();
  await b.close().catch(() => {});
  const del = await fetch('https://api.gologin.com/browser/' + a.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.tok } }).then((r) => r.status).catch(() => '?');
  const tClose = ((Date.now() - tCl) / 1000).toFixed(1);

  // 4) пометить если капча
  if (verdict === 'CAPTCHA') {
    await c.query(`UPDATE accounts SET ig_status='captcha', session_status='dead', status='paused', session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {});
  }
  await c.end();

  const total = ((Date.now() - T0) / 1000).toFixed(1);
  console.log(`\n===== ${a.slug} =====`);
  console.log(`ВЕРДИКТ: ${verdict}`);
  console.log(`url: ${finalUrl.slice(0, 80)}`);
  console.log(`⏱ connect: ${tConnect}с | detect: ${tDetect}с | close(DELETE ${del}): ${tClose}с | ИТОГО: ${total}с`);
  if (verdict === 'CAPTCHA') console.log(`помечен ig_status=captcha, dead, paused`);
  process.exit(0);
})().catch((e) => { console.log('FATAL', String(e.message).slice(0, 160)); process.exit(1); });
