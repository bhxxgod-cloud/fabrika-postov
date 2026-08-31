// ЛОКАЛЬНЫЙ РАННЕР — крутится на МАКЕ, слушает задачи из панели (таблица local_jobs) и выполняет их ЛОКАЛЬНО
// (Orbita на маке, 0 облачных часов GoLogin). Панель (облако) только КЛАДЁТ задачу; исполняет этот процесс.
// Запуск на маке: DB_PUBLIC_URL=… OPENROUTER_API_KEY=… node localrunner.cjs
// Правильный запуск: через сторожа ./runnerguard.sh (он держит РОВНО ОДИН раннер и поднимает его
// при зависании). Руками пускать только для отладки.
//
// ═══ ПОЧЕМУ ОЧЕРЕДЬ ВСТАВАЛА МОЛЧА (инцидент 07.08, третий раз) ═══
// Девять задач легли в local_jobs со статусом queued, процесс был жив по ps, лог не двигался 40
// минут, очередь никто не разбирал. Помогло только ручное убийство. Причины были три, и все три
// в работе с базой:
//   1. Клиент pg создавался БЕЗ таймаутов. `await c.connect()` и `await c.query(...)` в node-pg
//      по умолчанию ждут ответа БЕСКОНЕЧНО. База на Railway рвёт соединение регулярно и часто
//      без RST: сокет остаётся полуоткрытым, ответа не будет никогда, а цикл `for(;;)` стоит на
//      этом await навсегда. Процесс жив, событий нет, лога нет. Ровно наблюдаемая картина.
//   2. Не было `keepAlive`. Без него ОС не узнаёт, что другая сторона умерла, и пункт 1 случается
//      сам собой каждый раз, когда клиент простоял открытым (например все 20 минут публикации).
//   3. Ошибку опроса глушил пустой `catch (e) { /* db busy */ }`, а на клиенте не было
//      обработчика 'error'. Первое означало «снаружи не видно причины», второе в node-pg
//      означает смерть процесса без объяснений: событие 'error' без слушателя это uncaught.
// Что сделано: единая openDb() с таймаутами и keepAlive, предохранитель guard() поверх каждой
// операции (на случай, если таймауты pg сами зависнут в TLS-рукопожатии), слушатель 'error' на
// клиенте, соединение пересоздаётся КАЖДЫЙ круг, а на время работы задачи закрывается совсем.
// Ошибки печатаются, а не глушатся. Плюс сердцебиение (ниже) и внешний сторож runnerguard.sh.
'use strict';
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const POLL = Number(process.env.POLL_SEC || 8) * 1000;
const RUNNER_ID = String(process.env.RUNNER_ID || '').trim();
const NAME = 'localrunner' + (RUNNER_ID ? '#' + RUNNER_ID : '');
// ФАЙЛ СЕРДЦЕБИЕНИЯ. Сторож судит о жизни раннера по нему, а НЕ по ps и НЕ по mtime лога:
// «процесс есть» и «лог пишется» оба врут (лог не двигается и когда работа идёт молча внутри
// публикатора). В файле лежит и время последнего УСПЕШНОГО опроса очереди: именно оно отличает
// живой простой от зависания на запросе к базе.
const BEAT_FILE = process.env.RUNNER_BEAT || (RUNNER_ID ? `/tmp/localrunner_${RUNNER_ID}.beat` : '/tmp/localrunner.beat');
const BEAT_MS = Number(process.env.BEAT_SEC || 300) * 1000;   // строка в лог раз в 5 минут
const CONNECT_MS = Number(process.env.DB_CONNECT_MS || 15000);
const QUERY_MS = Number(process.env.DB_QUERY_MS || 60000);
const JOB_MS = Number(process.env.JOB_MAX_MIN || 20) * 60000;
// Раннер можно ограничить набором режимов: RUNNER_MODES=ping,stats. Нужно для проверки конвейера
// и сторожа на безобидной задаче, не трогая публикации живых аккаунтов.
const MODES = String(process.env.RUNNER_MODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 140);
// Время в логе МЕСТНОЕ (не UTC): сторож и все loop-скрипты пишут местное через `date`, а сверять
// «лог молчит с такого-то часа» человеку приходится по своим часам.
const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 19);
// Свои строки печатаем со временем: без метки времени «лог молчит 40 минут» приходилось считать
// по mtime файла, а внутри лога вообще не было видно, когда что происходило.
const say = (msg) => console.log(`${stamp()} [${NAME}] ${msg}`);
const mins = (ts) => (ts ? ((Date.now() - ts) / 60000).toFixed(1) + ' мин назад' : 'ни разу');

