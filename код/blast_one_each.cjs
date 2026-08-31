// РАЗОВАЯ РАЗДАЧА: по одному посту со склада КАЖДОМУ свободному живому акку (06.08,
// начальник: «запускай постинг, по 1 рилсу на каждый акк»). Только свежие посты стандарта.
// Запуск: node blast_one_each.cjs
//
// ПРЕДОХРАНИТЕЛЬ (06.08): раздатчик не имел НИ ОДНОЙ проверки, и cherry.mood59 намотал через него
// 42 провала за час на ограниченном акке. Теперь решение принимает postguard.cjs — тот же самый
// код, что и у планировщика, так что «ручная раздача» больше не значит «без правил».
// Сознательный обход гэпа 3 часа делается через POSTGUARD_PACING_OFF=1 (снимает ТОЛЬКО темп:
// дневной лимит и интервал; безопасность акка не снимает ничем):
//   POSTGUARD_PACING_OFF=1 node blast_one_each.cjs
'use strict';
const STRICT = /^(1|true|yes)$/i.test(String(process.env.PERSONA_STRICT || ''));
const fs = require('node:fs');
const { Client } = require('pg');
const PG = require('./postguard.cjs');
// СТРОКА БАЗЫ ЧЕРЕЗ ОБЩИЙ МОДУЛЬ (14.08). Прямое чтение /tmp стоило нам остановки всей фермы в
// ночь 13-14: уборка временных файлов унесла строку, а запасного пути не было. Модуль ищет её по
// цепочке окружение → ~/.neironka/secrets → /tmp и сам возвращает копию в /tmp. Разбор в dburl.cjs.
const DBURL = require('./dburl.cjs')();
// АДРЕСНАЯ РАЗДАЧА (07.08): `node blast_one_each.cjs <slug> [<slug>…]` — только этим аккам.
// ЗАЧЕМ. POSTGUARD_PACING_OFF=1 снимает темп СРАЗУ У ВСЕЙ фермы, и это тупой инструмент: 07.08
// нужно было добить один холодный акк на его 2/2, а тот же флаг выдал бы bryan436344 седьмой пост
// при норме 5 — ровно тот перебор, за который 06.08 IG выписал ограничение лучшему акку. Теперь
// обход темпа можно навести на конкретные акки, а норму остальных не ломать. Без аргументов — как раньше.
const ONLY = process.argv.slice(2).filter((x) => !x.startsWith('-'));

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const accs = (await c.query(`
    SELECT a.id, a.slug, coalesce(a.ig_login, a.slug) h, a.persona
      FROM accounts a
     WHERE a.deleted_at IS NULL AND (a.slug NOT LIKE 'FOL%' OR a.dressed_at IS NOT NULL)
       -- ТОЛЬКО ПРОМО-КОНТУР (07.08): акки, отданные в ферму комментов приказом начальника,
       -- продолжали получать задачи публикации, потому что раздатчики смотрели на статус и
       -- здоровье, но не на platform. Постинг живёт только в промо.
       AND a.platform = 'promo'   -- ОФОРМЛЕННЫЙ FOL постит: приказ 07.08,
           -- признак «нельзя постить» это отсутствие оформления, а не префикс слага
       AND ($1::text[] IS NULL OR a.slug = ANY($1) OR a.ig_login = ANY($1))
     ORDER BY coalesce(a.ig_login, a.slug)`, [ONLY.length ? ONLY : null])).rows;
  if (ONLY.length) console.log(`АДРЕСНО: ${accs.map((a) => a.h).join(', ') || '(никто не подошёл)'}`);
  let given = 0;
  for (const a of accs) {
    const v = await PG.canPost(a.slug, { client: c });
    if (!v.ok) { console.log(`⛔ ${v.reason}`); continue; }
    const post = (await c.query(`
      SELECT id, meta->>'persona' pn, meta->>'template' tpl FROM posts
       WHERE status='backlog' AND kind='promo'
         AND coalesce(meta->'validation'->>'verdict','') <> 'reject'
         -- Те же два вердикта, что и в postdaemon (ревизия 14.08): без них залив брал
         -- посты, уже забракованные card_qa и гейтом кадров. Забракованное отсекаем,
         -- непроверенное пускаем — coalesce на 'true' держит поток живым.
         AND coalesce(meta->'qa'->>'clean','true') <> 'false'
         AND coalesce(meta->'gate'->>'ok','true') <> 'false'
         AND meta->>'persona' IS NOT NULL AND created_at > '2026-08-05T22:30:00Z'
         -- ПЕРСОНА КАК ПРИОРИТЕТ (07.08, правило начальника «можно всех подряд на любой акк»):
         -- своя модель первой, чужая только если своей на складе нет. PERSONA_STRICT=1 вернёт запрет.
         AND (meta->>'persona' = $1 OR $2::boolean = false)
       ORDER BY (meta->>'persona' = $1) DESC, created_at DESC LIMIT 1`, [a.persona || '', STRICT])).rows[0];
    if (!post) { console.log(`${a.h}: нет постов своей модели (${a.persona}) — пропуск`); continue; }
    await c.query(`UPDATE posts SET account_id=$2, status='approved', scheduled_at=now() WHERE id=$1`, [post.id, a.id]);
    try {
      const j = await c.query(`INSERT INTO local_jobs (slug, mode, status, urls)
        VALUES ($1,'igpost','queued',$2) RETURNING id`, [a.slug, String(post.id)]);
      console.log(`→ ${a.h}: ${post.pn}/${post.tpl} job#${j.rows[0].id}`);
      given++;
    } catch (e) {
      await c.query(`UPDATE posts SET status='backlog', scheduled_at=NULL WHERE id=$1`, [post.id]);
      console.log(`${a.h}: задача не встала: ${String(e.message).slice(0, 50)}`);
    }
  }
  console.log(`РАЗДАНО: ${given}`);
  await c.end();
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
