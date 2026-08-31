// Свободный пул под новые модели: акки без персоны, живые, с куками.
// Печатает slug'и (для прогона проверки здоровья) плюс историю комментинга по slug —
// урок 01.08: горят рабочие лошади фермы, а не «свежие» акки, поэтому донор с большим
// числом прогонов под модель не годится, даже если сегодня он чист.
const { Pool } = require('pg');
const fs = require('fs');
const ONLY_SLUGS = process.argv.includes('--slugs');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.health_state, a.health_checked_at,
            (SELECT count(*) FROM account_run_stats s WHERE s.slug=a.slug) runs,
            (SELECT count(*) FROM post_answered pa WHERE pa.username=lower(coalesce(a.ig_login,a.slug))) comments
       FROM accounts a
      WHERE a.deleted_at IS NULL AND (a.persona IS NULL OR a.persona='')
        AND coalesce(a.ig_role,'')<>'reader' AND a.platform='comments'
        AND coalesce(a.session_status,'')='live' AND coalesce(a.ig_cookies::text,'')<>''
        AND coalesce(a.status,'')<>'paused'
        AND NOT (coalesce(a.ig_status,'') = ANY (ARRAY['restricted','suspended','captcha','challenge']))
      ORDER BY (SELECT count(*) FROM account_run_stats s WHERE s.slug=a.slug), a.created_at DESC`);

  if (ONLY_SLUGS) { console.log(rows.filter((r) => r.pid).map((r) => r.slug).join('\n')); await p.end(); return; }

  console.log(`СВОБОДНЫХ ЖИВЫХ С КУКАМИ: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.slug.padEnd(22)} @${String(r.h).padEnd(32)} профиль=${r.pid ? 'есть' : 'НЕТ'}` +
      ` прогонов=${r.runs} комментов=${r.comments}` +
      ` здоровье=${r.health_state || 'не проверено'}`);
  }
  const noProfile = rows.filter((r) => !r.pid);
  if (noProfile.length) console.log(`\n⚠ без профиля GoLogin (зайти нельзя): ${noProfile.map((r) => r.slug).join(', ')}`);
  fs.writeFileSync('/tmp/freepool.txt', rows.filter((r) => r.pid).map((r) => r.slug).join('\n'));
  console.log(`\nсписок для проверки: /tmp/freepool.txt (${rows.filter((r) => r.pid).length} шт)`);
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
