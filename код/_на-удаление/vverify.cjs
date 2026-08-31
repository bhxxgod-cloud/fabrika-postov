// Пишем 1 ответ, ПЕРЕЗАГРУЖАЕМ страницу (не оптимистичный рендер), проверяем реально ли вложился.
const { chromium } = require('playwright-core'); const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR; const SLUG = process.argv[2]; const URL = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ld(){for(let k=0;k<5;k++){const c=new Client({connectionString:process.env.DB_PUBLIC_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});try{await c.connect();const a=(await c.query("SELECT a.gologin_profile_id, g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'",[SLUG])).rows[0];await c.end();return a;}catch{await c.end().catch(()=>{});await sleep(2500);}}throw new Error('db');}
(async()=>{
  const a=await ld(); const tok=a.gologin_token||process.env.GOLOGIN_API_TOKEN;
  const u=new global.URL('wss://cloudbrowser.gologin.com/connect');u.searchParams.set('token',tok);u.searchParams.set('profile',a.gologin_profile_id);
  let b;for(let k=0;k<5;k++){try{b=await chromium.connectOverCDP(u.toString(),{timeout:60000});break;}catch{console.log('коннект'+k);await sleep(k===0?22000:14000);}}
  if(!b){console.log('НЕ ПОДКЛЮЧИЛСЯ');return;}
  const ctx=b.contexts()[0]||await b.newContext(); const page=ctx.pages()[0]||await ctx.newPage();
  const snap=async n=>{try{require('fs').writeFileSync(`${SHOT}/verify_${SLUG.replace(/\s+/g,'_')}_${n}.png`,await page.screenshot({type:'png',timeout:12000}).catch(()=>Buffer.alloc(0)));}catch{}};
  try{
    await page.route('**/*',r=>{const t=r.request().resourceType();if(t==='media')return r.abort().catch(()=>{});r.continue().catch(()=>{});}).catch(()=>{});
    await page.setViewportSize({width:1280,height:900});
    await page.goto(URL+'?hl=ru',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
    await sleep(4000); await page.mouse.click(600,450).catch(()=>{}); await sleep(1500);
    // открыть панель
    const ic=page.locator('svg[aria-label*="оммент" i], svg[aria-label*="omment" i]').first();
    if(await ic.isVisible().catch(()=>false)){const btn=ic.locator('xpath=ancestor::*[self::button or @role="button" or self::a][1]');await(await btn.count().catch(()=>0)?btn.first():ic).click({timeout:4000}).catch(()=>{});}else await page.mouse.click(882,582).catch(()=>{});
    await sleep(4000);
    // найти первого асқера (кнопка Ответить у коммента с «промт»), кликнуть Reply, напечатать, отправить
    const rb=page.getByText(/^(Ответить|Reply)$/i).first();
    await rb.scrollIntoViewIfNeeded().catch(()=>{}); const bb=await rb.boundingBox().catch(()=>null);
    // ник цели
    const target=await rb.evaluate(el=>{let n=el;for(let i=0;i<8&&n;i++){n=n.parentElement;const a=n&&n.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"])');const m=a&&(a.getAttribute('href')||'').match(/^\/([\w.]+)\/?$/);if(m)return m[1];}return '';}).catch(()=>'');
    console.log('цель:',target);
    if(bb)await page.mouse.click(bb.x+bb.width/2,bb.y+bb.height/2).catch(()=>{}); await sleep(2500);
    await page.keyboard.type(' нейронка про в яндексе, там бесплатный шаблон готовый',{delay:35}).catch(()=>{});
    await sleep(800); await snap('typed');
    const post=page.getByText(/^(Опубликовать|Post|Отправить)$/i).first(); if(await post.isVisible().catch(()=>false))await post.click().catch(()=>{}); else await page.keyboard.press('Enter').catch(()=>{});
    await sleep(5000); await snap('posted_optimistic');
    console.log('--- ПЕРЕЗАГРУЖАЮ страницу (чистое состояние) ---');
    await page.goto(URL+'?hl=ru',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
    await sleep(5000); await page.mouse.click(600,450).catch(()=>{}); await sleep(1500);
    if(await ic.isVisible().catch(()=>false)){const btn=ic.locator('xpath=ancestor::*[self::button or @role="button" or self::a][1]');await(await btn.count().catch(()=>0)?btn.first():ic).click({timeout:4000}).catch(()=>{});}else await page.mouse.click(882,582).catch(()=>{});
    await sleep(4000);
    // найти цель после перезагрузки и проверить, есть ли под ней наш вложенный ответ
    const check=await page.evaluate((tgt)=>{
      const body=document.body.innerText;
      const hasReply=/нейронка про в яндексе, там бесплатный шаблон готовый/.test(body);
      // ищем блок цели, смотрим есть ли рядом наш текст в НИЖЕ (вложенно)
      return {hasReplyVisible:hasReply, bodyLen:body.length};
    },target).catch(()=>({hasReplyVisible:false}));
    await snap('reloaded');
    console.log('после перезагрузки: наш ответ виден в DOM =',check.hasReplyVisible);
  }catch(e){console.log('ОШИБКА',String(e.message).slice(0,60));}
  finally{await fetch('https://api.gologin.com/browser/'+a.gologin_profile_id+'/web',{method:'DELETE',headers:{Authorization:'Bearer '+tok}}).catch(()=>{});await b.close().catch(()=>{});}
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
