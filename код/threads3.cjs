'use strict';
// Три Threads-поста с интервалом 3 часа (приказ 21.08): карусель 3 фото БЕЗ CTA-слайда,
// тексты по стратегии (история → вердикт → вопрос-развилка), тема «AI Threads»,
// ссылка ТОЛЬКО авто-реплаем через 45 минут (алгоритм режет ссылки в теле поста).
// Токен: ~/.neironka/threads_token (long-lived из User Token Generator).
const fs=require('fs'), os=require('os'), path=require('path');
const { Client } = require('pg');
// Токен из БД (канал threads_neironka, auth.access_token — кладёт OAuth-колбэк постера)
let TOK='';
async function loadTok(){
  const url=fs.readFileSync(path.join(os.homedir(),'.neironka_dburl'),'utf8').trim();
  const c=new Client({connectionString:url,ssl:{rejectUnauthorized:false}}); await c.connect();
  const {rows:[r]}=await c.query(`select auth->>'access_token' t from yt_channels where slug='threads_neironka'`);
  await c.end();
  if(!r||!r.t) throw new Error('в БД нет threads-токена');
  TOK=r.t;
}
const BASE='https://graph.threads.net/v1.0';
const HOST='https://web-production-efed0.up.railway.app';
const LINK='https://neironka.pro/go/threads';
const POSTS=[
 { imgs:['p1f1.jpg','p1f2.jpg','p1f3.jpg'],
   text:`мастер по бровям три года говорила мне «вам так идёт». карта бровей по фото показала, что излом стоит не там и визуально опускает глаз. то есть я платила за то, что меня старило. проверяли когда-нибудь за своим мастером?`,
   reply:`все спрашивают, где делала разбор — вот тут, по одному селфи: ${LINK}` },
 { imgs:['p2f1.jpg','p2f2.jpg','p2f3.jpg'],
   text:`всю жизнь красилась в холодные оттенки, потому что так сказала подружка в 9 классе. разбор по фото выдал тёплую осень: терракота, горчица, карамель. первый раз лицо не выглядит уставшим. вы свой цветотип реально проверяли или на глаз?`,
   reply:`отвечаю сразу всем: разбор не сама считала, собрало вот это по обычному селфи: ${LINK}` },
 { imgs:['p3f1.jpg','p3f2.jpg','p3f3.jpg'],
   text:`сделала полный разбор по одному селфи: цветотип, брови, образы. оказалось, годами красилась не в свои цвета( кому промпт?)`,
   reply:`не буду делать вид, что тайное знание) делала тут: ${LINK}` },
];
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function api(p, params){
  const r=await fetch(`${BASE}/${p}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({...params,access_token:TOK})});
  const j=await r.json();
  if(j.error) throw new Error(p+': '+JSON.stringify(j.error).slice(0,200));
  return j;
}
async function waitReady(id){
  for(let i=0;i<30;i++){
    const r=await fetch(`${BASE}/${id}?fields=status&access_token=${TOK}`).then(x=>x.json());
    if(r.status==='FINISHED') return;
    if(r.status==='ERROR') throw new Error('container ERROR');
    await sleep(10000);
  }
  throw new Error('container не дозрел');
}
async function tg(text){
  try{ const tok=fs.readFileSync('/tmp/.tgtok','utf8').trim(), chat=fs.readFileSync('/tmp/.tgchat','utf8').trim();
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:true})}); }catch{}
}
async function postOne(p, idx){
  const children=[];
  for(const f of p.imgs){
    const c=await api('me/threads',{media_type:'IMAGE',image_url:`${HOST}/t/${f}`,is_carousel_item:'true'});
    children.push(c.id); await sleep(3000);
  }
  let params={media_type:'CAROUSEL',children:children.join(','),text:p.text,topic_tag:'AI Threads'};
  let cont;
  try{ cont=await api('me/threads',params); }
  catch(e){ console.log('topic_tag не принят, пробую без:',e.message.slice(0,120)); delete params.topic_tag; cont=await api('me/threads',params); }
  await waitReady(cont.id);
  const pub=await api('me/threads_publish',{creation_id:cont.id});
  console.log(`ПОСТ ${idx} ОПУБЛИКОВАН: ${pub.id}`);
  await tg(`тредс [Нейронка] выложен пост ${idx}/3: ${p.text.slice(0,60)}…`);
  // авто-реплай со ссылкой через 45 минут
  setTimeout(async()=>{
    try{
      const rc=await api('me/threads',{media_type:'TEXT',text:p.reply,reply_to_id:pub.id});
      await waitReady(rc.id);
      const rp=await api('me/threads_publish',{creation_id:rc.id});
      console.log(`  реплай-ссылка к посту ${idx}: ${rp.id}`);
    }catch(e){ console.log('  реплай не вышел:',e.message.slice(0,150)); }
  }, 45*60*1000);
  return pub.id;
}
(async()=>{
  await loadTok();
  for (let i=0;i<POSTS.length;i++){
    try{ await postOne(POSTS[i], i+1); }
    catch(e){ console.log(`ПОСТ ${i+1} ОШИБКА:`, e.message); await tg(`тредс: пост ${i+1} не вышел: `+e.message.slice(0,150)); }
    if(i<POSTS.length-1){ console.log('сплю 3 часа до следующего…'); await sleep(3*3600*1000); }
  }
  // держим процесс ради отложенного реплая последнего поста
  await sleep(50*60*1000);
  console.log('ВСЁ: 3 поста + реплаи');
})();
