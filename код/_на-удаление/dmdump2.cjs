// ДАМП ДИАЛОГА: берём ВСЁ со страницы и фильтруем навигацию/список чатов по координатам —
// сообщения лежат правее списка диалогов (x > 550).
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
  console.log('страница:', page.url());
  // скроллим ленту сообщений вверх
  for (let i = 0; i < 20; i++) {
    const n1 = await page.evaluate(() => document.querySelectorAll('img').length).catch(() => 0);
    await page.evaluate(() => {
      const sc = [...document.querySelectorAll('div')].filter((d) => { const r = d.getBoundingClientRect(); return r.x > 500 && d.scrollHeight > d.clientHeight + 100 && d.clientHeight > 300; });
      sc.forEach((d) => { d.scrollTop = 0; });
    }).catch(() => {});
    await sleep(1500);
    const n2 = await page.evaluate(() => document.querySelectorAll('img').length).catch(() => 0);
    if (n2 === n1 && i > 4) break;
  }
  const collect = () => page.evaluate(() => {
    const items = [];
    const NAV = /^(Home|Reels|Messages|Search|Notifications|Create|Dashboard|Profile|More|Primary|General|Requests|Message\.\.\.|Your note|Log in|Switch)$/i;
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.x < 550 || r.width === 0 || r.height === 0) return;   // левее 550 — список чатов и меню
      if (el.tagName === 'IMG') {
        const s = el.src || '';
        if (/cdninstagram|fbcdn/.test(s) && r.width > 60) items.push({ type: 'img', src: s, alt: el.alt || '', y: Math.round(r.y), x: Math.round(r.x) });
        return;
      }
      if (el.tagName === 'VIDEO') { const s = el.src || (el.querySelector('source') || {}).src || ''; if (s) items.push({ type: 'vid', src: s, y: Math.round(r.y), x: Math.round(r.x) }); return; }
      if (el.children.length === 0) {
        const t = (el.textContent || '').trim();
        if (t && t.length < 800 && !NAV.test(t)) items.push({ type: 'text', text: t, y: Math.round(r.y), x: Math.round(r.x) });
      }
    });
    // порядок сверху вниз, слева направо; убираем дубли
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const clean = [];
    const seen = new Set();
    for (const i of items) {
      const k = i.type + '|' + (i.text || i.src);
      if (seen.has(k)) continue; seen.add(k);
      clean.push(i);
    }
    const hdr = [...document.querySelectorAll('span,div')].filter((e) => { const r = e.getBoundingClientRect(); return r.y < 90 && r.x > 550 && (e.textContent || '').trim().length > 2 && e.children.length === 0; }).map((e) => e.textContent.trim()).slice(0, 3);
    return { header: hdr.join(' / '), count: clean.length, rows: clean };
  }).catch(() => ({ rows: [] }));

  // ИНКРЕМЕНТАЛЬНЫЙ СБОР: IG рендерит только видимый кусок ленты (виртуализация), поэтому идём
  // сверху вниз и накапливаем. Иначе получаем случайный срез, а не весь диалог.
  const acc = new Map(); let header = '';
  const scrollTo = (frac) => page.evaluate((f) => {
    const sc = [...document.querySelectorAll('div')].filter((d) => { const r = d.getBoundingClientRect(); return r.x > 500 && d.scrollHeight > d.clientHeight + 100 && d.clientHeight > 300; });
    sc.forEach((d) => { d.scrollTop = (d.scrollHeight - d.clientHeight) * f; });
  }, frac).catch(() => {});
  for (let step = 0; step <= 20; step++) {
    await scrollTo(step / 20);
    await sleep(1200);
    const part = await collect();
    if (part.header && !header) header = part.header;
    (part.rows || []).forEach((r) => { const k = r.type + '|' + (r.text || r.src); if (!acc.has(k)) acc.set(k, r); });
    if (step % 5 === 0) console.log(`  прокрутка ${Math.round(step / 20 * 100)}% · собрано ${acc.size}`);
  }
  const data = { header, rows: [...acc.values()].sort((a, b) => a.y - b.y || a.x - b.x), count: acc.size };
  console.log('блоков всего:', data.count);
  let dl = 0; const seen = new Set();
  for (const r of data.rows) {
    if (!['img', 'vid'].includes(r.type) || !r.src || seen.has(r.src)) continue;
    seen.add(r.src);
    try {
      const resp = await page.request.get(r.src, { timeout: 60000 });
      if (!resp.ok()) continue;
      const buf = await resp.body();
      if (buf.length < 3000) continue;
      const name = `${String(++dl).padStart(3, '0')}_${r.type}.${r.type === 'vid' ? 'mp4' : 'jpg'}`;
      fs.writeFileSync(`${OUT}/attachments/${name}`, buf);
      r.file = name;
    } catch {}
  }
  console.log('вложений скачано:', dl);
  const lines = [`ДИАЛОГ IG DIRECT`, `аккаунт: s4rxisme (FOL_42688)`, `шапка: ${data.header}`,
    `снято локально: ${new Date().toISOString()}`, `блоков: ${data.count}`, ''.padEnd(64, '='), ''];
  data.rows.forEach((r) => {
    if (r.type === 'text') lines.push(r.text);
    else if (r.file) lines.push(`[${r.type === 'img' ? 'фото' : 'видео'} → attachments/${r.file}]`);
  });
  fs.writeFileSync(`${OUT}/dialog.txt`, lines.join('\n'), 'utf8');
  fs.writeFileSync(`${OUT}/dialog.json`, JSON.stringify(data, null, 1), 'utf8');
  try { fs.writeFileSync(`${OUT}/screenshot.png`, await page.screenshot({ type: 'png', timeout: 15000 })); } catch {}
  console.log(`ГОТОВО → ${OUT}/`);
  await b.close().catch(() => {});   // отсоединяемся, окно НЕ закрываем
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
