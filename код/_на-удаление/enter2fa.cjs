// enter2fa.cjs — НАПРЯМУЮ ввести 2FA-код в открытое окно акка (обход застревающего detect chlogin на re-auth пути).
// Ждёт появления окна профиля, ловит экран two_step_verification, генерит TOTP, вводит в поле Code, жмёт Continue,
// проверяет вход (onetap/лента) → markLive. usage: node enter2fa.cjs <slug>
const { chromium } = require('/Users/qq/Desktop/neironka-poster/node_modules/playwright-core');
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const { execSync } = require('child_process');
const crypto = require('crypto');
const DBURL = require('fs').readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
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
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, statement_timeout: 8000 }); await c.connect();
  const a = (await c.query('SELECT id, gologin_profile_id pid, totp_secret sid FROM accounts WHERE lower(slug)=lower($1) LIMIT 1', [SLUG])).rows[0];
  await c.end();
  if (!a || !a.sid) { console.log('нет акка/2FA-сида'); return; }
  console.log(`жду окно ${SLUG} (профиль ${String(a.pid).slice(0, 8)})…`);
  for (let k = 0; k < 90; k++) { // ~7.5 мин
    const port = findPort(a.pid);
    if (port) {
      let b;
      try {
        b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 });
        const ctx = b.contexts()[0]; const page = ctx && ctx.pages()[0];
        if (page) {
          const url = page.url();
          // onetap (после 2FA/входа) = вошёл. Ленту определяем по Home-иконке, НЕ по URL instagram.com/ (там бывает Continue-as overlay → ложное «вошли», баг 22.07).
          if (/accounts\/onetap/.test(url) || await page.locator('svg[aria-label="Home" i],svg[aria-label="Главная" i]').first().isVisible().catch(() => false)) {
            console.log('✅ УЖЕ ВОШЛИ (' + url.slice(0, 50) + ')');
            const cc = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await cc.connect();
            await cc.query(`UPDATE accounts SET session_status='live', ig_status='login_ok', status='warming', session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {}); await cc.end();
            await b.close().catch(() => {}); return;
          }
          if (/two_step_verification|two_factor|challenge/.test(url)) {
            const codeInput = page.locator('input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[inputmode="numeric"], input[type="text"]:not([type="password"])').first();
            if (await codeInput.isVisible().catch(() => false)) {
              const code = totp(a.sid);
              console.log(`  🔑 2FA-экран → ввожу код ${code}`);
              await codeInput.click().catch(() => {}); await codeInput.fill('').catch(() => {});
              await codeInput.pressSequentially(code, { delay: 90 }).catch(async () => { await codeInput.fill(code).catch(() => {}); });
              await sleep(800);
              const cont = page.getByRole('button', { name: /^\s*(Continue|Продолжить|Confirm|Next)\s*$/i }).first();
              if (await cont.isVisible().catch(() => false)) await cont.click().catch(() => {}); else await codeInput.press('Enter').catch(() => {});
              await sleep(3000);
              const u2 = page.url();
              console.log('  после Continue: ' + u2.slice(0, 60));
              if (/onetap/.test(u2) || await page.locator('svg[aria-label="Home" i],svg[aria-label="Главная" i]').first().isVisible().catch(() => false)) {
                console.log('✅✅ ВОШЛИ ПОСЛЕ 2FA');
                const cc = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await cc.connect();
                await cc.query(`UPDATE accounts SET session_status='live', ig_status='login_ok', status='warming', session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {}); await cc.end();
                await b.close().catch(() => {}); return;
              }
            }
          }
        }
        await b.close().catch(() => {});
      } catch (e) { if (b) await b.close().catch(() => {}); }
    }
    await sleep(2000); // быстрее ловим 2FA-экран (было 5000)
  }
  console.log('окно/2FA не дождался');
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
