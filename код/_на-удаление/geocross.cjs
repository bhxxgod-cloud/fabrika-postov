// geocross.cjs — сводит шарды geoscan.tsv и считает ДОЛИ по признакам. Только чтение.
'use strict';
const fs = require('node:fs');
const files = fs.readdirSync('/tmp').filter((f) => /^geoscan_\d+\.tsv$/.test(f)).map((f) => '/tmp/' + f);
let hdr = null; const rows = [];
for (const f of files) {
  const L = fs.readFileSync(f, 'utf8').trim().split('\n');
  const h = L[0].split('\t'); if (!hdr) hdr = h;
  for (const l of L.slice(1)) { const p = l.split('\t'); const o = {}; h.forEach((k, i) => { o[k] = p[i]; }); rows.push(o); }
}
console.log(`акков: ${rows.length}`);

// Первый мир и близкие к нашим прокси страны против экзотики (деление из отчёта ХВОСТ-АККОВ 10.08)
const ПЕРВЫЙ_МИР = new Set(['GB', 'DE', 'IE', 'IT', 'BE', 'FR', 'NO', 'PL', 'PT', 'CY', 'CZ', 'CH', 'LT', 'EE', 'BG', 'RO', 'CA', 'JP']);
const классСтраны = (c) => (!c || c === 'связки нет' ? 'связки нет' : (ПЕРВЫЙ_МИР.has(c) ? 'первый мир / EU' : 'экзотика'));

const KINDS = ['виден', 'спрятан', 'нет-профиля', 'нет-ника', 'без-вердикта'];
function срез(имя, f, filt) {
  const src = filt ? rows.filter(filt) : rows;
  const m = {};
  for (const r of src) { const k = String(f(r) || '(нет)'); m[k] = m[k] || { всего: 0 }; m[k].всего++; m[k][r.вердикт] = (m[k][r.вердикт] || 0) + 1; }
  console.log(`\n### ${имя}${filt ? '' : ''}`);
  const keys = Object.keys(m).sort((a, b) => m[b].всего - m[a].всего);
  for (const k of keys) {
    const v = m[k]; const ok = v['виден'] || 0;
    const пав = v.всего - ok;
    console.log(`${k.padEnd(28)} всего ${String(v.всего).padStart(3)}  ЖИВ ${String(ok).padStart(3)} (${String(Math.round(ok / v.всего * 100)).padStart(3)}%)  ПАЛ ${String(пав).padStart(3)} (${String(Math.round(пав / v.всего * 100)).padStart(3)}%)   ` +
      KINDS.filter((x) => x !== 'виден').map((x) => `${x} ${v[x] || 0}`).join('  '));
  }
}

срез('ИТОГО ПО ВСЕЙ ФЕРМЕ', () => 'все 214');
срез('ПАПКА / ГРУППА В БАЗЕ', (r) => r.папка);
срез('КЛАСС СТРАНЫ РЕГИСТРАЦИИ (связка магоса)', (r) => классСтраны(r.страна_связки));
срез('СТРАНА РЕГИСТРАЦИИ, детально', (r) => (r.страна_связки || 'связки нет'));
срез('ТИП ВХОДА: iOS-связка магоса против только браузерных куки', (r) => (r.есть_токен === 'да' ? 'iOS-связка с токеном' : (r.есть_токен === 'нет' ? 'связка без токена' : 'связки нет (только браузерные куки + 2FA)')));
срез('ПРОКСИ-ГЕО В БАЗЕ', (r) => r.прокси_гео);
срез('ПОЧТА ПРИВЯЗАНА', (r) => (r.почта === 'есть' ? 'почта есть' : 'почты нет'));
срез('ПРОГРЕВ У НАС В БАЗЕ', (r) => (r.прогрет === 'да' ? 'прогрет' : 'прогрева нет'));
срез('ДАТА ЗАВЕДЕНИЯ У НАС', (r) => r.создан);
срез('ЛОКАЛЬ СВЯЗКИ', (r) => (r.локаль || 'связки нет'));
срез('ЧИСЛО ПОСТОВ СНАРУЖИ (только у живых видно)', (r) => (r.вердикт === 'виден' ? (r.постов === '' ? '?' : (Number(r.постов) === 0 ? '0 постов' : Number(r.постов) <= 2 ? '1-2 поста' : Number(r.постов) <= 4 ? '3-4 поста' : '5 и больше')) : 'не видно (пал)'));

// Пересечение: страна × тип входа
console.log('\n### ПЕРЕСЕЧЕНИЕ: класс страны × наличие iOS-токена');
const cross = {};
for (const r of rows) {
  const k = `${классСтраны(r.страна_связки)} | ${r.есть_токен === 'да' ? 'токен есть' : (r.есть_токен === 'нет' ? 'токена нет' : 'связки нет')}`;
  cross[k] = cross[k] || { всего: 0, жив: 0 }; cross[k].всего++; if (r.вердикт === 'виден') cross[k].жив++;
}
for (const k of Object.keys(cross).sort()) { const v = cross[k]; console.log(`${k.padEnd(46)} всего ${String(v.всего).padStart(3)}  ЖИВ ${String(v.жив).padStart(3)} (${Math.round(v.жив / v.всего * 100)}%)`); }

// Живые: сколько постов
const живые = rows.filter((r) => r.вердикт === 'виден' && r.постов !== '');
const пост = живые.map((r) => Number(r.постов));
console.log(`\n### ПОСТОВ У ЖИВЫХ: акков ${живые.length}, среднее ${(пост.reduce((a, b) => a + b, 0) / пост.length).toFixed(1)}, медиана ${пост.slice().sort((a, b) => a - b)[Math.floor(пост.length / 2)]}, макс ${Math.max(...пост)}, с 0 постов ${пост.filter((x) => x === 0).length}`);
