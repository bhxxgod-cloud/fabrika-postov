'use strict';
// Рисованная героиня канала «Спроси у Кати»: активная, дружелюбная, узнаваемая.
// Текст НЕ просим у генератора (коверкает кириллицу), наносим сами.
const fs=require('fs'), path=require('path'), os=require('os');
const KEY=fs.readFileSync('/tmp/.rgkey','utf8').trim();
const BASE='https://api.rendergrid.io/api/public/v1';
const OUT=path.join(os.homedir(),'Desktop','ЮТУБ','авы-катя','героиня');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const COMMON=' Современная качественная векторная иллюстрация, чистые уверенные линии, плоские заливки, мягкие тени, дорогая ограниченная палитра. Без текста, без букв, без надписей, без логотипов. Персонаж крупно по центру, голова и плечи целиком в кадре, снизу оставлено пустое место под подпись. Фон однотонный, простой.';
const IDEAS=[
 ['a-подмигивает','Молодая девушка-эксперт по красоте: подмигивает и показывает большой палец вверх, живая энергичная эмоция, каре тёплого шоколадного цвета, розовые щёки, фон мягкий коралловый.'+COMMON],
 ['b-указывает','Молодая девушка бьюти-блогер: улыбается и уверенно указывает пальцем прямо на зрителя, будто зовёт задать вопрос, тёмное каре, фон насыщенный сиреневый.'+COMMON],
 ['c-телефон-сердечко','Молодая девушка держит телефон экраном к зрителю, на экране крупное сердечко, широкая радостная улыбка, длинные волнистые волосы, фон мятно-бирюзовый.'+COMMON],
 ['d-лупа','Молодая девушка-стилист смотрит через большую лупу и весело улыбается, будто разбирает внешность по фото, светлые волосы собраны, фон тёплый песочный.'+COMMON],
 ['e-палец-вверх','Молодая девушка радостно поднимает указательный палец вверх, будто придумала идею, над головой маленькая лампочка, рыжеватое каре, фон глубокий синий.'+COMMON],
 ['f-рука-у-щеки','Молодая девушка с хитрой улыбкой подпирает щёку рукой и смотрит прямо на зрителя, кокетливо и дружелюбно, тёмные волосы, фон пудрово-розовый.'+COMMON],
];
async function one(name,prompt){
  const g=await(await fetch(`${BASE}/images/generate`,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${KEY}`},
    body:JSON.stringify({model:'nano-banana-2',prompt,aspect_ratio:'1:1'})})).json();
  if(!g.id) return `${name}: не заказалось`;
  for(let i=0;i<70;i++){
    await sleep(5000);
    const r=await fetch(`${BASE}/creations/${g.id}`,{headers:{Authorization:`Bearer ${KEY}`}}).catch(()=>null);
    if(!r||!r.ok) continue;
    const d=await r.json();
    if(d.status==='completed'&&(d.result_urls||[]).length){
      const img=await fetch(d.result_urls[0]);
      fs.writeFileSync(path.join(OUT,`${name}.jpg`),Buffer.from(await img.arrayBuffer()));
      return `${name}: готово`;
    }
    if(d.status==='failed') return `${name}: упало`;
  }
  return `${name}: таймаут`;
}
(async()=>{ fs.mkdirSync(OUT,{recursive:true});
  const r=await Promise.all(IDEAS.map(([n,p])=>one(n,p).catch(e=>`${n}: ${e.message}`))); r.forEach(x=>console.log(x)); })();
