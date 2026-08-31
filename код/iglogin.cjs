// INLINE-ЛОГИН IG в УЖЕ ОТКРЫТОМ окне (page/ctx). Вынесен из проверенного chlogin.cjs, чтобы vcomment мог
// залогинить гостевой акк ПРЯМО в своём Orbita-окне и сразу комментить (не закрывая, не перекидывая). ЧП-модель
// владельца. Не трогает браузер/БД/жизненный цикл — только логин. Возвращает {ok, reason}.
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TOTP RFC 6238 (2FA-ключ). base32 → HMAC-SHA1 → 6 цифр, окно 30с.
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
// Код из почты (challenge). Пароль почты = часть до ":". sinceMs — только письма новее момента.
function getCode(email, emailPassRaw, sinceMs) {
  const pass = String(emailPassRaw || '').split(':')[0];
  const host = 'mail.' + String(email || '').split('@')[1];
  try { const out = execFileSync('node', ['imapcode.cjs', email, pass, host, String(sinceMs || 0)], { timeout: 30000, cwd: __dirname }).toString().trim();
    return JSON.parse(out); } catch (e) { return { ok: false, err: String(e.message).slice(0, 60) }; }
}

const NOTNOW = /^(Not now|Not Now|Не сейчас|Позже|Skip|Пропустить|Dismiss|Отмена|Để sau|Không phải bây giờ|Ahora no|Später|Daha sonra)$/i;
const CONT = /^(Continue|Продолжить|Confirm|Подтвердить|Next|Далее|Submit|Отправить|Done|Готово|Tiếp tục|Continuar|Weiter|Devam et|Devam|متابعة|继续|Avanti)$/i;
async function loggedIn(page) {
  const u = page.url();
  if (/\/challenge|accounts\/login|\/auth_platform|two_factor|\/accounts\/(suspended|disabled)/.test(u)) return false;
  return (await page.locator('a[href="/explore/"], a[href="/reels/"], svg[aria-label*="ome" i]').count().catch(() => 0)) > 0;
}

