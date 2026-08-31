// ВКЛЮЧЕНИЕ ДВУХФАКТОРКИ ПО ПРИЛОЖЕНИЮ И СОХРАНЕНИЕ КЛЮЧА (08.08).
//
// ЗАЧЕМ. Тест магоса 08.08: из пяти акков зашёл РОВНО ОДИН, у которого включена 2FA. Остальным
// Instagram на новом устройстве требует код с почты, а почты у нас нет и магос её читать не умеет.
// Ключ 2FA решает это насовсем: он вписывается третьим полем в строку акка (логин:пароль:2fa),
// и движок сам считает одноразовый код на каждом входе. Почта для этого НЕ нужна.
//
// Разведка на живом акке показала рабочий адрес: /accounts/two_factor_authentication/ с выбором
// способа. Экраны Instagram меняются, поэтому на каждом шаге печатаем, что видим, и сохраняем
// скриншот: чинить по факту, а не по теории.
//
// Пароль НЕ вводим (правило начальника). Работаем на сохранённой куке.
// Запуск: node enable2fa.cjs <slug>        SHOW=1 — с окном
'use strict';
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const L = require('./iglib.cjs');
const { totp } = require('./iglogin.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dump(page, tag) {
  const info = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const t = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
      h: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((e) => t(e.textContent)).slice(0, 8),
      f: [...document.querySelectorAll('input,textarea')].filter(vis).map((e) => `${e.type || 'text'}|${t(e.name || e.getAttribute('aria-label') || e.placeholder)}`).slice(0, 10),
      b: [...document.querySelectorAll('button,[role=button],a[role=link],label')].filter(vis).map((e) => t(e.innerText)).filter(Boolean).slice(0, 18),
      // Ключ 2FA Instagram печатает как 32 символа base32, часто блоками по 4
      keys: (document.body.innerText.match(/\b[A-Z2-7]{4}(?:\s?[A-Z2-7]{4}){3,7}\b/g) || []).slice(0, 3),
    };
  }).catch(() => ({}));
  console.log(`\n── ${tag} ── ${page.url()}`);
  console.log('   заголовки:', (info.h || []).join(' | ') || '—');
  console.log('   поля:', (info.f || []).join(' , ') || '—');
  console.log('   кнопки:', (info.b || []).join(' , ') || '—');
  if ((info.keys || []).length) console.log('   ПОХОЖЕ НА КЛЮЧ:', info.keys.join(' / '));
  await L.snap(page, `2fa_${tag}`).catch(() => {});
  return info;
}

// Клик по видимому тексту (кнопки Instagram часто без стабильных имён и ролей).
async function clickText(page, re, what) {
  const el = await page.evaluateHandle((src) => {
    const rx = new RegExp(src, 'i');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const all = [...document.querySelectorAll('button,[role=button],a,label,div[tabindex]')].filter(vis);
    return all.find((e) => rx.test((e.innerText || '').replace(/\s+/g, ' ').trim())) || null;
  }, re.source);
  const node = el.asElement();
  if (!node) { console.log(`   ✗ не нашёл: ${what}`); return false; }
  await node.click({ timeout: 8000 }).catch(() => {});
  console.log(`   ✓ нажал: ${what}`);
  await sleep(3500);
  return true;
}

(async () => {
  if (!SLUG) { console.log('usage: node enable2fa.cjs <slug>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  const a = (await c.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.ig_cookies, coalesce(a.totp_secret,'') ts, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id = a.group_id
      WHERE (a.slug = $1 OR a.ig_login = $1) AND a.deleted_at IS NULL LIMIT 1`, [SLUG])).rows[0];
  if (!a) { console.log('акк не найден:', SLUG); await c.end(); process.exit(1); }
  if (a.ts) { console.log(`у ${a.h} ключ 2FA уже есть, включать нечего`); await c.end(); process.exit(0); }
  console.log(`ВКЛЮЧАЮ 2FA на ${a.h}`);

  let b = null, gl = null, secret = '', verdict = 'не начато';
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
        ...(x.expires && x.expires > 0 ? { expires: Math.floor(x.expires) } : {}),
      }));
      if (cks.length) await ctx.addCookies(cks).catch(() => {});
    }
    // ПУТЬ ТОЛЬКО ЧЕРЕЗ ACCOUNTS CENTER. Старый адрес /accounts/two_factor_authentication/ на выбор
    // «приложение для аутентификации» отвечает «Use the Instagram app for this feature», то есть
    // веб там бессилен (проверено 08.08 на ai.promt.mood). В Accounts Center тот же способ
    // настраивается в браузере: сначала выбираем аккаунт в списке, потом способ.
    await page.goto('https://accountscenter.instagram.com/password_and_security/two_factor/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    const st = await L.classifyScreen(ctx, page);
    if (st.state !== 'logged_in') throw new Error(`сессия не жива (${st.state}), вход по паролю запрещён`);
    const start = await dump(page, 'центр_аккаунтов');
    // Выбираем СВОЙ аккаунт: в центре аккаунтов могут висеть чужие связанные профили, промах по
    // строке настроил бы двухфакторку не тому.
    const mine = new RegExp(`${a.h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const picked = await clickText(page, mine, `аккаунт ${a.h} в списке`);
    if (!picked) {
      console.log('   список в центре аккаунтов:', (start.b || []).join(' | '));
      throw new Error(`в центре аккаунтов нет строки ${a.h} — двухфакторку настраивать не на чем`);
    }
    await dump(page, 'выбран_аккаунт');
    await clickText(page, /authentication app|приложение для аутентификации|authenticator/i, 'способ: приложение');
    let info = await dump(page, 'после_выбора_способа');
    if (!info.keys || !info.keys.length) {
      // Иногда ключ прячется за «Set up manually» / «Настроить вручную» рядом с QR-кодом.
      await clickText(page, /set up (manually|another way)|настроить вручную|can.?t scan/i, 'настроить вручную');
      info = await dump(page, 'ручная_настройка');
    }
    secret = (info.keys && info.keys[0] || '').replace(/\s+/g, '');
    if (!secret || secret.length < 16) throw new Error('ключ 2FA на экране не найден, смотри скриншоты 2fa_*');
    console.log(`   ключ получен: ${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} символов)`);

    // Подтверждаем владение: считаем код по ключу и вводим.
    const code = totp(secret);
    const field = page.locator('input[type="text"], input[type="tel"], input[autocomplete="one-time-code"]').first();
    await field.fill(code, { timeout: 10000 }).catch(() => {});
    console.log(`   ввёл код ${code}`);
    await clickText(page, /^(next|confirm|done|далее|подтвердить|готово)$/i, 'подтвердить код');
    const after = await dump(page, 'после_подтверждения');
    const on = (after.h || []).concat(after.b || []).join(' ');
    const ok = /backup codes|резервные коды|two-factor authentication is on|включена/i.test(on) ||
      /\bOn\b/.test(on);
    await c.query(`UPDATE accounts SET totp_secret = $2 WHERE slug = $1`, [a.slug, secret]);
    console.log('   ключ сохранён в базу');
    verdict = ok ? 'двухфакторка включена, ключ в базе' : 'ключ сохранён, но подтверждение с экрана не прочитал — смотри скриншоты';
  } catch (e) {
    verdict = 'СБОЙ: ' + String(e.message).slice(0, 130);
  } finally {
    try { await b.close(); } catch {}
    try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch {}
    await c.end().catch(() => {});
  }
  console.log(`\nИТОГ ${SLUG}: ${verdict}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
