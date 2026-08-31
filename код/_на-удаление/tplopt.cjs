const fs=require('fs'),path=require('path'),os=require('os');
const {chromium}=require('playwright-core');
const PROFILE=path.join(os.homedir(),'.neironka-admin-profile');
const CHROME=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
(async()=>{
  const ctx=await chromium.launchPersistentContext(PROFILE,{headless:false,executablePath:CHROME,viewport:{width:1280,height:1000}});
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto('https://neironka.pro/admin/promo',{waitUntil:'domcontentloaded',timeout:60000});
  await new Promise(r=>setTimeout(r,5000));
  const form=await page.evaluate(()=>({
    selects:[...document.querySelectorAll('select')].map(s=>({id:s.id||s.name||'',first:s.options[0]?.text,count:s.options.length})),
    inputs:[...document.querySelectorAll('input,textarea')].filter(i=>i.offsetParent).map(i=>({type:i.type||'textarea',ph:i.placeholder||'',name:i.name||i.id||''})).slice(0,12),
    labels:[...document.querySelectorAll('label')].map(l=>(l.innerText||'').trim()).filter(Boolean).slice(0,15),
    buttons:[...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,14),
  }));
  console.log('СЕЛЕКТЫ:',JSON.stringify(form.selects));
  console.log('ПОЛЯ:',JSON.stringify(form.inputs));
  console.log('ПОДПИСИ:',JSON.stringify(form.labels));
  console.log('КНОПКИ:',JSON.stringify(form.buttons));
  await ctx.close();
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch(e=>{console.error('ОШИБКА:',e.message);process.exit(1)});
