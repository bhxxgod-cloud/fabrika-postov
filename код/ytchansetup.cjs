'use strict';
// Оформление ютуб-канала через API: node ytchansetup.cjs <slug> [--desc файл.txt] [--kw "слова"] [--country RU] [--title "Имя"]
// Токен берёт из БД (yt_channels), делает channels.list mine=true (покажет кто мы), потом channels.update brandingSettings.
const fs=require('fs'), os=require('os'), path=require('path');
const { Client } = require('pg');
const DBURL=(process.env.DBURL||fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8')).trim();
async function main(){
  const slug=process.argv[2]; if(!slug){console.log('нужен slug');process.exit(1);}
  const a=process.argv.slice(3); const opt={};
  for(let i=0;i<a.length;i++){ if(a[i]==='--desc')opt.desc=fs.readFileSync(a[++i],'utf8').trim();
    else if(a[i]==='--kw')opt.kw=a[++i]; else if(a[i]==='--country')opt.country=a[++i]; else if(a[i]==='--title')opt.title=a[++i]; }
  const db=new Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}}); await db.connect();
  const {rows}=await db.query('select * from yt_channels where slug=$1',[slug]); await db.end();
  const c=rows[0]; if(!c){console.log('нет канала',slug);process.exit(1);}
  if(!c.refresh_token){console.log('канал не подключён (нет refresh_token)');process.exit(1);}
  const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,refresh_token:c.refresh_token,grant_type:'refresh_token'})});
  const tj=await tr.json(); if(!tj.access_token){console.log('токен не обновился:',JSON.stringify(tj));process.exit(1);}
  const H={authorization:'Bearer '+tj.access_token,'content-type':'application/json'};
  const lr=await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings&mine=true',{headers:H});
  const lj=await lr.json(); const ch=lj.items&&lj.items[0];
  if(!ch){console.log('channels.list пусто:',JSON.stringify(lj).slice(0,300));process.exit(1);}
  console.log('КАНАЛ:',ch.id,'·',ch.snippet.title);
  if(!opt.desc&&!opt.kw&&!opt.country&&!opt.title)return;
  const b=ch.brandingSettings||{}; b.channel=b.channel||{};
  if(opt.desc)b.channel.description=opt.desc;
  if(opt.kw)b.channel.keywords=opt.kw;
  if(opt.country)b.channel.country=opt.country;
  if(opt.title)b.channel.title=opt.title;
  const ur=await fetch('https://www.googleapis.com/youtube/v3/channels?part=brandingSettings',{method:'PUT',headers:H,
    body:JSON.stringify({id:ch.id,brandingSettings:b})});
  const uj=await ur.json();
  console.log(ur.status===200?'ОБНОВЛЕНО':'ОШИБКА '+ur.status, uj.error?JSON.stringify(uj.error).slice(0,300):'');
}
main().catch(e=>{console.error(e.message);process.exit(1);});
