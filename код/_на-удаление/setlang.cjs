// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
// Сменить язык интерфейса IG у аккаунта на РУССКИЙ (иначе селекторы панели не матчатся: 评论/コメント).
// usage: node setlang.cjs <slug>
const fs=require('fs');const {Client}=require('pg');const {chromium}=require('playwright-core');
const SLUG=process.argv[2];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const {default:GoLogin}=await import('gologin');
  const c=new Client({connectionString:process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
  await c.connect();
  const a=(await c.query("SELECT a.gologin_profile_id pid, coalesce(g.gologin_token,(SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) tok FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1",[SLUG])).rows[0];
  await c.end();
  const gl=new GoLogin({token:a.tok,profile_id:a.pid,resolution:{width:1280,height:900}});
  const st=await gl.startLocal();const b=await chromium.connectOverCDP(st.wsUrl,{timeout:60000});
  const page=b.contexts()[0].pages()[0]||await b.contexts()[0].newPage();
  try{
    await page.goto('https://www.instagram.com/accounts/language/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
    await sleep(7000);
    // ищем «Русский» среди вариантов и кликаем (радио/строка)
    let done=false;
    for(const rx of [/^Русский$/, /Русский/, /^Russian$/]){
      const el=page.getByText(rx).first();
      if(await el.isVisible().catch(()=>false)){
        const bb=await el.boundingBox().catch(()=>null);
        if(bb) await page.mouse.click(bb.x+bb.width/2,bb.y+bb.height/2).catch(()=>{});
        else await el.click({timeout:4000}).catch(()=>{});
        done=true;break;
      }
    }
    if(!done){ // фолбэк: select-элемент
      const sel=page.locator('select').first();
      if(await sel.isVisible().catch(()=>false)){ await sel.selectOption({label:'Русский'}).catch(()=>{}); done=true; }
    }
    await sleep(4000);
    // сохранить, если есть кнопка
    for(const t of [/^Сохранить$/,/^Save$/,/^Отправить$/,/^Submit$/]){
      const btn=page.getByText(t).first();
      if(await btn.isVisible().catch(()=>false)){const bb=await btn.boundingBox().catch(()=>null);if(bb)await page.mouse.click(bb.x+bb.width/2,bb.y+bb.height/2).catch(()=>{});break;}
    }
    await sleep(5000);
    await page.goto('https://www.instagram.com/',{waitUntil:'domcontentloaded',timeout:40000}).catch(()=>{});
    await sleep(6000);
    const labels=await page.$$eval('svg[aria-label]',e=>Array.from(new Set(e.map(x=>x.getAttribute('aria-label')))).slice(0,8)).catch(()=>[]);
    const ru=labels.some(l=>/Главная|Коммент|Уведомл|Поиск/i.test(l||''));
    console.log(SLUG+': клик по языку='+done+' | итоговые метки: '+JSON.stringify(labels));
    console.log(SLUG+': РУССКИЙ '+(ru?'✅ ПРИМЕНЁН':'❌ не применился'));
    fs.writeFileSync('/tmp/lang_'+SLUG+'.png',await page.screenshot({type:'png'}).catch(()=>Buffer.alloc(0)));
  }catch(e){console.log('ERR',String(e.message).slice(0,100));}
  finally{await gl.stopLocal().catch(()=>{});await b.close().catch(()=>{});}
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('FATAL', String(e.message).slice(0, 120)); setTimeout(() => process.exit(1), 60); });
