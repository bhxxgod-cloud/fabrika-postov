// ПОЛНАЯ ВЫКАЧКА ДЛИННОГО ДИАЛОГА. Останавливаемся не по «нет новых фото» (бывают длинные участки без медиа),
// а по ДАТЕ: мотаем вверх, пока самая ранняя видимая дата продолжает уходить в прошлое.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2];
const DIR = (process.argv[3] || `${process.env.HOME}/Desktop/dm_dump`);
const OUT = DIR + '/attachments';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram\.com\/direct/.test(p.url())) || ctx.pages()[0];
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const MX = Math.round(vp.width * 0.72), MY = Math.round(vp.height * 0.5);
  const seen = new Set(); let saved = 0;
  const keyOf = (u) => { const m = u.match(/\/([\w.-]+?)_n\.(jpg|jpeg|png|mp4|webp)/i); return m ? m[1] : u.split('?')[0].split('/').pop(); };
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (!/cdninstagram|fbcdn/.test(u)) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/image|video/.test(ct)) return;
      if (/s150x150|s320x320|profile_pic/.test(u)) return;
      const k = keyOf(u); if (seen.has(k)) return; seen.add(k);
      const buf = await resp.body().catch(() => null);
      if (!buf || buf.length < 25000) return;
      const ext = /video/.test(ct) ? 'mp4' : (/png/.test(ct) ? 'png' : 'jpg');
      fs.writeFileSync(path.join(OUT, `all_${String(++saved).padStart(4, '0')}_${k.slice(0, 16)}.${ext}`), buf);
    } catch {}
  });
  const dateNow = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || '').trim())
      .filter((t) => /^\d{1,2}\/\d{1,2}\/\d{2},|^[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(t));
    const body = document.body.innerText;
    return { first: d[0] || '', atStart: /beginning of|very beginning/i.test(body) };
  }).catch(() => ({ first: '', atStart: false }));

  console.log('мотаю к началу диалога (по датам)…');
  let lastDate = '', same = 0, i = 0;
  while (i < 900 && same < 25) {
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, -700).catch(() => {});
    await sleep(750);
    i++;
    if (i % 10 === 0) {
      const { first, atStart } = await dateNow();
      if (atStart) { console.log(`  ✓ дошёл до начала переписки (шаг ${i})`); break; }
      if (first && first === lastDate) same++; else { same = 0; lastDate = first; }
      if (i % 40 === 0) console.log(`  шаг ${i} · дата ${lastDate || '?'} · медиа ${saved}`);
    }
  }
  console.log(`верх достигнут (шагов ${i}), медиа пока ${saved}. Иду вниз, добираю всё…`);
  for (let j = 0; j < 900; j++) {
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, 700).catch(() => {});
    await sleep(650);
    if (j % 60 === 0) { const { first } = await dateNow(); console.log(`  вниз ${j} · дата ${first || '?'} · медиа ${saved}`); }
    if (j % 120 === 0 && j > 0) { const d = await dateNow(); if (/2026/.test(d.first) && j > 400) break; }
  }
  await sleep(3000);
  console.log(`ИТОГО медиа скачано за проход: ${saved}`);
  await b.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
