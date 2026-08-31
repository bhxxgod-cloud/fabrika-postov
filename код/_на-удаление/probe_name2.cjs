const {chromium}=require('playwright-core');const {Client}=require('pg');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});await c.connect();
 const a=(await c.query("SELECT a.gologin_profile_id pid,g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug='FOL_3178'")).rows[0];await c.end();
 const {default:GoLogin}=await import('gologin');
 const gl=new GoLogin({token:a.tok,profile_id:a.pid,uploadCookiesToServer:true,resolution:{width:1280,height:900}});
 const r=await gl.startLocal();const b=await chromium.connectOverCDP(r.wsUrl,{timeout:60000});
 const page=b.contexts()[0].pages()[0]||await b.contexts()[0].newPage();
 await page.goto('https://accountscenter.instagram.com/profiles/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
 await sleep(6000);
 // клик по ПЕРВОЙ инстаграм-строке профиля
 const row=page.getByText('Instagram',{exact:true}).first();
 if(await row.isVisible().catch(()=>false)){await row.click().catch(()=>{});await sleep(5000);}
 fs.writeFileSync('/tmp/ac_step2.png',await page.screenshot({type:'png',timeout:15000}).catch(()=>Buffer.alloc(0)));
 console.log('URL:',page.url().slice(0,80));
 console.log('TEXT:',(await page.evaluate(()=>document.body.innerText.slice(0,500)).catch(()=>'')).replace(/\n+/g,' | '));
 // ищем строку Name
 const nm=page.getByText(/^Name$/i).first();
 if(await nm.isVisible().catch(()=>false)){await nm.click().catch(()=>{});await sleep(4000);
  fs.writeFileSync('/tmp/ac_step3.png',await page.screenshot({type:'png',timeout:15000}).catch(()=>Buffer.alloc(0)));
  console.log('NAME-URL:',page.url().slice(0,80));
  console.log('inputs:',await page.evaluate(()=>[...document.querySelectorAll('input')].map(i=>({n:i.name,v:(i.value||'').slice(0,20),al:i.getAttribute('aria-label')})).slice(0,5)).catch(()=>[]));
 } else console.log('строки Name нет');
 await Promise.race([gl.stopLocal({posting:true}).catch(()=>{}),sleep(6000)]);await b.close().catch(()=>{});
 try{gl.killBrowser&&gl.killBrowser();}catch{}
 process.exit(0);
})().catch(e=>{console.log('ERR',e.message.slice(0,60));process.exit(1);});
