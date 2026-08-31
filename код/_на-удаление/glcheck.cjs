const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const tok=(await c.query("SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1")).rows[0].gologin_token;
  const live=(await c.query("SELECT count(*)::int n FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND coalesce(session_status,'')='live'")).rows[0].n;
  const tot=(await c.query("SELECT count(*)::int n FROM accounts WHERE platform='comments' AND deleted_at IS NULL")).rows[0].n;
  await c.end();
  const t0=Date.now();
  const r=await fetch('https://api.gologin.com/browser/v2',{headers:{Authorization:'Bearer '+tok}}).catch(e=>({err:e.message}));
  if(r.err){console.log('CLOUD API: НЕДОСТУПЕН —',r.err);}
  else{const j=await r.json().catch(()=>null); console.log(`CLOUD API: HTTP ${r.status} за ${Date.now()-t0}мс, профилей в облаке: ${Array.isArray(j)?j.length:(j&&j.profiles?j.profiles.length:'?')}`);}
  console.log(`БАЗА: акков всего ${tot}, помечены live ${live}`);
})().catch(e=>console.log('FATAL',e.message));
