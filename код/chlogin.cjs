// Challenge-логин: вход в IG + прохождение подтверждения по почте (код читаем по IMAP из imapcode.cjs).
// Осторожно: код вводим ОДИН раз; при провале — стоп (без перебора, чтобы не залочить купленный акк).
// usage: node chlogin.cjs "<slug>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const SHOT = process.env.SHOT_DIR;
// TOTP RFC 6238 (для акков с 2FA-ключом). base32 → HMAC-SHA1 → 6 цифр, окно 30с.
function totp(secret) {
  const b32 = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!b32) return '';
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of b32) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const cb = Buffer.alloc(8); cb.writeUInt32BE(Math.floor(counter / 2 ** 32), 0); cb.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(cb).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24 | (hmac[off + 1] & 0xff) << 16 | (hmac[off + 2] & 0xff) << 8 | (hmac[off + 3] & 0xff)) % 1e6;
  return String(code).padStart(6, '0');
}
const SLUG = process.argv[2];
// Unbuffered stdout: node БУФЕРИЗУЕТ вывод при pipe (не TTY) → лог «застывает на params», диагностика вслепую.
// Делаем синхронным — каждый шаг виден в реальном времени (иначе не понять, ГДЕ 2FA-логин висит).
try { if (process.stdout._handle && process.stdout._handle.setBlocking) process.stdout._handle.setBlocking(true); } catch {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// АНТИДЕТЕКТ ввода (начальник 22.07): НЕ печатать креды посимвольно за 25мс (чистый бот). Живой юзер ВСТАВЛЯЕТ пароль
// из менеджера (Ctrl/Meta+V) → так и делаем. Фолбэк: человеческая печать 110-160мс/символ (чуть быстрее среднего ~200мс).
// Всегда добиваем input/keydown (End), иначе IG не активирует кнопку Login (комментарий про pressSequentially ниже).
async function humanEnter(page, loc, text) {
  const s = String(text || '');
  await loc.click().catch(() => {}); await sleep(180 + Math.floor(Math.random() * 220));
  await loc.fill('').catch(() => {});
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  let ok = false;
  try {
    await page.evaluate((t) => navigator.clipboard.writeText(t), s);
    await sleep(120 + Math.floor(Math.random() * 160));           // «нашёл пароль в менеджере»
    await page.keyboard.press(`${mod}+V`);
    await sleep(220);
    ok = (((await loc.inputValue().catch(() => '')) || '').length >= s.length - 1);
  } catch {}
  if (!ok) { // копипаст не прошёл (нет clipboard-доступа) → человеческая печать, НЕ 25мс-бот
    await loc.fill('').catch(() => {});
    await loc.pressSequentially(s, { delay: 110 + Math.floor(Math.random() * 50) }).catch(async () => { await loc.fill(s).catch(() => {}); });
  }
  await loc.press('End').catch(() => {}); await sleep(140);        // добить input-event → кнопка Login активна
}
// COOKIE-БАННЕР IG перекрывает форму логина (начальник 22.07). Живой юзер кликает по нему ПЕРВЫМ; бот лезет за поля
// ПОД баннером = детект. Гасим ДО ввода. «Decline optional cookies» (privacy: essential остаются) → фолбэк «Allow all».
async function dismissCookies(page) {
  for (const rx of [/decline optional cookies/i, /only allow essential/i, /allow all cookies/i, /отклонить необязательные|разрешить все файлы cookie/i]) {
    try {
      const b = page.getByText(rx).first();
      if (await b.isVisible().catch(() => false)) {
        await sleep(500 + Math.floor(Math.random() * 600)); // «прочитал баннер» — не мгновенный клик
        await b.click().catch(() => {}); await sleep(1000);
        console.log(`  🍪 cookie-баннер закрыт (${String(rx).slice(1, 22)}…)`);
        return true;
      }
    } catch {}
  }
  return false;
}
const shot = async (page, name) => { try { require('fs').writeFileSync(`${SHOT}/cl_${SLUG}_${name}.png`, await page.screenshot({ type: 'png' })); } catch {} };
// Инструментируй провал, а не угадывай: на КАЖДОМ неуспехе логируем URL + тексты видимых кнопок + скрин.
// Тогда чужеязычная кнопка (польский onetap/consent/Not now) видна в ПЕРВОМ логе, а не через 6 итераций вслепую.
const diag = async (page, name) => {
  let url = ''; let btns = [];
  try { url = page.url(); } catch {}
  try {
    btns = await page.evaluate(() => {
      const seen = new Set();
      for (const el of document.querySelectorAll('button,[role="button"],a[href],input[type="submit"],div[role="button"]')) {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        if (s.display === 'none' || s.visibility === 'hidden' || r.width < 1 || r.height < 1) continue;
        const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (t) seen.add(t);
      }
      return [...seen].slice(0, 25);
    });
  } catch {}
  console.log(`  ⓘ ${name}: url=${url}`);
  console.log(`  ⓘ ${name}: кнопки=[${btns.join(' | ')}]`);
  await shot(page, name);
};

async function loadDb() {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try {
      await c.connect();
      // По slug без привязки к платформе: модельные акки живут в platform='promo' (изоляция от
      // комментинга, promoisolate.cjs), а логинить руками их надо ровно так же.
      const a = (await c.query(`SELECT a.id, a.gologin_profile_id, a.ig_login, a.ig_password, a.ig_email, a.ig_email_password, a.totp_secret, g.gologin_token
        FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
      await c.end(); return a;
    } catch (e) { await c.end().catch(() => {}); console.log('db try' + k, e.code); await sleep(2500); }
  }
  throw new Error('db fail');
}
// Код из почты (пароль почты = первая часть до ":"). sinceMs — берём только письма НОВЕЕ этого момента (не протухший код).
function getCode(email, emailPassRaw, sinceMs) {
  const pass = String(emailPassRaw || '').split(':')[0];
  const host = 'mail.' + String(email || '').split('@')[1];
  try { const out = execFileSync('node', ['imapcode.cjs', email, pass, host, String(sinceMs || 0)], { timeout: 30000, cwd: __dirname }).toString().trim();
    return JSON.parse(out); } catch (e) { return { ok: false, err: String(e.message).slice(0, 60) }; }
}
let loginConfirmed = false; // ставится в markLive (зовётся ТОЛЬКО при подтверждённом входе) → finally закрывает Orbita только тогда
let CTX = null;             // контекст живого окна: нужен, чтобы снять куки ДО закрытия профиля (см. saveCookies)
// КУКИ В БАЗУ В ТОЙ ЖЕ СЕССИИ (баг 06.08, luke85469). Раньше надеялись только на синк профиля в облако:
// SDK читает cookie-файл на ЕЩЁ ЖИВОМ Orbita, поэтому sessionid логина в зип не попадал — следующий заход
// видел форму входа, а в базе стояло «live» без ig_cookies (движки постинга стартуют только по кукам).
// Теперь при подтверждённом входе куки снимаются из контекста и пишутся в accounts.ig_cookies.
async function saveCookies(id) {
  if (!CTX) return;
  try {
    const fresh = (await CTX.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
    if (!fresh.some((x) => x.name === 'sessionid' && String(x.value).length > 10)) { console.log('  ⚠ куки: живой sessionid не найден — в базу НЕ пишу'); return; }
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try { await c.connect(); await c.query('UPDATE accounts SET ig_cookies=$2::jsonb WHERE id=$1', [id, JSON.stringify(fresh)]); await c.end(); } catch (e) { await c.end().catch(() => {}); throw e; }
    console.log(`  💾 куки сняты и сохранены в базу (${fresh.length})`);
  } catch (e) { console.log('  ⚠ куки не сохранились:', String(e.message).slice(0, 80)); }
}
async function markLive(id) {
  loginConfirmed = true;
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(`UPDATE accounts SET session_status='live', ig_status='login_ok', login_fails=0, status='warming', session_checked_at=now() WHERE id=$1`, [id]); await c.end(); } catch { await c.end().catch(() => {}); }
  await saveCookies(id);
}
async function markSuspended(id) { // акк в бане (труп) → в снос авто-заменой
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(`UPDATE accounts SET session_status='dead', ig_status='suspended', status='paused', session_checked_at=now() WHERE id=$1`, [id]); await c.end(); } catch { await c.end().catch(() => {}); }
}
async function markSoftBlock(id) { // IG отбил вход свежего акка как анти-бот («неверный пароль» ложно) → НЕ труп, 3ч кулдаун, ретрай
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(`UPDATE accounts SET session_status='dead', ig_status='soft_block', status='paused', session_checked_at=now() WHERE id=$1`, [id]); await c.end(); } catch { await c.end().catch(() => {}); }
}

const NOTNOW = /^(Not now|Not Now|Не сейчас|Позже|Skip|Пропустить|Dismiss|Отмена|Để sau|Không phải bây giờ|Ahora no|Später|Daha sonra)$/i;
const CONT = /^(Continue|Продолжить|Confirm|Подтвердить|Next|Далее|Submit|Отправить|Done|Готово|Tiếp tục|Continuar|Weiter|Devam et|Devam|متابعة|继续|Avanti)$/i;
const loggedIn = async (page) => {
  const u = page.url();
  if (/\/challenge|accounts\/login|\/auth_platform|two_factor|\/accounts\/(suspended|disabled)/.test(u)) return false;
  // Языконезависимо: ссылки навигации логина одинаковы на любом языке (в отличие от aria-label «Home»/«Trang chủ»).
  return (await page.locator('a[href="/explore/"], a[href="/reels/"], svg[aria-label*="ome" i]').count().catch(() => 0)) > 0;
};

(async () => {
  if (!SLUG) { console.log('usage: <slug>'); return; }
  const a = await loadDb();
  if (!a) { console.log('нет акка'); return; }
  console.log(`акк ${SLUG}: почта ${a.ig_email}, профиль ${a.gologin_profile_id}`);
  let b, gl = null;
  if (process.env.LOCAL) {
    // ЛОКАЛЬНЫЙ запуск: профиль поднимается в Orbita НА ЭТОМ МАКЕ (без cloud-лимитов и штормов «не подключился»).
    // SDK применяет тот же прокси+фингерпринт профиля, коннект — к локальному ws://127.0.0.1. Первый раз качает Orbita.
    try {
      const { GoLogin } = await import('gologin');
      // uploadCookiesToServer: без него локальный вход НЕ сохраняется в облачный профиль (куки логина
      // выбрасываются при закрытии) → акк остаётся «ПЕРЕЛОГИН». Флаг заставляет залить куки на сервер при stop.
      // HEADLESS=1 — вход БЕЗ окна Chrome (правило начальника 06.08: окна не открывать). Тот же приём,
      // что в setbio/addemail: '--headless=new' в extra_params Orbita. По умолчанию поведение старое (окно).
      const extra = process.env.HEADLESS === '1' ? ['--headless=new'] : [];
      gl = new GoLogin({ token: a.gologin_token, profile_id: a.gologin_profile_id, uploadCookiesToServer: true, extra_params: extra });
      const res = await gl.startLocal();
      if (res && res.wsUrl) b = await chromium.connectOverCDP(res.wsUrl, { timeout: 60000 });
    } catch (e) { console.log('LOCAL старт не удался:', String(e.message).slice(0, 120)); }
  } else {
    const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', a.gologin_token); u.searchParams.set('profile', a.gologin_profile_id);
    for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch (e) { console.log('коннект try' + k); await sleep(k === 0 ? 22000 : 14000); } }
  }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); if (gl) { try { await gl.stopLocal(); } catch {} } return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  CTX = ctx; // отдаём контекст saveCookies: куки снимаем на живом окне, после закрытия профиля их уже не достать
  const startTs = Date.now();
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    // НЕ ЖЕЧЬ РЕЗИД-ТРАФИК (дорогой!): режем тяжёлые ресурсы — для логина картинки/видео/шрифты не нужны.
    // Экономит ~80% байт страницы (раньше churn сжёг ~3.5GB). Отключить: NO_TRAFFIC_SAVE=1.
    if (!process.env.NO_TRAFFIC_SAVE) await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    }).catch(() => {});
    // Пиним английскую локаль IG. ?hl=en в URL часто перебивается локалью GoLogin-профиля (рандом PT/FR/TR/AR/BG…),
    // из-за чего challenge/2FA приходит на чужом языке. Кука ig_lang=en + Accept-Language держат интерфейс на EN
    // надёжнее, чем один hl. Даже если не сработает — детект ниже теперь языконезависим (страховка вторым слоем).
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
    // Идём на ГЛАВНУЮ, НЕ на /accounts/login: если акк залогинен (куки в профиле) — IG отдаёт ЛЕНТУ сразу (loggedIn→markLive,
    // без Continue-as/2FA). Если не залогинен — IG сам редиректит на login, и дальше отработает форма. Баг (начальник 22.07):
    // раньше всегда шли на /accounts/login → даже залогиненный акк показывал Continue-as вместо ленты.
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4000);
    await shot(page, '0_open');
    if (await loggedIn(page)) { console.log('УЖЕ ЗАЛОГИНЕН'); await markLive(a.id); await shot(page, 'done'); return; }
    await dismissCookies(page); // cookie-баннер перекрывает форму → гасим ПЕРВЫМ, как живой юзер (не лезем под него)
    // 0) ЛЕНДИНГ «Get the full experience — Log in or Sign up» (свежий профиль без кук): поля username НЕТ,
    //    оно за ссылкой «Log in». Жмём её, иначе chlogin висит на «форма не появилась». До 3 шагов.
    for (let g = 0; g < 3; g++) {
      const hasInput = await page.locator('input[name="username"], input[name="email"], input[type="password"], input[type="text"]').first().isVisible().catch(() => false);
      if (hasInput) break;
      const li = page.getByText(/^(Log ?in|Войти|Iniciar sesión|Entrar|Fazer login|Đăng nhập|Anmelden|Accedi)$/i).first();
      if (await li.isVisible().catch(() => false)) { console.log('лендинг → жму «Log in»'); await li.click().catch(() => {}); await sleep(4500); }
      else break;
    }
    // 1) ЛОГИН-ФОРМА: дожидаемся поля username (до ~18с), заполняем логин+пароль, входим.
    // IG отдаёт РАЗНЫЕ лейауты логина — поле бывает name=username | name=email | просто text | по aria/placeholder.
    const userInput = page.locator('input[name="username"], input[name="email"], input[autocomplete="username"], input[aria-label*="sername" i], input[aria-label*="obile number" i], input[placeholder*="sername" i], input[placeholder*="obile number" i], input[type="text"]:not([type="password"])').first();
    let hasForm = false;
    for (let i = 0; i < 9; i++) { if (await userInput.isVisible().catch(() => false)) { hasForm = true; break; } await sleep(2000); }
    if (hasForm) {
      await dismissCookies(page); // баннер мог всплыть вместе с формой — гасим ПЕРЕД вводом, не тянемся под него
      // ВВОД ПОСИМВОЛЬНО: fill() у нового React-логина IG не триггерит onChange → кнопка «Log in» остаётся disabled →
      // сабмит впустую, висим на форме (кейс raphael/cash/sterling). pressSequentially шлёт keydown/input → кнопка активна.
      await humanEnter(page, userInput, a.ig_login);
      const passInput = page.locator('input[name="password"], input[type="password"]').first();
      await sleep(300 + Math.floor(Math.random() * 400)); // пауза между полями (человек переводит взгляд / жмёт Tab)
      await humanEnter(page, passInput, a.ig_password);
      await sleep(400); await shot(page, '1_filled');
      const btn = page.locator('button[type="submit"]:not([disabled])').first();
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {}); else await passInput.press('Enter').catch(() => {});
      await sleep(7000); await shot(page, '2_afterlogin');
    } else { console.log('форма логина не появилась'); await diag(page, '1_noform'); }
    // 2) ЦИКЛ прохождения экранов (save-info / challenge / код). Терпеливо: на загрузочном/незнакомом экране ждём.
    let codeEntered = false, unknown = 0, resubmit = 0, passModalTries = 0, transRetry = 0;
    // После Login ЖДЁМ разрешения спиннера: пока видна форма логина (поле пароля + submit-спиннер), 2FA ещё не пришёл.
    // Иначе detect ловит поле пароля спиннер-формы → уходит в re-auth ветку вместо ожидания 2FA (баг hallie 22.07).
    for (let sp = 0; sp < 12; sp++) {
      const stillLoginForm = await page.locator('input[name="password"], input[type="password"]').first().isVisible().catch(() => false);
      const spinner = await page.locator('button[type="submit"] svg[aria-label*="oad" i], [role="progressbar"], svg circle[stroke-dasharray]').first().isVisible().catch(() => false);
      if (!stillLoginForm && !spinner) break;          // форма ушла / спиннер пропал → идём в detect (2FA появится)
      if (await loggedIn(page)) break;
      await sleep(2500);
    }
    for (let step = 0; step < 16; step++) {
      await shot(page, `loop${step}`); // СКРИНШОТ КАЖДОЙ ИТЕРАЦИИ — смотреть ЧТО видит бот (не гадать по логу, урок 22.07)
      if (await loggedIn(page)) { console.log('ВОШЛИ ✓'); await markLive(a.id); await shot(page, 'done'); return; }
      // ПРЯМОЙ 2FA-ВВОД ПО URL (cloud+local, единый поток, обход застревающего detect): на two_step_verification генерим
      // TOTP и вводим в поле Code + Continue СРАЗУ — НЕ полагаясь на detect-цикл (passModal раньше перехватывал → застревал).
      // Для CLOUD критично: одна сессия на профиль, второй connect (enter2fa) невозможен → chlogin вводит 2FA САМ.
      if (/two_step_verification|two_factor/.test(page.url()) && a.totp_secret && !codeEntered) {
        const codeField = page.locator('input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[inputmode="numeric"], input[type="text"]:not([type="password"])').first();
        if (await codeField.isVisible().catch(() => false)) {
          const code = totp(a.totp_secret);
          console.log(`  🔑 2FA (прямой ввод по URL) → код ${code}`);
          await codeField.click().catch(() => {}); await codeField.fill('').catch(() => {});
          await codeField.pressSequentially(code, { delay: 80 }).catch(async () => { await codeField.fill(code).catch(() => {}); });
          codeEntered = true; await sleep(600);
          const cb = page.getByText(CONT).first(); if (await cb.isVisible().catch(() => false)) await cb.click().catch(() => {}); else await codeField.press('Enter').catch(() => {});
          await sleep(3000); await shot(page, `s${step}_2fa_direct`); continue;
        }
      }
      // СПИННЕР-ГЕЙТ (баг hallie 22.07): submit-кнопка формы/модалки = loading → запрос грузится, экран НЕ финальный.
      // Ждём разрешения, НЕ детектим (иначе passModal видит поле пароля спиннер-модалки → вводит пароль СНОВА вместо
      // перехода к 2FA — начальник: «снова не увидел 2FA»). Покрывает ВСЕ пути: форма, Continue-as/re-auth, passModal.
      const spinning = await page.locator('button[type="submit"] svg circle[stroke-dasharray], button svg circle[stroke-dasharray], [role="progressbar"], button[disabled] svg[aria-label*="oad" i]').first().isVisible().catch(() => false);
      if (spinning) { unknown = 0; await sleep(1200); continue; }
      // Save info попап (onetap/лента) → ЖМЁМ «Save info» (НЕ Not now): акк → trusted device → следующий вход onetap
      // «Continue as X» БЕЗ пароля/2FA (правило начальника 22.07). Снимает боль повторного 2FA.
      const saveBtn = page.getByRole('button', { name: /^\s*(Save info|Сохранить(\sинформацию)?)\s*$/i }).first();
      if (await saveBtn.isVisible().catch(() => false)) {
        console.log('  💾 Save info → trusted device (следующий вход без 2FA)');
        await sleep(600 + Math.floor(Math.random() * 500)); await saveBtn.click().catch(() => {}); await sleep(2500);
        await shot(page, `s${step}_saveinfo`);
        console.log('ВОШЛИ ✓ (onetap, логин сохранён)'); await markLive(a.id); await shot(page, 'done_onetap'); return;
      }
      // Continue-as (saved-login re-auth): «Continue as X» + «Use another profile» → жмём Continue СРАЗУ, не висим
      // 20-40с на unknown-цикле (баг 19, начальник). Ускоряет повторный вход. Дальше пойдёт пароль-модалка ИЛИ 2FA.
      // Continue-as (saved-login): детектим по КНОПКЕ Continue (button ИЛИ div[role=button]), НЕ по тексту «Use another
      // profile» (он грузится медленно/на чужом языке → бот висел 20с не видя экран, начальник 22.07). На /accounts/login
      // + видимая кнопка Continue = сохранённый профиль → жмём сразу. Нет поля пароля (иначе это passModal ниже).
      if (/accounts\/login|onetap/.test(page.url())) {
        const contBtn = page.locator('button, div[role="button"]').filter({ hasText: /^\s*(Continue|Продолжить)\s*$/i }).first();
        const hasPwHere = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
        if (!hasPwHere && await contBtn.isVisible().catch(() => false)) { unknown = 0; console.log('  ▶ Continue-as → жму Continue (по кнопке, не по тексту)'); await sleep(200); await contBtn.click().catch(() => {}); await sleep(1500); continue; }
      }
      // onetap («сохранить данные входа») показывается ПОСЛЕ успешного входа — сессия уже установлена = успех.
      if (/accounts\/onetap/.test(page.url())) {
        // ГОНКА (06.08, luke85469): на /accounts/onetap мы оказываемся РАНЬШЕ, чем дорисуется попап
        // «Save your login info?» → проверка saveBtn выше не срабатывала, и trusted device не ставился
        // (следующий вход снова с паролем и 2FA = лишний риск). Ждём кнопку до 8с и жмём, если появилась.
        for (let w = 0; w < 8; w++) {
          const sb = page.getByRole('button', { name: /^\s*(Save info|Сохранить(\sинформацию)?)\s*$/i }).first();
          if (await sb.isVisible().catch(() => false)) { console.log('  💾 Save info → trusted device'); await sb.click().catch(() => {}); await sleep(2500); break; }
          await sleep(1000);
        }
        console.log('ВОШЛИ ✓ (onetap)'); await markLive(a.id); await shot(page, 'done_onetap'); return;
      }
      // TRANSPORT_ERROR = ПРОКСИ оборвал запрос (не 2FA, не акк, не пароль). Лечение: релоад страницы + повтор.
      // При упорстве (3×) — значит прокси реально нестабилен: захватываем текст ошибки + скрин и стоп.
      const trans = await page.getByText(/TRANSPORT_ERROR|Network request encountered error|Что-то пошло не так|Something went wrong|запрос.{0,20}(ошибк|error)/i).first().isVisible().catch(() => false);
      if (trans) {
        if (transRetry < 3) { transRetry++; console.log(`  ⚠ TRANSPORT_ERROR (прокси флапнул) → релоад + повтор (${transRetry}/3)`); await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(5000); codeEntered = false; passModalDone = false; unknown = 0; continue; }
        console.log('  ⛔ TRANSPORT_ERROR не ушёл за 3 релоада → прокси нестабилен (менять прокси), стоп'); await diag(page, `s${step}_transport_error`); break;
      }
      // НЕВЕРНЫЙ ПАРОЛЬ (подтверждённо) vs транзиентный кулдаун — РАЗНЫЕ вещи: пароль битый = труп (куки-акк сносим),
      // «wait a few minutes» = soft-block, повторить позже (НЕ сносить). Разводим два сигнала.
      const wrongPw = await page.getByText(/login information you entered is incorrect|password (you entered is|was) incorrect|incorrect password|неверный пароль|введённый.*пароль.*неверн/i).first().isVisible().catch(() => false);
      if (wrongPw) {
        // «Неверный пароль» на СВЕЖЕМ bought-акке (есть 2FA-сид, первый вход) = почти всегда SOFT-BLOCK, а НЕ битый пароль:
        // поставщик даёт рабочие пароли, а IG отбивает свежак/пул-IP как анти-бот. Помечаем soft_block (3ч кулдаун), НЕ труп.
        const fresh = !!a.totp_secret; // свежий bought с 2FA-ключом
        if (fresh) { console.log('  🔴🔴 SOFT-BLOCK ДЕТЕКТ: IG отбил вход свежего акка как «неверный пароль» = АНТИ-БОТ, НЕ битый пароль → ig_status=soft_block, 3ч кулдаун, ретрай позже'); await markSoftBlock(a.id); await diag(page, `s${step}_SOFTBLOCK`); break; }
        console.log('  IG: НЕВЕРНЫЙ ПАРОЛЬ (bad_creds, НЕ свежий — вероятно реально битый) — стоп'); await diag(page, `s${step}_badpw`); break;
      }
      const cool = await page.getByText(/wait a few minutes|подождите несколько минут|try again later|попробуйте (позже|ещё раз)/i).first().isVisible().catch(() => false);
      if (cool) { console.log('  IG кулдаун входа (soft-block) — стоп, повторить позже'); await diag(page, `s${step}_cooldown`); break; }
      // Аккаунт СУСПЕНДНУТ/забанен (часто продавцы впаривают уже мёртвые акки): «We suspended your account».
      const susp = await page.getByText(/suspended your account|account (has been )?suspended|suspendimos tu cuenta|cuenta.{0,25}suspendida|приостанов|account.{0,20}disabled|inhabilita/i).first().isVisible().catch(() => false);
      if (susp || /\/accounts\/(suspended|disabled)/.test(page.url())) { console.log('  ⛔ СУСПЕНДНУТ/ЗАБАНЕН — акк мёртвый (вероятно, при покупке)'); await markSuspended(a.id); await diag(page, `s${step}_SUSPENDED`); break; }
      // «Save login info / Turn on notifications» → Not now
      const nn = page.getByText(NOTNOW).first();
      if (await nn.isVisible().catch(() => false)) { unknown = 0; console.log('  Not now'); await nn.click().catch(() => {}); await sleep(3000); await shot(page, `s${step}_notnow`); continue; }
      // ── ЕДИНЫЙ ДЕТЕКТОР ЭКРАНА КОДА (языконезависимый) ─────────────────────────────────
      // И почтовый challenge, И authenticator-2FA выглядят одинаково: видимое ПОЛЕ КОДА + НЕТ поля пароля.
      // Раньше 2FA распознавался по ТЕКСТУ («authentication app»…, ~6 языков) — при рандомной локали GoLogin
      // (PT/FR/TR/AR/ZH…) текст не совпадал и скрипт «не понимал, куда вводить код». Теперь текст не нужен:
      // различаем два случая ТОЛЬКО по замаскированной почте (r****b@t***.com — одинакова на любом языке).
      const ptext = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
      const hasMaskedEmail = /\S[*•·]{2,}\S*@\S*[*•·]/.test(ptext); // маска-звёздочками ИЛИ буллетами
      const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
      // Поле кода: сперва явные атрибуты IG (языконезависимы, тот же селектор что в radar.ts), потом — любой
      // одиночный видимый text/number-инпут как fallback.
      const codeInput = page.locator([
        'input[name="verificationCode"]', 'input[autocomplete="one-time-code"]',
        'input[aria-label*="код" i]', 'input[aria-label*="code" i]', 'input[inputmode="numeric"]',
        'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])',
      ].join(', ')).first();
      const hasCodeField = !hasPassword && await codeInput.isVisible().catch(() => false);
      // «Continue as <акк>» / one-tap re-auth: видно ПОЛЕ ПАРОЛЯ (username-формы нет — основной блок выше её
      // не ловит, оттого раньше висли на «Continue» вхолостую). Вводим пароль посимвольно (React onChange) → Log in.
      if (hasPassword && !hasMaskedEmail && passModalTries < 3) {
        passModalTries++; unknown = 0;
        const pf = page.locator('input[type="password"]').first();
        await humanEnter(page, pf, a.ig_password);
        await sleep(700); await shot(page, `s${step}_passmodal`);
        // КЛИК по «Log in» ОБЯЗАТЕЛЕН (баг: пароль вписан, кнопка не нажата → вис). Ждём АКТИВНУЮ кнопку до ~8с.
        let clicked = false;
        for (let i = 0; i < 16 && !clicked; i++) {
          const bBtn = page.getByRole('button', { name: /^\s*(Log ?in|Войти|Continue|Продолжить|Confirm|Подтвердить|Anmelden|Se connecter|Iniciar sesión|Giriş|Accedi)\s*$/i }).first();
          if (await bBtn.isVisible().catch(() => false) && await bBtn.isEnabled().catch(() => false)) { await bBtn.click().catch(() => {}); clicked = true; break; }
          const sBtn = page.locator('button[type="submit"]:not([disabled])').first();
          if (await sBtn.isVisible().catch(() => false)) { await sBtn.click().catch(() => {}); clicked = true; break; }
          await sleep(500);
        }
        if (!clicked) await pf.press('Enter').catch(() => {});
        console.log(`  «Continue as X»: пароль введён, «Log in» ${clicked ? 'НАЖАТ' : 'Enter (кнопку не нашёл)'} (попытка ${passModalTries}/3)`);
        await sleep(3000); await shot(page, `s${step}_afterpass`);
        continue;
      }
      if (hasCodeField && !codeEntered) {
        let code = null, src = '';
        if (hasMaskedEmail) {
          // ПОЧТОВЫЙ challenge → код с IMAP (свежий, новее старта; письмо идёт не сразу — несколько попыток)
          let cr = null;
          for (let t = 0; t < 11; t++) { cr = getCode(a.ig_email, a.ig_email_password, startTs - 120000); if (cr.ok && cr.code) break; console.log(`  жду код с почты (${t})…`); await sleep(7000); }
          if (!(cr && cr.ok && cr.code)) { console.log('  КОД НЕ ПРИШЁЛ:', cr && cr.err); await diag(page, `s${step}_nocode`); break; }
          code = cr.code; src = `почта («${cr.subject}» ${cr.when})`;
        } else if (a.totp_secret) {
          // AUTHENTICATOR-2FA → TOTP из ключа в БД (RFC 6238)
          code = totp(a.totp_secret); src = '2FA TOTP';
        } else {
          // Поле кода есть, но ни маски-почты, ни TOTP-ключа → 2FA-приложение без ключа. Пробуем «Try another way»→почта.
          console.log('  поле кода без маски-почты и без TOTP-ключа → пробую «Try another way»'); unknown = 0;
          const another = page.getByText(/another way|Thử cách khác|Другой способ|другим способом|Otra forma|outra forma|Andere|Intentar de otra|autre méthode/i).first();
          if (await another.isVisible().catch(() => false)) {
            await another.click().catch(() => {}); await sleep(3500); await shot(page, `s${step}_another`);
            const emOpt = page.getByText(/@\S*[*•·]|[*•·]\S*@|\be-?mail\b|correo|почт|электрон/i).first();
            if (await emOpt.isVisible().catch(() => false)) { await emOpt.click().catch(() => {}); await sleep(1200); }
            const cb = page.getByText(CONT).first(); if (await cb.isVisible().catch(() => false)) await cb.click().catch(() => {});
            await sleep(4500); await shot(page, `s${step}_emailmethod`); continue;
          }
          console.log('  «Try another way» не найдено — нечем получить код, стоп'); await diag(page, `s${step}_nocodeway`); break;
        }
        // ВВОД кода (одинаково для почты и TOTP). Submit языконезависимо: Enter, а CONT-кнопка — запасной клик.
        console.log(`  код (${src}): ${code}`);
        await codeInput.click().catch(() => {});
        const otpBoxes = await page.locator('input[maxlength="1"]').count().catch(() => 0);
        if (otpBoxes >= 4) { await page.keyboard.type(code, { delay: 60 }).catch(() => {}); } // редкий лейаут: 6 отдельных боксов
        else { await codeInput.fill(code).catch(() => {}); }
        unknown = 0; codeEntered = true; await sleep(500); await shot(page, `s${step}_codefilled`);
        const cbtn = page.getByText(CONT).first();
        if (await cbtn.isVisible().catch(() => false)) await cbtn.click().catch(() => {}); else await codeInput.press('Enter').catch(() => {});
        await sleep(6000); await shot(page, `s${step}_aftercode`);
        continue;
      }
      // Иначе — экран выбора метода/подтверждения: жмём Continue/«это я»
      const cont = page.getByText(/^(Continue|Продолжить|Send [Cc]ode|Отправить код|This was me|Это я|Confirm|Dismiss|OK)$/i).first();
      if (await cont.isVisible().catch(() => false)) { unknown = 0; console.log('  Continue/подтверждение'); await cont.click().catch(() => {}); await sleep(2000); await shot(page, `s${step}_cont`); continue; }
      // Всё ещё на ЛОГИН-ФОРМЕ (видны и username, и password) → сабмит не прошёл: клик по «Log in» проглотился/
      // таймаутнул (кейс tripp70222: скрины 1_filled и 2_afterlogin идентичны — форма заполнена, но НЕ отправлена,
      // ошибки нет). Один клик хрупок; досабмичиваем в цикле, до 2 раз. Если пароль реально неверный — верхний
      // детект `bad` поймает «incorrect» на следующей итерации и остановит (без долбёжки).
      const uAgain = page.locator('input[name="username"], input[autocomplete="username"], input[aria-label*="sername" i], input[type="text"]:not([type="password"])').first();
      const pAgain = page.locator('input[type="password"]').first();
      if (resubmit < 2 && await pAgain.isVisible().catch(() => false) && await uAgain.isVisible().catch(() => false)) {
        resubmit++; unknown = 0; console.log(`  всё ещё логин-форма → досабмичиваю (${resubmit}/2)`);
        await humanEnter(page, uAgain, a.ig_login);
        await sleep(300 + Math.floor(Math.random() * 300));
        await humanEnter(page, pAgain, a.ig_password);
        const sb = page.locator('button[type="submit"]').first();
        if (await sb.isVisible().catch(() => false)) await sb.click({ timeout: 8000 }).catch(() => {});
        await pAgain.press('Enter').catch(() => {}); // и клик, и Enter — чтобы сабмит точно ушёл
        await sleep(6500); await diag(page, `s${step}_resubmit`);
        continue;
      }
      // Незнакомый/загрузочный экран — НЕ бросаем сразу: ждём и повторяем (IG показывает сплэш между шагами).
      unknown++; console.log(`  экран не распознан (${unknown}) — жду`);
      if (unknown === 1) await diag(page, `s${step}_wait`); // скрин только на ПЕРВОЙ нераспознанной (не каждую итерацию — тормозит)
      await sleep(1800);
      if (unknown >= 5) { console.log('  застряло надолго, стоп'); break; }
    }
    const okFinal = await loggedIn(page);
    if (okFinal) { console.log('ИТОГ: ВОШЛИ ✓'); await markLive(a.id); }
    else { console.log('ИТОГ: НЕ вошли'); await diag(page, 'final_notloggedin'); } // дамп последнего экрана: url+кнопки, а не «см. скрины»
  } catch (e) { console.log('ОШИБКА', String(e.message).slice(0, 100)); await diag(page, 'err'); }
  finally {
    if (gl) {
      // ЗАКРЫВАЕМ РОВНО СВОЮ сессию через gl.killBrowser() = наш собственный child-процесс Orbita (processSpawned).
      // ⛔ НИКАКОГО pkill по паттерну (он валил ВСЕ окна). killBrowser физически не может задеть чужое окно.
      if (process.env.NOCLOSE) {
        console.log('  окно ОСТАВЛЕНО ОТКРЫТЫМ (NOCLOSE)');
      } else {
        if (loginConfirmed) {
          try { const nn = page.getByRole('button', { name: /not now|не сейчас/i }).first(); if (await nn.isVisible().catch(() => false)) { await nn.click().catch(() => {}); await sleep(800); } } catch {}
          // синк кук в облако через REST (работает даже когда wss-браузер лежит), короткий retry; не вышло — не страшно, куки на диске
          let synced = false;
          for (let i = 0; i < 3; i++) { try { await gl.stopLocal({ posting: true }); synced = true; break; } catch { await sleep(2500); } }
          console.log(synced ? '  ✓ вход, куки синкнуты, закрываю СВОЮ сессию' : '  ✓ вход (синк не прошёл), закрываю СВОЮ сессию');
        } else {
          console.log('  вход не подтверждён — закрываю СВОЮ сессию');
        }
        try { gl.killBrowser(); } catch {}       // РОВНО свой процесс, чужие окна недосягаемы
        await b.close().catch(() => {});
      }
    } else {
      // CLOUD: облачную сессию всегда гасим (иначе висит и ест слот тарифа).
      await fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.gologin_token } }).catch(() => {});
      await b.close().catch(() => {});
    }
  }
})().catch(e => console.log('FATAL', e.message)).finally(() => { if (process.env.LOCAL) process.exit(0); }); // SDK держит хендлы → выходим явно