// creds: {ig_login, ig_password, ig_email, ig_email_password, totp_secret}
// opts:  {log?, shot?}  (shot(name) — опциональный скриншот)
// Возврат: {ok:boolean, reason:'logged_in'|'already'|'suspended'|'bad_pw'|'cooldown'|'no_code'|'transport'|'stuck'|'noform'}
async function loginInline(page, ctx, creds, opts = {}) {
  const log = opts.log || (() => {});
  const shot = opts.shot || (async () => {});
  const startTs = Date.now();
  try {
    // Пиним EN-локаль IG (challenge/2FA на чужом языке иначе). Кука+заголовок надёжнее одного hl.
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
    await page.goto('https://www.instagram.com/accounts/login/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4000); await shot('0_open');
    if (await loggedIn(page)) { log('  уже залогинен'); return { ok: true, reason: 'already' }; }
    // 0) Лендинг «Log in or Sign up» (свежий профиль): поле за ссылкой «Log in».
    for (let g = 0; g < 3; g++) {
      const hasInput = await page.locator('input[name="username"], input[name="email"], input[type="password"], input[type="text"]').first().isVisible().catch(() => false);
      if (hasInput) break;
      const li = page.getByText(/^(Log ?in|Войти|Iniciar sesión|Entrar|Fazer login|Đăng nhập|Anmelden|Accedi)$/i).first();
      if (await li.isVisible().catch(() => false)) { log('  лендинг → жму «Log in»'); await li.click().catch(() => {}); await sleep(4500); } else break;
    }
    // 1) Форма логина: ждём username, заполняем ПОСИМВОЛЬНО (fill не триггерит React onChange → кнопка disabled).
    const userInput = page.locator('input[name="username"], input[name="email"], input[autocomplete="username"], input[aria-label*="sername" i], input[aria-label*="obile number" i], input[placeholder*="sername" i], input[placeholder*="obile number" i], input[type="text"]:not([type="password"])').first();
    let hasForm = false;
    for (let i = 0; i < 9; i++) { if (await userInput.isVisible().catch(() => false)) { hasForm = true; break; } await sleep(2000); }
    if (hasForm) {
      await userInput.click().catch(() => {}); await userInput.fill('').catch(() => {});
      await userInput.pressSequentially(creds.ig_login, { delay: 25 }).catch(async () => { await userInput.fill(creds.ig_login).catch(() => {}); });
      const passInput = page.locator('input[name="password"], input[type="password"]').first();
      await passInput.click().catch(() => {}); await passInput.fill('').catch(() => {});
      await passInput.pressSequentially(creds.ig_password, { delay: 25 }).catch(async () => { await passInput.fill(creds.ig_password).catch(() => {}); });
      // ПРОВЕРКА ЗАПОЛНЕНИЯ (баг 28.07, скрин владельца: пароль вписан, ЛОГИН ПУСТ). IG перерисовывает форму
      // после гидрации и стирает то, что напечатали первым — а логин печатается первым. Перепечатываем до 3 раз.
      for (let v = 0; v < 3; v++) {
        const uv = await userInput.inputValue().catch(() => '');
        if (uv && uv.trim().length >= 3) break;
        await sleep(700);
        await userInput.click().catch(() => {}); await userInput.fill('').catch(() => {});
        await userInput.pressSequentially(creds.ig_login, { delay: 30 }).catch(async () => { await userInput.fill(creds.ig_login).catch(() => {}); });
        if (opts.log) opts.log(`  ↻ логин был пуст (перерисовка формы) — перепечатал (попытка ${v + 1})`);
      }
      const pv = await passInput.inputValue().catch(() => '');
      if (!pv) { await passInput.click().catch(() => {}); await passInput.pressSequentially(creds.ig_password, { delay: 30 }).catch(() => {}); }
      await sleep(400); await shot('1_filled');
      const btn = page.locator('button[type="submit"]:not([disabled])').first();
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {}); else await passInput.press('Enter').catch(() => {});
      await sleep(7000); await shot('2_afterlogin');
    } else { log('  форма логина не появилась'); return { ok: false, reason: 'noform' }; }
    // 2) Цикл прохождения экранов (save-info / challenge / 2FA-код / «Continue as X»).
    let codeTries = 0, unknown = 0, resubmit = 0, passModalTries = 0, transRetry = 0;
    for (let step = 0; step < 16; step++) {
      if (await loggedIn(page)) { log('  ВОШЛИ ✓'); return { ok: true, reason: 'logged_in' }; }
      if (/accounts\/onetap/.test(page.url())) { log('  ВОШЛИ ✓ (onetap)'); return { ok: true, reason: 'logged_in' }; }
      const trans = await page.getByText(/TRANSPORT_ERROR|Network request encountered error|Что-то пошло не так|Something went wrong|запрос.{0,20}(ошибк|error)/i).first().isVisible().catch(() => false);
      if (trans) {
        if (transRetry < 3) { transRetry++; log(`  ⚠ TRANSPORT_ERROR (прокси флап) → релоад ${transRetry}/3`); await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(5000); codeTries = 0; unknown = 0; continue; }
        log('  ⛔ TRANSPORT_ERROR не ушёл (прокси нестабилен)'); return { ok: false, reason: 'transport' };
      }
      const wrongPw = await page.getByText(/login information you entered is incorrect|password (you entered is|was) incorrect|incorrect password|неверный пароль|введённый.*пароль.*неверн/i).first().isVisible().catch(() => false);
      if (wrongPw) { log('  IG: НЕВЕРНЫЙ ПАРОЛЬ'); return { ok: false, reason: 'bad_pw' }; }
      const cool = await page.getByText(/wait a few minutes|подождите несколько минут|try again later|попробуйте (позже|ещё раз)/i).first().isVisible().catch(() => false);
      if (cool) { log('  IG кулдаун входа (soft-block)'); return { ok: false, reason: 'cooldown' }; }
      const susp = await page.getByText(/suspended your account|account (has been )?suspended|suspendimos tu cuenta|cuenta.{0,25}suspendida|приостанов|account.{0,20}disabled|inhabilita/i).first().isVisible().catch(() => false);
      if (susp || /\/accounts\/(suspended|disabled)/.test(page.url())) { log('  ⛔ СУСПЕНД/БАН'); return { ok: false, reason: 'suspended' }; }
      const nn = page.getByText(NOTNOW).first();
      if (await nn.isVisible().catch(() => false)) { unknown = 0; log('  Not now'); await nn.click().catch(() => {}); await sleep(3000); continue; }
      // Единый детектор экрана кода (языконезависимо): поле кода + нет пароля. Маска почты → challenge, иначе 2FA.
      const ptext = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
      const hasMaskedEmail = /\S[*•·]{2,}\S*@\S*[*•·]/.test(ptext);
      const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
      // КРИТ (01.08): раньше брали .first() по селектору — на экране 2FA перед видимым полем «Code»
      // лежат СКРЫТЫЕ инпуты, первый матч оказывался невидимым → «поля кода нет» → скрипт молча ждал
      // (владелец видел пустое поле, пока мы «вводили»). Берём первый ВИДИМЫЙ и редактируемый.
      const codeSel = [
        'input[name="verificationCode"]', 'input[autocomplete="one-time-code"]',
        'input[aria-label*="код" i]', 'input[aria-label*="code" i]', 'input[inputmode="numeric"]',
        'input[placeholder*="код" i]', 'input[placeholder*="code" i]',
        'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])',
      ].join(', ');
      const findVisible = async () => {
        const loc = page.locator(codeSel);
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false) && await el.isEditable().catch(() => false)) return el;
        }
        return null;
      };
      const codeVisible = hasPassword ? null : await findVisible();
      const codeInput = codeVisible || page.locator(codeSel).first();
      const hasCodeField = !hasPassword && !!codeVisible;
      // «Continue as X» / one-tap re-auth: видно поле пароля (username-формы нет) → вводим пароль → Log in.
      if (hasPassword && !hasMaskedEmail && passModalTries < 3) {
        passModalTries++; unknown = 0;
        const pf = page.locator('input[type="password"]').first();
        await pf.click().catch(() => {}); await pf.fill('').catch(() => {});
        await pf.pressSequentially(creds.ig_password, { delay: 25 }).catch(async () => { await pf.fill(creds.ig_password).catch(() => {}); });
        await sleep(700);
        let clicked = false;
        for (let i = 0; i < 16 && !clicked; i++) {
          const bBtn = page.getByRole('button', { name: /^\s*(Log ?in|Войти|Continue|Продолжить|Confirm|Подтвердить|Anmelden|Se connecter|Iniciar sesión|Giriş|Accedi)\s*$/i }).first();
          if (await bBtn.isVisible().catch(() => false) && await bBtn.isEnabled().catch(() => false)) { await bBtn.click().catch(() => {}); clicked = true; break; }
          const sBtn = page.locator('button[type="submit"]:not([disabled])').first();
          if (await sBtn.isVisible().catch(() => false)) { await sBtn.click().catch(() => {}); clicked = true; break; }
          await sleep(500);
        }
        if (!clicked) await pf.press('Enter').catch(() => {});
        log(`  «Continue as X»: пароль введён (${passModalTries}/3)`); await sleep(6000); continue;
      }
      if (hasCodeField && codeTries < 3) {
        let code = null, src = '';
        if (hasMaskedEmail) {
          let cr = null;
          for (let t = 0; t < 11; t++) { cr = getCode(creds.ig_email, creds.ig_email_password, startTs - 120000); if (cr.ok && cr.code) break; log(`  жду код с почты (${t})…`); await sleep(7000); }
          if (!(cr && cr.ok && cr.code)) { log('  КОД НЕ ПРИШЁЛ'); return { ok: false, reason: 'no_code' }; }
          code = cr.code; src = 'почта';
        } else if (creds.totp_secret) {
          // Ждём СВЕЖЕЕ окно TOTP: три попытки подряд укладывались в одно 30-сек окно → IG трижды получал
          // один и тот же уже использованный код (ревью 28.07).
          { const left = 30 - Math.floor((Date.now() / 1000) % 30); if (codeTries > 0 || left < 8) await sleep((left + 1) * 1000); }
          code = totp(creds.totp_secret); src = '2FA TOTP';
        } else {
          log('  поле кода без маски-почты и без TOTP → пробую «Try another way»'); unknown = 0;
          const another = page.getByText(/another way|Другой способ|другим способом|Otra forma|outra forma|Andere|autre méthode/i).first();
          if (await another.isVisible().catch(() => false)) {
            await another.click().catch(() => {}); await sleep(3500);
            const emOpt = page.getByText(/@\S*[*•·]|[*•·]\S*@|\be-?mail\b|correo|почт|электрон/i).first();
            if (await emOpt.isVisible().catch(() => false)) { await emOpt.click().catch(() => {}); await sleep(1200); }
            const cb = page.getByText(CONT).first(); if (await cb.isVisible().catch(() => false)) await cb.click().catch(() => {});
            await sleep(4500); continue;
          }
          log('  нечем получить код'); return { ok: false, reason: 'no_code' };
        }
        log(`  код (${src}): ${code}`);
        await codeInput.click().catch(() => {});
        const otpBoxes = await page.locator('input[maxlength="1"]').count().catch(() => 0);
        if (otpBoxes >= 4) { await page.keyboard.type(code, { delay: 60 }).catch(() => {}); } else { await codeInput.pressSequentially(code, { delay: 80 }).catch(async () => { await codeInput.fill(code).catch(() => {}); }); }
        unknown = 0; codeTries++; await sleep(500);
        const cbtn = page.getByText(CONT).first();
        if (await cbtn.isVisible().catch(() => false)) await cbtn.click().catch(() => {}); else await codeInput.press('Enter').catch(() => {});
        await sleep(6000); continue;
      }
      const cont = page.getByText(/^(Continue|Продолжить|Send [Cc]ode|Отправить код|This was me|Это я|Confirm|Dismiss|OK)$/i).first();
      if (await cont.isVisible().catch(() => false)) { unknown = 0; log('  Continue/подтверждение'); await cont.click().catch(() => {}); await sleep(5000); continue; }
      // Всё ещё логин-форма (username+password) → сабмит не прошёл, досабмичиваем до 2 раз.
      const uAgain = page.locator('input[name="username"], input[autocomplete="username"], input[aria-label*="sername" i], input[type="text"]:not([type="password"])').first();
      const pAgain = page.locator('input[type="password"]').first();
      if (resubmit < 2 && await pAgain.isVisible().catch(() => false) && await uAgain.isVisible().catch(() => false)) {
        resubmit++; unknown = 0; log(`  всё ещё логин-форма → досабмичиваю (${resubmit}/2)`);
        await uAgain.click().catch(() => {}); await uAgain.fill('').catch(() => {}); await uAgain.pressSequentially(creds.ig_login, { delay: 20 }).catch(async () => { await uAgain.fill(creds.ig_login).catch(() => {}); });
        await pAgain.click().catch(() => {}); await pAgain.fill('').catch(() => {}); await pAgain.pressSequentially(creds.ig_password, { delay: 20 }).catch(async () => { await pAgain.fill(creds.ig_password).catch(() => {}); });
        const sb = page.locator('button[type="submit"]').first();
        if (await sb.isVisible().catch(() => false)) await sb.click({ timeout: 8000 }).catch(() => {});
        await pAgain.press('Enter').catch(() => {}); await sleep(6500); continue;
      }
      unknown++; log(`  экран не распознан (${unknown}) — жду`); await sleep(4500);
      if (unknown >= 5) { log('  застряло, стоп'); return { ok: false, reason: 'stuck' }; }
    }
    return (await loggedIn(page)) ? { ok: true, reason: 'logged_in' } : { ok: false, reason: 'stuck' };
  } catch (e) { log('  ОШИБКА логина: ' + String(e.message).slice(0, 80)); return { ok: false, reason: 'stuck' }; }
}

module.exports = { loginInline, totp };
