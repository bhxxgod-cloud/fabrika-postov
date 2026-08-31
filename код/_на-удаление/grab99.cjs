// Качаем авы с 99px по категориям, используя СЕССИЮ ВЛАДЕЛЬЦА (проверку «я не робот» он прошёл сам в браузере).
// Вежливо: пауза между запросами, ограниченный объём. Раскладываем по ~/Desktop/avatars/<категория>/
const fs=require('fs');const {execFileSync}=require('child_process');
const CK=process.argv[2], UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const OUT=process.env.HOME+'/Desktop/avatars';
const CATS={anime:'anime', car:'avto', girly:'devushki', cinema:'kino', nature:'priroda', city:'gorod'};
const PAGES=Number(process.env.PAGES||3);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const H={'User-Agent':UA,'Cookie':CK,'Referer':'https://avatars.99px.ru/','Accept':'text/html,image/*'};
(async()=>{
 let total=0;
 for(const [cat,tag] of Object.entries(CATS)){
  const dir=`${OUT}/${cat}`;fs.mkdirSync(dir,{recursive:true});
  const urls=new Set();
  for(let p=1;p<=PAGES;p++){
   const u=p===1?`https://avatars.99px.ru/avatars/tags/${tag}/`:`https://avatars.99px.ru/avatars/tags/${tag}/${p}/`;
   try{const r=await fetch(u,{headers:H,signal:AbortSignal.timeout(20000)});
    if(r.status!==200){console.log(`  ${cat} стр${p}: HTTP ${r.status}`);break;}
    const h=await r.text();
    [...h.matchAll(/data-src="(https:\/\/99px\.ru\/sstorage\/[^"]+\.(?:jpg|jpeg|png))"/g)].forEach(m=>urls.add(m[1]));
   }catch(e){console.log(`  ${cat} стр${p} err`);break;}
   await sleep(900);
  }
  let n=0;
  for(const u of urls){
   const name=u.split('/').pop();
   const p=`${dir}/${name}`;
   if(fs.existsSync(p))continue;
   try{const r=await fetch(u,{headers:H,signal:AbortSignal.timeout(15000)});
    const b=Buffer.from(await r.arrayBuffer());
    if(b.length>3000){fs.writeFileSync(p,b);n++;total++;}
   }catch{}
   await sleep(250);
  }
  console.log(`  ${cat}: скачано ${n} (всего ссылок ${urls.size})`);
 }
 console.log(`ИТОГО: ${total} ав → ${OUT}`);
})();
