'use strict';
const fs=require('fs'), path=require('path'), os=require('os');
const KEY=fs.readFileSync('/tmp/.rgkey','utf8').trim();
const BASE='https://api.rendergrid.io/api/public/v1';
const OUT=path.join(os.homedir(),'Desktop','ЮТУБ','авы-катя');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const CROP=' Кадр заполнен целиком, без белых полей и без нарисованной рамки-круга. Главное строго по центру, лицо целиком в кадре, ничего не обрезано. Высокий контраст, читается в маленьком размере.';
const IDEAS=[
 ['9-монограмма-контраст','Аватарка-логотип: очень крупная белая буква К по центру на насыщенном тёмно-вишнёвом фоне, современная геометричная типографика, максимальный контраст, ничего лишнего.'+CROP],
 ['10-улыбка-крупно','Фотопортрет девушки 25 лет крупным планом, открытая живая улыбка, смотрит прямо в камеру, лицо целиком помещается в кадр, ухоженная кожа, лёгкий макияж, тёплый мягкий свет, размытый розово-бежевый фон.'+CROP],
 ['11-неон-улыбка','Стильный фотопортрет девушки крупно, дружелюбная улыбка, современный розово-фиолетовый неоновый свет на лице, тёмный фон, модно и дорого, лицо целиком в кадре.'+CROP],
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
(async()=>{ const r=await Promise.all(IDEAS.map(([n,p])=>one(n,p).catch(e=>`${n}: ${e.message}`))); r.forEach(x=>console.log(x)); })();
