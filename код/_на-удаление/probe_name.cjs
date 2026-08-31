const {chromium}=require('playwright-core');const {Client}=require('pg');const fs=require('fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});await c.connect();
 const a=(await c.query("SELECT a.gologin_profile_id pid,g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug='FOL_3178'")).rows[0];await c.end();
 const {default:GoLogin}=await import('gologin');
 const gl=new GoLogin({token:a.tok,profile_id:a.pid,uploadCookiesToServer:true,resolution:{width:1280,height:900}});
 const r=await gl.startLocal();const b=await chromium.connectOverCDP(r.wsUrl,{timeout:60000});
 const page=b.contexts()[0].pages()[0]||await b.contexts()[0].newPage();
 for(const u of ['https://accountscenter.instagram.com/profiles/','https://accountscenter.instagram.com/personal_details/']){
  await page.goto(u,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});await sleep(6000);
  const n=u.includes('personal')?'pd':'prof';
  fs.writeFileSync('/tmp/ac_'+n+'.png',await page.screenshot({type:'png',timeout:15000}).catch(()=>Buffer.alloc(0)));
  const txt=await page.evaluate(()=>document.body.innerText.slice(0,600)).catch(()=>'');
  console.log('=== '+u+' → '+page.url().slice(0,60));console.log(txt.replace(/\n+/g,' | ').slice(0,400));
 }
 await Promise.race([gl.stopLocal({posting:true}).catch(()=>{}),sleep(6000)]);await b.close().catch(()=>{});
 try{gl.killBrowser&&gl.killBrowser();}catch{}
 process.exit(0);
})().catch(e=>{console.log('ERR',e.message.slice(0,60));process.exit(1);});
