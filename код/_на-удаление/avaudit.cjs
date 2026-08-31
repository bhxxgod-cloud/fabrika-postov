// АУДИТ АВ: смотрим, что РЕАЛЬНО стоит на аватарках у людей, которые комментят наши целевые посты.
// Открываем пост локально, вытаскиваем ник + URL авы каждого комментатора, качаем их в папку для разбора.
const {chromium}=require('playwright-core');const {Client}=require('pg');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SLUG=process.argv[2], CODE=process.argv[3]||'DbGC7ElCKAP';
const OUT=process.env.HOME+'/Desktop/av_audit';
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});await c.connect();
 const a=(await c.query("SELECT a.gologin_profile_id pid,g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1",[SLUG])).rows[0];await c.end();
 if(!a){console.log('нет акка');process.exit(1);}
 const {default:GoLogin}=await import('gologin');
 const gl=new GoLogin({token:a.tok,profile_id:a.pid,uploadCookiesToServer:true,resolution:{width:1280,height:900}});
 const r=await gl.startLocal();const b=await chromium.connectOverCDP(r.wsUrl,{timeout:60000});
 const page=b.contexts()[0].pages()[0]||await b.contexts()[0].newPage();
 await page.goto(`https://www.instagram.com/p/${CODE}/?hl=ru`,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
 await sleep(7000);
 // скроллим панель комментов, чтобы подгрузить больше людей
 for(let i=0;i<4;i++){await page.mouse.wheel(0,1200).catch(()=>{});await sleep(1800);}
 // вытаскиваем: ник + src авы (img в строке коммента)
 const people=await page.evaluate(()=>{
  const out=[];const seen=new Set();
  document.querySelectorAll('img').forEach(im=>{
   const alt=im.getAttribute('alt')||'';
   const m=alt.match(/^(.+?)['’]?s? (profile picture|фото профиля)/i);
   if(m&&im.src&&!seen.has(m[1])){seen.add(m[1]);out.push({user:m[1],src:im.src});}
  });
  return out.slice(0,30);
 }).catch(()=>[]);
 console.log('нашёл авы:',people.length);
 let n=0;
 for(const p of people){
  try{const im=await fetch(p.src,{signal:AbortSignal.timeout(15000)});const buf=Buffer.from(await im.arrayBuffer());
   if(buf.length>1000){fs.writeFileSync(`${OUT}/${String(++n).padStart(2,'0')}_${p.user.replace(/[^\w.]/g,'')}.jpg`,buf);}}catch{}
 }
 console.log('скачано ав:',n,'→',OUT);
 await Promise.race([gl.stopLocal({posting:true}).catch(()=>{}),sleep(6000)]);await b.close().catch(()=>{});
 try{gl.killBrowser&&gl.killBrowser();}catch{}
 process.exit(0);
})().catch(e=>{console.log('ERR',e.message.slice(0,60));process.exit(1);});
