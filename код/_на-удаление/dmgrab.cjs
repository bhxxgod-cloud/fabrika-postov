// ВЫКАЧКА ВСЕХ МЕДИА ИЗ ДИАЛОГА. Ключевое отличие: слушаем СЕТЕВЫЕ ОТВЕТЫ, а не DOM.
// IG подгружает картинки лениво и выкидывает из DOM при прокрутке — поэтому скрап DOM даёт лишь часть.
// Мы медленно проходим весь диалог и сохраняем каждый пришедший медиа-ответ. Окно не закрываем.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2];
const OUT = (process.argv[3] || `${process.env.HOME}/Desktop/dm_dump`) + '/attachments';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram\.com\/direct/.test(p.url())) || ctx.pages()[0];
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const MX = Math.round(vp.width * 0.72), MY = Math.round(vp.height * 0.5);

  // что уже есть — чтобы не качать повторно
  const have = new Set(fs.readdirSync(OUT).map((f) => f));
  const seenUrl = new Set();
  let saved = 0, skipped = 0;
  const keyOf = (u) => { const m = u.match(/\/([\w.-]+)_n\.(jpg|jpeg|png|mp4|webp)/i); return m ? m[1] : u.split('?')[0].split('/').pop(); };

  // ПЕРЕХВАТ: каждый медиа-ответ сохраняем
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (!/cdninstagram|fbcdn/.test(u)) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/image|video/.test(ct)) return;
      if (/s150x150|s320x320|profile_pic|\/e35\/c/.test(u)) return;   // аватарки и превьюшки
      const k = keyOf(u);
      if (seenUrl.has(k)) return; seenUrl.add(k);
      const buf = await resp.body().catch(() => null);
      if (!buf || buf.length < 25000) { skipped++; return; }           // мелочь = иконки
      const ext = /video/.test(ct) ? 'mp4' : (/png/.test(ct) ? 'png' : 'jpg');
      const name = `net_${String(++saved).padStart(3, '0')}_${k.slice(0, 18)}.${ext}`;
      if (have.has(name)) return;
      fs.writeFileSync(path.join(OUT, name), buf);
    } catch { /* */ }
  });

  console.log(`ловлю медиа · окно ${vp.width}x${vp.height}`);
  // 1) в самый верх диалога, медленно (чтобы всё успело подгрузиться)
  console.log('мотаю в начало…');
  let stable = 0;
  for (let i = 0; i < 120 && stable < 6; i++) {
    const before = saved;
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, -600).catch(() => {});
    await sleep(1100);
    if (saved === before) stable++; else stable = 0;
    if (i % 15 === 0) console.log(`  вверх ${i} · медиа ${saved}`);
  }
  // 2) обратно вниз мелким шагом — добираем всё, что подгружается при обратном проходе
  console.log('иду вниз мелким шагом…');
  for (let i = 0; i < 140; i++) {
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, 450).catch(() => {});
    await sleep(800);
    if (i % 20 === 0) console.log(`  вниз ${i} · медиа ${saved}`);
  }
  // 3) ещё один проход вверх — IG часто отдаёт полноразмер при повторном показе
  console.log('контрольный проход вверх…');
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, -700).catch(() => {});
    await sleep(700);
  }
  await sleep(3000);
  console.log(`ИТОГО скачано медиа: ${saved} (мелочь пропущена: ${skipped})`);
  console.log(`папка: ${OUT}`);
  await b.close().catch(() => {});   // окно НЕ закрываем
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
