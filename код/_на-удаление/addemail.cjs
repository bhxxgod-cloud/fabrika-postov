// ПРИВЯЗКА ПОЧТЫ К АККУ (05.08, начальник: «поставь на главный акк наш самый где просмотров
// много memebersceos@gmail.com»).
//
// Зачем: без подтверждённой почты/телефона IG отвечает 400 на сохранение профиля
// («You need an email or confirmed phone number») — из-за этого био пустое у всех акков.
// Проверено на самом старом акке, дело не в возрасте.
//
// В IG-2026 контакты живут в Accounts Center, а не в /accounts/edit (там же, куда переехало имя).
// Точную вёрстку не знаем, поэтому идём с разведкой: скрины на каждом шаге в /tmp/mail_<slug>_*.png
// и дамп кнопок в лог. Пароли НЕ вводим ни при каких условиях — только адрес почты.
//
// Запуск: node addemail.cjs <slug> <email> [код_подтверждения]
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const EMAIL = process.argv[3];
const CODE = process.argv[4] || '';
const sleep = L.sleep;
const shot = async (page, n) => { try { await page.screenshot({ path: `/tmp/mail_${SLUG}_${n}.png` }); } catch {} };

// ПРАВИЛО НАЧАЛЬНИКА: окна НЕ гасим сами. Раньше стояло закрытие в finally — на каждой
// неудаче окно убивалось, и следующая попытка была новым ВХОДОМ в акк (главный убийца акков).
// Теперь окно живёт: можно доработать шаг руками и добить сценарий без повторного входа.
// Закрыть осознанно: CLOSE=1 в окружении, либо node closeone.cjs --slug <slug>.
async function closeLocal() {
  if (process.env.CLOSE !== '1') { console.log('  (окно оставляю открытым — закрыть: CLOSE=1 или closeone.cjs)'); return; }
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (gl.killBrowser) gl.killBrowser(); } catch {}
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));

async function dump(page, label) {
  const d = await page.evaluate(() => ({
    url: location.href,
    text: (document.body.innerText || '').slice(0, 400).replace(/\n+/g, ' | '),
    clickable: [...document.querySelectorAll('div[role="button"], button, a')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 25),
    inputs: [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)
      .map((e) => e.getAttribute('aria-label') || e.getAttribute('name') || e.type),
  })).catch(() => ({}));
  console.log(`  [${label}] ${d.url}`);
  console.log(`     текст: ${d.text}`);
  console.log(`     кнопки: ${JSON.stringify(d.clickable)}`);
  console.log(`     поля: ${JSON.stringify(d.inputs)}`);
  return d;
}