// ─────────────────────────── СОСТОЯНИЕ ДЛЯ СЕРДЦЕБИЕНИЯ ───────────────────────────
const st = {
  phase: 'start',        // start | poll (опрос очереди) | idle (очередь пуста) | job (работаю) | db_error
  jobId: null, jobSlug: null, jobMode: null, jobSince: null,
  tickAt: null,          // последний УСПЕШНЫЙ опрос очереди
  polls: 0, idleTicks: 0, done: 0, dbError: null,
  startedAt: Date.now(),
};

function writeBeat() {
  const b = {
    runner: NAME, pid: process.pid, host: os.hostname(), phase: st.phase,
    job_id: st.jobId, job_slug: st.jobSlug, job_mode: st.jobMode,
    job_since: st.jobSince ? new Date(st.jobSince).toISOString() : null,
    tick_at: st.tickAt ? new Date(st.tickAt).toISOString() : null,
    beat_at: new Date().toISOString(),
    db_error: st.dbError, polls: st.polls, done: st.done,
    started_at: new Date(st.startedAt).toISOString(),
  };
  // Пишем через временный файл и rename: сторож читает файл в любой момент и не должен поймать
  // половину строки.
  try { fs.writeFileSync(BEAT_FILE + '.tmp', JSON.stringify(b)); fs.renameSync(BEAT_FILE + '.tmp', BEAT_FILE); } catch { /* */ }
}

// ─────────────────────────── БАЗА: ТАЙМАУТЫ И ПЕРЕСОЗДАНИЕ ───────────────────────────
// guard(): жёсткий предел поверх обещания. Таймауты pg закрывают connect и query, но рукопожатие
// TLS и c.end() ими не закрыты, а зависнуть можно на любом из них. Здесь нет «умного» ретрая
// нарочно: любая незакрытая операция превращается в ошибку, круг цикла заканчивается, соединение
// пересоздаётся. Молчаливого ожидания не остаётся нигде.
function guard(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`таймаут ${label}: ${ms} мс`)), ms); }),
  ]);
}
async function openDb() {
  const c = new Client({
    connectionString: DBURL,
    ssl: { rejectUnauthorized: false },
    keepAlive: true,                       // без него полуоткрытый сокет живёт вечно
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: CONNECT_MS,
    query_timeout: QUERY_MS,               // предел на стороне клиента
    statement_timeout: QUERY_MS,           // предел на стороне сервера
    idle_in_transaction_session_timeout: QUERY_MS,
  });
  // ОБЯЗАТЕЛЬНЫЙ слушатель: обрыв соединения на простаивающем клиенте это событие 'error', и без
  // слушателя node убивает процесс без внятного сообщения. Здесь мы его не глушим, а помечаем
  // клиента негодным и пишем в лог, дальше круг цикла возьмёт новое соединение.
  c.on('error', (e) => { c.__broken = short(e); say(`⚠ соединение с базой оборвалось: ${c.__broken}`); });
  await guard(c.connect(), CONNECT_MS + 5000, 'подключение к базе');
  return c;
}
const q = (c, sql, params) => guard(c.query(sql, params), QUERY_MS + 5000, 'запрос к базе');
async function shut(c) {
  if (!c) return;
  try { await guard(c.end(), 5000, 'закрытие соединения'); }
  catch { try { c.connection && c.connection.stream && c.connection.stream.destroy(); } catch { /* */ } }
}

