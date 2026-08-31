// ЕДИНЫЙ ПЛАНИРОВЩИК ПОСТИНГА ПО ВСЕЙ ФЕРМЕ (05.08, начальник: «на акках прогретые 5 постов
// в сутки, не гретые 2»).
//
// Заменяет kasey_daily.cjs, который вёл ОДИН акк по жёсткому списку постов.
// Прогретость считаем по факту: сколько НАШИХ постов акк уже опубликовал.
//   • прогретый (>= WARM_POSTS публикаций) — 5 постов в сутки, интервал >= 3ч;
//   • не гретый — 2 поста в сутки, интервал >= 6ч (свежий акк = главный кандидат на бан).
// Плюс страховки: не ставим задачу, если у акка уже есть живая (двойная сессия = мёртвый акк),
// и не постим с акка в день его оформления (кластер действий убил 4 акка 03.08).
//
// Запуск: node postdaemon.cjs   (крутится в фоне, тик раз в 10 минут)
//
// ПРЕДОХРАНИТЕЛЬ (06.08): все гейты («болен ли акк», «сколько провалов», «занят ли», «дневной
// лимит», «интервал», «кулдаун оформления») переехали в postguard.cjs и НЕ дублируются здесь.
// Раньше у каждого источника задач был свой набор проверок, поэтому cherry.mood59 и получил
// 25 заходов ночью: планировщик его пропускал по одним правилам, ручная раздача по другим.
'use strict';
const STRICT = /^(1|true|yes)$/i.test(String(process.env.PERSONA_STRICT || ''));
const fs = require('node:fs');
const { Client } = require('pg');
const PG = require('./postguard.cjs');

