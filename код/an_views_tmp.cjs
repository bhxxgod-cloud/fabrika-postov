'use strict';
const fs=require('node:fs'); const { Client } = require('pg');
(async()=>{
  const c=new Client({connectionString:(process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8')).trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const n=(await c.query(`SELECT count(DISTINCT meta->>'persona') p FROM posts WHERE meta->>'source_cover_url' IS NOT NULL AND status IN ('backlog','approved')`)).rows[0].p;
  console.log('уникальных чистых лиц под авы:', n);
  await c.end();
})();
