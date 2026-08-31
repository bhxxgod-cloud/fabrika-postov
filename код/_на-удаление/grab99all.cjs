// Массовый сбор ав с 99px по ОТОБРАННЫМ категориям (сессия владельца, он прошёл проверку сам).
// Исключены: эротика, дети, кровь/черепа/монстры, реклама, широкоформатные (не квадрат).
const fs=require('fs');
const CK=process.argv[2];
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const OUT=process.env.HOME+'/Desktop/avatars';
const H={'User-Agent':UA,'Cookie':CK,'Referer':'https://avatars.99px.ru/'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// категория → папка (группируем в наши смысловые корзины)
const MAP={
 anime:['anime','manga','multiki','kosplej','fentezi','skazki'],
 popculture:['kino','seriali','supergeroi','cyberpunk','igri','muzika'],
 girly:['devushki','glamurnie','krasivie','milie','gubi','glaza','ruki','serdechki','lubov','cveti','babochki'],
 car:['avto','motocikli','transport'],
 nature:['priroda','more','les','gori','nebo','oblaka','luna','voda','zima','sneg','leto','osen','vesna','dojd','listja'],
 city:['gorod','interer','doma','mosti','dorogi','noch','arhitektura'],
 animals:['koshki','sobaki','jivotnie','kroliki','ptici','lisi','volki'],
 mood:['minimalizm','cherno-belie','boke','kapli','makro','pozitiv','grustnie','emocionalnie','abstrakcija','tatu','brendi','eda','predmeti'],
};
(async()=>{
 let total=0;
 for(const [bucket,tags] of Object.entries(MAP)){
  const dir=`${OUT}/${bucket}`;fs.mkdirSync(dir,{recursive:true});
  let n=0;
  for(const tag of tags){
   try{
    const r=await fetch(`https://avatars.99px.ru/avatars/tags/${tag}/`,{headers:H,signal:AbortSignal.timeout(20000)});
    if(r.status!==200){console.log(`  ${tag}: HTTP ${r.status}`);await sleep(600);continue;}
    const h=await r.text();
    const urls=[...new Set([...h.matchAll(/data-src="(https:\/\/99px\.ru\/sstorage\/[^"]+\.(?:jpg|jpeg|png))"/g)].map(m=>m[1]))];
    for(const u of urls){
     const p=`${dir}/${tag}_${u.split('/').pop()}`;
     if(fs.existsSync(p))continue;
     try{const ir=await fetch(u,{headers:H,signal:AbortSignal.timeout(15000)});
      const b=Buffer.from(await ir.arrayBuffer());
      if(b.length>2500){fs.writeFileSync(p,b);n++;total++;}
     }catch{}
     await sleep(200);
    }
   }catch(e){console.log(`  ${tag} err`);}
   await sleep(800);
  }
  console.log(`${bucket}: ${n} шт`);
 }
 console.log(`ИТОГО СКАЧАНО: ${total}`);
})();
