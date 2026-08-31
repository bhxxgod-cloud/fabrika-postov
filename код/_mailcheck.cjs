'use strict';
const AB = require('./adminbrowser.cjs');
(async () => {
  const { page } = await AB.openAdmin();
  try {
    await page.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    const url = page.url();
    console.log('URL:', url.slice(0, 110));
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) { console.log('НЕ ЗАЛОГИНЕН в Google'); return; }
    const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2500));
    console.log('--- ИНБОКС ---');
    console.log(txt);
  } finally { await AB.снятьСвою(page).catch(() => {}); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
