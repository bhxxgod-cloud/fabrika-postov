const fs=require('fs'); const { Client } = require('pg');
(async()=>{const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
await c.connect();
const r=await c.query(`SELECT count(*) n FROM posts WHERE created_at > now() - interval '10 minutes'`);
console.log(new Date().toTimeString().slice(0,5), '· за 10 мин:', r.rows[0].n, '· в час ~', r.rows[0].n*6);
await c.end();})();
