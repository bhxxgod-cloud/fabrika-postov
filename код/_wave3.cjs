// Волна 3 от генерки: 160 свежих роликов. Кладём в очереди ютуб-каналов ПЕРВЫМИ,
// чтобы они ушли раньше старых (scheduled_at в прошлое = приоритет в выборке раннера).
const fs=require('fs'), path=require('path'), os=require('os'), {createHash}=require('crypto');
const {Client}=require('pg');
(async()=>{
 const url=fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8').trim();
 const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const chans=(await c.query("select id,slug from yt_channels where platform='youtube' and enabled order by id")).rows;
 const known=new Set((await c.query('select file_path from yt_queue where file_path is not null')).rows.map(r=>r.file_path));
 const lines=fs.readFileSync('/Users/qq/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/манифест-волна3.txt','utf8').split('\n').filter(Boolean);
 const fresh=lines.map(l=>l.split(';')[0]).filter(p=>p && fs.existsSync(p) && !known.has(p));
 fresh.sort(()=>Math.random()-0.5);   // вперемешку, чтобы шаблоны не шли пачкой на один канал
 let i=0, added=0, dup=0;
 for(const p of fresh){
   const ch=chans[i++ % chans.length];
   const hash=createHash('sha1').update(p).digest('hex').slice(0,16);
   const base=p.replace(/\.mp4$/i,'');
   let txt=null;
   for(const ext of ['.tt.txt','.ig.txt']) if(fs.existsSync(base+ext)){ txt=fs.readFileSync(base+ext,'utf8').trim(); break; }
   const r=await c.query(`INSERT INTO yt_queue (channel_id,file_path,file_hash,src_text,scheduled_at)
     VALUES ($1,$2,$3,$4, now() - interval '1 year') ON CONFLICT (file_hash) WHERE file_hash IS NOT NULL DO NOTHING`,
     [ch.id,p,hash,txt]);
   (r.rowCount||0) ? added++ : dup++;
 }
 console.log('добавлено свежих:', added, '| уже были:', dup, '| всего в манифесте:', lines.length);
 const q=await c.query(`select ch.slug, count(*) filter (where q.status='queued' and q.scheduled_at < now() - interval '300 days') prio,
    count(*) filter (where q.status='queued') total
   from yt_channels ch left join yt_queue q on q.channel_id=ch.id where ch.platform='youtube'
   group by ch.id,ch.slug order by ch.id`);
 console.log('\nканал | свежих в приоритете | всего в очереди');
 q.rows.forEach(x=>console.log(' '+x.slug.padEnd(10), String(x.prio).padStart(3), '|', x.total));
 await c.end();
})().catch(e=>{console.error('ОШИБКА',e.message);process.exit(1)});
