// ПРИЁМ ФАЙЛА ПРОКСИ: в нашу базу и в формат магоса (08.08).
//
// ЗАЧЕМ. Начальник кидает файл от бота, и каждый раз это была ручная возня: перевести формат,
// сложить в базу, вставить в кабинет. Здесь первые два шага делаются одной командой, а третий
// (вставка в кабинет) остаётся браузеру, у магоса нет API.
//
// Формат от бота: логин:пароль@адрес:порт. Формат магоса: адрес:порт:логин:пароль.
// Проверяем ГЛАВНОЕ, на чём мы уже спотыкались: сколько строк УНИКАЛЬНЫХ. Бот при «обычной»
// сессии отдаёт один и тот же вход, повторённый N раз, и это выглядит как пачка прокси, хотя
// разделения по аккам не даёт вообще.
//
// Запуск: node proxyload.cjs <файл> [страна]      например: node proxyload.cjs ~/Downloads/p.txt RU
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const FILE = process.argv[2];
const COUNTRY = (process.argv[3] || '').toUpperCase();
const OUT = '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/magos-proxy.txt';

function toMagos(line) {
  let m = line.match(/^(.+?):(.+?)@(.+?):(\d+)$/);            // логин:пароль@адрес:порт
  if (m) return `${m[3]}:${m[4]}:${m[1]}:${m[2]}`;
  m = line.match(/^([\w.-]+):(\d+):(.+?):(.+)$/);              // уже в формате магоса
  if (m) return line;
  return null;
}
// Страну берём из метки в логине (…-cc-GB), если её не задали руками.
function countryOf(line) {
  const m = line.match(/-cc-([A-Za-z]{2})/);
  return COUNTRY || (m ? m[1].toUpperCase() : '?');
}

(async () => {
  if (!FILE || !fs.existsSync(FILE)) { console.log('usage: node proxyload.cjs <файл> [страна]'); process.exit(1); }
  const raw = fs.readFileSync(FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(raw)];
  const mag = [...new Set(uniq.map(toMagos).filter(Boolean))];
  fs.writeFileSync(OUT, mag.join('\n') + '\n');

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  // СТАТУС ПРИ ЗАЛИВКЕ (09.08, приказ начальника: «100 ру прокси заводи, остатки в расходники»).
  // По умолчанию складываем как РАСХОДНИКИ (spare): это склад, из которого потом раздаём под акки.
  // STATUS=in_magos ставится, только если прокси реально вставлены в кабинет магоса, иначе база врёт
  // про то, где прокси живёт, и мы второй раз отдаём занятый вход другому акку.
  const ST = process.env.STATUS || 'spare';
  let add = 0, was = 0;
  for (const p of uniq) {
    const r = await c.query(
      `INSERT INTO proxy_pool (proxy, country, status)
       SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM proxy_pool WHERE proxy = $1) RETURNING id`,
      [p, countryOf(p), ST]);
    r.rowCount ? add++ : was++;
  }
  // Уже лежавшие не перебиваем, если они кому-то назначены: иначе потеряем привязку акка к IP.
  await c.query(`UPDATE proxy_pool SET status=$2 WHERE proxy = ANY($1) AND assigned_slug IS NULL`, [uniq, ST]);
  await c.end().catch(() => {});

  console.log(`файл: ${path.basename(FILE)}`);
  console.log(`строк в файле: ${raw.length}, УНИКАЛЬНЫХ: ${uniq.length}${uniq.length < raw.length ? '  ← бот отдал один вход, повторённый ' + Math.round(raw.length / uniq.length) + ' раз' : ''}`);
  console.log(`страны: ${[...new Set(uniq.map(countryOf))].join(', ')}`);
  console.log(`в базу добавлено: ${add}, уже были: ${was} (статус in_magos)`);
  console.log(`для вставки в кабинет магоса готово строк: ${mag.length} → ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
