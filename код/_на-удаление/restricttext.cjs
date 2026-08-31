// Читаем ДОСЛОВНО, что Instagram написал про ограничение аккаунта. Раньше я пересказывал по
// догадке, начальник справедливо ткнул: «какие ограничения, почему не прочитал что там написано».
'use strict';
const fs=require('fs');const {chromium}=require('playwright-core');const {Client}=require('pg');const L=require('./iglib.cjs');
const KEY=process.argv[2];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const URLS=['https://www.instagram.com/accounts/account_status/','https://www.instagram.com/challenge/?next=/accounts/edit/','https://help.instagram.com/'];
(async()=>{
const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});await c.connect();
const a=(await c.query(`SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.ig_cookies, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE (a.slug=$1 OR a.ig_login=$1) AND a.deleted_at IS NULL LIMIT 1`,[KEY])).rows[0];
const {default:GoLogin}=await import('gologin');
const gl=new GoLogin({token:a.tok,profile_id:a.pid,uploadCookiesToServer:false,extra_params:['--headless=new']});
const r=await gl.startLocal();const b=await chromium.connectOverCDP(r.wsUrl,{timeout:60000});
const ctx=b.contexts()[0];const page=ctx.pages()[0]||await ctx.newPage();
await ctx.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
const raw=typeof a.ig_cookies==='string'?JSON.parse(a.ig_cookies):a.ig_cookies;
await ctx.addCookies((raw||[]).filter(x=>x&&x.name&&x.value).map(x=>({name:x.name,value:String(x.value),domain:x.domain||'.instagram.com',path:x.path||'/',httpOnly:!!x.httpOnly,secure:x.secure!==false}))).catch(()=>{});
await page.goto(URLS[0],{waitUntil:'domcontentloaded',timeout:60000});await sleep(6000);
const txt=await page.evaluate(()=>document.body.innerText.replace(/\n{2,}/g,'\n').trim()).catch(()=>'');
console.log('=== ДОСЛОВНО СО СТРАНИЦЫ ===');console.log(txt.slice(0,2200));
// пробуем открыть подробности «See why»
const more=await page.evaluateHandle(()=>{const v=e=>{const r=e.getBoundingClientRect();return r.width>2&&r.height>2};return [...document.querySelectorAll('button,[role=button],a')].filter(v).find(e=>/see why|подробн|why/i.test(e.innerText||''))||null});
const el=more.asElement();
if(el){await el.click({timeout:8000}).catch(()=>{});await sleep(5000);
const t2=await page.evaluate(()=>document.body.innerText.replace(/\n{2,}/g,'\n').trim()).catch(()=>'');
console.log('\n=== ПОДРОБНОСТИ ===');console.log(t2.slice(0,2200));}
try{await b.close()}catch{};try{await gl.stopLocal()}catch{};await c.end();process.exit(0);
})().catch(e=>{console.error('ОШИБКА:',e.message);process.exit(1)});
