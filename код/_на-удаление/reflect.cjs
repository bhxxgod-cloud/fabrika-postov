const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const code='DZQe5pIIP-C';
  // 1) сколько всего ответили за всё время + по дням
  const total=(await c.query(`SELECT count(*)::int n FROM post_answered WHERE code=$1`,[code])).rows[0].n;
  const byday=(await c.query(`SELECT date_trunc('day',ts)::date d, count(*)::int n FROM post_answered WHERE code=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 5`,[code])).rows;
  // 2) за 21 июля по часам — где был темп, где простой
  const byhour=(await c.query(`SELECT extract(hour from ts)::int h, count(*)::int n FROM post_answered WHERE code=$1 AND ts::date='2026-07-21' GROUP BY 1 ORDER BY 1`,[code])).rows;
  console.log(`ВСЕГО ответов на посту: ${total}`);
  console.log('\nпо дням:'); byday.forEach(r=>console.log(`  ${String(r.d).slice(0,10)}: ${r.n}`));
  console.log('\nза 21.07 по часам (где реально постили):');
  byhour.forEach(r=>console.log(`  ${String(r.h).padStart(2)}:00  ${'█'.repeat(r.n)} ${r.n}`));
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
