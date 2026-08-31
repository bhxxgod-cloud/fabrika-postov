#!/usr/bin/env node
'use strict';
// АНАЛИЗ ГОРЫ СТАРОГО СКЛАДА БЕЗ РЕЗКИ И БЕЗ СНЯТИЙ (задача 13.08: вердикт для начальника).
// Для каждого поста горы: лица к1↔к3 и к1↔к4 с тремя ловушками ложняка (stylized и hearts не
// мерим вовсе; кадр 3 телефонных шаблонов не мерим), плюс наличие чистого исходника
// (source_cover_url: без него хук в рилсе не перерисовать — приговор по гейту).
// Статусы постов НЕ трогаем. Выход: /tmp/mountain_report.json + живой лог.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const TPL = require('./templates.cjs');
const fkk = require('./facesim.cjs');

const МОИ = new Set(['тату-розовая', 'аня', 'розовая-полумесяц', 'бмв-очки', 'веснушки', 'загорелая', 'девочка01']);

(async () => {
  const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
    ssl: { rejectUnauthorized: false }, query_timeout: 30000 });
  await c.connect();
  const r = await c.query(`SELECT id, meta->>'persona' p, meta->>'template' t, meta->'image_urls' u,
      meta->>'source_cover_url' src
    FROM posts WHERE status='backlog' ORDER BY created_at`);
  await c.end();
  const гора = r.rows.filter((x) => !МОИ.has(x.p) && !String(x.p || '').startsWith('pink')
    && !/^[a-z]\d+v\d+_/.test(String(x.p || '')));
  console.log('в горе постов:', гора.length);

  const итог = { всего: гора.length, годные: 0, чужие: 0, подозрительные: 0, безЧистого: 0,
    неМерились: 0, ошибки: 0, чужиеПоШаблонам: {}, подозрПоШаблонам: {}, списокЧужих: [], списокПодозр: [] };
  for (const [i, row] of гора.entries()) {
    const конф = TPL.get(row.t || '') || {};
    const urls = row.u || [];
    if (!row.src) итог.безЧистого++;
    if (конф.stylized || конф.kind === 'hearts' || urls.length < 4) { итог.неМерились++; continue; }
    const b = `/tmp/mnt_${String(row.id).slice(0, 8)}`;
    try {
      execFileSync('curl', ['-s', '-m', '60', '-o', b + '_1.jpg', urls[0]]);
      execFileSync('curl', ['-s', '-m', '60', '-o', b + '_4.jpg', urls[urls.length - 1]]);
      const v4 = fkk.keepsFace(b + '_1.jpg', b + '_4.jpg');
      let v3 = { ok: true, d: 'мокап' };
      if (!конф.phone) {
        execFileSync('curl', ['-s', '-m', '60', '-o', b + '_3.jpg', urls[2] || urls[1]]);
        v3 = fkk.keepsFace(b + '_1.jpg', b + '_3.jpg');
      }
      const низ4 = v4.ok === false, низ3 = v3.ok === false;
      if (низ4 && низ3) {
        итог.чужие++;
        итог.чужиеПоШаблонам[row.t] = (итог.чужиеПоШаблонам[row.t] || 0) + 1;
        итог.списокЧужих.push({ id: String(row.id).slice(0, 8), p: row.p, t: row.t, d3: v3.d, d4: v4.d });
        console.log(`⛔ чужой человек: ${row.p} ${row.t} (к3 ${v3.d} / к4 ${v4.d})`);
      } else if (низ4 || низ3) {
        итог.подозрительные++;
        итог.подозрПоШаблонам[row.t] = (итог.подозрПоШаблонам[row.t] || 0) + 1;
        итог.списокПодозр.push({ id: String(row.id).slice(0, 8), p: row.p, t: row.t, d3: v3.d, d4: v4.d });
      } else итог.годные++;
    } catch (e) { итог.ошибки++; }
    finally { for (const s of ['_1.jpg', '_3.jpg', '_4.jpg']) { try { fs.unlinkSync(b + s); } catch {} } }
    if ((i + 1) % 50 === 0) console.log(`…проверено ${i + 1}/${гора.length}`);
  }
  fs.writeFileSync('/tmp/mountain_report.json', JSON.stringify(итог, null, 1));
  console.log('ОТЧЁТ ГОРЫ:', JSON.stringify({ всего: итог.всего, годные: итог.годные,
    чужие: итог.чужие, подозрительные: итог.подозрительные, неМерились: итог.неМерились,
    безЧистого: итог.безЧистого, ошибки: итог.ошибки }));
  console.log('чужие по шаблонам:', JSON.stringify(итог.чужиеПоШаблонам));
})();
