// ПОЛНЫЙ СБОР ТЕКСТА за всю историю: мотаем к началу, потом вниз, накапливая сообщения с датами.
const { chromium } = require('playwright-core');
const fs = require('fs');
const PORT = process.argv[2];
const OUT = `${process.env.HOME}/Desktop/dm_dump`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram\.com\/direct/.test(p.url())) || ctx.pages()[0];
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const MX = Math.round(vp.width * 0.72), MY = Math.round(vp.height * 0.5);
  const acc = new Map();
  const NAV = /^(Home|Reels|Messages|Search|Notifications|Create|Dashboard|Profile|More|Primary|General|Requests.*|Message\.\.\.|Your note|Seen|Switch|Log in)$/i;
  const grab = () => page.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length) return;
      const r = el.getBoundingClientRect();
      if (r.x < 550 || r.width === 0 || r.height === 0 || r.y < 80) return;
      const t = (el.textContent || '').trim();
      if (t && t.length < 900) out.push({ t, y: Math.round(r.y), x: Math.round(r.x) });
    });
    return out;
  }).catch(() => []);
  const add = (rows, ord) => rows.forEach((r) => { if (NAV.test(r.t)) return; if (!acc.has(r.t)) acc.set(r.t, { ...r, ord }); });

  console.log('к началу…');
  let last = '', same = 0;
  for (let i = 0; i < 600 && same < 30; i++) {
    add(await grab(), -i);
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, -800).catch(() => {});
    await sleep(850);
    if (i % 10 === 0) {
      const d = await page.evaluate(() => { const x = [...document.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => (e.textContent || '').trim()).filter((t) => /^\d{1,2}\/\d{1,2}\/\d{2},|^[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(t)); return x[0] || ''; }).catch(() => '');
      if (d && d === last) same++; else { same = 0; last = d; }
      if (i % 50 === 0) console.log(`  вверх ${i} · ${last} · строк ${acc.size}`);
    }
  }
  console.log(`начало: ${last} · строк ${acc.size}. Иду вниз…`);
  for (let j = 0; j < 800; j++) {
    add(await grab(), j);
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, 700).catch(() => {});
    await sleep(650);
    if (j % 80 === 0) console.log(`  вниз ${j} · строк ${acc.size}`);
  }
  const rows = [...acc.values()].sort((a, b) => a.ord - b.ord || a.y - b.y);
  const lines = ['ДИАЛОГ IG DIRECT — ПОЛНЫЙ ТЕКСТ', 's4rxisme ↔ Jaysemipro (highzotic.588)',
    `собрано: ${new Date().toISOString()} · строк ${rows.length}`, ''.padEnd(64, '='), ''];
  rows.forEach((r) => lines.push(r.t));
  fs.writeFileSync(`${OUT}/dialog_full.txt`, lines.join('\n'), 'utf8');
  console.log(`ГОТОВО → dialog_full.txt · строк ${rows.length}`);
  await b.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
