// Генерим по 3 образца на категорию под ЖЕНСКУЮ аудиторию. Только БЕЗ ЛИЦ и без чужой интеллектуальной
// собственности (конкретных персонажей/знаменитостей не генерим — их владелец кидает в свою папку сам).
const fs=require('fs');const {execFileSync}=require('child_process');
const KEY=fs.readFileSync('/tmp/rg_key.txt','utf8').trim();
const BASE='https://api.rendergrid.io/api/public/v1';
const OUT=process.env.HOME+'/Desktop/av_cat';
const REAL='amateur iphone photo, casual snapshot, natural imperfect light, slight grain, no face visible';
const CATS={
 back_brand:[
  `young woman photographed from behind, long hair, holding a designer handbag, walking on a city street, back view only, ${REAL}`,
  `young woman from behind on stone stairs, beige coat, luxury handbag on shoulder, autumn city, back view only, ${REAL}`,
  `young woman from behind at a cafe window, long wavy hair, quilted chain bag, ${REAL}`],
 car:[
  `close up of a woman's hands with neat manicure on a car steering wheel, luxury car interior, ${REAL}`,
  `woman's legs on a car dashboard, white sneakers, road ahead through windshield, sunset, ${REAL}`,
  `car keys and a coffee cup on a car seat, premium car interior, ${REAL}`],
 girly:[
  `close up of hands with fresh manicure holding a coffee cup, marble table, ${REAL}`,
  `bouquet of pink peonies on a bed with white linen, morning light, ${REAL}`,
  `perfume bottle and jewelry on a mirrored tray, soft window light, ${REAL}`],
 anime:[
  `anime style avatar, girl with long dark hair, pastel colors, soft lighting, clean digital art, no text`,
  `black and white manga style avatar portrait of a girl, dramatic shading, screentone, no text`,
  `anime style avatar, girl in a hoodie at night, city lights bokeh, purple tones, clean digital art, no text`],
 cinema:[
  `cinematic film still aesthetic, silhouette of a girl at a rainy window, moody warm light, 35mm grain, no face`,
  `cinematic aesthetic, empty night street with neon reflections in puddles, film grain, moody`,
  `cinematic film still, girl from behind on a beach at sunset, wind in hair, back view only, film grain`],
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 for(const [cat,prompts] of Object.entries(CATS)){
  fs.mkdirSync(`${OUT}/${cat}`,{recursive:true});
  for(let i=0;i<prompts.length;i++){
   try{
    const g=await fetch(`${BASE}/images/generate`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+KEY},body:JSON.stringify({model:'nano-banana-2',prompt:prompts[i],aspect_ratio:'1:1'}),signal:AbortSignal.timeout(20000)});
    if(!g.ok){console.log(cat,i+1,'HTTP',g.status);continue;}
    const j=await g.json();let url=null;
    for(let k=0;k<22;k++){await sleep(4000);
     const q=await fetch(`${BASE}/creations/${j.id}`,{headers:{Authorization:'Bearer '+KEY},signal:AbortSignal.timeout(15000)}).catch(()=>null);
     if(!q||!q.ok)continue;const d=await q.json();
     if(d.status==='completed'&&d.result_urls?.length){url=d.result_urls[0];break;}
     if(d.status==='failed'||d.status==='error')break;}
    if(url){const im=await fetch(url,{signal:AbortSignal.timeout(30000)});const b=Buffer.from(await im.arrayBuffer());
     const p=`${OUT}/${cat}/${i+1}.jpg`;fs.writeFileSync(p,b);
     try{execFileSync('sips',['-Z','1080',p,'--out',p],{stdio:'ignore'});}catch{}
     console.log(`  ${cat} ${i+1} ✓`);}
    else console.log(`  ${cat} ${i+1} ✗`);
   }catch(e){console.log(' ',cat,i+1,'err',String(e.message).slice(0,30));}
  }
 }
 console.log('ГОТОВО →',OUT);
})();