let ensured = false;
async function ensure(c) {
  if (ensured) return;                     // раньше CREATE TABLE шёл на каждом опросе, то есть каждые 8 секунд
  await q(c, `CREATE TABLE IF NOT EXISTS local_jobs (
    id bigserial PRIMARY KEY, slug text, mode text, n int, urls text, proxy text,
    status text DEFAULT 'queued', result text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`).catch(() => {});
  ensured = true;
}

// ─────────────────────────── СЕРДЦЕБИЕНИЕ ───────────────────────────
// Раз в 5 минут: строка в лог с тем, ЧТО раннер делает, метка в файл и в таблицу runner_heartbeat
// (панель и сторож видят факт работы, а не наличие процесса). Заодно подметаем задачи, зависшие
// в статусе running от умерших процессов: reapStale живёт в предохранителе, но зовётся только из
// canPost, а если раннер лежал, canPost никто не звал и задача блокировала аккаунт вечно.
async function beatTick() {
  let human;
  if (st.phase === 'job') human = `работаю над задачей #${st.jobId} (${st.jobSlug} · ${st.jobMode}, ${((Date.now() - st.jobSince) / 60000).toFixed(1)} мин)`;
  else if (st.dbError) human = `база не отвечает: ${st.dbError}; последний успешный опрос ${mins(st.tickAt)}`;
  else human = `очередь пуста (опросов ${st.polls}, задач выполнено ${st.done}, последний опрос ${mins(st.tickAt)})`;
  say(`💓 жив: ${human}`);
  writeBeat();
  let c = null;
  try {
    c = await openDb();
    await q(c, `CREATE TABLE IF NOT EXISTS runner_heartbeat (
      runner text PRIMARY KEY, pid int, host text, phase text, job_id bigint, job_slug text,
      note text, tick_at timestamptz, beat_at timestamptz DEFAULT now(), started_at timestamptz)`);
    await q(c, `INSERT INTO runner_heartbeat (runner,pid,host,phase,job_id,job_slug,note,tick_at,beat_at,started_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)
      ON CONFLICT (runner) DO UPDATE SET pid=$2, host=$3, phase=$4, job_id=$5, job_slug=$6,
        note=$7, tick_at=$8, beat_at=now(), started_at=$9`,
      [NAME, process.pid, os.hostname(), st.phase, st.jobId, st.jobSlug, human.slice(0, 300),
        st.tickAt ? new Date(st.tickAt) : null, new Date(st.startedAt)]);
    const n = await require('./postguard.cjs').reapStale((sql, p) => q(c, sql, p)).catch(() => 0);
    if (n) say(`подметено зависших задач публикации: ${n}`);
    // reapStale в предохранителе умеет ТОЛЬКО mode='igpost' (он про публикации). Задачи остальных
    // режимов от убитого раннера висели в running навсегда и врали панели «работа идёт».
    // 45 минут это тот же порог: дочерний процесс раннер гасит на 20-й минуте, живую работу не рвём.
    const other = await q(c, `UPDATE local_jobs SET status='done', updated_at=now(),
        result=concat(coalesce(result,''), 'ИТОГ: ✗ задача зависла (раннер умер, не закрыл её) — закрыта раннером')
      WHERE mode <> 'igpost' AND status='running' AND updated_at < now() - interval '45 minutes'
      RETURNING id, mode`).catch(() => ({ rows: [] }));
    for (const j of other.rows || []) say(`подметена зависшая задача #${j.id} (${j.mode}): висела больше 45 мин`);
  } catch (e) { say(`⚠ сердцебиение в базу не записалось: ${short(e)} (метка в файле ${BEAT_FILE} всё равно свежая)`); }
  finally { await shut(c); }
}

