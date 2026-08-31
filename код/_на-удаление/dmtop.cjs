// Проверяем, дошли ли до НАСТОЯЩЕГО начала диалога, и терпеливо дожимаем подгрузку старых сообщений.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2];
const OUT = `${process.env.HOME}/Desktop/dm_dump/attachments`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram\.com\/direct/.test(p.url())) || ctx.pages()[0];
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const MX = Math.round(vp.width * 0.72), MY = Math.round(vp.height * 0.5);
  const seen = new Set(); let saved = 0;
  const keyOf = (u) => { const m = u.match(/\/([\w.-]+?)_n\.(jpg|jpeg|png|mp4|webp)/i); return m ? m[1] : u.split('?')[0].split('/').pop(); };
  page.on('response', async (resp) => {
    try {
      const u = resp.url(); if (!/cdninstagram|fbcdn/.test(u)) return;
      const ct = resp.headers()['content-type'] || ''; if (!/image|video/.test(ct)) return;
      if (/s150x150|s320x320|profile_pic/.test(u)) return;
      const k = keyOf(u); if (seen.has(k)) return; seen.add(k);
      const buf = await resp.body().catch(() => null); if (!buf || buf.length < 25000) return;
      fs.writeFileSync(path.join(OUT, `old_${String(++saved).padStart(4, '0')}_${k.slice(0, 16)}.${/video/.test(ct) ? 'mp4' : 'jpg'}`), buf);
    } catch {}
  });
  const state = () => page.evaluate(() => {
    const t = document.body.innerText;
    const d = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || '').trim()).filter((x) => /^\d{1,2}\/\d{1,2}\/\d{2},|^[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(x));
    return {
      topDate: d[0] || '',
      spinner: !!document.querySelector('[role="progressbar"], svg[aria-label*="Loading" i]'),
      atStart: /beginning of|very beginning|You (are )?friends on|followers.*posts/i.test(t.slice(0, 1200)),
    };
  }).catch(() => ({ topDate: '', spinner: false, atStart: false }));

  console.log('терпеливо дожимаю старые сообщения…');
  let last = '', same = 0;
  for (let i = 0; i < 700; i++) {
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, -800).catch(() => {});
    await sleep(1000);
    const st = await state();
    if (st.spinner) { await sleep(2500); same = 0; continue; }       // идёт подгрузка — ждём, шаг не считаем
    if (st.atStart) { console.log(`  ✓ НАЧАЛО ПЕРЕПИСКИ достигнуто (дата ${st.topDate})`); break; }
    if (st.topDate && st.topDate === last) same++; else { same = 0; last = st.topDate; }
    if (same >= 40) { console.log(`  дальше не грузится, самая ранняя дата: ${last}`); break; }
    if (i % 25 === 0) console.log(`  шаг ${i} · верх ${last || '?'} · новых медиа ${saved} · застой ${same}`);
  }
  console.log(`самая ранняя дата: ${last} | новых медиа: ${saved}`);
  await b.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
