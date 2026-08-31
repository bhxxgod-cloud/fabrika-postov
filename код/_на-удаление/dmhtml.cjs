// Собирает из dialog.json один HTML-файл: переписка по порядку, ФОТО ВСТАВЛЕНЫ В КОНТЕКСТ (не отдельной папкой).
const fs = require('fs');
const OUT = process.env.HOME + '/Desktop/dm_dump';
const rows = JSON.parse(fs.readFileSync(`${OUT}/dialog.json`, 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isDate = (t) => /^[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(t) || /^\d{1,2}:\d{2}/.test(t);
const isSys = (t) => /video chat|Seen|Reacted|replied to|Sent|You sent/i.test(t);
let html = `<meta charset="utf-8"><title>Диалог s4rxisme ↔ Jaysemipro</title>
<style>
body{background:#0f1115;color:#e8eaed;font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#8b93a1;font-size:13px;margin-bottom:22px}
.date{text-align:center;color:#8b93a1;font-size:12px;margin:22px 0 10px}
.sys{text-align:center;color:#6b7280;font-size:12px;margin:8px 0;font-style:italic}
.msg{background:#1b2029;padding:9px 14px;border-radius:16px;margin:6px 0;display:inline-block;max-width:70%;word-break:break-word}
.num{background:#2a3550}
.ph{margin:10px 0;display:flex;flex-wrap:wrap;gap:8px}
.ph img{max-width:230px;max-height:330px;border-radius:10px;cursor:pointer;border:1px solid #2a3038}
.ph img:hover{border-color:#6b8afd}
.cnt{color:#8b93a1;font-size:12px;margin:18px 0 6px;border-top:1px solid #232833;padding-top:14px}
</style>
<h1>Диалог: s4rxisme ↔ Jaysemipro (highzotic.588)</h1>
<div class="sub">Аккаунт FOL_42688 · снято локально ${new Date().toLocaleString('ru-RU')} · блоков ${rows.length}</div>
`;
let photoBuf = [];
const flush = () => { if (photoBuf.length) { html += `<div class="ph">${photoBuf.map((f) => `<a href="attachments/${f}" target="_blank"><img src="attachments/${f}" loading="lazy"></a>`).join('')}</div>\n`; photoBuf = []; } };
let photos = 0;
for (const r of rows) {
  if (r.type === 'img' || r.type === 'vid') {
    if (!r.file) continue;
    if (r.type === 'vid') { flush(); html += `<div class="ph"><video src="attachments/${r.file}" controls style="max-width:260px;border-radius:10px"></video></div>\n`; }
    else { photoBuf.push(r.file); photos++; }
    continue;
  }
  const t = (r.text || '').trim(); if (!t) continue;
  flush();
  if (isDate(t)) html += `<div class="date">${esc(t)}</div>\n`;
  else if (isSys(t)) html += `<div class="sys">${esc(t)}</div>\n`;
  else html += `<div class="msg${/^[\d+\-=,. ]+$/.test(t) ? ' num' : ''}">${esc(t)}</div><br>\n`;
}
flush();
html += `<div class="cnt">Фото в переписке: ${photos} · файлы лежат в attachments/</div>`;
fs.writeFileSync(`${OUT}/dialog.html`, html, 'utf8');
console.log(`ГОТОВО → ${OUT}/dialog.html (фото в тексте: ${photos})`);
