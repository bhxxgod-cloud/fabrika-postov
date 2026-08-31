// СТОРОЖ ЖИВОСТИ СЕССИЙ (07.08). Нейтрализует ложные смерти акков до деплоя правки в облако.
//
// ЧТО ПРОИСХОДИТ (установлено двумя независимыми разборами):
// 1. Облачный воркер раз в 30 минут зовёт быстрый REST-чек: GET api.gologin.com/browser/<id>/cookies
//    и ищет там куку sessionid. Но облачный профиль это ОТСТАЮЩАЯ копия: он обновляется только в
//    КОНЦЕ локальной сессии. Чек попадает в середину работы, видит старый набор и пишет dead.
//    Замер: акк luke85469 помечен мёртвым в 00:04:31, а в 00:06:42 опубликовал рилс.
// 2. В воркере стоит ратчет: переход dead → live этому чеку ЗАПРЕЩЁН, а dead ставить РАЗРЕШЕНО.
//    Асимметрия и есть баг: один и тот же недостоверный сигнал не может воскрешать, но может
//    убивать. Поэтому одна ложная смерть выключает акк навсегда.
// 3. Публикатор при session_status <> 'live' сам возвращает пост в очередь и выходит. Итог:
//    рабочий акк с живыми куками стоит вне фермы при полном складе.
//
// ЧТО ДЕЛАЕТ СТОРОЖ: возвращает в live тех, кто ДОКАЗАЛ живость, и только их.
// Доказательство одно из двух:
//   • успешная публикация за последние 45 минут (это доказательство от самого Instagram);
//   • в accounts.ig_cookies есть sessionid (длиннее 10 символов) и ds_user_id, то есть ровно то,
//     из чего работает публикатор (igpost2 подставляет куки ИЗ БАЗЫ, а не из облака).
// Никого не воскрешаем при бане, чекпоинте, требовании верификации и ограничении: там статус
// поставлен настоящим доказательством, а не REST-лампочкой.
//
// Запуск: node sessionguard.cjs           один проход
//         node sessionguard.cjs --loop    круг раз в 5 минут (пока не починим облако)
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LOOP = process.argv.includes('--loop');
const EVERY_MS = Number(process.env.GUARD_EVERY_MS || 5 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Состояния, при которых воскрешать НЕЛЬЗЯ: их ставит реальное доказательство от Instagram.
const NEVER = ['banned', 'restricted', 'needs_human_verify', 'checkpoint', 'captcha_dead'];

async function pass(c) {
  const r = await c.query(`
    UPDATE accounts a SET session_status='live',
        health_note = concat('сторож сессий: возвращён в строй (доказательство живости), ',
                             to_char(now(),'DD.MM HH24:MI'), '. ', coalesce(a.health_note,''))
     WHERE a.deleted_at IS NULL
       AND a.session_status = 'dead'
       AND coalesce(a.ig_status,'') NOT IN ('suspended','challenge','profile_lost')
       AND coalesce(a.health_state,'') <> ALL($1::text[])
       AND (
         EXISTS (SELECT 1 FROM posts p WHERE p.account_id = a.id AND p.status='published'
                   AND p.published_at > now() - interval '45 minutes')
         OR (
           EXISTS (SELECT 1 FROM jsonb_array_elements(a.ig_cookies) e
                    WHERE e->>'name'='sessionid' AND length(e->>'value') > 10)
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.ig_cookies) e
                    WHERE e->>'name'='ds_user_id')
         )
       )
    RETURNING coalesce(a.ig_login, a.slug) h`, [NEVER]);
  if (r.rowCount) console.log(`${new Date().toISOString().slice(11, 19)} вернул в строй ${r.rowCount}: ${r.rows.map((x) => x.h).join(', ')}`);
  else console.log(`${new Date().toISOString().slice(11, 19)} ложно-мёртвых нет`);
  return r.rowCount;
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  if (!LOOP) { await pass(c); await c.end(); process.exit(0); }
  console.log(`сторож сессий пошёл по кругу, шаг ${Math.round(EVERY_MS / 60000)} мин`);
  for (;;) { await pass(c).catch((e) => console.log('ошибка прохода:', e.message)); await sleep(EVERY_MS); }
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
