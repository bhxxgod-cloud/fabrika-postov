// ВОССТАНОВЛЕНИЕ ПУЛА ЛОКАЦИЙ ИЗ БАЗЫ (10.08). Файл locations-moscow.json обрезался на 8 КБ при
// одновременной записи двумя процессами: остались только имена локаций, описания потерялись.
// Придумывать описания заново нельзя: именно они уезжают в оплаченный заказ. Зато они СОХРАНИЛИСЬ
// в мете собранных постов (meta.loc3 и meta.loc4), причём это ровно те тексты, по которым начальник
// одобрил кадр 3 словами «3 ахуенно». Берём их как источник правды.
'use strict';
const fs=require('fs');const {Client}=require('pg');
const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
const slugify=(t)=>t.toLowerCase().replace(/[«»,.:;]/g,'').split(/\s+/).slice(0,4).join('-').replace(/[^a-zа-я0-9-]/gi,'');
(async()=>{await c.connect();
const r=await c.query(`select distinct meta->>'loc3' l3, meta->>'loc4' l4 from posts where meta->>'loc3' is not null`);
const city=new Set(), quiet=new Set();
for(const x of r.rows){ if(x.l3) city.add(x.l3.trim()); if(x.l4) quiet.add(x.l4.trim()); }
await c.end();
const old=JSON.parse(fs.readFileSync('locations-moscow.json','utf8'));
const locations={};
const add=(text,klass)=>{ const slug=slugify(text); if(!locations[slug]) locations[slug]={ название:text.slice(0,40), промпт:text, класс:klass, группа:null }; };
for(const t of city) add(t,'заставка');
for(const t of quiet) add(t,'дома');
const out={ _о_файле: (old._о_файле||'')+' | ВОССТАНОВЛЕН 10.08 из meta.loc3/loc4 после обрезки файла на 8 КБ',
  _правила_для_всех: old._правила_для_всех||{}, группы: old.группы||{}, locations };
fs.writeFileSync('locations-moscow.json', JSON.stringify(out,null,1));
const cc=Object.values(locations).filter(v=>v.класс==='заставка').length;
const qq=Object.values(locations).filter(v=>v.класс==='дома').length;
console.log(`восстановлено локаций: ${Object.keys(locations).length} (заставка ${cc}, дома ${qq})`);
console.log('имена:', Object.keys(locations).slice(0,8).join(', '));
})().catch(e=>{console.error('ОШИБКА',e.message);process.exit(1)});
