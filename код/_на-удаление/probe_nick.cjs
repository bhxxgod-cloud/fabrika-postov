// РАЗВЕДКА пути смены @ника. Только читаем: открываем Accounts Center → профиль → смотрим, какие строки есть
// и открывается ли /username/. НИЧЕГО не меняем.
const {chromium}=require('playwright-core');const {Client}=require('pg');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SLUG=process.argv[2];
(async()=>{
 const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});await c.connect();
 const a=(await c.query("SELECT a.gologin_profile_id pid,g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1",[SLUG])).rows[0];await c.end();
 if(!a||!a.tok){console.log('нет акка/токена');process.exit(1);}
 const {default:GoLogin}=await import('gologin');
 const gl=new GoLogin({token:a.tok,profile_id:a.pid,uploadCookiesToServer:true,resolution:{width:1280,height:900}});
 const r=await gl.startLocal().catch(e=>{console.log('startLocal:',String(e.message).slice(0,50));return null;});
 if(!r||!r.wsUrl){process.exit(1);}
 const b=await chromium.connectOverCDP(r.wsUrl,{timeout:60000}).catch(()=>null);
 if(!b){console.log('коннект fail');process.exit(1);}
 const page=b.contexts()[0].pages()[0]||await b.contexts()[0].newPage();
 await page.goto('https://accountscenter.instagram.com/profiles/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
 await sleep(6000);
 if(/login|challenge/i.test(page.url())){console.log('РАЗЛОГИНЕН:',page.url().slice(0,60));}
 else{
  const row=page.getByText('Instagram',{exact:true}).first();
  if(await row.isVisible().catch(()=>false)){await row.click().catch(()=>{});await sleep(4500);}
  const txt=await page.evaluate(()=>document.body.innerText.slice(0,900)).catch(()=>'');
  console.log('URL:',page.url().slice(0,70));
  console.log('СТРОКИ ПРОФИЛЯ:',txt.replace(/\n+/g,' | ').slice(0,500));
  // пробуем прямой путь username
  const base=page.url().replace(/\/$/,'');
  await page.goto(base+'/username/',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await sleep(4000);
  console.log('USERNAME-URL:',page.url().slice(0,80));
  const inp=await page.evaluate(()=>[...document.querySelectorAll('input')].map(i=>({v:(i.value||'').slice(0,25),ph:i.placeholder||''})).slice(0,3)).catch(()=>[]);
  console.log('поля:',JSON.stringify(inp));
  const t2=await page.evaluate(()=>document.body.innerText.slice(0,300)).catch(()=>'');
  console.log('текст:',t2.replace(/\n+/g,' | ').slice(0,250));
  fs.writeFileSync('/tmp/nick_probe.png',await page.screenshot({type:'png',timeout:15000}).catch(()=>Buffer.alloc(0)));
 }
 await Promise.race([gl.stopLocal({posting:true}).catch(()=>{}),sleep(6000)]);await b.close().catch(()=>{});
 try{gl.killBrowser&&gl.killBrowser();}catch{}
 process.exit(0);
})().catch(e=>{console.log('ERR',String(e.message).slice(0,60));process.exit(1);});
