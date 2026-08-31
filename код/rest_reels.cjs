const fs=require('node:fs'),path=require('node:path'),{Client}=require('pg');
const ST=path.join(require('node:os').homedir(),'.neironka','reels');
const rd=f=>{try{return fs.readFileSync(f,'utf8').split('\n').map(s=>s.trim()).filter(Boolean)}catch{return[]}};
// Всё, что уже роздано слотам или уже собрано — трогать нельзя, иначе порежем дважды.
const занято=new Set();
for(const f of fs.readdirSync(ST)) if(/^reels_(allow|done)_?.*\.txt$/.test(f)) rd(path.join(ST,f)).forEach(x=>занято.add(x));
(async()=>{
const c=new Client({connectionString:process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
await c.connect();
const r=(await c.query(`SELECT id::text FROM posts
 WHERE status IN ('backlog','approved') AND published_at IS NULL
 AND jsonb_array_length(meta->'image_urls')=4 AND meta->>'frame4_art'='true'
 AND coalesce(meta->>'look_missing','')<>'true'
 AND coalesce(meta->'validation'->>'verdict','')<>'reject'
 AND meta->'qa'->>'clean'='true'
 ORDER BY created_at DESC`)).rows.map(x=>x.id);
await c.end();
const нов=r.filter(id=>!занято.has(id));
console.log(`чистых всего ${r.length}, уже роздано ${r.length-нов.length}, НОВЫХ ${нов.length}`);
if(!нов.length){console.log('добирать нечего');return;}
const N=нов.length>40?2:1;
for(let i=0;i<N;i++){
  const кусок=нов.filter((_,j)=>j%N===i);
  fs.writeFileSync(path.join(ST,`reels_allow_n${i+1}.txt`),кусок.join('\n')+'\n');
  console.log(`  слот n${i+1}: ${кусок.length} id`);
}
})().catch(e=>{console.error('ОШИБКА:',e.message);process.exit(1)});
