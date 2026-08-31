// Сводка по всем аккам моделей: сколько постов всего, сколько сегодня, что стоит в очереди.
// Отдельно видно, у кого сегодня НЕ было ни одного ролика — это и есть ответ на «выставлены ли
// новые видео на вчерашние акки».
const { Pool } = require('pg');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query(
    `SELECT a.persona, coalesce(a.ig_login,a.slug) h, a.is_spare, coalesce(a.ig_status,'') ig,
            to_char(a.created_at,'DD.MM') created,
            (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published') total,
            (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published'
               AND p.published_at::date = current_date) today,
            (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status IN ('approved','publishing')) queued,
            (SELECT to_char(max(p.published_at),'DD.MM HH24:MI') FROM posts p
               WHERE p.account_id=a.id AND p.status='published') last
       FROM accounts a
      WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
      ORDER BY a.persona, a.is_spare, a.created_at`);

  console.log('модель    аккаунт                заведён  всего  сегодня  в очереди  последний пост');
  let tot = 0, tod = 0, q = 0;
  for (const r of rows) {
    tot += Number(r.total); tod += Number(r.today); q += Number(r.queued);
    console.log(
      `${String(r.persona).padEnd(9)} @${String(r.h).padEnd(21)} ${String(r.created).padEnd(8)}` +
      `${String(r.total).padEnd(7)}${String(r.today).padEnd(9)}${String(r.queued).padEnd(11)}${r.last || '—'}` +
      `${r.ig === 'suspended' ? '  ⛔' : ''}`);
  }
  console.log(`\nВСЕГО: аккаунтов ${rows.length}, постов ${tot}, сегодня ${tod}, ждут очереди ${q}`);

  const idle = rows.filter((r) => Number(r.today) === 0 && Number(r.queued) === 0);
  console.log(idle.length
    ? `\nБЕЗ РОЛИКОВ СЕГОДНЯ И БЕЗ ОЧЕРЕДИ: ${idle.map((r) => '@' + r.h).join(', ')}`
    : '\nу всех аккаунтов сегодня был ролик или стоит в очереди');
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
