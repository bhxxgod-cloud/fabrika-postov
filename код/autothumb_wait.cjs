'use strict';
// Ждёт верификацию prigovor/podruga и доливает согласованные обложки (файлы от 21.08).
// Пробует thumbnails.set раз в 25 минут; 200 = встало (печатает строку), 403 = ещё ждём (молчит).
const fs=require('fs'), os=require('os'), path=require('path');
const { Client } = require('pg');
const DBURL=fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8').trim();
const JOBS=[
 ['prigovor','pFC5a5QCW10', path.join(os.homedir(),'Desktop/ЮТУБ/свежие-6/блонд-каре-brow-map-p1.thumb.jpg')],
 ['podruga','aAhLQPUK0qU', path.join(os.homedir(),'Desktop/ЮТУБ/свежие-6/сучка-в-кровати-brow-map-p1.thumb.jpg')],
];
const done=new Set();
(async()=>{
  while(done.size<JOBS.length){
    for (const [slug,vid,file] of JOBS){
      if (done.has(slug)) continue;
      try{
        const db=new Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}}); await db.connect();
        const {rows:[c]}=await db.query(`select client_id,client_secret,refresh_token from yt_channels where slug=$1`,[slug]); await db.end();
        const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,refresh_token:c.refresh_token,grant_type:'refresh_token'})});
        const tj=await tr.json(); if(!tj.access_token) continue;
        const r=await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${vid}&uploadType=media`,
          {method:'POST',headers:{authorization:'Bearer '+tj.access_token,'content-type':'image/jpeg'},body:fs.readFileSync(file)});
        if(r.status===200){ done.add(slug); console.log(`ВЕРИФ ПРОШЁЛ: ${slug} — обложка ${vid} встала`); }
        else if(r.status!==403){ console.log(`${slug}: неожиданный статус ${r.status}`); }
      }catch(e){ /* сеть моргнула — молчим, следующий круг */ }
    }
    if (done.size<JOBS.length) await new Promise(s=>setTimeout(s,25*60*1000));
  }
  console.log('ОБА КАНАЛА ГОТОВЫ, сторож выключаюсь');
})();
