'use strict';
// ПРОВЕРКА РАСПИСАНИЯ: НЕТ ЛИ ДВУХ ПУБЛИКАЦИЙ СЛИШКОМ БЛИЗКО (26.08.2026).
//
// ЗАЧЕМ. Минуту публикации внутри часа мы подбираем хешем от имени канала. Хеш даёт разброс, но
// НИЧЕГО НЕ ГАРАНТИРУЕТ: у двух каналов минуты уже совпали (обоим выпало :05), спасло только то,
// что часы у них разные. Ветка фермы телефонов наступила на это же и вывела правило: надёжен не
// хеш, а проверка ПОСЛЕ него. Плюс её же урок: мерить надо на выборке, где эффект может
// проявиться. Один день для расписания не выборка, оно повторяется сутками.
//
// ЧТО СЧИТАЕМ. Разворачиваем расписание всех включённых каналов в сутки и смотрим минимальный
// разрыв между соседними публикациями РАЗНЫХ каналов. Тесная пара это две «независимые» площадки,
// выложившие ролик почти одновременно, то есть ровно та подпись сети, за которую нас накрыло.
//
// Запуск: node расписание.cjs [минимальный_разрыв_минут]   по умолчанию 15
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const МИН = Number(process.argv[2] || 15);

function сдвигМинут(slug) {
  let h = 2166136261;
  for (const ch of String(slug || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 4 + (h % 52);
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query("SELECT slug, title, post_hours, post_minute FROM yt_channels WHERE platform='youtube' AND enabled AND title IS NOT NULL ORDER BY id");
  await c.end();

  const точки = [];
  for (const ch of rows) {
    // Минута из поля канала, если задана: её раскладывает разложить-часы.cjs. Хеш остаётся
    // запасным путём для каналов, которым раскладку ещё не делали.
    const м = Number.isFinite(Number(ch.post_minute)) && ch.post_minute !== null ? Number(ch.post_minute) : сдвигМинут(ch.slug);
    for (const h of String(ch.post_hours || '').split(/[,\s]+/).filter(Boolean).map(Number)) {
      if (!Number.isFinite(h) || h < 0 || h > 23) continue;
      точки.push({ канал: ch.title, slug: ch.slug, мин: h * 60 + м, время: String(h).padStart(2, '0') + ':' + String(м).padStart(2, '0') });
    }
  }
  точки.sort((a, b) => a.мин - b.мин);
  if (точки.length < 2) { console.log('в расписании меньше двух публикаций, сверять нечего'); return; }

  const тесные = [];
  for (let i = 1; i < точки.length; i++) {
    const d = точки[i].мин - точки[i - 1].мин;
    if (d < МИН && точки[i].slug !== точки[i - 1].slug) тесные.push({ разрыв: d, a: точки[i - 1], b: точки[i] });
  }
  // сутки замкнуты: последняя публикация дня и первая следующего тоже соседи
  const через = (1440 - точки[точки.length - 1].мин) + точки[0].мин;
  if (через < МИН && точки[0].slug !== точки[точки.length - 1].slug) тесные.push({ разрыв: через, a: точки[точки.length - 1], b: точки[0] });

  console.log('публикаций в сутки: ' + точки.length + ', каналов: ' + rows.length + ', порог ' + МИН + ' мин\n');
  console.log('расписание: ' + точки.map((t) => t.время).join('  ') + '\n');
  const разрывы = точки.slice(1).map((t, i) => t.мин - точки[i].мин);
  console.log('минимальный разрыв: ' + Math.min(...разрывы) + ' мин, средний: ' + Math.round(разрывы.reduce((a, b) => a + b, 0) / разрывы.length) + ' мин');
  if (!тесные.length) console.log('\nтесных пар нет, расписание разведено');
  else {
    console.log('\nТЕСНЫЕ ПАРЫ (' + тесные.length + '):');
    for (const t of тесные) console.log('  ' + t.разрыв + ' мин: ' + t.a.время + ' ' + t.a.канал + '  →  ' + t.b.время + ' ' + t.b.канал);
    console.log('\nчинить: развести post_hours у этих каналов, минута берётся хешем и её не подкрутить');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