(async () => {
  if (!SLUG || !EMAIL) { console.log('usage: node addemail.cjs <slug> <email> [код]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const row = (await c.query(`SELECT a.id, coalesce(a.ig_login,a.slug) h, a.ig_cookies, a.gologin_profile_id pid,
      a.session_status, g.gologin_token tok
    FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  await c.end();
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); process.exit(1); }
  if (row.session_status !== 'live') { console.log(`ИТОГ: ✗ сессия ${row.session_status}`); process.exit(0); }

  const { default: GoLogin } = await import('gologin');
  // HEADLESS по умолчанию (правило начальника 06.08: окна Chrome не открывать). Код из письма
  // передаём третьим аргументом. SHOW=1 возвращает видимое окно, если надо добить руками.
  const extra = process.env.SHOW === '1' ? [] : ['--headless=new'];
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid, extra }));
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    page.on('response', async (r) => {
      if (/contact_point|personal_info|add_email|confirm/i.test(r.url()) && r.request().method() === 'POST') {
        const t = await r.text().catch(() => '');
        console.log(`  NET ${r.status()} ${r.url().split('?')[0].replace(/https:\/\/[^/]+/, '')} :: ${t.slice(0, 200)}`);
      }
    });

    // Контакты живут ДИАЛОГОМ поверх /profiles/ (прямой URL контактов редиректит обратно,
    // у рабочего адреса в конце is_from_dialog=true). Поэтому: открыть /profiles/ и кликнуть
    // карточку «Contact info» — она и разворачивает нужный экран.
    console.log(`@${row.h}: открываю контактные данные`);
    await page.goto('https://accountscenter.instagram.com/profiles/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(9000);
    await L.clearOverlays(page).catch(() => {});
    await shot(page, '1_profiles');
    const contact = page.getByText(/Contact info|Контактн/i).first();
    if (await contact.isVisible({ timeout: 10000 }).catch(() => false)) {
      await contact.click().catch(() => {});
      await sleep(7000);
      await shot(page, '2_contacts');
      await dump(page, 'contact_points');
    } else console.log('  ⚠ карточка «Contact info» не найдена — смотри скрин 1');

    // РЕЖИМ ПОДТВЕРЖДЕНИЯ: почта уже добавлена и висит «Pending confirmation» — жмём её
    // и вводим код с почты, повторно добавлять адрес не нужно.
    if (CODE) {
      const pending = page.getByText(new RegExp(EMAIL.replace(/[.@+]/g, '\\$&'), 'i')).first();
      if (await pending.isVisible({ timeout: 8000 }).catch(() => false)) {
        await pending.click().catch(() => {});
        await sleep(6000);
        await shot(page, 'c1_pending');
        await dump(page, 'pending');
        const confirmBtn = page.getByText(/Confirm|Подтвердить/i).first();
        if (await confirmBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
          await confirmBtn.click().catch(() => {});
          await sleep(6000);
          await shot(page, 'c2_codeform');
        }
      }
      const codeField = page.locator('input[type="text"]:visible, input[autocomplete="one-time-code"]:visible').first();
      if (await codeField.isVisible({ timeout: 10000 }).catch(() => false)) {
        await codeField.click(); await sleep(300);
        await codeField.pressSequentially(CODE, { delay: 70 });
        await sleep(1200);
        await shot(page, 'c3_filled');
        const next = page.getByRole('button', { name: /^(Next|Confirm|Done|Далее|Подтвердить|Готово)$/i }).first();
        if (await next.isEnabled().catch(() => false)) { await next.click(); await sleep(9000); }
        else console.log('  ⚠ кнопка подтверждения неактивна');
        await shot(page, 'c4_after');
        await dump(page, 'after_code');
      } else console.log('  ⚠ поле кода не нашлось — смотри скрины c*');
      console.log('ИТОГ: код введён, смотри /tmp/mail_' + SLUG + '_c*.png');
      return;
    }

    // Кнопка добавления. В UI 2026 она называется «Add new contact» (не «Add email»):
    // на экране контактов лежит неподтверждённый телефон, из-за него IG и рубит правку профиля.
    const add = page.getByText(/Add new contact|Add email|Add new email|Добавить контакт|Добавить почт/i).first();
    if (await add.isVisible({ timeout: 8000 }).catch(() => false)) {
      await add.click().catch(() => {});
      await sleep(5000);
      await shot(page, '3_addform');
      await dump(page, 'add_form');
      // «Add new contact» только раскрывает выбор: «Add mobile number» / «Add email».
      const addMail = page.getByText(/^Add email$|Добавить эл/i).first();
      if (await addMail.isVisible({ timeout: 8000 }).catch(() => false)) {
        await addMail.click().catch(() => {});
        await sleep(6000);
        await shot(page, '3b_emailform');
        await dump(page, 'email_form');
      }
      // Поле в диалоге — голый input[type=text]: «Enter email» нарисовано плавающей меткой,
      // а не атрибутом placeholder, поэтому ищем по типу, а не по тексту.
      const field = page.locator('input[type="text"]:visible, input[type="email"]:visible').first();
      if (await field.isVisible({ timeout: 8000 }).catch(() => false)) {
        await field.click(); await sleep(300);
        await field.pressSequentially(EMAIL, { delay: 40 });
        await sleep(1000);
        // ОБЯЗАТЕЛЬНО: галочка «Choose accounts for this email» — без неё Next остаётся серым
        // и почта ни к чему не привяжется.
        const box = page.locator('input[type="checkbox"]').first();
        if (await box.isVisible({ timeout: 5000 }).catch(() => false)) {
          if (!(await box.isChecked().catch(() => false))) await box.click({ force: true }).catch(() => {});
        } else {
          await page.getByText(new RegExp(row.h, 'i')).last().click().catch(() => {});
        }
        await sleep(1200);
        await shot(page, '4_filled');
        const next = page.getByRole('button', { name: /^(Next|Add|Continue|Далее|Добавить|Продолжить)$/i }).first();
        if (await next.isEnabled().catch(() => false)) { await next.click(); await sleep(9000); }
        else console.log('  ⚠ Next серый: галочка акка не встала');
        await shot(page, '5_after');
        await dump(page, 'after_submit');
      } else console.log('  ⚠ поле почты не нашлось — смотри скрин 3');
    } else {
      console.log('  ⚠ кнопка добавления почты не нашлась — смотри скрины');
    }

    // ЖДЁМ КОД В ТОМ ЖЕ ОКНЕ (06.08). Неподтверждённая почта НЕ сохраняется между сессиями:
    // следующий заход видит в контактах только телефон, и вводить код уже некуда. Поэтому
    // после запроса кода процесс не завершается, а ждёт файл /tmp/igcode.txt до 15 минут.
    if (!CODE) {
      const CODEFILE = '/tmp/igcode.txt';
      try { fs.unlinkSync(CODEFILE); } catch {}
      console.log('  ⏳ код запрошен. Жду его в /tmp/igcode.txt (до 15 минут), окно держу открытым');
      let got = '';
      for (let i = 0; i < 90 && !got; i++) {
        await sleep(10000);
        try { got = (fs.readFileSync(CODEFILE, 'utf8') || '').replace(/\D/g, ''); } catch {}
      }
      if (!got) { console.log('ИТОГ: ⏳ код так и не пришёл, окно оставляю открытым'); return; }
      console.log(`  код получен: ${got}`);
      const cf = page.locator('input[type="text"]:visible, input[autocomplete="one-time-code"]:visible').first();
      if (await cf.isVisible({ timeout: 10000 }).catch(() => false)) {
        await cf.click(); await sleep(300);
        await cf.pressSequentially(got, { delay: 70 });
        await sleep(1200);
        await shot(page, 'w1_filled');
        const nx = page.getByRole('button', { name: /^(Next|Confirm|Done|Далее|Подтвердить|Готово)$/i }).first();
        if (await nx.isEnabled().catch(() => false)) { await nx.click(); await sleep(9000); }
        await shot(page, 'w2_after');
        await dump(page, 'после кода');
        console.log('ИТОГ: код введён в том же окне');
      } else console.log('ИТОГ: ⚠ поле кода пропало');
      return;
    }

    // Если пришли с кодом — вводим его
    if (CODE) {
      const codeField = page.locator('input[aria-label*="code" i], input[name*="code" i], input[autocomplete="one-time-code"]').first();
      if (await codeField.isVisible({ timeout: 8000 }).catch(() => false)) {
        await codeField.click(); await sleep(300);
        await codeField.pressSequentially(CODE, { delay: 60 });
        await sleep(800);
        const done = page.getByRole('button', { name: /Confirm|Done|Next|Подтвердить|Готово|Далее/i }).first();
        if (await done.isEnabled().catch(() => false)) { await done.click(); await sleep(8000); }
        await shot(page, '6_confirmed');
        await dump(page, 'after_code');
      } else console.log('  ⚠ поле кода не нашлось');
    }
    console.log('ИТОГ: шаги пройдены, смотри /tmp/mail_' + SLUG + '_*.png');
  } catch (e) { console.log(`ОШИБКА: ${String(e.message).slice(0, 120)}`); }
  finally { await closeLocal(); }
})();
