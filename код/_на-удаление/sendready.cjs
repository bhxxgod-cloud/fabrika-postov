// ОТПРАВКА ГОТОВЫХ ПОСТОВ В ТГ (06.08, «давай в тг что уже было готово»).
//
// Берём со склада всё, что собрано по стандарту (4 кадра, refit4) и ещё НЕ уходило в чат
// (дедуп по журналу tg_journal.json, ключ post:<id>), и шлём карточками с паузами:
// подряд без пауз телеграм режет флуд-лимитом, половина пачки просто не доставляется.
//
// Запуск: node sendready.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 20);
const JOURNAL = path.join(__dirname, 'tg_journal.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// СТОРОЖ (07.08). Отправка идёт с паузой 20 с на карточку, поэтому общий лимит считаем от лимита
// пачки с запасом, а «шаг не менялся 3 минуты» ловит зависшее скачивание или зависший tgsend.
const wd = armWatchdog({ minutes: Math.min(90, 5 + Math.ceil(LIMIT * 1.5)), stallMinutes: 3,
  label: `отправка готовых постов в ТГ (до ${LIMIT})` });

(async () => {
  wd.stage('читаю журнал отправок');
  let sent = {};
  try { sent = (JSON.parse(fs.readFileSync(JOURNAL, 'utf8')).sent) || {}; } catch {}

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT id, caption, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls
      FROM posts
     WHERE status='backlog' AND kind='promo'
       AND (meta->>'refit4')::bool IS TRUE
       AND jsonb_array_length(coalesce(meta->'image_urls','[]'::jsonb)) >= 3
     ORDER BY created_at DESC`)).rows;
  await c.end();

  // «Уже слали» = запись в журнале ЕСТЬ, а не «значение правдивое». Прежняя проверка на
  // правдивость роняла всю защиту на записях бэкфилла: tgbackfill пишет номер 0, а 0 в js
  // ложный, поэтому 104 уже виденных поста считались новыми и уходили в группу по кругу
  // (разбор пачки одинаковых карточек 06.08). Сам tgsend теперь тоже это переживает, но
  // отбирать заведомо отправленное здесь всё равно правильнее: меньше пустых прогонов.
  const todo = rows.filter((r) => sent[`post:${r.id}`] === undefined).slice(0, LIMIT);
  console.log(`готово по стандарту: ${rows.length}, не отправлено: ${todo.length}`);

  let ok = 0;
  for (const [n, r] of todo.entries()) {
    wd.stage(`карточка ${n + 1} из ${todo.length} (${r.pn || 'без модели'})`);
    try {
      const dir = `/tmp/tgr2_${String(r.id).slice(0, 8)}`;
      fs.mkdirSync(dir, { recursive: true });
      const files = [];
      for (const [i, u] of r.urls.entries()) {
        const f = path.join(dir, `${i + 1}.jpg`);
        // ТАЙМАУТ И ПРОВЕРКА ОТВЕТА (07.08). Здесь стоял fetch без сигнала и БЕЗ проверки r.ok:
        // при 404 в файл писалось тело ошибки, и в чат уходил «кадр» из текста ошибки, а висящий
        // запрос вешал всю пачку молча.
        if (!fs.existsSync(f)) await fetchToFile(u, f, { what: `кадр ${i + 1}`, ms: 60000, min: 5000 });
        files.push(f);
      }
      execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
        '--key', String(r.id), '--persona', r.pn || 'без модели',
        '--type', String(r.tpl || '').replace('img-', ''), '--template', r.tpl || '',
        '--note', r.caption || ''], { cwd: __dirname, encoding: 'utf8', timeout: 2 * 60000 });
      ok++;
      console.log(`  → ${r.pn}/${r.tpl}`);
    } catch (e) { console.log(`  ✗ ${r.pn}/${r.tpl}: ${String(e.stdout || e.message).slice(-70)}`); }
    wd.poke('пауза 20 с против флуд-лимита телеграма');
    await sleep(20000);
  }
  wd.done(0, `ИТОГ: отправлено ${ok} из ${todo.length}`);
})().catch((e) => wd.fail(e));