// СТРОКА БАЗЫ ЧЕРЕЗ ОБЩИЙ МОДУЛЬ (14.08). Прямое чтение /tmp стоило нам остановки всей фермы в
// ночь 13-14: уборка временных файлов унесла строку, а запасного пути не было. Модуль ищет её по
// цепочке окружение → ~/.neironka/secrets → /tmp и сам возвращает копию в /tmp. Разбор в dburl.cjs.
const DBURL = require('./dburl.cjs')();
// Порог прогретости (WARM_POSTS) и все лимиты темпа теперь живут в postguard.cjs — одно место.
const TICK_MS = Number(process.env.TICK_MS || 10 * 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Что мы в прошлый раз сказали про каждый акк — чтобы не повторять одно и то же каждые 10 минут.
const lastReason = new Map();

async function db() {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function tick() {
  const c = await db();
  try {
    // Берём ВСЕ неудалённые акки и спрашиваем предохранитель. Раньше фильтр «живой и login_ok»
    // стоял прямо в SQL, и из-за этого правила отбора расползались по источникам задач.
    const accs = (await c.query(`
      SELECT a.id, a.slug, coalesce(a.ig_login, a.slug) h, a.persona
        FROM accounts a
       WHERE a.deleted_at IS NULL AND (a.slug NOT LIKE 'FOL%' OR a.dressed_at IS NOT NULL)
       -- ТОЛЬКО ПРОМО-КОНТУР (07.08): акки, отданные в ферму комментов приказом начальника,
       -- продолжали получать задачи публикации, потому что раздатчики смотрели на статус и
       -- здоровье, но не на platform. Постинг живёт только в промо.
       AND a.platform = 'promo'   -- ОФОРМЛЕННЫЙ FOL постит: приказ 07.08,
           -- признак «нельзя постить» это отсутствие оформления, а не префикс слага
       ORDER BY coalesce(a.ig_login, a.slug)`)).rows;

    for (const a of accs) {
      // ЕДИНОЕ РЕШЕНИЕ. Внутри: пауза, здоровье, сессия, серия провалов, тишина 30 мин после
      // провала, занятость акка, дневной лимит с личным posts_per_day, интервал, кулдаун оформления.
      const v = await PG.canPost(a.slug, { client: c });
      if (!v.ok) {
        // В логе говорим только про то, что требует человека, и только КОГДА причина сменилась:
        // тик идёт каждые 10 минут, и 17 строк «акк забанен» на каждом проходе превращают лог
        // в стену, в которой не видно настоящих событий.
        const boring = ['session_not_live', 'ig_not_ok', 'deleted', 'no_account'].includes(v.code);
        if (v.hard && !boring && lastReason.get(a.slug) !== v.code) {
          console.log(new Date().toISOString(), v.reason);
        }
        lastReason.set(a.slug, v.code);
        continue;
      }
      lastReason.delete(a.slug);
      const { warm, limit } = v.info;

      // ДЫРА РЕТРАЕВ (закрыта 06.08): «вернул в очередь» оставлял пост approved БЕЗ queued-задачи,
      // и он висел вечно (Анечка от 04.08). Сначала доигрываем такие ретраи, потом склад.
      // ЖЁСТКИЙ КУЛДАУН РЕТРАЯ (06.08, я сам этим сжёг 25 заходов на cherry.mood59): попытка
      // возвращает пост в approved, а ретрай тут же ставил новую задачу — вечный цикл. Теперь
      // ретрай только если по этому посту НЕ было провала за последний час и попыток меньше 3.
      const retry = (await c.query(`
        SELECT p.id, p.meta->>'persona' pn, p.meta->>'template' tpl FROM posts p
         WHERE p.account_id=$1 AND p.status='approved' AND p.published_at IS NULL
           AND coalesce(p.scheduled_at, now()) <= now()
           AND coalesce(p.attempts, 0) < 3
           AND p.created_at > '2026-08-05T22:30:00Z'
           AND NOT EXISTS (SELECT 1 FROM local_jobs j WHERE j.urls=p.id::text AND j.mode='igpost'
                             AND j.status IN ('queued','running'))
           AND NOT EXISTS (SELECT 1 FROM local_jobs j WHERE j.urls=p.id::text AND j.mode='igpost'
                             AND j.updated_at > now() - interval '1 hour')
         ORDER BY p.created_at DESC LIMIT 1`, [a.id])).rows[0];
      if (retry) {
        try {
          const j = await c.query(`INSERT INTO local_jobs (slug, mode, status, urls)
            VALUES ($1,'igpost','queued',$2) RETURNING id`, [a.slug, String(retry.id)]);
          console.log(new Date().toISOString(), `${a.h} → РЕТРАЙ ${retry.pn}/${retry.tpl} job#${j.rows[0].id}`);
        } catch { console.log(new Date().toISOString(), `${a.h}: ретрай уже в работе, пропуск`); }
        continue;
      }

      // Пост: сначала «свою» модель акка, иначе любой проверенный со склада (акки мультиаккаунтные,
      // поэтому чужая модель на акке — норма).
      const post = (await c.query(`
        SELECT id, meta->>'persona' pn, meta->>'template' tpl FROM posts
         WHERE status='backlog' AND kind='promo'
           AND coalesce(meta->'validation'->>'verdict','') <> 'reject'
           -- ВЕРДИКТЫ ГЕЙТОВ СПРАШИВАЕМ ЗДЕСЬ, А НЕ ТОЛЬКО В ZIP-ПУЛЕ (ревизия 14.08).
           -- Замер: в очереди на публикацию 446 постов, из них 159 УЖЕ забракованы —
           -- 96 с qa.clean=false (card_qa увидел обрез карточки, мусорный текст,
           -- графическую кашу) и 81 с gate.ok=false (гейт кадров). Робот брал их как
           -- обычные: единственным фильтром был verdict<>'reject' выше. При этом все
           -- 92 опубликованных поста прошли МИМО card_qa — ни одной отметки.
           -- Топ причин у забракованных: ванная/метро/транспорт в кадрах 3-4 (34 поста),
           -- обложка без лица или лицо закрыто на 40% (25), обрезанная снизу карточка,
           -- исковерканные слова в подписях («dorich», «great bnown»).
           -- Вся работа card_qa и framegate защищала только ZIP-пул для магоса
           -- (magosreels.cjs:284), а собственный залив шёл вслепую.
           -- ЗАБРАКОВАННОЕ ОТСЕКАЕМ, НЕПРОВЕРЕННОЕ ПУСКАЕМ: coalesce на 'true' держит
           -- поток живым, пока card_qa не прошёл по свежим постам. Ужесточить до
           -- «только проверенные» можно будет, когда проверка встанет в конвейер.
           AND coalesce(meta->'qa'->>'clean','true') <> 'false'
           AND coalesce(meta->'gate'->>'ok','true') <> 'false'
           -- Только материал с моделью и шаблоном: посты-сироты (persona/template = null) —
           -- остатки ручных прогонов, гейт качества их всё равно рубит на публикации.
           AND meta->>'persona' IS NOT NULL AND meta->>'template' IS NOT NULL
           -- Посты до ночного стандарта 06.08 (плашка посередине, выведенные шаблоны) не постим:
           -- 06.08 ферма выгребала старьё от 04.08 первым, начальник ловил его в ТГ.
           AND created_at > '2026-08-05T22:30:00Z'
           -- ПЕРСОНА КАК ПРИОРИТЕТ, НЕ ЗАПРЕТ (07.08, новое правило начальника: «можно всех подряд
           -- постить на любой акк»). Жёсткий гейт держал 52 поста мёртвым грузом: их персоны
           -- (Дарья, Блонди, Париж, Мия, девочки) живых акков не имеют, и акки простаивали при
           -- полном складе. Своя модель по-прежнему идёт ПЕРВОЙ, чужая берётся только когда своей
           -- нет. Жёсткий режим возвращается PERSONA_STRICT=1.
           AND (meta->>'persona' = $1 OR $2::boolean = false)
         ORDER BY (meta->>'persona' = $1) DESC, created_at DESC
         LIMIT 1`, [a.persona || '', STRICT])).rows[0];
      if (!post) { console.log(new Date().toISOString(), `${a.h}: нет постов своей модели (${a.persona}) — ждёт`); continue; }
      if (!post) { console.log(new Date().toISOString(), 'склад пуст — постить нечего'); break; }

      await c.query(`UPDATE posts SET account_id=$2, status='approved', scheduled_at=now() WHERE id=$1`,
        [post.id, a.id]);
      try {
        const j = await c.query(`INSERT INTO local_jobs (slug, mode, status, urls)
          VALUES ($1,'igpost','queued',$2) RETURNING id`, [a.slug, String(post.id)]);
        console.log(new Date().toISOString(),
          `${a.h} (${warm ? 'прогрет' : 'не грет'}, ${v.info.today}/${limit} за сутки) → ${post.pn}/${post.tpl} job#${j.rows[0].id}`);
      } catch (e) {
        // Уникальный индекс на живую igpost-задачу — значит акк уже занят, откатываем привязку.
        await c.query(`UPDATE posts SET status='backlog', scheduled_at=NULL WHERE id=$1`, [post.id]);
        console.log(new Date().toISOString(), `${a.h}: задача уже есть, пропуск`);
      }
    }
  } finally { await c.end(); }
}

(async () => {
  console.log(new Date().toISOString(), `планировщик запущен: прогретые 5/сутки (шаг 3ч), не гретые 2/сутки (шаг 6ч)`);
  for (;;) {
    try { await tick(); } catch (e) { console.log('тик упал:', String(e.message).slice(0, 120)); }
    await sleep(TICK_MS);
  }
})();
