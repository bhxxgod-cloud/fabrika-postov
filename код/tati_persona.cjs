// СОЗДАНИЕ ЛИЧНОСТИ «Тати» на промо-фабрике через UI вкладки «Личности» (API создания нет,
// проверено 04.08: /api/admin/promo/personas отвечает 404). Фото: АВАТАРЫ /Тати/00_исходник.jpeg.
// Скрины каждого шага в /tmp/tati_step*.png: если форма отличается от ожиданий, чиним по скринам.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const PHOTO = '/Users/qq/Desktop/АВАТАРЫ /Тати/00_исходник.jpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 30 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1400, height: 1000 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    // если Тати уже есть — выходим тихо
    const have = await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo');
      return ((await r.json()).personas || []).some((p) => p.name === 'Тати');
    });
    if (have) { console.log('ИТОГ: Тати уже на фабрике'); return; }

    await page.getByText('Личности', { exact: true }).first().click({ timeout: 8000 });
    await sleep(2500);
    await page.getByRole('button', { name: 'Добавить' }).first().click({ timeout: 8000 });
    await sleep(2000);
    await page.screenshot({ path: '/tmp/tati_step1_form.png' });

    // Имя: первое видимое текстовое поле формы
    const nameInput = page.locator('input[type=text]:visible, input:not([type]):visible').first();
    await nameInput.fill('Тати', { timeout: 8000 });
    // Фото: последний file-инпут (появился с формой)
    await page.locator('input[type=file]').last().setInputFiles(PHOTO);
    await sleep(4000);
    await page.screenshot({ path: '/tmp/tati_step2_filled.png' });

    // Сабмит: кнопка Сохранить/Создать/Добавить в форме
    const submit = page.getByRole('button', { name: /Сохранить|Создать|Добавить/i }).last();
    await submit.click({ timeout: 8000 });
    await sleep(6000);
    await page.screenshot({ path: '/tmp/tati_step3_after.png' });

    const check = await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo');
      const p = ((await r.json()).personas || []).find((x) => x.name === 'Тати');
      return p ? p.id : null;
    });
    console.log(check ? `ИТОГ: ✅ Тати создана, id=${check}` : 'ИТОГ: ✗ Тати не появилась в списке (см. /tmp/tati_step*.png)');
  } finally { await ctx.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
