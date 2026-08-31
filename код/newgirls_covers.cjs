// Достаёт ЗАСТАВКИ (кадр 1) свежесобранных постов новых девочек и кладёт их файлами на диск.
// Заставка рилса это кадр 1 поста, поэтому смотреть на неё можно не режа видео вовсе.
const fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const {fetchToFile}=require('./watchdog.cjs');
const OUT=path.join(require('node:os').homedir(),'Desktop','НЕЙРОНКА','ТЕСТ-ДЕВОЧКИ');
const PERS=['сучка-в-машине','сучка-в-кровати','аня-апгрейд','анжела-удивлена','красивые-глаза','блондинка-сучка'];
(async()=>{
fs.mkdirSync(OUT,{recursive:true});
const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
await c.connect();
const r=(await c.query(`SELECT meta->>'persona' persona, meta->'image_urls'->>0 cover,
   meta->>'source_cover_url' clean, meta->>'hook_text' hook, id::text
 FROM posts WHERE meta->>'persona' = ANY($1) AND created_at > now() - interval '3 hours'
 ORDER BY created_at DESC`,[PERS])).rows;
const seen=new Set(); let n=0;
for(const p of r){
  if(seen.has(p.persona)) continue; seen.add(p.persona);
  const dst=path.join(OUT,`${p.persona}.jpg`);
  try{ await fetchToFile(p.cover,dst,{what:'заставка',ms:60000,min:3000});
    console.log(`✅ ${p.persona}  хук: «${(p.hook||'').replace(/\n/g,' / ')}»`); n++; }
  catch(e){ console.log(`✗ ${p.persona}: ${String(e.message).slice(0,60)}`); }
}
console.log(`\nзаставок скачано: ${n} → ${OUT}`);
await c.end();})().catch(e=>{console.error('ОШИБКА:',e.message);process.exit(1)});
