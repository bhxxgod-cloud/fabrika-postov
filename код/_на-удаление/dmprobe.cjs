const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram\.com\/direct/.test(p.url())) || ctx.pages()[0];
  const d = await page.evaluate(() => {
    const counts = {};
    ['div[role="row"]', 'div[role="listbox"]', 'div[role="grid"]', 'div[data-testid]', 'div[dir="auto"]', 'span[dir="auto"]', 'img', 'video'].forEach((s) => { counts[s] = document.querySelectorAll(s).length; });
    // ищем контейнер с максимумом текстовых узлов сообщений
    const spans = [...document.querySelectorAll('span[dir="auto"], div[dir="auto"]')].filter((e) => (e.innerText || '').trim().length > 0);
    const sample = spans.slice(0, 12).map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 40), txt: (e.innerText || '').trim().slice(0, 50) }));
    const imgs = [...document.querySelectorAll('img')].map((i) => i.src).filter((s) => /cdninstagram|fbcdn/.test(s)).slice(0, 14);
    return { counts, sample, imgCount: imgs.length, imgs };
  });
  console.log(JSON.stringify(d, null, 1).slice(0, 2600));
  await b.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