// ─────────────────────────── ЗАПУСК ДОЧЕРНЕГО СКРИПТА ───────────────────────────
function run(cmd, args, env) {
  return new Promise((res) => {
    const p = spawn('node', [path.join(__dirname, cmd), ...args], { cwd: __dirname, env: { ...process.env, ...env, DB_PUBLIC_URL: DBURL, SHOT_DIR: process.env.SHOT_DIR || '/tmp' } });
    let buf = ''; p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); }); p.stderr.on('data', (d) => { buf += d; });
    // Убийство по таймауту раньше проходило МОЛЧА: в логе просто заканчивалась работа, и понять,
    // что публикатора обрубили на 20-й минуте, было нельзя. Теперь говорим об этом и добиваем
    // SIGKILL, если SIGTERM не подействовал (иначе процесс остаётся, а мы считаем задачу закрытой).
    const t = setTimeout(() => {
      say(`⏱ ${cmd} не уложился в ${JOB_MS / 60000} мин, гашу его`);
      try { p.kill(); } catch { /* */ }
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, 30000);
      res(buf + `\nИТОГ: ✗ таймаут ${JOB_MS / 60000} мин, ${cmd} убит раннером`);
    }, JOB_MS);
    p.on('close', () => { clearTimeout(t); res(buf); });
    p.on('error', (e) => { clearTimeout(t); say(`⚠ не смог запустить ${cmd}: ${short(e)}`); res(buf + `\nИТОГ: ✗ не запустился ${cmd}: ${short(e)}`); });
  });
}

// Аварийные исходы: раньше падение печаталось только как 'FATAL' в stderr, а если раннер пускали
// без 2>&1, не печаталось нигде, и снаружи это выглядело как «тихо встало». Теперь причина в лог
// и в метку, а процесс выходит НАРОЧНО: поднять его чисто это работа сторожа, зомби хуже смерти.
process.on('unhandledRejection', (e) => { say(`⚠ необработанный reject: ${short(e)}`); });
process.on('uncaughtException', (e) => {
  st.phase = 'crash'; st.dbError = short(e); writeBeat();
  say(`💀 упал: ${short(e)} — выхожу, сторож поднимет`);
  process.exit(1);
});
// Дочернего публикатора при выходе НАРОЧНО не убиваем. Если сторож гасит раннер, igpost2 доигрывает
// сам: он закрывает своё окно Orbita и, главное, сам пишет shortcode опубликованного поста. Убить
// его на середине значит потерять external_url уже опубликованного ролика, а это дубль в ленте.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { st.phase = 'stopped'; writeBeat(); say(`получил ${sig}, выхожу (публикатор, если работает, доигрывает сам)`); process.exit(0); });

