// ДАМП ДИАЛОГА IG DIRECT — прокрутка КОЛЕСОМ по области сообщений (детектор скроллера в IG не работает),
// инкрементальный сбор при виртуализации. Подключается к уже открытому окну, НИЧЕГО не закрывает.
const { chromium } = require('playwright-core');
const fs = require('fs');
const PORT = process.argv[2];
const OUT = process.argv[3] || `${process.env.HOME}/Desktop/dm_dump`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(`${OUT}/attachments`, { recursive: true });
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram\.com\/direct/.test(p.url())) || ctx.pages()[0];
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const MX = Math.round(vp.width * 0.72), MY = Math.round(vp.height * 0.5);
  console.log(`страница: ${page.url()} | окно ${vp.width}x${vp.height} | курсор ${MX},${MY}`);

  const collect = () => page.evaluate(() => {
    const NAV = /^(Home|Reels|Messages|Search|Notifications|Create|Dashboard|Profile|More|Primary|General|Requests.*|Message\.\.\.|Your note|Seen|Switch)$/i;
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.x < 550 || r.width === 0 || r.height === 0 || r.y < 80) return;
      if (el.tagName === 'IMG') { const s = el.src || ''; if (/cdninstagram|fbcdn/.test(s) && r.width > 90) out.push({ type: 'img', src: s, y: Math.round(r.y) }); return; }
      if (el.tagName === 'VIDEO') { const s = el.src || (el.querySelector('source') || {}).src || ''; if (s) out.push({ type: 'vid', src: s, y: Math.round(r.y) }); return; }
      if (el.children.length === 0) { const t = (el.textContent || '').trim(); if (t && t.length < 800 && !NAV.test(t)) out.push({ type: 'text', text: t, y: Math.round(r.y), x: Math.round(r.x) }); }
    });
    return out;
  }).catch(() => []);

  const acc = new Map();
  const add = (rows, order) => rows.forEach((r) => { const k = r.type + '|' + (r.text || r.src); if (!acc.has(k)) acc.set(k, { ...r, order }); });

  // 1) уводим ленту в самый верх колесом
  console.log('мотаю вверх до начала диалога…');
  let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const before = acc.size;
    add(await collect(), -i);
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, -1200).catch(() => {});
    await sleep(900);
    if (acc.size === before) stable++; else stable = 0;
    if (i % 10 === 0) console.log(`  вверх ${i} · собрано ${acc.size}`);
  }
  // 2) идём вниз, добирая всё, что подгрузилось
  console.log('иду вниз, добираю…');
  for (let i = 0; i < 70; i++) {
    add(await collect(), i);
    await page.mouse.move(MX, MY).catch(() => {});
    await page.mouse.wheel(0, 900).catch(() => {});
    await sleep(700);
    if (i % 15 === 0) console.log(`  вниз ${i} · собрано ${acc.size}`);
  }
  const rows = [...acc.values()].sort((a, b) => a.order - b.order || a.y - b.y);
  console.log('блоков всего:', rows.length);

  // вложения
  let dl = 0; const seen = new Set();
  for (const r of rows) {
    if (!['img', 'vid'].includes(r.type) || !r.src || seen.has(r.src)) continue;
    seen.add(r.src);
    try {
      const resp = await page.request.get(r.src, { timeout: 60000 });
      if (!resp.ok()) continue;
      const buf = await resp.body();
      if (buf.length < 4000) continue;
      const name = `${String(++dl).padStart(3, '0')}_${r.type}.${r.type === 'vid' ? 'mp4' : 'jpg'}`;
      fs.writeFileSync(`${OUT}/attachments/${name}`, buf);
      r.file = name;
    } catch {}
  }
  console.log('вложений скачано:', dl);

  const lines = ['ДИАЛОГ IG DIRECT', 'аккаунт: s4rxisme (FOL_42688)', 'собеседник: Jaysemipro / highzotic.588',
    `снято локально: ${new Date().toISOString()}`, `блоков: ${rows.length} · вложений: ${dl}`, ''.padEnd(64, '='), ''];
  rows.forEach((r) => {
    if (r.type === 'text') lines.push(r.text);
    else if (r.file) lines.push(`[${r.type === 'img' ? 'фото' : 'видео'} → attachments/${r.file}]`);
  });
  fs.writeFileSync(`${OUT}/dialog.txt`, lines.join('\n'), 'utf8');
  fs.writeFileSync(`${OUT}/dialog.json`, JSON.stringify(rows, null, 1), 'utf8');
  console.log(`ГОТОВО → ${OUT}/dialog.txt`);
  await b.close().catch(() => {});   // только отсоединяемся, окно остаётся
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
