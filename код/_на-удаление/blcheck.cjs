const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=(await c.query(`SELECT a.slug, a.last_commented_at, coalesce(a.comments_today,0) ct,
    now()-a.last_commented_at AS ago FROM accounts a JOIN account_groups g ON g.id=a.group_id
    WHERE g.backlog AND a.deleted_at IS NULL ORDER BY a.last_commented_at DESC NULLS LAST`)).rows;
  r.forEach(x=>console.log(` ${x.slug.padEnd(16)} послед.коммент: ${x.last_commented_at?String(x.last_commented_at).slice(0,19):'НИКОГДА'}  (${x.ago?String(x.ago).split('.')[0]:'-'} назад)  сегодня:${x.ct}`));
  const ans=(await c.query(`SELECT count(*)::int n, max(ts) last FROM post_answered WHERE code='DZQe5pIIP-C'`)).rows[0];
  console.log(`\n post_answered по посту: ${ans.n} записей, последняя ${ans.last?String(ans.last).slice(0,19):'-'}`);
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