// ─────────────────────────── ГЛАВНЫЙ ЦИКЛ ───────────────────────────
(async () => {
  say(`старт (pid ${process.pid}), опрос очереди каждые ${POLL / 1000} с, сердцебиение раз в ${BEAT_MS / 60000} мин, метка ${BEAT_FILE}${MODES.length ? `, только режимы: ${MODES.join(',')}` : ''}`);
  st.phase = 'poll'; writeBeat();
  // Сердцебиение живёт на своём таймере, а не в цикле: во время публикации цикл стоит на await
  // до 20 минут, и «раз в круг» означало бы 20 минут тишины, то есть ровно то, что мы лечим.
  const heart = setInterval(() => { beatTick().catch((e) => say(`⚠ сердцебиение упало: ${short(e)}`)); }, BEAT_MS);
  heart.unref && heart.unref();
  beatTick().catch(() => {});   // первый удар сразу: сторож не должен ждать 5 минут после старта

  for (;;) {
    let c = null, job = null;
    try {
      c = await openDb();
      await ensure(c);
      // Атомарно забираем 1 очередную задачу.
      // Берём только ту задачу, которую МОЖНО делать сейчас: пост со слотом в будущем пропускаем,
      // иначе он встаёт первым по id и держит всю очередь (03.08: рилс ждал час за постом,
      // у которого слот был позже).
      job = (await q(c, `UPDATE local_jobs SET status='running', updated_at=now()
        WHERE id = (SELECT j.id FROM local_jobs j
                     WHERE j.status='queued'
                       AND (j.mode <> 'igpost' OR NOT EXISTS (
                             SELECT 1 FROM posts p WHERE p.id::text = j.urls
                                AND p.scheduled_at IS NOT NULL AND p.scheduled_at > now()))
                       AND ($1::text[] IS NULL OR j.mode = ANY($1::text[]))
                     ORDER BY j.id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [MODES.length ? MODES : null])).rows[0] || null;
      st.tickAt = Date.now(); st.polls++;
      if (st.dbError) { say(`✅ база снова отвечает, опрос очереди пошёл`); st.dbError = null; }
    } catch (e) {
      // НЕ ГЛУШИМ. Раньше здесь стоял пустой catch с подписью «db busy», и снаружи причина
      // остановки была не видна вообще. Соединение считаем негодным и берём новое на следующем
      // круге: обрыв со стороны Railway лечится только пересозданием клиента.
      st.dbError = short(e); st.phase = 'db_error'; writeBeat();
      say(`⚠ опрос очереди не удался: ${st.dbError}; последний успешный опрос ${mins(st.tickAt)}, пересоздаю соединение`);
      await shut(c);
      await sleep(Math.min(POLL * 2, 30000));
      continue;
    }

    if (!job) {
      st.phase = 'idle'; st.idleTicks++; writeBeat();
      await shut(c);
      await sleep(POLL);
      continue;
    }

    const urls = String(job.urls || '').split(/[\s,]+/).map((s) => s.trim()).filter((u) => /instagram\.com/i.test(u)).join(',');
    const freeFlag = job.proxy === 'free' ? ['--free'] : [];

    // СЛОТ ВРЕМЕНИ. Раннер брал задачу СРАЗУ, игнорируя scheduled_at: 03.08 два поста Дарьи вышли
    // с разницей 2 минуты вместо 45. Не время, значит вернуть в очередь и не трогать до срока.
    if (job.mode === 'igpost') {
      const pid = String(job.urls || '').trim();
      let due = null;
      try {
        due = (await q(c, `SELECT (scheduled_at IS NULL OR scheduled_at <= now()) ok,
          to_char(scheduled_at,'HH24:MI') t FROM posts WHERE id=$1`, [pid])).rows[0];
      } catch (e) { say(`⚠ не смог прочитать слот поста ${pid}: ${short(e)}`); }
      if (due && !due.ok) {
        await q(c, `UPDATE local_jobs SET status='queued', updated_at=now() WHERE id=$1`, [job.id]).catch(() => {});
        // Про каждую задачу говорим ОДИН раз: опрос идёт каждые 8 секунд, и без этого лог
        // превращается в стену «рано», в которой не видно настоящих событий.
        if (!global.__toldEarly) global.__toldEarly = new Set();
        if (!global.__toldEarly.has(job.id)) {
          global.__toldEarly.add(job.id);
          say(`#${job.id} ждёт слота ${due.t} (проверяю дальше молча)`);
        }
        st.phase = 'idle'; writeBeat();
        await shut(c); await sleep(POLL); continue;
      }
    }

    // Соединение на время работы ЗАКРЫВАЕМ. Публикация идёт до 20 минут, и открытый простаивающий
    // клиент за это время гарантированно теряет связь с Railway; дальше первый же запрос по нему
    // висел вечно (см. причину 2 в шапке) или ронял процесс событием 'error'.
    await shut(c); c = null;

    st.phase = 'job'; st.jobId = job.id; st.jobSlug = job.slug; st.jobMode = job.mode; st.jobSince = Date.now(); writeBeat();
    say(`ЗАДАЧА #${job.id}: ${job.slug} · ${job.mode}${job.mode === 'comments' ? ' x' + job.n : ''} · прокси ${job.proxy} · постов ${urls.split(',').filter(Boolean).length}`);
    let out = '';
    try {
      if (job.mode === 'dress') {
        // ОФОРМЛЕНИЕ (ава + имя + био) локально. urls тут не нужны; n>1 = сколько акков подряд (батч из панели).
        const slugs = String(job.slug || '').split(',').map((x) => x.trim()).filter(Boolean); // ТОЛЬКО запятая: слаги бывают с пробелами («акк 2», «TT KZ SELF 5»)
        for (const s of slugs) out += await run('dressup.cjs', [s], { DRESS_NICK: '1', SKIP_NAME: '1' }) + '\n';
      } else if (job.mode === 'igpost') {
        // ПУБЛИКАЦИЯ РОЛИКА (промо-фабрика → постер). urls тут = id поста. v2 = iglib-дисциплина (PLAN-igposter2.md).
        // Свой job id передаём публикатору: его финальный предохранитель иначе посчитает
        // собственную running-задачу «второй живой задачей на акке» и сам себя не пустит.
        out = await run('igpost2.cjs', [job.slug, String(job.urls || '').trim()], { POSTGUARD_JOB_ID: String(job.id) });
      } else if (job.mode === 'health') {
        // ПРОВЕРКА ЗДОРОВЬЯ акка (ограничения IG) — кнопка «🩺 здоровье» в панели.
        for (const s of String(job.slug || '').split(',').map((x) => x.trim()).filter(Boolean)) out += await run('ighealth.cjs', [s], {}) + '\n';
      } else if (job.mode === 'cookies') {
        // СНЯТИЕ КУК с залогиненного профиля — кнопка «🍪 снять куки» (без этого постер акк не откроет).
        for (const s of String(job.slug || '').split(',').map((x) => x.trim()).filter(Boolean)) out += await run('igsnapcookies.cjs', [s], {}) + '\n';
      } else if (job.mode === 'stats') {
        // СБОР ПРОСМОТРОВ. Instagram отдаёт счётчики только по куке самого аккаунта, поэтому
        // цифры снимает мак: запрос с куками через прокси акка, браузер при этом не открывается.
        // slug='all' (кнопка «обновить всё») → полный обход; конкретный slug (кнопка ⟳ на строке
        // акка в таблице) → только этот акк, stats.cjs понимает персону/slug/ig_login аргументом.
        const one = String(job.slug || '').trim();
        out = await run('stats.cjs', one && one !== 'all' ? [one] : [], {});
      } else if (job.mode === 'accheck') {
        // ВНЕШНИЙ ЧЕК ПРОФИЛЯ (кнопка ⟳ на строке акка): анонимное чтение снаружи, ноль входов.
        // Обновляет ава/био/подписчиков/health в базе. --no-vision: без платной сверки лиц —
        // кнопке нужны свежие ник/био/ава, платную сверку гоняет уборщик своим расписанием.
        for (const s of String(job.slug || '').split(',').map((x) => x.trim()).filter(Boolean)) {
          out += await run('accheck.cjs', [s, '--no-vision'], {}) + '\n';
        }
      } else if (job.mode === 'prepacc') {
        // ПОДГОТОВКА АККА ПОД МОДЕЛЬ одним заходом: чистка чужих постов, своя ава, ник по имени
        // модели. Ставится в том числе сторожем сразу после того, как акк подняли из мёртвых.
        for (const s of String(job.slug || '').split(',').map((x) => x.trim()).filter(Boolean)) {
          out += await run('prepacc.cjs', [s], {}) + '\n';
        }
      } else if (job.mode === 'genposts') {
        // ЗАКАЗ ФОТОПОСТОВ на фабрике neironka.pro → склад (posts.status='backlog').
        // slug = «Персона» либо «Персона|группа» (beauty/photo/looks/all), n = сколько постов.
        const [who, grp] = String(job.slug || '').trim().split('|');
        out = await run('genposts.cjs', [who, String(job.n || 1), ...(grp ? ['--group', grp] : [])], {});
      } else if (job.mode === 'brand') {
        out = await run('brandbatch.cjs', [job.slug, urls, ...freeFlag], {});
      } else if (job.mode === 'ping') {
        // САМОПРОВЕРКА КОНВЕЙЕРА. Ничего не делает, только держит задачу n секунд и отвечает.
        // Нужна, чтобы проверять «очередь разбирается» и работу сторожа НЕ на живых аккаунтах:
        // раньше единственным способом проверить конвейер была настоящая публикация.
        const secs = Math.min(Math.max(Number(job.n || 3), 1), 300);
        say(`пинг: держу задачу ${secs} с`);
        await sleep(secs * 1000);
        out = `ИТОГ: ✅ пинг ок (${secs} с, pid ${process.pid})`;
        console.log(out);
      } else {
        // comments: гоним vcomment локально по каждому URL (N ответов + бренд), одна сессия на URL
        for (const u of urls.split(',').filter(Boolean)) {
          out += await run('vcomment.cjs', [job.slug, u, String(job.n || 3)], { GL_LOCAL: '1', BRANDTOP: '1' }) + '\n';
        }
      }
    } catch (e) { out += 'ERR ' + short(e); say(`⚠ задача #${job.id} упала внутри: ${short(e)}`); }

    const okN = (out.match(/✅/g) || []).length;
    const summary = (out.match(/ИТОГ:[^\n]*/g) || []).join(' | ') || `готово (${okN} ✅)`;
    // ЗАКРЫТИЕ ЗАДАЧИ идёт по новому соединению и с ретраями: если исход не записать, задача
    // останется в running, аккаунт будет считаться занятым, и предохранитель не пустит следующий
    // пост до подметания через 45 минут. Раньше запись шла один раз и ошибка глушилась молча.
    let closed = false;
    for (let att = 1; att <= 3 && !closed; att++) {
      let c2 = null;
      try {
        c2 = await openDb();
        await q(c2, `UPDATE local_jobs SET status='done', result=$2, updated_at=now() WHERE id=$1`, [job.id, summary.slice(0, 500)]);
        closed = true;
        // АЛЕРТ НА ПЕРВОМ ПРОВАЛЕ ПУБЛИКАЦИИ (06.08). Раньше про провал узнавали из лога через
        // полчаса, когда акк уже получил десятки заходов. Точка выбрана здесь, а не в igpost2:
        // это ЕДИНСТВЕННОЕ место, через которое проходит любой исход, включая падение публикатора
        // и его убийство по таймауту (тогда igpost2 ничего сказать уже не может).
        // noteFailure сам считает провалы за окно, снимает акк с постинга на третьем и шлёт в ТГ.
        if (job.mode === 'igpost' && !/опубликовано/.test(summary)) {
          try {
            const PG = require('./postguard.cjs');
            await PG.noteFailure({ query: (sql, p) => q(c2, sql, p), slug: job.slug, error: summary, jobId: job.id });
          } catch (e) { say(`предохранитель не отработал: ${short(e)}`); }
        }
      } catch (e) {
        say(`⚠ не смог записать исход задачи #${job.id} (попытка ${att}/3): ${short(e)}`);
        await sleep(3000 * att);
      } finally { await shut(c2); }
    }
    if (!closed) say(`⚠ задача #${job.id} осталась в running: исход записать не удалось, её подметёт предохранитель`);

    st.done++; st.phase = 'poll'; st.jobId = null; st.jobSlug = null; st.jobMode = null; st.jobSince = null; writeBeat();
    say(`#${job.id} готово: ${summary}`);
    await sleep(2000);
  }
})().catch((e) => { say(`💀 главный цикл выпал: ${short(e)}`); st.phase = 'crash'; st.dbError = short(e); writeBeat(); process.exit(1); });
