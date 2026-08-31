'use strict';
// РАЗБОР «API access blocked» ПО КОНСОЛИ МЕТЫ. Работаем в своей вкладке статичного Chrome.
const AB = require('./adminbrowser.cjs');
const APP = '1080592121075910';
(async () => {
  const { page } = await AB.openAdmin();
  try {
    await page.goto(`https://developers.facebook.com/apps/${APP}/dashboard/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const url = page.url();
    console.log('URL:', url);
    if (/login|checkpoint/i.test(url)) { console.log('НЕ ЗАЛОГИНЕН в консоли Меты'); return; }
    const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 4000));
    console.log('--- ТЕКСТ ДАШБОРДА ---');
    console.log(txt);
  } finally {
    await AB.снятьСвою(page).catch(() => {});
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
