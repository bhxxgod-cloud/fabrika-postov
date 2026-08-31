// Что реально ушло на каждый акк модели: сколько роликов, когда, с каким исходом.
// Отдельно видно, получал ли ЗАПАСНОЙ акк хоть что-то (страховка не работает, если она пустая).
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query(
    `SELECT a.persona, a.is_spare, coalesce(a.ig_login,a.slug) h,
            count(p.id) FILTER (WHERE p.status='published') pub,
            count(p.id) FILTER (WHERE p.status NOT IN ('published')) other,
            to_char(max(p.published_at),'DD.MM HH24:MI') last_pub
       FROM accounts a LEFT JOIN posts p ON p.account_id=a.id
      WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
      GROUP BY a.persona, a.is_spare, h ORDER BY a.persona, a.is_spare`);
  console.log('РОЛИКИ ПО АККАМ МОДЕЛЕЙ:');
  for (const r of rows) {
    console.log(`  ${r.persona.padEnd(8)} ${(r.is_spare ? '◇ запас  ' : '⭐ основной')} @${String(r.h).padEnd(20)}` +
      ` опубликовано=${r.pub} прочее=${r.other} последний=${r.last_pub || '—'}`);
  }
  const q = await p.query(
    `SELECT coalesce(a.ig_login,a.slug) h, p.status, left(coalesce(p.caption,''),40) cap,
            to_char(p.created_at,'DD.MM HH24:MI') created
       FROM posts p JOIN accounts a ON a.id=p.account_id
      WHERE p.kind='promo' AND p.status<>'published' ORDER BY p.created_at DESC LIMIT 10`);
  console.log('\nНЕ ОПУБЛИКОВАННЫЕ промо-посты (висят в очереди или в разборе):');
  if (!q.rows.length) console.log('  нет');
  q.rows.forEach((r) => console.log(`  @${r.h} ${r.status} ${r.created} «${r.cap}»`));
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
