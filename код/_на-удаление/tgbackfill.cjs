// БЭКФИЛЛ ЖУРНАЛА ТГ (05.08): помечаем ВСЁ, что уже улетало в чат (по любому пути), как
// отправленное по ключу post:<id>, чтобы пересылки по кругу прекратились навсегда.
// Отправленным считаем всякий пост старше 30 минут: всё это владелец уже видел.
// Запуск: node tgbackfill.cjs
'use strict';
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, 'tg_journal.json');
const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  let st;
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { try { st = JSON.parse(fs.readFileSync('/tmp/tg_counters.json', 'utf8')); } catch { st = { counters: {}, sent: {} }; } }
  const r = await c.query(`SELECT id FROM posts WHERE platform='instagram' AND kind='promo' AND created_at < now() - interval '30 minutes'`);
  let n = 0;
  for (const row of r.rows) {
    const k = `post:${row.id}`;
    // Метку пишем ОБЪЕКТОМ, а не числом 0: ноль в js ложный, и проверки вида `if (sent[k])`
    // считали помеченные посты новыми, то есть бэкфилл ничего не защищал и посты уходили
    // в группу заново (разбор пачки одинаковых карточек 06.08).
    if (st.sent[k] === undefined) { st.sent[k] = { num: 0, backfill: true, at: new Date().toISOString() }; n++; }
  }
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  console.log(`бэкфилл: помечено отправленными ${n} постов, журнал ${STATE}`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
