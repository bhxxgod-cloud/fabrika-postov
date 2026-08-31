// СВОДКА ПРАВДЫ (07.08, приказ начальника после двух случаев ложного прогресса: «я честно
// докладывал прогресс, которого не было»).
//
// ЗАЧЕМ. Прогресс нельзя докладывать по строкам лога и по «процесс жив»: залп печатал «готов
// девочка01» в фазе опроса, а постов было собрано ноль; пересборка финалов напечатала итог и
// висела 45 минут, потому что нода не вышла. Оба раза цифры в докладе были выдуманы из косвенных
// признаков. Здесь считаем ТОЛЬКО факты из базы, а живые процессы показываем отдельно и без чисел
// о сделанной работе.
//
// Запуск: node status.cjs
'use strict';
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (sql, p) => (await c.query(sql, p)).rows;

  const stock = await q(`
    SELECT count(*) FILTER (WHERE status='backlog') sklad,
           count(*) FILTER (WHERE status='backlog' AND coalesce(meta->>'frame4_art','')='true') novyj_standart,
           count(*) FILTER (WHERE status='approved') zaplanirovano,
           count(*) FILTER (WHERE status='rejected') brak,
           count(*) FILTER (WHERE status='ambiguous') neyasno
      FROM posts WHERE published_at IS NULL`);
  console.log('СКЛАД:', JSON.stringify(stock[0]));

  const pub = await q(`SELECT count(*) sutki FROM posts
     WHERE status='published' AND published_at > now() - interval '24 hours'`);
  const last = await q(`SELECT meta->>'persona' pn, external_url u, published_at at FROM posts
     WHERE status='published' AND external_url IS NOT NULL ORDER BY published_at DESC LIMIT 5`);
  console.log(`\nОПУБЛИКОВАНО за сутки: ${pub[0].sutki}`);
  for (const p of last) console.log(`  ${String(p.at).slice(11, 16)} ${p.pn || '—'} ${p.u}`);

  const jobs = await q(`SELECT status, count(*) n FROM local_jobs
     WHERE mode='igpost' AND created_at > now() - interval '6 hours' GROUP BY 1 ORDER BY 1`);
  console.log('\nЗАДАЧИ ПУБЛИКАЦИИ за 6ч:', jobs.map((j) => `${j.status}=${j.n}`).join(' ') || 'нет');

  const acc = await q(`SELECT coalesce(ig_login,slug) h, status, session_status ss,
       (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published'
          AND p.published_at > now() - interval '24 hours') sutki
     FROM accounts a
    WHERE deleted_at IS NULL AND persona IS NOT NULL AND persona <> ''
    ORDER BY sutki DESC, h LIMIT 10`);
  console.log('\nАККИ (постов за сутки):');
  for (const a of acc) console.log(`  ${a.h.padEnd(22)} ${a.status.padEnd(8)} ${a.ss || '—'} ${a.sutki}`);

  // Живые процессы показываем БЕЗ выводов о прогрессе: это только «запущено», не «сделано».
  let live = '';
  try {
    live = execSync("ps aux | grep -E '[n]ode (factorypost|makepost|fix4|localrunner|postdaemon|accjanitor)' | awk '{print $2, $11, $12, $13}'",
      { encoding: 'utf8' }).trim();
  } catch {}
  console.log('\nЗАПУЩЕНО (без выводов о сделанном):');
  console.log(live ? live.split('\n').map((l) => '  ' + l).join('\n') : '  ничего');

  await c.end();
  process.exit(0);   // явный выход: без него нода висит на живых сокетах, это и дало ложный прогресс
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
