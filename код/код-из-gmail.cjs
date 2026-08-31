'use strict';
/**
 * КОД ПОДТВЕРЖДЕНИЯ ИЗ GMAIL ЧЕРЕЗ БРАУЗЕР — ЗАПАСНОЙ ПУТЬ, КОГДА IMAP НЕ ДАЁТСЯ.
 *
 * Зачем. Ферма умеет добирать код из письма по IMAP, но у Gmail с 2022 года
 * обычный пароль для IMAP не работает: нужен «пароль приложения», а его на
 * купленных ящиках обычно нет. Итог: вход в аккаунт упирается в код, ферма
 * встаёт и ждёт человека. Владелец 30.08: «если я не у ноута, у нас акк будет
 * стоять».
 *
 * Как. Тем же приёмом, что и обновлялка токена ВК (vktoken.cjs): держим свой
 * профиль Chrome, где владелец логинится в почту ОДИН раз руками. Дальше скрипт
 * сам открывает Gmail, находит свежее письмо от TikTok и вынимает из него код.
 *
 * Пароли скрипт не вводит и не хранит: вход владелец делает сам, дальше живёт
 * сессия в профиле браузера.
 *
 *   node scripts/код-из-gmail.cjs --login            один раз: залогиниться в Gmail
 *   node scripts/код-из-gmail.cjs --account <id>     взять код и отдать ферме
 *   node scripts/код-из-gmail.cjs --account <id> --показать   только показать, не отдавать
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ПРОФИЛЬ = path.join(os.homedir(), '.neironka', 'gmailprofile');
const ЖИВОЙ = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ПУЛЬТ = process.env.TF_API || 'http://127.0.0.1:7420';
const ПОРТ_ОТЛАДКИ = process.env.CHROME_CDP_PORT || '9223';

// Письмо от TikTok приходит с разных адресов, поэтому ищем по теме и телу.
// Код всегда шестизначный и стоит отдельным блоком.
const ПОИСК = 'from:(tiktok OR bytedance) newer_than:1d';
const КОНФИГ = path.join(os.homedir(), 'Desktop', 'НЕЙРОНКА', 'tapfarm', 'config.json');

/* Ящик берём из конфига фермы: у каждого аккаунта своя почта, а в браузере
   владельца их пять сразу. Без этого мост читал бы чужой ящик и возвращал
   код от другого аккаунта — молча и с виду успешно. */
function почтаАккаунта(id) {
  const j = JSON.parse(fs.readFileSync(КОНФИГ, 'utf8'));
  const почта = j.accounts?.[id]?.email;
  if (!почта) throw new Error(`у аккаунта ${id} в конфиге фермы не записана почта`);
  return почта;
}
const КОД = /\b(\d{6})\b/;

/* СНИМАЕМ СЕССИЮ С ЖИВОГО ПРОФИЛЯ ВЛАДЕЛЬЦА.
   Логиниться в Gmail из-под автоматизации нельзя: Google отвечает
   «Couldn't sign you in — this browser or app may not be secure» и не
   пускает даже с верным паролем. Но ГОТОВУЮ сессию он принимает, поэтому
   вход не нужен вовсе — берём куки из Chrome, где владелец уже залогинен.
   Копируем, а не работаем на живом профиле: Chrome не открывает один
   каталог дважды, и мост не должен мешать владельцу пользоваться браузером.
   Копия обновляется на каждом запуске, чтобы не протухала. */
function обновитьСессию() {
  fs.mkdirSync(path.join(ПРОФИЛЬ, 'Default'), { recursive: true });
  const копия = (откуда, куда) => {
    try { fs.cpSync(откуда, куда, { recursive: true, force: true }); } catch {}
  };
  копия(path.join(ЖИВОЙ, 'Local State'), path.join(ПРОФИЛЬ, 'Local State'));
  for (const f of ['Cookies', 'Preferences', 'Secure Preferences', 'Local Storage', 'Session Storage']) {
    копия(path.join(ЖИВОЙ, 'Default', f), path.join(ПРОФИЛЬ, 'Default', f));
  }
}

