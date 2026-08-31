const fs=require('node:fs'), path=require('node:path'), {Client}=require('pg');
const ST=path.join(require('node:os').homedir(),'.neironka','reels');
const allow=fs.readFileSync(path.join(ST,'reels_allow_mine.txt'),'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
const done=(()=>{try{return fs.readFileSync(path.join(ST,'reels_done_mine.txt'),'utf8').split('\n').map(s=>s.trim()).filter(Boolean)}catch{return[]}})();
(async()=>{
const c=new Client({connectionString:process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
await c.connect();
// ТОТ ЖЕ ОТБОР И ТОТ ЖЕ ПОРЯДОК, что у боевой выборки: иначе куски разъедутся с тем,
// что реально возьмёт уже запущенный воркер.
const r=(await c.query(`
 SELECT id::text FROM posts
  WHERE status IN ('backlog','approved') AND published_at IS NULL
    AND jsonb_array_length(meta->'image_urls')=4 AND meta->>'frame4_art'='true'
    AND coalesce(meta->>'look_missing','')<>'true'
    AND coalesce(meta->'validation'->>'verdict','')<>'reject'
    AND meta->'qa'->>'clean'='true'
    AND NOT (id::text = ANY($1)) AND id::text = ANY($2)
  ORDER BY created_at DESC`,[done,allow])).rows.map(x=>x.id);
await c.end();
const ВЗЯЛ_MINE=50;                     // сколько уже забрал запущенный воркер mine
const хвост=r.slice(ВЗЯЛ_MINE);
const N=4;
console.log(`кандидатов ${r.length}, у mine ${Math.min(ВЗЯЛ_MINE,r.length)}, на раздачу ${хвост.length}`);
for(let i=0;i<N;i++){
  const кусок=хвост.filter((_,j)=>j%N===i);
  const f=path.join(ST,`reels_allow_r${i+1}.txt`);
  fs.writeFileSync(f,кусок.join('\n')+'\n');
  console.log(`  слот r${i+1}: ${кусок.length} id → ${f}`);
}
})().catch(e=>{console.error('ОШИБКА:',e.message);process.exit(1)});
