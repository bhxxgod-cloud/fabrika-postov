const fs=require('fs'), os=require('os'), path=require('path'), {createHash}=require('crypto');
const {Client}=require('pg');
(async()=>{
 const url=fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8').trim();
 const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}});await c.connect();
 const {rows:[v]}=await c.query("select id from yt_channels where slug='vk_neironka'");
 // 1) битые задачи (файла нет) убираем из очереди
 const {rows:q}=await c.query("select id,file_path from yt_queue where channel_id=$1 and status in ('queued','error')",[v.id]);
 let dead=0;
 for(const r of q){ if(!r.file_path || !fs.existsSync(r.file_path)){ await c.query("update yt_queue set status='skipped' where id=$1",[r.id]); dead++; } }
 console.log('убрано задач с пропавшими файлами:', dead);
 // 2) что уже знаем (чтобы не задваивать)
 const known=new Set((await c.query("select file_path from yt_queue where channel_id=$1",[v.id])).rows.map(r=>r.file_path));
 // 3) свежие из манифеста генерки
 const man='/Users/qq/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/манифест-готовые.txt';
 const lines=fs.readFileSync(man,'utf8').split('\n').filter(Boolean);
 const fresh=[];
 for(const ln of lines){
   const p=ln.split(';')[0];
   if(!p || known.has(p) || !fs.existsSync(p)) continue;
   fresh.push(p);
 }
 // перемешиваем, чтобы шаблоны и девочки шли вразнобой
 fresh.sort(()=>Math.random()-0.5);
 const take=fresh.slice(0, 80);
 let added=0;
 for(const p of take){
   const hash=createHash('sha1').update(p).digest('hex').slice(0,16);
   const base=p.replace(/\.mp4$/i,'');
   let txt=null;
   for(const ext of ['.tt.txt','.ig.txt']){ if(fs.existsSync(base+ext)){ txt=fs.readFileSync(base+ext,'utf8').trim(); break; } }
   const r=await c.query(`INSERT INTO yt_queue (channel_id,file_path,file_hash,src_text,scheduled_at)
     VALUES ($1,$2,$3,$4,NULL) ON CONFLICT (file_hash) WHERE file_hash IS NOT NULL DO NOTHING`,[v.id,p,hash,txt]);
   added+=(r.rowCount||0);
 }
 console.log('добавлено свежих роликов в ВК:', added, 'из', fresh.length, 'доступных новых');
 const st=await c.query("select status,count(*) n from yt_queue where channel_id=$1 group by 1",[v.id]);
 console.log('очередь ВК теперь:', st.rows.map(x=>x.status+':'+x.n).join(', '));
 await c.end();
})().catch(e=>{console.error('ОШИБКА',e.message);process.exit(1)});
