const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=(await c.query("SELECT username, ts FROM post_answered WHERE code='DZQe5pIIP-C' ORDER BY ts DESC LIMIT 6")).rows;
  console.log('последние записи post_answered:');
  r.forEach(x=>console.log(`  @${String(x.username).padEnd(20)} ${String(x.ts).slice(0,24)}`));
  const n=(await c.query("SELECT count(*)::int n FROM post_answered WHERE code='DZQe5pIIP-C'")).rows[0].n;
  console.log(`всего: ${n} (было 94 в начале сессии)`);
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
