// Снять админ-куку ОДИН РАЗ из постоянного окна, чтобы дальше лить референсы без браузера.
const { openAdmin } = require('./adminbrowser.cjs');
(async()=>{
  const { page, done } = await openAdmin();
  await page.goto('https://neironka.pro/admin/promo', { waitUntil:'domcontentloaded', timeout:60000 });
  const cookies = await page.context().cookies('https://neironka.pro');
  const строка = cookies.map(c=>`${c.name}=${c.value}`).join('; ');
  require('fs').writeFileSync('/tmp/admin_cookie.txt', строка);
  console.log('кук снято:', cookies.length, '· имена:', cookies.map(c=>c.name).join(','));
  await done();
  process.exit(0);
})().catch(e=>{ console.log('ОШИБКА:', e.message.slice(0,120)); process.exit(1); });
