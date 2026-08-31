// ПРИВЯЗКА ПОЧТЫ И ВКЛЮЧЕНИЕ 2FA (08.08).
//
// ЗАЧЕМ. Тест магоса показал точную причину провала: из пяти акков зашёл РОВНО ОДИН, тот, у
// которого включена двухфакторка. Остальным Instagram на новом устройстве требует код с почты, а
// магос почту читать не умеет (в его формате акка есть только логин, пароль, ключ 2FA и кука).
// Значит цепочка такая: своя почта на акк → подтвердить код → включить 2FA → секретный ключ в базу.
// После этого магос заходит сам и навсегда, а заодно снимается стена с правкой ника и описания.
//
// Почта: адреса Apple Hide My Email, все падают в один ящик iCloud, читаем по IMAP через imapcode.cjs
// (креды в ~/.icloud_imap как email:пароль_приложения:хост).
//
// ВХОДА ПО ПАРОЛЮ НЕТ (правило начальника: пароль главный убийца акков). Работаем только на
// сохранённой куке: нет сессии — честно докладываем и выходим.
//
// Запуск:
//   node attachmail.cjs <slug> --mail <адрес>     привязать почту, подтвердить, включить 2FA
//   node attachmail.cjs <slug> --discover         только разведка: куда ведут экраны и что на них
//   SHOW=1 — открыть окно глазами (по умолчанию headless)
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const MAIL = (process.argv.includes('--mail') ? process.argv[process.argv.indexOf('--mail') + 1] : '') || '';
const DISCOVER = process.argv.includes('--discover');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Экраны, где Instagram держит контактные данные и двухфакторку. Порядок от нового к старому:
// в 2026 всё переехало в Accounts Center, но старые адреса ещё отвечают.
const SCREENS = {
  contact: [
    'https://accountscenter.instagram.com/personal_info/contact_points/',
    'https://accountscenter.instagram.com/personal_info/',
    'https://www.instagram.com/accounts/edit/',
  ],
  twofa: [
    'https://accountscenter.instagram.com/password_and_security/two_factor/',
    'https://www.instagram.com/accounts/two_factor_authentication/',
  ],
};

function readCode(sinceMs) {
  const [em, pw, hs] = fs.readFileSync(require('node:os').homedir() + '/.icloud_imap', 'utf8').trim().split(':');
  const out = execFileSync('node', [__dirname + '/imapcode.cjs', em, pw, hs, String(sinceMs)], { cwd: __dirname, encoding: 'utf8' });
  try { return JSON.parse(out); } catch { return { ok: false, err: 'ответ IMAP не разобран' }; }
}

// Что видно на экране: адрес, заголовки, поля, кнопки. Нужно, чтобы не гадать по DOM (правило:
// инструментируй провал, а не строй теории).
async function dumpScreen(page, tag) {
  const url = page.url();
  const info = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const t = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    return {
      заголовки: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((e) => t(e.textContent)).slice(0, 10),
      поля: [...document.querySelectorAll('input,textarea')].filter(vis).map((e) => `${e.type || 'text'}|${t(e.name || e.getAttribute('aria-label') || e.placeholder)}`).slice(0, 12),
      кнопки: [...document.querySelectorAll('button,[role=button],a[role=link]')].filter(vis).map((e) => t(e.innerText)).filter(Boolean).slice(0, 20),
    };
  }).catch(() => ({}));
  console.log(`\n── ${tag} ── ${url}`);
  console.log('   заголовки:', (info.заголовки || []).join(' | ') || '—');
  console.log('   поля:', (info.поля || []).join(' , ') || '—');
  console.log('   кнопки:', (info.кнопки || []).join(' , ') || '—');
  await L.snap(page, `attachmail_${tag}`).catch(() => {});
  return info;
}

// Клик по видимому тексту: у Instagram кнопки без стабильных имён и ролей.
async function clickText(page, re, what) {
  const h = await page.evaluateHandle((src) => {
    const rx = new RegExp(src, 'i');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const all = [...document.querySelectorAll('button,[role=button],a,label,div[tabindex]')].filter(vis);
    return all.find((e) => rx.test((e.innerText || '').replace(/\s+/g, ' ').trim())) || null;
  }, re.source);
  const node = h.asElement();
  if (!node) { console.log(`   ✗ не нашёл: ${what}`); return false; }
  await node.click({ timeout: 8000 }).catch(() => {});
  console.log(`   ✓ нажал: ${what}`);
  await sleep(3500);
  return true;
}

