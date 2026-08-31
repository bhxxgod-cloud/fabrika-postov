// ПЕРЕВОД АККА В ЛИЧНЫЙ РЕЖИМ (08.08, решение начальника).
//
// ЗАЧЕМ. Трендовая музыка Instagram даёт бесплатный подъём показов, но у аккаунтов в
// профессиональном режиме музыкальная библиотека урезана до «коммерческой», трендов там почти нет.
// Полный каталог только у ЛИЧНЫХ аккаунтов. Значит для постов с телефона акк должен быть личным.
// Побочная выгода: у личных нет вкладки статистики, зато нет и метки «бизнес», которая у Meta
// повышает планку по рекламным правилам.
//
// Пароль НЕ вводим. Работаем на сохранённой куке, как везде.
// Запуск: node topersonal.cjs <slug|ник> [--discover]      SHOW=1 — с окном
'use strict';
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const KEY = process.argv[2];
const DISCOVER = process.argv.includes('--discover');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Адреса, где Instagram держит переключатель типа аккаунта. От нового к старому.
const SCREENS = [
  'https://accountscenter.instagram.com/profiles/',
  'https://www.instagram.com/accounts/professional_account_settings/',
  'https://www.instagram.com/accounts/convert_to_personal_account/',
  'https://www.instagram.com/accounts/edit/',
];

async function dump(page, tag) {
  const info = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const t = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
      h: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((e) => t(e.textContent)).slice(0, 8),
      b: [...document.querySelectorAll('button,[role=button],a,label,div[tabindex]')].filter(vis).map((e) => t(e.innerText)).filter(Boolean).slice(0, 22),
      // Признаки профессионального режима на странице
      prof: /professional|business|creator|профессиональн|бизнес|автор/i.test(document.body.innerText || ''),
    };
  }).catch(() => ({}));
  console.log(`\n── ${tag} ── ${page.url()}`);
  console.log('   заголовки:', (info.h || []).join(' | ') || '—');
  console.log('   кнопки:', (info.b || []).join(' , ') || '—');
  await L.snap(page, `personal_${tag}`).catch(() => {});
  return info;
}

async function clickText(page, re, what) {
  const h = await page.evaluateHandle((src) => {
    const rx = new RegExp(src, 'i');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    return [...document.querySelectorAll('button,[role=button],a,label,div[tabindex]')].filter(vis)
      .find((e) => rx.test((e.innerText || '').replace(/\s+/g, ' ').trim())) || null;
  }, re.source);
  const el = h.asElement();
  if (!el) { console.log(`   ✗ нет: ${what}`); return false; }
  await el.click({ timeout: 8000 }).catch(() => {});
  console.log(`   ✓ нажал: ${what}`);
  await sleep(3500);
  return true;
}

(async () => {
  if (!KEY) { console.log('usage: node topersonal.cjs <slug|ник> [--discover]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  const a = (await c.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.ig_cookies, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id = a.group_id
      WHERE (a.slug = $1 OR a.ig_login = $1) AND a.deleted_at IS NULL LIMIT 1`, [KEY])).rows[0];
  if (!a) { console.log('акк не найден:', KEY); await c.end(); process.exit(1); }
  console.log(`АКК ${a.h}`);

  let b = null, gl = null, verdict = 'не начато';
  try {
    L.dropBrokenProfileZip(a.pid);
    const { default: GoLogin } = await import('gologin');
    gl = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 }, extra_params: process.env.SHOW === '1' ? [] : ['--headless=new'] });
    const r = await gl.startLocal();
    b = await chromium.connectOverCDP(r.wsUrl, { timeout: 60000 });
  } catch (e) { console.log('браузер не поднялся:', String(e.message).slice(0, 90)); }
  if (!b) { if (gl) await gl.stopLocal().catch(() => {}); await c.end(); process.exit(1); }

  const ctx = b.contexts()[0] || await b.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
    if (a.ig_cookies) {
      const raw = typeof a.ig_cookies === 'string' ? JSON.parse(a.ig_cookies) : a.ig_cookies;
      const cks = (Array.isArray(raw) ? raw : []).filter((x) => x && x.name && x.value).map((x) => ({
        name: x.name, value: String(x.value), domain: x.domain || '.instagram.com', path: x.path || '/',
        httpOnly: !!x.httpOnly, secure: x.secure !== false,
      }));
      if (cks.length) await ctx.addCookies(cks).catch(() => {});
    }
    await page.goto(SCREENS[1], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const st = await L.classifyScreen(ctx, page);
    console.log(`экран: ${st.state}`);
    if (st.state !== 'logged_in') throw new Error(`сессия не жива (${st.state}), вход по паролю запрещён`);

    if (DISCOVER) {
      for (const u of SCREENS) {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3500);
        await dump(page, 'экран_' + (u.split('/').filter(Boolean).slice(-1)[0] || 'корень'));
      }
      verdict = 'разведка выполнена';
      return;
    }

    await dump(page, 'настройки_типа');
    // Путь Instagram: «Switch account type» → «Switch to personal account» → подтверждение.
    await clickText(page, /switch account type|тип аккаунта|сменить тип/i, 'сменить тип аккаунта');
    const ok1 = await clickText(page, /switch to personal|переключиться на личный|личный аккаунт/i, 'переключиться на личный');
    if (!ok1) throw new Error('кнопки перехода на личный нет, смотри скриншоты personal_*');
    await clickText(page, /^(switch|continue|next|да|переключить|продолжить)$/i, 'подтвердить');
    const after = await dump(page, 'после_перевода');
    const still = /switch to personal|переключиться на личный/i.test((after.b || []).join(' '));
    verdict = still ? 'кнопка ещё на месте, перевод не подтверждён, смотри скриншоты' : 'акк переведён в личный режим';
    if (!still) await c.query(`UPDATE accounts SET health_note = coalesce(health_note,'') || ' | 08.08 переведён в личный режим (полная музыкальная библиотека)' WHERE slug = $1`, [a.slug]).catch(() => {});
  } catch (e) {
    verdict = 'СБОЙ: ' + String(e.message).slice(0, 130);
  } finally {
    try { await b.close(); } catch {}
    try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch {}
    await c.end().catch(() => {});
  }
  console.log(`\nИТОГ ${a.h}: ${verdict}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
