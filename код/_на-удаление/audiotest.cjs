// ТЕСТ аудио-поиска: локально заходим на аудио-страницу саунда и смотрим, СВЕЖИЕ ли рилсы там
// (гипотеза: аудио-страница = поток свежака того же тренда, в отличие от keyword-поиска = старьё).
// usage: DB_PUBLIC_URL=... AUDIO_ID=27280066711695368 node audiotest.cjs
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUDIO = process.env.AUDIO_ID;

(async () => {
  if (!process.env.DB_PUBLIC_URL || !AUDIO) { console.log('нужны DB_PUBLIC_URL + AUDIO_ID'); process.exit(1); }
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const a = (await c.query(`SELECT a.slug,a.gologin_profile_id,g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.ig_role='reader' AND a.gologin_profile_id IS NOT NULL LIMIT 1`)).rows[0];
  await c.end();
  console.log('искатель ' + a.slug + ' — Orbita локально…');
  const { GoLogin } = await import('gologin');
  const gl = new GoLogin({ token: a.gologin_token, profile_id: a.gologin_profile_id });
  const res = await gl.startLocal();
  const b = await chromium.connectOverCDP(res.wsUrl, { timeout: 60000 });
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  await page.route('**/*', (r) => { const t = r.request().resourceType(); if (t === 'media' || t === 'font' || t === 'image') return r.abort().catch(() => {}); return r.continue().catch(() => {}); }).catch(() => {});
  try {
    // Пробуем оба формата URL аудио-страницы.
    for (const url of [`https://www.instagram.com/reels/audio/${AUDIO}/`, `https://www.instagram.com/reel/audio/${AUDIO}/`]) {
      console.log('\n→ ' + url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(5000);
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 1800).catch(() => {}); await sleep(1500); }
      const links = await page.locator('a[href*="/reel/"], a[href*="/p/"]').evaluateAll((els) => Array.from(new Set(els.map(e => e.href))).slice(0, 30)).catch(() => []);
      const title = await page.title().catch(() => '');
      console.log('  title:', title.slice(0, 80));
      console.log('  рилсов на странице:', links.length);
      if (!links.length) { console.log('  (пусто — пробую другой формат/логин-волл)'); continue; }
      // Читаем 4 рилса — свежие ли (дата поста)?
      let fresh = 0, checked = 0;
      for (const l of links.slice(0, 5)) {
        await page.goto(l, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        await sleep(2000);
        const dts = await page.evaluate(() => Array.from(document.querySelectorAll('time[datetime]')).map(e => e.getAttribute('datetime')).filter(Boolean)).catch(() => []);
        const st = dts.map(t => Date.parse(t)).filter(n => !Number.isNaN(n)).sort((x, y) => x - y);
        const days = st.length ? ((Date.now() - st[0]) / 86400000).toFixed(1) : '?';
        const code = (l.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
        checked++; if (days !== '?' && Number(days) <= 4) fresh++;
        console.log(`    ${code}: пост ${days} дн назад`);
        await sleep(2500);
      }
      console.log(`  ИТОГ: свежих (≤4дн) ${fresh} из ${checked} проверенных → аудио-поиск ${fresh >= 2 ? 'ДАЁТ СВЕЖАК ✓' : 'свежака мало'}`);
      break;
    }
  } catch (e) { console.log('СБОЙ', e.message.slice(0, 150)); }
  finally { try { await gl.stopLocal(); } catch { try { await gl.stop(); } catch {} } }
})().catch(e => console.log('FATAL', e.message)).finally(() => process.exit(0));
