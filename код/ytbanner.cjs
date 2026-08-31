'use strict';
// Заливка баннера канала: node ytbanner.cjs <slug> <файл.jpg>
// channelBanners.insert (resumable по факту simple upload) -> channels.update brandingSettings.image.bannerExternalUrl
const fs=require('fs'), os=require('os'), path=require('path');
const { Client } = require('pg');
const DBURL=(process.env.DBURL||fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8')).trim();
async function main(){
  const [slug,file]=process.argv.slice(2);
  if(!slug||!file){console.log('node ytbanner.cjs <slug> <файл>');process.exit(1);}
  const db=new Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}}); await db.connect();
  const {rows:[c]}=await db.query('select * from yt_channels where slug=$1',[slug]); await db.end();
  if(!c||!c.refresh_token){console.log('нет канала или токена');process.exit(1);}
  const tr=await fetch('https://oauth2.googleapis.com/token',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,refresh_token:c.refresh_token,grant_type:'refresh_token'})});
  const tj=await tr.json(); if(!tj.access_token){console.log('токен:',JSON.stringify(tj));process.exit(1);}
  const H={authorization:'Bearer '+tj.access_token};
  const up=await fetch('https://www.googleapis.com/upload/youtube/v3/channelBanners/insert?uploadType=media',{
    method:'POST',headers:{...H,'content-type':'image/jpeg'},body:fs.readFileSync(file)});
  const uj=await up.json();
  if(!uj.url){console.log('ошибка заливки:',JSON.stringify(uj).slice(0,300));process.exit(1);}
  const lr=await fetch('https://www.googleapis.com/youtube/v3/channels?part=brandingSettings&mine=true',{headers:H});
  const lj=await lr.json(); const ch=lj.items[0]; const b=ch.brandingSettings||{}; b.image={bannerExternalUrl:uj.url};
  const ur=await fetch('https://www.googleapis.com/youtube/v3/channels?part=brandingSettings',{method:'PUT',
    headers:{...H,'content-type':'application/json'},body:JSON.stringify({id:ch.id,brandingSettings:b})});
  console.log(ch.snippet? '':'', ur.status===200?`БАННЕР СТОИТ: ${slug} (${ch.id})`:('ОШИБКА '+ur.status+' '+JSON.stringify(await ur.json()).slice(0,200)));
}
main().catch(e=>{console.error(e.message);process.exit(1);});
