// inlinelogin.cjs — залогинить акк В УЖЕ ОТКРЫТОМ локальном окне (Orbita), не переоткрывая профиль.
// Находит порт профиля по ps, коннектится по CDP, идёт на /accounts/login, вводит креды + 2FA (TOTP),
// проверяет вход по куке sessionid, возвращает на рил. usage: node inlinelogin.cjs <slug> [reelURL]
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const crypto = require('crypto');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const REEL = process.argv[3] || 'https://www.instagram.com/reel/Da5nHB4IbKf/';
const SHOT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function totp(secret) {
  const b32 = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, ''); if (!b32) return '';
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of b32) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Math.floor(Date.now() / 1000 / 30); const cb = Buffer.alloc(8);
  cb.writeUInt32BE(Math.floor(counter / 2 ** 32), 0); cb.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(cb).digest(); const off = h[h.length - 1] & 0xf;
  return String(((h[off] & 0x7f) << 24 | (h[off + 1] & 0xff) << 16 | (h[off + 2] & 0xff) << 8 | (h[off + 3] & 0xff)) % 1e6).padStart(6, '0');
}
function findPort(pid) {
  try { const out = execSync('ps -Ao command 2>/dev/null', { encoding: 'utf8', maxBuffer: 1 << 24 });
    for (const line of out.split('\n')) { if (line.includes(`gologin_profile_${pid}`) && line.includes('remote-debugging-port=')) return (line.match(/remote-debugging-port=(\d+)/) || [])[1]; }
  } catch {} return null;
}
async function hasSession(page) { try { const ck = await page.context().cookies(['https://www.instagram.com']); const s = ck.find((c) => c.name === 'sessionid'); return !!(s && s.value && s.value.length > 10); } catch { return false; } }

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 }); await c.connect();
  const a = (await c.query('SELECT slug, gologin_profile_id pid, ig_login, ig_password, totp_secret FROM accounts WHERE lower(slug)=lower($1) LIMIT 1', [SLUG])).rows[0];
  await c.end();
  if (!a) { console.log('нет акка'); process.exit(1); }
  const port = findPort(a.pid);
  if (!port) { console.log(`локальное окно ${SLUG} (профиль ${String(a.pid).slice(0, 8)}) не найдено — открой сперва`); process.exit(1); }
  console.log(`коннект к окну ${SLUG} порт ${port}`);
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();

  console.log('иду на /accounts/login…');
  await page.goto('https://www.instagram.com/accounts/login/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(2500);
  // куки-баннер
  for (const t of ['Decline optional cookies', 'Allow all cookies', 'Разрешить все', 'Отклонить']) {
    const btn = page.getByRole('button', { name: new RegExp(t, 'i') }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(800); break; }
  }
  // Continue-as: ЖДЁМ отрисовки экрана (Continue / пароль / лента) до ~15с — через тормозной прокси рисуется не
  // мгновенно (баг «не дождался окна»). Профиль запомнен → жмём Continue, сессия возобновляется.
  for (let w = 0; w < 15; w++) {
    if (await hasSession(page)) break;
    if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) break; // форма пароля → ввод ниже
    const contAs = page.locator('button, div[role="button"]').filter({ hasText: /^\s*(Continue|Продолжить)\s*$/i }).first();
    if (await contAs.isVisible().catch(() => false)) {
      console.log('экран «Continue as» → жму Continue');
      await contAs.click().catch(() => {});
      await sleep(6000);
      break;
    }
    await sleep(1000);
  }
  // если уже залогинен (кука) — сразу на рил
  if (await hasSession(page)) { console.log('уже залогинен (кука есть)'); }
  else {
    const userSel = 'input[name="username"], input[name="email"]';
    const passSel = 'input[type="password"]';
    await page.locator(passSel).first().waitFor({ timeout: 9000 }).catch(() => {});
    if (await page.locator(passSel).first().isVisible().catch(() => false)) {
      const u = page.locator(userSel).first(); const p = page.locator(passSel).first();
      await u.click().catch(() => {}); await u.fill('').catch(() => {}); await u.pressSequentially(a.ig_login, { delay: 120 }).catch(() => {});
      await p.click().catch(() => {}); await p.fill('').catch(() => {}); await p.pressSequentially(a.ig_password, { delay: 120 }).catch(() => {});
      await sleep(500);
      const lb = page.getByRole('button', { name: /^\s*Log ?in\s*$|^\s*Войти\s*$/i }).first();
      if (await lb.isVisible().catch(() => false)) await lb.click().catch(() => {}); else await p.press('Enter').catch(() => {});
      console.log('креды введены, сабмит…');
      await sleep(6000);
    }
    // 2FA
    const twofaSel = 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[inputmode="numeric"]';
    for (let att = 1; att <= 3 && a.totp_secret; att++) {
      const on2fa = /two_factor|two_step|verification/i.test(page.url()) || await page.locator(twofaSel).first().isVisible().catch(() => false);
      if (!on2fa || await hasSession(page)) break;
      const code = totp(a.totp_secret); console.log(`  2FA попытка ${att}: код ${code}`);
      let cf = page.locator(twofaSel).first(); if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
      await cf.click().catch(() => {}); await cf.fill('').catch(() => {}); await cf.pressSequentially(code, { delay: 90 }).catch(() => {});
      await sleep(700);
      const cont = page.getByRole('button', { name: /Continu|Confirm|Подтверд|Next|Далее/i }).first();
      if (await cont.isVisible().catch(() => false)) await cont.click().catch(() => {}); else await cf.press('Enter').catch(() => {});
      for (let i = 0; i < 12; i++) { if (!/two_factor|two_step|verification/i.test(page.url()) || await hasSession(page)) break; await sleep(2000); }
    }
    // Save info / Continue
    for (const t of ['Save info', 'Not now', 'Не сейчас']) { const btn = page.getByRole('button', { name: new RegExp(t, 'i') }).first(); if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(1500); break; } }
  }
  const logged = await hasSession(page);
  console.log(`\nВХОД: ${logged ? 'OK ✓ (кука sessionid есть)' : 'НЕ вошли'} url=${page.url().replace('https://www.instagram.com', '')}`);
  if (logged) { console.log('иду на рил…'); await page.goto(REEL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(5000); }
  await page.screenshot({ path: `${SHOT}/inline_${a.slug}.png` }).catch(() => {});
  await b.close().catch(() => {}); // закрываем ТОЛЬКО CDP-соединение, окно Orbita живёт
  process.exit(logged ? 0 : 2);
})().catch((e) => { console.log('FATAL', String(e.message).slice(0, 160)); process.exit(1); });