const арг = (имя) => {
  const i = process.argv.indexOf(имя);
  return i > 0 ? (process.argv[i + 1] || true) : null;
};

(async () => {
  const логин = process.argv.includes('--login');
  const account = арг('--account');
  const толькоПоказать = process.argv.includes('--показать');

  if (!логин && !account) {
    console.log('нужен --account <id> или --login');
    process.exit(1);
  }

  /* Основной путь — живой Chrome владельца: там сессия настоящая, и Google
     не видит попытки входа. Открывается скриптом включить-мост-gmail.sh.
     Запасной путь (копия профиля) оставлен на случай, если порт закрыт: он
     работает не всегда, потому что куки шифруются ключом из связки ключей. */
  let ctx;
  let живой = false;
  try {
    const br = await chromium.connectOverCDP(`http://127.0.0.1:${ПОРТ_ОТЛАДКИ}`, { timeout: 5000 });
    ctx = br.contexts()[0];
    живой = true;
    console.log('работаю в твоём Chrome');
  } catch {
    console.log('порт отладки закрыт, пробую копию сессии (менее надёжно)');
    console.log('надёжнее: запусти ./включить-мост-gmail.sh');
    обновитьСессию();
    ctx = await chromium.launchPersistentContext(ПРОФИЛЬ, {
      executablePath: CHROME,
      headless: !логин,
      viewport: { width: 1280, height: 900 },
      args: логин ? [] : ['--window-position=-2400,-2400'],
    });
  }

  let page;
  try {
    // В живом Chrome НЕ трогаем вкладки владельца: заводим свою.
    page = живой ? await ctx.newPage() : (ctx.pages()[0] || (await ctx.newPage()));

    if (логин) {
      await page.goto('https://mail.google.com/', { waitUntil: 'domcontentloaded' });
      console.log('Окно открыто на сессии владельца — проверь, что почта видна.');
      await page.waitForTimeout(120_000);
      return;
    }

    /* authuser заставляет Gmail открыть КОНКРЕТНЫЙ ящик. Индекс /u/N зависит
       от порядка входа и меняется, поэтому на него не опираемся. */
    const почта = почтаАккаунта(account);
    console.log('ящик: ' + почта);
    const url = 'https://mail.google.com/mail/u/0/?authuser=' + encodeURIComponent(почта)
      + '#search/' + encodeURIComponent(ПОИСК);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // Не залогинены — говорим честно, а не возвращаем пустоту.
    if (/accounts\.google\.com|ServiceLogin/.test(page.url())) {
      console.log('ОШИБКА: сессия владельца не подхватилась — открой Gmail в своём Chrome и повтори');
      process.exit(2);
    }

    // Открываем самое свежее письмо и читаем текст.
    const первое = page.locator('tr.zA').first();
    if (!(await первое.count())) {
      console.log('писем от TikTok за сутки нет');
      process.exit(3);
    }
    await первое.click();
    await page.waitForTimeout(2500);

    const текст = await page.locator('div.a3s').first().innerText().catch(() => '');
    const m = String(текст).match(КОД);
    if (!m) {
      console.log('письмо открыто, но шестизначного кода в нём нет');
      process.exit(4);
    }
    const код = m[1];
    console.log('код из письма: ' + код);

    if (толькоПоказать) return;

    // Отдаём ферме тем же путём, что и человек через панель.
    const r = await fetch(`${ПУЛЬТ}/api/accounts/${encodeURIComponent(account)}/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: код }),
    });
    const тело = await r.text();
    console.log(r.ok ? `код передан ферме для ${account}` : `ферма не приняла код: ${тело.slice(0, 200)}`);
    if (!r.ok) process.exit(5);
  } finally {
    // Живой браузер не закрываем — он владельца. Убираем только свою вкладку.
    if (живой) await page?.close().catch(() => {});
    else await ctx.close().catch(() => {});
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
