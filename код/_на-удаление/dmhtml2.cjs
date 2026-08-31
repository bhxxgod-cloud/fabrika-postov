// Финальный HTML: переписка + ВСЕ выкачанные медиа. Медиа из сетевого перехвата не привязаны к строкам,
// поэтому даём два блока: сама переписка (по порядку) и полная галерея всех фото/видео диалога.
const fs = require('fs');
const OUT = process.env.HOME + '/Desktop/dm_dump';
const rows = JSON.parse(fs.readFileSync(`${OUT}/dialog.json`, 'utf8'));
const files = fs.readdirSync(`${OUT}/attachments`).filter((f) => /\.(jpg|png|mp4)$/i.test(f)).sort();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isDate = (t) => /^\d{1,2}\/\d{1,2}\/\d{2},|^[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(t);
const isSys = (t) => /video chat|^Seen$|Reacted|replied to|You sent/i.test(t);
const inline = new Set(rows.filter((r) => r.file).map((r) => r.file));
let h = `<meta charset="utf-8"><title>Диалог s4rxisme ↔ Jaysemipro</title>
<style>body{background:#0f1115;color:#e8eaed;font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:1000px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 12px;border-top:1px solid #232833;padding-top:20px}
.sub{color:#8b93a1;font-size:13px;margin-bottom:20px}
.date{text-align:center;color:#8b93a1;font-size:12px;margin:20px 0 8px}
.sys{text-align:center;color:#6b7280;font-size:12px;margin:6px 0;font-style:italic}
.msg{background:#1b2029;padding:8px 13px;border-radius:16px;margin:5px 0;display:inline-block;max-width:70%;word-break:break-word}
.num{background:#2a3550}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px}
.g a{display:block}.g img,.g video{width:100%;height:190px;object-fit:cover;border-radius:8px;border:1px solid #2a3038}
.g img:hover{border-color:#6b8afd}
.ph{margin:8px 0;display:flex;flex-wrap:wrap;gap:6px}.ph img{max-width:200px;max-height:280px;border-radius:10px}
</style>
<h1>Диалог: s4rxisme ↔ Jaysemipro (highzotic.588)</h1>
<div class="sub">Аккаунт FOL_42688 · период 13.07.2025 — 05.07.2026 · сообщений ${rows.filter((r) => r.type === 'text').length} · медиа <b>${files.length}</b> · снято ${new Date().toLocaleString('ru-RU')}</div>
<h2>Переписка</h2>\n`;
let buf = [];
const flush = () => { if (buf.length) { h += `<div class="ph">${buf.map((f) => `<a href="attachments/${f}" target="_blank"><img src="attachments/${f}" loading="lazy"></a>`).join('')}</div>\n`; buf = []; } };
for (const r of rows) {
  if (r.file) { buf.push(r.file); continue; }
  const t = (r.text || '').trim(); if (!t) continue;
  flush();
  if (isDate(t)) h += `<div class="date">${esc(t)}</div>\n`;
  else if (isSys(t)) h += `<div class="sys">${esc(t)}</div>\n`;
  else h += `<div class="msg${/^[\d+\-=,. ]+$/.test(t) ? ' num' : ''}">${esc(t)}</div><br>\n`;
}
flush();
h += `<h2>Все медиа диалога (${files.length})</h2><div class="g">` +
  files.map((f) => /\.mp4$/i.test(f)
    ? `<video src="attachments/${f}" controls preload="none"></video>`
    : `<a href="attachments/${f}" target="_blank"><img src="attachments/${f}" loading="lazy" title="${f}"></a>`).join('') +
  `</div>`;
fs.writeFileSync(`${OUT}/dialog.html`, h, 'utf8');
console.log(`ГОТОВО → dialog.html · в переписке ${inline.size} фото, в галерее ${files.length}`);
