const fs=require('fs'); const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
  await c.connect();
  const code='DZQe5pIIP-C';
  const q=async(s,p)=>(await c.query(s,p)).rows;
  const duty=await q(`SELECT a.slug, coalesce(a.session_status,'-') st, coalesce(a.ig_status,'-') ig, a.gologin_profile_id IS NOT NULL pid, coalesce(a.comments_today,0) ct
    FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE g.watchdog AND a.deleted_at IS NULL ORDER BY a.slug`);
  const back=await q(`SELECT a.slug, coalesce(a.session_status,'-') st, coalesce(a.ig_status,'-') ig, a.gologin_profile_id IS NOT NULL pid, coalesce(a.comments_today,0) ct
    FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE g.backlog AND a.deleted_at IS NULL ORDER BY a.slug`);
  const free=await q(`SELECT a.slug, coalesce(a.session_status,'-') st, coalesce(a.ig_status,'-') ig, a.gologin_profile_id IS NOT NULL pid, coalesce(a.comments_today,0) ct,
      EXISTS(SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked) blk
    FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
    WHERE a.platform='comments' AND a.deleted_at IS NULL
      AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
      AND a.status NOT IN ('paused','trash')
    ORDER BY a.gologin_profile_id IS NULL, coalesce(a.comments_today,0) DESC, a.slug`,[code]);
  await c.end();
  const f=r=>`${r.slug.padEnd(20)} сессия:${String(r.st).padEnd(7)} ig:${String(r.ig).padEnd(10)} профиль:${r.pid?'есть':'НЕТ '} комм.сегодня:${r.ct}${r.blk?'  ⛔заблочен автором':''}`;
  console.log(`=== ДЕЖУРСТВО (${duty.length}) ===`); duty.forEach(r=>console.log(' '+f(r)));
  console.log(`\n=== БЭКЛОГ (${back.length}) ===`); back.forEach(r=>console.log(' '+f(r)));
  const ok=free.filter(r=>r.pid&&!r.blk);
  console.log(`\n=== СВОБОДНЫЙ ПУЛ: ${free.length}, из них с профилем и не заблочены: ${ok.length} ===`);
  ok.slice(0,25).forEach(r=>console.log(' '+f(r)));
  const nopid=free.filter(r=>!r.pid).length, blk=free.filter(r=>r.blk).length;
  console.log(`\nиз пула: без gologin-профиля ${nopid}, заблочены автором поста ${blk}`);
})().catch(e=>console.log('FATAL',e.message));
