// Проверяет состояние TikTok-акков (залогинен/ник) для выбора брендового. Read-only.
// usage: node ttcheck.cjs  (TT KZ SELF 1-5, токен группы «TT KZ SELF · IG», освобождает слот bhxxgod)
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  await c.connect();
  const rows = (await c.query(`SELECT slug, gologin_profile_id FROM accounts WHERE slug LIKE $1 AND platform='tiktok' ORDER BY slug`, ['TT KZ SELF%'])).rows;
  const tok = (await c.query(`SELECT gologin_token FROM account_groups WHERE name=$1`, ['TT KZ SELF · IG'])).rows[0].gologin_token;
  const rd = (await c.query(`SELECT gologin_profile_id FROM accounts WHERE ig_role='reader'`)).rows.map(r => r.gologin_profile_id);
  await c.end();
  for (const id of [...rows.map(r => r.gologin_profile_id), ...rd]) {
    await fetch('https://api.gologin.com/browser/' + id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {});
  }
  await sleep(18000);
  for (const r of rows) {
    const u = new URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', r.gologin_profile_id);
    let b;
    for (let k = 0; k < 3; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 50000 }); break; } catch { await sleep(k === 0 ? 15000 : 12000); } }
    if (!b) { console.log(r.slug + ': НЕ подключился (прокси/слот)'); continue; }
    const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      // РОБАСТНАЯ загрузка: TikTok на медленном прокси виснет на сплэше. Поллим готовность, релоадим до 6 раз.
      let info = { href: '', up: false, loginBtn: false, bad: false };
      for (let ld = 0; ld < 6; ld++) {
        await sleep(ld === 0 ? 8000 : 5000);
        info = await page.evaluate(() => {
          const prof = document.querySelector('[data-e2e="nav-profile"]');
          const up = !!document.querySelector('[data-e2e="upload-icon"], a[href*="/upload"]');
          const loginBtn = !!document.querySelector('[data-e2e="top-login-button"]');
          const bad = /account.{0,20}(banned|suspend)|заблокир|нарушен|verify|captcha|too many|подозрительн/i.test(document.body.innerText || '');
          return { href: prof ? prof.getAttribute('href') : '', up, loginBtn, bad };
        }).catch(() => info);
        if (info.href || info.up || info.loginBtn || info.bad) break;
        if (ld < 5) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      if (SHOT) require('fs').writeFileSync(`${SHOT}/ttself_${r.slug.replace(/\s+/g, '_')}.png`, await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)));
      const state = info.bad ? 'ПРОБЛЕМА (капча/бан?)' : ((info.href || info.up) ? 'ЗАЛОГИНЕН ✓' : (info.loginBtn ? 'разлогинен' : 'не догрузился'));
      let followers = '?', videos = '?', ipCountry = '?';
      // гео прокси — из GoLogin API (со страницы TikTok CSP блокирует внешний fetch)
      try { const pr = await fetch('https://api.gologin.com/browser/' + r.gologin_profile_id, { headers: { Authorization: 'Bearer ' + tok } }).then(x => x.json()); const px = pr && pr.proxy; if (px) ipCountry = String(px.country || px.autoProxyRegion || px.mode || '?'); } catch {}
      // если залогинен и есть ник — зайдём на профиль, снимем подписчиков/видео
      if (info.href) {
        try {
          await page.goto('https://www.tiktok.com' + info.href, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
          await sleep(6000);
          const st = await page.evaluate(() => {
            const f = document.querySelector('[data-e2e="followers-count"]');
            const posts = document.querySelectorAll('[data-e2e="user-post-item"]').length;
            return { followers: f ? f.textContent : '?', videos: posts };
          }).catch(() => ({ followers: '?', videos: 0 }));
          followers = st.followers; videos = st.videos;
          if (SHOT) require('fs').writeFileSync(`${SHOT}/ttprofile_${r.slug.replace(/\s+/g, '_')}.png`, await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)));
        } catch {}
      }
      console.log(`${r.slug}: ${state}${info.href ? ' | ' + info.href : ''} | подписчиков: ${followers} | видео: ${videos} | гео: ${ipCountry}`);
    } catch (e) { console.log(r.slug + ': ошибка ' + String(e.message).slice(0, 40)); }
    finally { await fetch('https://api.gologin.com/browser/' + r.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {}); await b.close().catch(() => {}); await sleep(3000); }
  }
  console.log('ГОТОВО');
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
