// ЛЁГКАЯ ПРОВЕРКА ЖИВОСТИ: открываем профиль ЛОКАЛЬНО (Orbita), идём на instagram.com, смотрим — залогинены ли
// (sessionid ИЛИ маркеры ленты). Если да — СОХРАНЯЕМ куки в ig_cookies и метим live. Логин НЕ выполняем (не жжём).
// Закрываем корректно. Запуск: node livecheck.cjs "<slug>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const SLUG = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
global.__GL = null;
async function closeLocal() { const gl = global.__GL; if (!gl) return; try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch {} }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(); process.exit(0); });
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const a = (await c.query(`SELECT a.id, a.gologin_profile_id pid, g.gologin_token tok, coalesce(a.ig_login,a.slug) h FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [SLUG])).rows[0];
  if (!a || !a.pid || !a.tok) { console.log(`${SLUG}: НЕТ профиля/токена`); await c.end(); process.exit(0); }
  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 } });
  let verdict = 'нет коннекта';
  try {
    const r = await gl.startLocal().catch((e) => { verdict = 'startLocal: ' + (e.message || '').slice(0, 30); return null; });
    if (r && r.wsUrl) {
      const b = await chromium.connectOverCDP(r.wsUrl, { timeout: 60000 }).catch(() => null);
      if (b) {
        const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(6000);
        // ЭКРАН «Continue as X» = сессия ЖИВА (IG помнит акк), просто нужен один клик. Раньше я считал это
        // «не подтвердил вход» и метил живой акк мёртвым (ошибка повторялась весь день 28-29.07).
        for (let t = 0; t < 2; t++) {
          const cont = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
          if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) { await cont.click({ timeout: 5000 }).catch(() => {}); await sleep(7000); } else break;
        }
        const url = page.url();
        const onLogin = /accounts\/login|__coig_login/.test(url);
        // Дополнительный признак живой сессии: IG показывает ИМЕННО наш аккаунт на экране входа (значит куки есть)
        const remembers = await page.getByText(new RegExp(String(a.h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first().isVisible({ timeout: 2000 }).catch(() => false);
        const ck = await ctx.cookies('https://www.instagram.com').catch(() => []);
        const hasSess = ck.some((x) => x.name === 'sessionid' && x.value && x.value.length > 10);
        const domIn = await page.locator('a[href="/explore/"], a[href="/reels/"], svg[aria-label="Home" i], svg[aria-label="New post" i]').first().isVisible({ timeout: 3000 }).catch(() => false);
        fs.writeFileSync(`${SHOT}/live_${SLUG.replace(/\W/g, '_')}.png`, await page.screenshot({ type: 'jpeg', quality: 45, timeout: 12000 }).catch(() => Buffer.alloc(0)));
        if ((!onLogin && (hasSess || domIn)) || (hasSess && remembers)) {
          const useful = ck.filter((x) => /instagram/i.test(x.domain || ''));
          if (useful.length) await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', session_checked_at=now() WHERE id=$1`, [a.id, JSON.stringify(useful)]).catch(() => {});
          verdict = `ЖИВ ✅ (${hasSess ? 'sessionid' : 'DOM'}, кук ${useful.length})`;
        } else {
          if (onLogin && !remembers) await c.query(`UPDATE accounts SET session_status='dead', session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {}); // мёртвым метим ТОЛЬКО при явном разлогине
          verdict = remembers ? `ПОЧТИ ЖИВ ⚠️ (IG помнит @${a.h}, но сессия требует пароля)` : (onLogin ? 'МЁРТВ ❌ (разлогинен)' : 'НЕЯСНО ⚠️ (страница не догрузилась)');
        }
        await b.close().catch(() => {});
      } else verdict = 'CDP не подключился';
    }
  } catch (e) { verdict = 'ERR ' + (e.message || '').slice(0, 40); }
  console.log(`${SLUG} (@${a.h}): ${verdict}`);
  await closeLocal();
  await c.end();
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
