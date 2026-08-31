// ПРОВЕРЩИК УНИКАЛЬНОСТИ ПОСТОВ (11.08, приказ: «все посты уникальные? пройдись по ним
// проверщиком, нам нужны уник посты без брака»).
//
// ЗАЧЕМ. Правило «один пост = один акк» держится только если ни один КАДР не повторяется между
// постами. Побайтовое сравнение тут бесполезно: пересжатие меняет байты, а картинка та же.
// Поэтому считаем восприятийный хэш: кадр в серое 8 на 8, каждый пиксель против среднего, 64 бита.
// Похожесть считаем расстоянием Хэмминга: до 5 бит это тот же кадр, дальше разные.
'use strict';
const fs=require('fs'), path=require('path'), {execFile}=require('child_process');
const FF=require('ffmpeg-static'), {Client}=require('pg');
const {fetchToFile}=require('./watchdog.cjs');
const КЭШ='/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/uniq_cache';
fs.mkdirSync(КЭШ,{recursive:true});

const прогнать=(args)=>new Promise((ok,бяда)=>execFile(FF,args,{encoding:'buffer',maxBuffer:1<<20},(e,so)=>e?бяда(e):ok(so)));

async function ахэш(файл){
  const raw=await прогнать(['-v','error','-i',файл,'-vf','scale=8:8,format=gray','-frames:v','1','-f','rawvideo','-']);
  const пиксели=[...raw.slice(0,64)];
  const среднее=пиксели.reduce((a,b)=>a+b,0)/64;
  let биты=0n;
  пиксели.forEach((p,i)=>{ if(p>среднее) биты |= (1n<<BigInt(i)); });
  return биты;
}
const хэмминг=(a,b)=>{ let x=a^b, n=0; while(x){ n+=Number(x&1n); x>>=1n; } return n; };

(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const посты=(await c.query(`SELECT id, meta->>'persona' persona, meta->'image_urls' urls
    FROM posts WHERE status IN ('backlog','approved') AND published_at IS NULL
      AND jsonb_array_length(meta->'image_urls')=4
      AND coalesce(meta->'qa'->>'clean','нет') <> 'false'
      AND coalesce(meta->>'look_missing','') <> 'true'
    ORDER BY created_at DESC`)).rows;
  console.log(`проверяю постов: ${посты.length}`);
  const кадры=[]; let сбои=0;
  for (const [i,p] of посты.entries()){
    const s=String(p.id).slice(0,8);
    for (const [j,u] of (p.urls||[]).entries()){
      const ф=path.join(КЭШ,`${s}_${j}.jpg`);
      try{
        if(!fs.existsSync(ф)) await fetchToFile(u,ф,{what:`${s} кадр ${j+1}`,ms:45000,min:3000,тихо:true});
        кадры.push({пост:s, персона:p.persona, номер:j+1, хэш:await ахэш(ф)});
      }catch(e){ сбои++; }
    }
    if((i+1)%20===0) console.log(`  ...${i+1} из ${посты.length}`);
  }
  console.log(`кадров посчитано: ${кадры.length}, не скачалось: ${сбои}`);
  // ищем повторы: сравниваем только кадры с ОДИНАКОВЫМ номером, потому что карточка похожа на
  // карточку по замыслу, а вот две одинаковые обложки это настоящий дубль
  const повторы=[];
  for(let a=0;a<кадры.length;a++) for(let b=a+1;b<кадры.length;b++){
    if(кадры[a].номер!==кадры[b].номер) continue;
    if(кадры[a].пост===кадры[b].пост) continue;
    // ПОРОГ РАЗНЫЙ ПО КАДРАМ, и это не придирка, а замер. Карточка на кадре 2 это документ с
    // ОДНОЙ И ТОЙ ЖЕ вёрсткой: тот же заголовок, те же блоки, та же сетка. Восьмёрка на восемь
    // видит в двух разных карточках почти одну картинку, и первый прогон объявил дублями 12 пар
    // карточек, хотя внутри разные девочки. Поэтому для карточки порог жёсткий, только почти
    // побитовое совпадение, а для фотографий (кадры 1, 3, 4) остаётся 5.
    const порог = (кадры[a].номер===2) ? 2 : 5;
    const d=хэмминг(кадры[a].хэш,кадры[b].хэш);
    if(d<=порог) повторы.push({a:кадры[a],b:кадры[b],d});
  }
  const плохие=new Set();
  for(const п of повторы){ плохие.add(п.b.пост); }   // оставляем более свежий, второй помечаем
  console.log(`\nПОВТОРОВ КАДРОВ: ${повторы.length}`);
  const покадру={}; повторы.forEach(п=>{покадру[п.a.номер]=(покадру[п.a.номер]||0)+1;});
  console.log('по номеру кадра: '+JSON.stringify(покадру));
  повторы.slice(0,12).forEach(п=>console.log(`  кадр ${п.a.номер}: ${п.a.пост} (${п.a.персона}) = ${п.b.пост} (${п.b.персона}), расстояние ${п.d}`));
  const уник=посты.filter(p=>!плохие.has(String(p.id).slice(0,8)));
  console.log(`\nИТОГ: постов ${посты.length}, с повторами ${плохие.size}, УНИКАЛЬНЫХ ${уник.length}`);
  fs.writeFileSync('/tmp/uniq_ok.json', JSON.stringify(уник.map(p=>p.id)));
  fs.writeFileSync('/tmp/uniq_dup.json', JSON.stringify([...плохие]));
  await c.end();
})().catch(e=>{console.log('ОШИБКА '+e.message); process.exit(1);});
