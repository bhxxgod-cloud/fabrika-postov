// ДНЕВНОЙ ПЛАНИРОВЩИК darya.smirnova13 (начальник 05.08: «с него постим 5 постов в день раз
// в 3 часа»). Акк с отлёжкой 12+ дней, держал 2-4 поста/день, темп 5 согласован явно.
//
// Почему демоном, а не пачкой задач: у local_jobs констрейнт «одна живая igpost-задача на акк»,
// а раннер не пересоздаёт задачи сам (дыра ретраев). Демон ставит СЛЕДУЮЩУЮ задачу, когда
// предыдущая закрылась и настал слот. Первый пост уже ушёл отдельной задачей (#211).
//
// Запуск: node kasey_daily.cjs   (фоном; лог смотрится в /tmp/kasey_daily.log)
'use strict';
const { Client } = require('pg');
const fs = require('fs');
const PG = require('./postguard.cjs');
const SLUG = 'kasey37750';
// Шаг между постами (3 часа) больше не задаётся здесь: интервал считает postguard.cjs по
// прогретости акка, чтобы у каждого источника задач не было своего представления о темпе.
// Очередь на сегодня после первого (люкс-гайд): цветотип → дождь → оценка → двойная экспозиция.
// Очередь берётся ЖИВОЙ из склада, а не списком id: жёсткий список протухал (посты уходили
// в брак/публикацию, а демон продолжал их дёргать). Берём следующий проверенный пост Дарьи.
const QUEUE_SIZE = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() {
  const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

(async () => {
  for (let round = 0; round < QUEUE_SIZE; round++) {
    // ЖДЁМ РАЗРЕШЕНИЯ ПРЕДОХРАНИТЕЛЯ (06.08). Раньше тут были свои три проверки (занятость,
    // 3 часа от последней публикации, «акк ещё live»), и они не знали ни про провалы, ни про
    // ограничения от IG — демон спокойно молотил бы по больному акку. Теперь спрашиваем postguard:
    // «темп» просто ждём, а жёсткий отказ (пауза, здоровье, серия провалов) = стоп демона.
    for (;;) {
      const c = await db();
      const v = await PG.canPost(SLUG, { client: c });
      await c.end();
      if (v.ok) break;
      if (v.hard) { console.log(new Date().toISOString(), `демон стоп: ${v.reason}`); process.exit(0); }
      await sleep(120000);
    }
    const c = await db();
    // БЕРЁМ ВСЁ, КРОМЕ ЯВНОГО БРАКА (07.08). Раньше стояло verdict='ok', и пост, проверка которого
    // не состоялась (платный vision ответил «нужна оплата», вердикт 'unknown'), становился для
    // демона невидимым: он писал «склад пуст» и выходил, а начальник видел «ничего не произошло».
    // Сбой проверки не делает пост плохим, поэтому отсеиваем только настоящий 'reject'.
    // Перед самой публикацией igpost2 всё равно проверяет картинки заново.
    const post = (await c.query(`SELECT id, status FROM posts WHERE status='backlog'
      AND meta->>'persona'='Дарья' AND coalesce(meta->'validation'->>'verdict','') <> 'reject'
      ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (!post) {
      console.log(new Date().toISOString(), 'склад Дарьи пуст — демон стоп');
      await c.end();
      return;
    }
    const pid = String(post.id).slice(0, 8);
    await c.query(`UPDATE posts SET account_id=(SELECT id FROM accounts WHERE slug=$1), status='approved', scheduled_at=now() WHERE id=$2`, [SLUG, post.id]);
    const j = await c.query(`INSERT INTO local_jobs (slug, mode, status, urls) VALUES ($1,'igpost','queued',$2) RETURNING id`, [SLUG, String(post.id)]);
    console.log(new Date().toISOString(), `поставлен ${pid} → job#${j.rows[0].id}`);
    await c.end();
    await sleep(180000); // даём раннеру подхватить
  }
  console.log(new Date().toISOString(), 'дневная очередь kasey расставлена полностью');
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
