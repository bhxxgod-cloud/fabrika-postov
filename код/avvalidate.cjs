// ВАЛИДАЦИЯ АВ: смотрим каждую картинку зрением LLM и решаем, поставила бы её на аву живая девушка 18-25 в 2026.
// Отсев: устаревшее (Гарфилд, старые мемы, демотиваторы), водяные знаки/тексты, треш (кровь, черепа), низкое
// качество, откровенное. Плохие уезжают в _rejected/, хорошие получают правильную категорию.
const fs=require('fs');const path=require('path');
const KEY=process.env.OPENROUTER_API_KEY;
const DIR=process.env.HOME+'/Desktop/avatars';
const REJ=DIR+'/_rejected';
const CONC=Number(process.env.CONC||4);
const SYS=`You judge Instagram profile pictures for a Russian-speaking girls' audience.
HARD REJECT if the image contains ANY photo of a real human being (face, body, cosplay, selfie, portrait, group) — real-people photos are banned entirely.
Also REJECT: outdated/cringe (Garfield, 2000s memes, demotivators, clipart), watermarks or website text, gore/blood/skulls/horror, sexual content, low quality/pixelated, logos/ads, weapons.
KEEP ONLY: anime/manga art, cute animals, nature, city/interior, flowers, food, objects, minimalist or aesthetic art, abstract, drawn/cartoon characters that are still trendy.
Pick best category from: anime, girly, animals, nature, city, mood, popculture, car.
Reply ONLY JSON: {"keep":true|false,"cat":"...","why":"3 words"}`;
async function judge(file){
 const b64=fs.readFileSync(file).toString('base64');
 const ext=path.extname(file).slice(1).toLowerCase()==='png'?'png':'jpeg';
 const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',
  headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},
  body:JSON.stringify({model:'openai/gpt-4o-mini',max_tokens:60,messages:[
   {role:'system',content:SYS},
   {role:'user',content:[{type:'text',text:'Judge this avatar.'},{type:'image_url',image_url:{url:`data:image/${ext};base64,`+b64}}]}]}),
  signal:AbortSignal.timeout(40000)}).then(x=>x.json()).catch(()=>null);
 const t=r?.choices?.[0]?.message?.content||'';
 try{return JSON.parse((t.match(/\{[\s\S]*\}/)||['{}'])[0]);}catch{return {};}
}
(async()=>{
 if(!KEY){console.log('нет OPENROUTER_API_KEY');process.exit(1);}
 fs.mkdirSync(REJ,{recursive:true});
 const cats=fs.readdirSync(DIR).filter(d=>!d.startsWith('_')&&!d.startsWith('.')&&fs.statSync(`${DIR}/${d}`).isDirectory());
 const files=[];
 for(const c of cats) for(const f of fs.readdirSync(`${DIR}/${c}`)) if(/\.(jpe?g|png|webp)$/i.test(f)) files.push({c,f,p:`${DIR}/${c}/${f}`});
 console.log('к проверке:',files.length);
 let keep=0,rej=0,moved=0,i=0;
 async function worker(){
  while(i<files.length){
   const k=i++;const it=files[k];
   try{
    const v=await judge(it.p);
    if(v.keep===false){fs.renameSync(it.p,`${REJ}/${it.c}_${it.f}`);rej++;}
    else{keep++;
     if(v.cat&&v.cat!==it.c&&cats.includes(v.cat)){fs.mkdirSync(`${DIR}/${v.cat}`,{recursive:true});fs.renameSync(it.p,`${DIR}/${v.cat}/${it.f}`);moved++;}
    }
   }catch(e){}
   if((keep+rej)%50===0)console.log(`  ${keep+rej}/${files.length} · оставлено ${keep} · отсеяно ${rej} · перекатегорено ${moved}`);
  }
 }
 await Promise.all(Array.from({length:CONC},worker));
 console.log(`ГОТОВО: оставлено ${keep}, отсеяно ${rej} (в _rejected), перекатегорено ${moved}`);
})();
