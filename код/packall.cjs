const fs=require('fs'), path=require('path'), https=require('https'), os=require('os');
const { Client } = require('pg');
const OUT=path.join(os.homedir(),'Desktop','НЕЙРОНКА','СКЛАД-ПОСТОВ');
const качать=(u,f)=>new Promise((ок,не)=>{https.get(u,r=>{if(r.statusCode!==200){r.resume();return не(new Error('HTTP '+r.statusCode));}
  const w=fs.createWriteStream(f); r.pipe(w); w.on('finish',()=>w.close(ок)); }).on('error',не);});
(async()=>{
  const c=new Client({connectionString:(process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8')).trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`SELECT id, meta->>'template' t, meta->>'persona' p, meta->'image_urls' u
    FROM posts WHERE status='backlog' ORDER BY created_at DESC`);
  console.log('постов на складе:', r.rows.length);
  fs.rmSync(OUT,{recursive:true,force:true}); fs.mkdirSync(OUT,{recursive:true});
  let n=0;
  for (const p of r.rows) {
    const urls=p.u||[]; if (urls.length<4) continue;
    const имя=`${String(p.id).slice(0,8)}_${(p.t||'').replace('img-','')}_${(p.p||'').slice(0,16)}`.replace(/[^\wа-яА-Я.-]/g,'_');
    const d=path.join(OUT,имя); fs.mkdirSync(d,{recursive:true});
    let ок=0;
    for (let i=0;i<urls.length;i++){ try{ await качать(urls[i], path.join(d,`${i+1}.jpg`)); ок++; }catch{} }
    if (ок>=4){ n++; if(n%25===0) console.log('  ...',n); } else fs.rmSync(d,{recursive:true,force:true});
  }
  await c.end();
  console.log(`ГОТОВО: упаковано постов ${n}`);
})();
