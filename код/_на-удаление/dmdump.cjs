// ДАМП ДИАЛОГА IG DIRECT из УЖЕ ОТКРЫТОГО окна Orbita (подключаемся по порту, НИЧЕГО не закрываем).
// Собирает: автора, текст, время, вложения (фото/видео/голосовые/ссылки). Пишет в файл + скачивает вложения.
// Запуск: node dmdump.cjs <порт> [папка_вывода]
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const PORT = process.argv[2];
const OUT = process.argv[3] || `${process.env.HOME}/Desktop/dm_dump`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (!PORT) { console.log('usage: node dmdump.cjs <порт>'); process.exit(1); }
  fs.mkdirSync(`${OUT}/attachments`, { recursive: true });
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 30000 });
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => /instagram\.com\/direct/.test(p.url())) || pages[0];
  console.log('страница:', page.url());

  // Прокручиваем историю вверх, чтобы подгрузить старые сообщения
  console.log('подгружаю историю (скроллю вверх)…');
  for (let i = 0; i < 25; i++) {
    const before = await page.evaluate(() => document.querySelectorAll('div[role="row"], div[data-testid="message-container"]').length).catch(() => 0);
    await page.evaluate(() => {
      const sc = [...document.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 80 && d.clientHeight > 250);
      if (sc.length) sc.sort((a, b) => b.clientHeight - a.clientHeight)[0].scrollTop = 0;
    }).catch(() => {});
    await sleep(1400);
    const after = await page.evaluate(() => document.querySelectorAll('div[role="row"], div[data-testid="message-container"]').length).catch(() => 0);
    if (after === before && i > 3) break;
  }

  // Собираем сообщения. В IG-2026 нет role="row" — берём ПРАВУЮ панель диалога (ту, где поле ввода)
  // и вытаскиваем из неё текстовые узлы и картинки по порядку появления в DOM.
  const data = await page.evaluate(() => {
    // находим панель разговора: поднимаемся от поля ввода сообщения
    let pane = document.querySelector('div[contenteditable="true"][role="textbox"], textarea[placeholder*="essage" i]');
    for (let i = 0; i < 8 && pane; i++) { pane = pane.parentElement; if (pane && pane.clientHeight > 400 && pane.clientWidth > 500) break; }
    if (!pane) pane = document.body;
    const NAV = new Set(['Home', 'Reels', 'Messages', 'Search', 'Notifications', 'Create', 'Dashboard', 'Profile', 'More', 'Primary', 'General', 'Search', 'Message...']);
    const out = [];
    const walk = (node) => {
      for (const el of node.children) {
        const tag = el.tagName;
        if (tag === 'IMG') {
          const src = el.src || '';
          const alt = el.alt || '';
          if (/cdninstagram|fbcdn/.test(src) && !/s150x150/.test(src)) out.push({ type: 'img', src, alt });
          continue;
        }
        if (tag === 'VIDEO') { const src = el.src || (el.querySelector('source') || {}).src || ''; if (src) out.push({ type: 'vid', src }); continue; }
        if (tag === 'AUDIO') { const src = el.src || ''; if (src) out.push({ type: 'aud', src }); continue; }
        // текстовый лист
        const t = (el.innerText || '').trim();
        if (t && el.children.length === 0 && !NAV.has(t) && t.length < 900) { out.push({ type: 'text', text: t }); continue; }
        if (el.children.length) walk(el);
      }
    };
    walk(pane);
    // схлопываем дубли подряд
    const clean = [];
    for (const o of out) { const last = clean[clean.length - 1]; if (last && last.type === o.type && (o.type === 'text' ? last.text === o.text : last.src === o.src)) continue; clean.push(o); }
    const header = (document.querySelector('div[role="heading"], h1, h2') || {}).innerText || '';
    return { header: header.trim(), title: document.title, count: clean.length, rows: clean };
  }).catch((e) => ({ error: e.message }));

  if (data.error) { console.log('ошибка чтения:', data.error); process.exit(1); }
  console.log(`сообщений/блоков: ${data.count}`);

  // Скачиваем вложения
  let dl = 0; const seen = new Set();
  for (let i = 0; i < data.rows.length; i++) {
    const r = data.rows[i];
    if (!['img', 'vid', 'aud'].includes(r.type) || !r.src || seen.has(r.src)) continue;
    seen.add(r.src);
    try {
      const resp = await page.request.get(r.src, { timeout: 60000 });
      if (!resp.ok()) continue;
      const buf = await resp.body();
      if (buf.length < 3000) continue;
      const ext = r.type === 'vid' ? 'mp4' : r.type === 'aud' ? 'm4a' : (/\.png/i.test(r.src) ? 'png' : 'jpg');
      const name = `${String(++dl).padStart(3, '0')}_${r.type}.${ext}`;
      fs.writeFileSync(`${OUT}/attachments/${name}`, buf);
      r.file = name;
    } catch { /* пропускаем */ }
  }
  console.log(`вложений скачано: ${dl}`);

  // Пишем читаемый текст + json
  const lines = [`ДИАЛОГ IG DIRECT`, `аккаунт: s4rxisme`, `собеседник: ${data.header || '—'}`, `страница: ${page.url()}`,
    `снято локально: ${new Date().toISOString()}`, `блоков: ${data.count}`, ''.padEnd(60, '='), ''];
  data.rows.forEach((r) => {
    if (r.type === 'text') lines.push(r.text);
    else if (r.file) lines.push(`[${r.type === 'img' ? 'фото' : r.type === 'vid' ? 'видео' : 'аудио'}: attachments/${r.file}]`);
    else if (r.src) lines.push(`[${r.type}: не скачалось] ${r.src.slice(0, 90)}`);
  });
  fs.writeFileSync(`${OUT}/dialog.txt`, lines.join('\n'), 'utf8');
  fs.writeFileSync(`${OUT}/dialog.json`, JSON.stringify(data, null, 1), 'utf8');
  // скрин диалога
  try { fs.writeFileSync(`${OUT}/screenshot.png`, await page.screenshot({ type: 'png', fullPage: false, timeout: 15000 })); } catch {}
  console.log(`ГОТОВО → ${OUT}/dialog.txt (+ json, screenshot, attachments/)`);
  // ВАЖНО: окно НЕ закрываем — только отсоединяемся
  await b.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
