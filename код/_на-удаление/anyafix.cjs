// Аня: основной акк @anya.mirova91 отдал /accounts/suspended/ (бан) уже ПОСЛЕ вчерашней публикации.
// Правило проекта: не лечим, заменяем. Помечаем терминально, снимаем его пост из очереди, чтобы
// постер не тратил на него заходы, и делаем основным запасной @anya.frost64.
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const dead = (await c.query(
      `UPDATE accounts SET ig_status='suspended', status='paused', session_status='dead',
              health_state='restricted', health_note='/accounts/suspended/ при проверке 02.08'
        WHERE slug='elisha793845' RETURNING coalesce(ig_login,slug) h`)).rows[0];
    const cancelled = await c.query(
      `UPDATE posts SET status='cancelled', error='акк забанен (suspended) — снят до публикации'
        WHERE account_id=(SELECT id FROM accounts WHERE slug='elisha793845')
          AND status IN ('approved','publishing') AND post_submitted=false RETURNING id`);
    // запасной становится основным: уникальный индекс держит ровно один основной на персону
    await c.query(`UPDATE accounts SET is_spare=true WHERE persona='Анечка'`);
    await c.query(`UPDATE accounts SET is_spare=false WHERE slug='oscar94930'`);
    // и его пост из «запасного» слота двигаем на сейчас: модель осталась без основного акка
    const moved = await c.query(
      `UPDATE posts SET scheduled_at=now() + interval '3 minutes'
        WHERE account_id=(SELECT id FROM accounts WHERE slug='oscar94930')
          AND status='approved' AND post_submitted=false RETURNING id`);
    await c.query('COMMIT');
    console.log(`@${dead.h}: помечен suspended+paused, снято постов: ${cancelled.rowCount}`);
    console.log(`@anya.frost64 теперь ОСНОВНОЙ у Ани, его пост подвинут на «через 3 минуты»: ${moved.rowCount}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.log('ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally { c.release(); await p.end(); }
})();
