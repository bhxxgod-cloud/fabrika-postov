const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:process.env.DB_PUBLIC_URL||fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const cols=(await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='accounts' AND (column_name ILIKE '%pass%' OR column_name ILIKE '%totp%' OR column_name ILIKE '%2fa%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%mail%')`)).rows.map(r=>r.column_name);
  console.log('колонки кредов:', cols.join(', ')||'нет');
  const r=(await c.query(`SELECT coalesce(session_status,'?') st, count(*)::int n FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND gologin_profile_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('\nпо статусу сессии:'); r.forEach(x=>console.log(`  ${x.st.padEnd(8)} ${x.n}`));
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
