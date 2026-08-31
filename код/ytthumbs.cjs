'use strict';
// Обложки задним числом: node ytthumbs.cjs <slug|all> [--limit N]
// Для запощенных роликов канала берёт обложку (cover_path или <имя>.кадр1.jpg рядом с mp4,
// иначе пропуск) и дёргает thumbnails.set. 403 = канал не верифнут телефоном, это не ошибка кода.
const fs=require('fs'), os=require('os'), path=require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { makeThumb } = require('./thumbgen.cjs');
const DBURL=(process.env.DBURL||fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8')).trim();
function findCover(it){
  if (it.cover_path && fs.existsSync(it.cover_path)) return it.cover_path;
  if (!it.file_path) return null;
  const d=path.dirname(it.file_path), b=path.basename(it.file_path,path.extname(it.file_path));
  for (const c of [`${b}.кадр1.jpg`,`${b}.cover.jpg`,`${b}.jpg`]){ const p2=path.join(d,c); if(fs.existsSync(p2)) return p2; }
  return null;
}
async function main(){
  const slug=process.argv[2]||'all';
  const lim=Number((process.argv.join(' ').match(/--limit (\d+)/)||[])[1]||50);
  const db=new Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}}); await db.connect();
  const chans=(await db.query(`select * from yt_channels where platform='youtube' and refresh_token is not null ${slug==='all'?'':'and slug=$1'}`, slug==='all'?[]:[slug])).rows;
  for (const c of chans){
    const onlyNew = !process.argv.includes('--all-again');
    const items=(await db.query(`select * from yt_queue where channel_id=$1 and status='posted' and video_id is not null
      ${onlyNew ? 'and thumb_set_at is null' : ''} order by posted_at desc limit $2`,[c.id,lim])).rows;
    if(!items.length){ console.log(c.slug+': все обложки уже подтверждены'); continue; }
    const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,refresh_token:c.refresh_token,grant_type:'refresh_token'})});
    const tj=await tr.json(); if(!tj.access_token){ console.log(c.slug+': токен не обновился'); continue; }
    let ok=0,noCover=0,denied=false;
    for (const it of items){
      const cov=makeThumb(it.file_path,it.title,path.join(os.tmpdir(),'ytthumbs'),{slug:c.slug})||findCover(it);
      if(!cov){ noCover++; await db.query(`update yt_queue set thumb_err=$2 where id=$1`,[it.id,'нет исходника на маке: обложку не из чего собрать']); continue; }
      const r=await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${it.video_id}&uploadType=media`,
        {method:'POST',headers:{authorization:'Bearer '+tj.access_token,'content-type':'image/jpeg'},body:fs.readFileSync(cov)});
      if(r.status===200){ ok++; await db.query(`update yt_queue set thumb_set_at=now(), thumb_err=null where id=$1`,[it.id]); }
      else { const j=await r.json().catch(()=>({}));
        const msg=(r.status+' '+JSON.stringify(j.error&&j.error.errors||'')).slice(0,180);
        await db.query(`update yt_queue set thumb_err=$2 where id=$1`,[it.id,msg]);
        if(r.status===403){ denied=true; console.log(c.slug+': 403 — ютуб не пускает обложки (канал не верифнут телефоном)'); break; }
        if(r.status===429||r.status===403){ denied=true; break; }
        console.log(c.slug+' '+it.video_id+': '+msg); }
      await new Promise(s=>setTimeout(s,400));
    }
    if(!denied) console.log(`${c.slug}: обложек поставлено ${ok}, без файла обложки ${noCover}, всего постов ${items.length}`);
  }
  await db.end();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