(async () => {
  if (!SLUG) { console.log('usage: node attachmail.cjs <slug> [--mail адрес] [--discover]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  const a = (await c.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.ig_cookies, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id = a.group_id
      WHERE (a.slug = $1 OR a.ig_login = $1) AND a.deleted_at IS NULL LIMIT 1`, [SLUG])).rows[0];
  if (!a) { console.log('акк не найден:', SLUG); await c.end(); process.exit(1); }
  console.log(`АКК ${a.h} · профиль ${a.pid}`);

  let b = null, gl = null;
  try {
    L.dropBrokenProfileZip(a.pid);
    const { default: GoLogin } = await import('gologin');
    const extra = process.env.SHOW === '1' ? [] : ['--headless=new'];
    gl = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 }, extra_params: extra });
    const r = await gl.startLocal();
    b = await chromium.connectOverCDP(r.wsUrl, { timeout: 60000 });
    console.log('браузер поднят локально');
  } catch (e) { console.log('браузер не поднялся:', String(e.message).slice(0, 90)); }
  if (!b) { if (gl) await gl.stopLocal().catch(() => {}); await c.end(); process.exit(1); }

  const ctx = b.contexts()[0] || await b.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  let verdict = 'не начато';
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
      if (cks.length) { await ctx.addCookies(cks).catch(() => {}); console.log(`подставил сессию: ${cks.length} кук`); }
    }

    // ЖИВА ЛИ СЕССИЯ. Пароль не вводим ни при каких условиях.
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const st = await L.classifyScreen(ctx, page);
    console.log(`экран: ${st.state} (${st.evidence})`);
    if (st.state !== 'logged_in') {
      verdict = `сессия не жива (${st.state}) — вход по паролю запрещён, нужен ручной заход`;
      throw new Error(verdict);
    }

    if (DISCOVER) {
      for (const url of SCREENS.contact.concat(SCREENS.twofa)) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3500);
        await dumpScreen(page, 'экран_' + url.split('/').filter(Boolean).slice(-1)[0]);
      }
      verdict = 'разведка выполнена';
      return;
    }
    if (!MAIL) throw new Error('не указан адрес: --mail <адрес>');

    // ПРИВЯЗКА. Разведка 08.08 показала рабочий экран: контактные данные в центре аккаунтов,
    // где есть кнопка «Add new contact». Старая почта прежнего владельца остаётся на месте, её не
    // трогаем: снять чужой адрес IG даёт только после подтверждения нового, иначе акк без контакта.
    await page.goto('https://accountscenter.instagram.com/personal_info/contact_points/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const before = await dumpScreen(page, 'контакты_до');
    if ((before.кнопки || []).some((x) => x.toLowerCase().includes(MAIL.toLowerCase()))) {
      verdict = `адрес ${MAIL} уже привязан`;
      await c.query(`UPDATE accounts SET ig_email = $2 WHERE slug = $1`, [a.slug, MAIL]);
      return;
    }
    if (!await clickText(page, /add new contact|добавить контакт/i, 'Add new contact')) throw new Error('кнопки добавления контакта нет');
    await clickText(page, /email|почт/i, 'вариант: почта');
    await dumpScreen(page, 'форма_почты');

    const field = page.locator('input[type="email"], input[type="text"]').first();
    await field.fill(MAIL, { timeout: 10000 });
    console.log(`   вписал адрес ${MAIL}`);
    const sentAt = Date.now() - 60000; // окно поиска письма с запасом на часы сервера
    await clickText(page, /^(next|add|continue|далее|добавить|продолжить)$/i, 'отправить');
    await dumpScreen(page, 'после_отправки');

    // Забираем код из ящика: письмо идёт не мгновенно, ждём до трёх минут.
    let got = null;
    for (let i = 1; i <= 9; i++) {
      await sleep(20000);
      got = readCode(sentAt);
      console.log(`   попытка ${i}: ${got.ok ? 'код ' + got.code : got.err}`);
      if (got.ok) break;
    }
    if (!got || !got.ok) throw new Error('код с почты не пришёл за три минуты');

    const codeField = page.locator('input[autocomplete="one-time-code"], input[type="tel"], input[type="text"]').first();
    await codeField.fill(String(got.code).replace(/\s/g, ''), { timeout: 10000 });
    await clickText(page, /^(next|confirm|done|далее|подтвердить|готово)$/i, 'подтвердить код');
    const after = await dumpScreen(page, 'контакты_после');
    const ok = (after.кнопки || []).some((x) => x.toLowerCase().includes(MAIL.toLowerCase()));
    if (ok) {
      await c.query(`UPDATE accounts SET ig_email = $2 WHERE slug = $1`, [a.slug, MAIL]);
      try { await require('./blockers.cjs').resolve({ slug: a.slug, kind: 'no_email', by: 'привязана почта ' + MAIL }); } catch {}
      verdict = `почта ${MAIL} привязана и подтверждена`;
    } else {
      verdict = 'код ввёл, но адреса в списке контактов не видно — смотри скриншоты attachmail_*';
    }
  } catch (e) {
    console.log('СБОЙ:', String(e.message).slice(0, 140));
  } finally {
    try { await b.close(); } catch {}
    try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch {}
    await c.end().catch(() => {});
  }
  console.log(`\nИТОГ по ${a.h}: ${verdict}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
