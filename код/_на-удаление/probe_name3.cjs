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
 await sleep(5500);
 const row=page.getByText('Instagram',{exact:true}).first();
 if(await row.isVisible().catch(()=>false)){await row.click().catch(()=>{});await sleep(4500);}
 const nm=page.getByText(/^Name$/i).first();
 if(await nm.isVisible().catch(()=>false)){await nm.click().catch(()=>{});await sleep(4000);}
 const val=await page.evaluate(()=>{const i=document.querySelector('input[type="text"],input:not([type])');return i?i.value:'NOINPUT';}).catch(()=>'ERR');
 console.log('ТЕКУЩЕЕ ИМЯ В IG:',val);
 // проверим состояние кнопки Done при вводе
 const inp=page.locator('input[type="text"]').first();
 if(await inp.isVisible().catch(()=>false)){
  await inp.click().catch(()=>{});await inp.fill('').catch(()=>{});
  await inp.pressSequentially('Лена',{delay:60}).catch(()=>{});await sleep(1200);
  const st=await page.evaluate(()=>{const bs=[...document.querySelectorAll('div[role="button"],button')].filter(b=>/done|save/i.test(b.innerText||''));return bs.map(b=>({t:(b.innerText||'').slice(0,10),dis:b.getAttribute('aria-disabled')||b.disabled||'no'}));}).catch(()=>[]);
  console.log('кнопки после ввода:',JSON.stringify(st));
  const done=page.getByRole('button',{name:/^(Done|Save)$/i}).first();
  const en=await done.isEnabled().catch(()=>false);
  console.log('Done enabled?',en);
  if(en){await done.click().catch(()=>{});await sleep(4500);console.log('нажал Done');}
  await sleep(2000);
  fs.writeFileSync('/tmp/ac_after.png',await page.screenshot({type:'png',timeout:15000}).catch(()=>Buffer.alloc(0)));
 }
 await Promise.race([gl.stopLocal({posting:true}).catch(()=>{}),sleep(6000)]);await b.close().catch(()=>{});
 try{gl.killBrowser&&gl.killBrowser();}catch{}
 process.exit(0);
})().catch(e=>{console.log('ERR',e.message.slice(0,60));process.exit(1);});
