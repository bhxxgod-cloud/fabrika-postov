// ПАЧКА ОФОРМЛЕНИЯ: всем не-FOL аккам ставим GoLogin-прокси и гоним dressup (АВА + НИК; имя не трогаем —
// лимит IG 2 смены/14 дней). Локально, по одному окну Orbita за раз (CONC), чтоб не ловить лок за суету.
const {Client}=require('pg');const {spawn}=require('child_process');const fs=require('fs');const path=require('path');
const DBURL=process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim();
const CONC=Number(process.env.CONC||2), LIMIT=Number(process.env.LIMIT||50);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function run(slug){
 return new Promise(res=>{
  const out=fs.openSync(`/tmp/db_${slug.replace(/\W/g,'_')}.txt`,'w');
  const p=spawn('node',[path.join(__dirname,'dressup.cjs'),slug],{cwd:__dirname,
   env:{...process.env,DB_PUBLIC_URL:DBURL,SHOT_DIR:'/tmp',DRESS_NICK:'1',SKIP_NAME:'1'},stdio:['ignore',out,out]});
  const t=setTimeout(()=>{try{p.kill();}catch{}res('timeout');},7*60000);
  p.on('close',()=>{clearTimeout(t);fs.closeSync(out);res('done');});
 });
}
(async()=>{
 const c=new Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});await c.connect();
 const rows=(await c.query(`SELECT a.slug, a.gologin_profile_id pid, g.gologin_token tok, coalesce(a.ig_login,a.slug) h
   FROM accounts a JOIN account_groups g ON g.id=a.group_id
   WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
     AND a.slug NOT LIKE 'FOL%' AND coalesce(a.ig_status,'') NOT IN ('owner_posting','challenge','suspended')
     AND a.dressed_at IS NULL
   ORDER BY (a.session_status='live') DESC, a.slug LIMIT $1`,[LIMIT])).rows;
 console.log(`[пачка] к оформлению: ${rows.length} акков (FOL исключены), окон разом: ${CONC}`);
 // ставим GoLogin-прокси всем заранее (ClickIP мёртв)
 for(const a of rows){
  try{await fetch(`https://api.gologin.com/browser/${a.pid}/proxy`,{method:'PATCH',headers:{Authorization:'Bearer '+a.tok,'Content-Type':'application/json'},body:JSON.stringify({mode:'gologin',autoProxyRegion:'us'}),signal:AbortSignal.timeout(15000)});
   await c.query(`UPDATE accounts SET ig_proxy=NULL, proxy_status='gologin_free' WHERE slug=$1`,[a.slug]);
  }catch{}
  await sleep(150);
 }
 console.log('[пачка] прокси проставлены, начинаю оформление');
 await c.end();
 let i=0,ok=0,fail=0;
 async function worker(w){
  while(i<rows.length){
   const k=i++;const s=rows[k].slug;
   console.log(`[окно${w}] ${k+1}/${rows.length} ${s} (@${rows[k].h})`);
   await run(s);
   const log=fs.readFileSync(`/tmp/db_${s.replace(/\W/g,'_')}.txt`,'utf8');
   const nick=(log.match(/НИК сменён: @\S+ → @(\S+)/)||[])[1];
   const ava=/ава загружена/.test(log);
   if(nick||ava){ok++;console.log(`   ✅ ${s}: ${ava?'ава':''}${nick?' ник→@'+nick:''}`);}
   else{fail++;const why=(log.match(/СКИП[^\n]*|⚠[^\n]*|ОШИБКА[^\n]*/)||['?'])[0];console.log(`   ✗ ${s}: ${why.slice(0,70)}`);}
   await sleep(4000);
  }
 }
 await Promise.all(Array.from({length:CONC},(_,w)=>worker(w+1)));
 console.log(`\n[пачка] ИТОГ: оформлено ${ok}, не вышло ${fail}`);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
