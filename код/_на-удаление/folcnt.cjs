const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const slugs="FOL_122,FOL_250,FOL_700,FOL_2038,FOL_124,FOL_364,FOL_823,FOL_2593,FOL_148,FOL_384,FOL_871,FOL_2740,FOL_196,FOL_462,FOL_1155,FOL_3178,FOL_561,FOL_673,FOL_42688".split(',');
  const r=(await c.query(`SELECT slug, coalesce(session_status,'-') st, CASE WHEN comments_day=current_date THEN coalesce(comments_today,0) ELSE 0 END today FROM accounts WHERE slug=ANY($1) ORDER BY slug`,[slugs])).rows;
  r.forEach(x=>console.log(`  ${x.slug.padEnd(12)} сессия:${x.st.padEnd(6)} сегодня:${x.today}`));
  console.log(`\nживых: ${r.filter(x=>x.st==='live').length} | с нагрузкой сегодня: ${r.filter(x=>x.today>0).length}`);
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
