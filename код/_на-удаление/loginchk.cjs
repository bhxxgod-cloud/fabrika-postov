const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  // Акки, которые батч/движки считают рабочими: session_status=live
  const r=(await c.query(`SELECT count(*)::int n FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND coalesce(session_status,'')='live'`)).rows[0].n;
  const bad=['troy48629','raphael224881','rafael41852','mohamed544667','FOL_384','darrell85982','elvis74754','carson54236'];
  const ok=['FOL_250','sterling32961','aryan825577','jesus673444'];
  const q=async(list)=>(await c.query(`SELECT slug, coalesce(session_status,'-') st, coalesce(ig_status,'-') ig, coalesce(comments_today,0) ct, last_commented_at FROM accounts WHERE slug=ANY($1) ORDER BY slug`,[list])).rows;
  console.log(`live по базе всего: ${r}\n`);
  console.log('=== ПАДАЛИ на reply (по факту разлогинены?) ===');
  (await q(bad)).forEach(x=>console.log(`  ${x.slug.padEnd(16)} session:${x.st.padEnd(6)} ig:${x.ig.padEnd(10)} сегодня:${x.ct} посл:${x.last_commented_at?String(x.last_commented_at).slice(4,19):'-'}`));
  console.log('\n=== РАБОТАЛИ ===');
  (await q(ok)).forEach(x=>console.log(`  ${x.slug.padEnd(16)} session:${x.st.padEnd(6)} ig:${x.ig.padEnd(10)} сегодня:${x.ct} посл:${x.last_commented_at?String(x.last_commented_at).slice(4,19):'-'}`));
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
