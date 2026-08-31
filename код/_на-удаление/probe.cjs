const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:23002', { timeout: 60000 });
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  console.log('вкладок:', pages.length, pages.map(p => p.url().slice(0,60)).join(' | '));
  const page = pages.find(p => /instagram/.test(p.url())) || pages[0];
  await page.screenshot({ path: '/tmp/probe_darrell.png' }).catch(e=>console.log('скрин фейл', e.message));
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    body: document.body.innerText.slice(0, 900),
    links: document.querySelectorAll('a[href^="/"]').length,
    ul: document.querySelectorAll('ul').length,
    otvet: Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0 && /^Ответить$|^Reply$/.test(e.textContent.trim())).length,
    boxes: document.querySelectorAll('textarea, div[contenteditable="true"]').length,
  })).catch(e => ({err: e.message}));
  console.log(JSON.stringify(info, null, 1));
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
