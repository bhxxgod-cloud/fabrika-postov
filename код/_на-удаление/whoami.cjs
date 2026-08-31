// Под кем реально сессия акка: сверяем логин из API Instagram с тем, что записано у нас в базе.
// Нужно потому, что центр аккаунтов показал чужие профили и в списке НЕ было нашего логина.
const fs=require('fs');const {chromium}=require('playwright-core');const {Client}=require('pg');const L=require('/Users/qq/Desktop/neironka-poster/iglib.cjs');
const SLUG=process.argv[2];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});await c.connect();
const a=(await c.query(`SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.ig_cookies, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE (a.slug=$1 OR a.ig_login=$1) AND a.deleted_at IS NULL LIMIT 1`,[SLUG])).rows[0];
const {default:GoLogin}=await import('gologin');
const gl=new GoLogin({token:a.tok,profile_id:a.pid,uploadCookiesToServer:false,extra_params:['--headless=new']});
const r=await gl.startLocal();const b=await chromium.connectOverCDP(r.wsUrl,{timeout:60000});
const ctx=b.contexts()[0];const page=ctx.pages()[0]||await ctx.newPage();
const raw=typeof a.ig_cookies==='string'?JSON.parse(a.ig_cookies):a.ig_cookies;
await ctx.addCookies((raw||[]).filter(x=>x&&x.name&&x.value).map(x=>({name:x.name,value:String(x.value),domain:x.domain||'.instagram.com',path:x.path||'/',httpOnly:!!x.httpOnly,secure:x.secure!==false}))).catch(()=>{});
await page.goto('https://www.instagram.com/accounts/edit/',{waitUntil:'domcontentloaded',timeout:60000});await sleep(5000);
const who=await page.evaluate(()=>{const u=document.querySelector('input[name="username"]');const link=[...document.querySelectorAll('a[href^="/"]')].map(a=>a.getAttribute('href')).find(h=>/^\/[A-Za-z0-9._]{3,30}\/$/.test(h)&&!/\/(explore|reels|direct|accounts)\//.test(h));return{из_поля:u?u.value:null,из_ссылки:link||null,ds_user_id:(document.cookie.match(/ds_user_id=(\d+)/)||[])[1]||null}});
console.log('в базе значится:',a.h);console.log('реально сессия:',JSON.stringify(who));
try{await b.close()}catch{};try{await gl.stopLocal()}catch{};await c.end();process.exit(0);
})().catch(e=>{console.error('ОШИБКА:',e.message);process.exit(1)});
