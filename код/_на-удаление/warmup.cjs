// ПРОГРЕВ МОДЕЛЬНОГО АККА — один акк за запуск, локальная Orbita, действия ровно того дня,
// который у акка сегодня по календарю прогрева.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ (03.08). За два дня потеряно 7 аккаунтов, и два из них умерли, НЕ
// опубликовав ни одного поста. Значит дело не в объёме постинга. Разбор показал другое: акк
// покупается, в тот же час на нём меняется ава, чистятся чужие посты, меняется ник и сразу летит
// первый рилс. Для Instagram это ровно тот профиль поведения, который он ищет у угнанных
// аккаунтов: смена всех идентификационных признаков + немедленная публикация, и ни одного
// потребительского действия между ними. Живой человек так не делает НИКОГДА — он сначала листает
// ленту, смотрит сторис, кому-то ставит лайк, и только потом что-то публикует.
//
// Прогрев здесь — не «накрутка активности», а достройка недостающей половины поведения: аккаунт
// должен ПОТРЕБЛЯТЬ контент раньше, чем начнёт его производить, и продолжать потреблять в дни,
// когда постов нет. Аккаунт, который просыпается только чтобы опубликовать, имеет соотношение
// «публикации / просмотры» = бесконечность; у живого человека оно порядка 1 к сотням. Это самый
// дешёвый машинный признак бота из всех, что есть у площадки, и его не лечит никакая антидетект-
// подмена отпечатка: отпечаток врёт про устройство, а поведение врать не умеет.
//
// ЧЕТЫРЕ ПРАВИЛА, ИЗ КОТОРЫХ ВЫВЕДЕНО ВСЁ ОСТАЛЬНОЕ:
//
//   1. Первые трое суток — НОЛЬ письменных действий. Ни лайка, ни подписки, ни коммента.
//      Только просмотр. Так говорят 4 из 6 разобранных источников (conbersa: «дни 1-3 чистое
//      потребление, ноль вовлечения»; buyagedinstagramaccount, правило 24 часов для КУПЛЕННЫХ
//      акков: первые сутки — один вход и 10-15 минут листания, и ничего больше; BHW-схема: дни
//      1-4 только просмотр сторис; shadowphone: дни 2-7 только просмотр по 5-15 минут).
//
//   2. ОДИН тип действия за сессию, и новый тип — не раньше чем через сутки после предыдущего.
//      Это главная находка разбора причин блокировок (multilogin, 07.2026): «автоматизация обычно
//      совмещает лайки с подписками, комментариями и личными сообщениями в одной сессии, создавая
//      многосигнальный паттерн, который система ловит надёжнее, чем любое отдельное превышение».
//      То есть смешение типов ловится ЛУЧШЕ, чем тройное превышение по одному типу. Ровно то, на
//      чём мы и горели: чистка + ава + ник + пост в одну минуту — это четыре разных типа подряд.
//      Поэтому в календаре ниже у каждого дня ОДИН «фокус»: день лайков, день подписок, день
//      отдыха. Смешанных дней нет.
//
//   3. Между любыми двумя письменными действиями — не меньше 30-50 секунд на молодом акке.
//      Нижняя граница из источников: 30-50 сек первые 4 недели (boostfluence), 36-48 сек первые
//      12-20 дней (elfsight). Скорость ловится отдельно от объёма: «пробей 100 отписок за десять
//      минут, и тебя заблокирует раньше, чем ты закончишь, даже если суточный итог сильно ниже
//      лимита» (unfollr). Ровный интервал опасен сам по себе — паузы случайные.
//
//   4. Лимиты считаем по ФАКТУ из account_events, а не по вере в то, что скрипт отработал как
//      задумано. Каждое действие пишется отдельной строкой ПОСЛЕ положительного подтверждения,
//      что оно прошло. Живой пример цены этого правила лежит рядом: followbeauty.cjs пишет
//      detail строкой в jsonb-колонку, вставка молча падает в .catch, и в базе НОЛЬ событий
//      'follow' — то есть его суточный лимит 15 и дедуп «на кого уже подписаны» не работали
//      никогда. Скрипт считал, что считает.
//
// ЗАПАС ПО ЛИМИТАМ. Публичных лимитов у Instagram нет (публикуется ровно один: 7500 подписок
// всего). Всё остальное — оценки практиков, и они расходятся в 3-5 раз: подписки для нового акка
// от 20-30/сут (BHW, тулинг-вендоры, которые сами едят баны) до 100/сут (маркетинговые блоги).
// Мы берём НИЖНИЙ кластер и уходим ещё вдвое ниже. Причина простая: мы уже теряем акки, значит
// наши оценки риска систематически оптимистичны. Стоимость лишнего лайка нулевая, стоимость
// сгоревшего акка — неделя работы. Потолок в этом скрипте не должен срабатывать никогда; если
// сработал — что-то сломалось.
//
// Запуск:
//   node warmup.cjs <slug>            — отработать сегодняшний день прогрева
//   node warmup.cjs <slug> --check    — вердикт «прогрет / сырой», браузер НЕ открывается
//   node warmup.cjs <slug> --plan     — показать план дня и бюджеты, браузер НЕ открывается
// Флаги: --force (игнорировать «сегодня уже грелись»), WARMUP_NIGHT=1 (разрешить ночь).
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');

const SLUG = process.argv[2];
const CHECK_ONLY = process.argv.includes('--check');
const PLAN_ONLY = process.argv.includes('--plan');
const FORCE = process.argv.includes('--force');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

const sleep = L.sleep;
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const span = (s) => (Array.isArray(s) ? rnd(s[0], s[1]) : (s || 0));
const FEED = 'https://www.instagram.com/?hl=en';

// ── КАЛЕНДАРЬ ПРОГРЕВА ──────────────────────────────────────────────────────
// День 1 = сутки, когда акк оформили (dressed_at). Считаем от dressed_at, а не от created_at:
// акки покупные, дата настоящей регистрации нам неизвестна и к нашему поведению отношения не
// имеет. Для площадки акк «новый» с того момента, как на нём сменились ава, ник и устройство —
// то есть с нашего оформления. Окно повышенного внимания к новому акку: 2-4 недели.
//
// focus — единственный письменный тип действия дня (см. правило 2). Всё остальное в этот день = 0.
//   'none'    — пассив: лента, сторис, чужие профили, explore. Ноль письменных действий.
//   'like'    — лайки (и сохранения: сохранение невидимо посторонним и по сути тот же лайк,
//               но сильнее как сигнал интереса, поэтому идёт в один день с лайками, а не отдельно).
//   'follow'  — подписки.
//   'rest'    — день отдыха: короткая сессия, ноль письменных. Взято из BHW-схемы, где дни 10-11
//               это полный отдых посреди набора подписок. Смысл: у живого человека бывают дни,
//               когда он просто полистал и закрыл. У бота таких дней не бывает никогда.
//
// feedMin — сколько МИНУТ листать ленту (не «сколько экранов»: время это то, что видит площадка).
//           Ориентир источников для молодого акка: 10-15 минут пассива в сутки, у conbersa 15-30.
// stories — сколько сторис досмотреть. В BHW-схеме первые четверо суток держатся ИМЕННО на
//           просмотре сторис, 10-15 в день. Оговорка честности: утверждение «сторис весят в
//           доверии больше ленты» первичными данными не подтверждено, это сходящаяся практика
//           нескольких независимых практиков, а не измерение. Но риск нулевой, поэтому берём.
const DAYS = [
  // День 1: оформление (ава + чистка чужих постов) руками prepacc. Прогрев НЕ запускается вовсе:
  // окно Orbita в эти сутки уже открывалось, второе окно = та самая плотность, от которой лечимся.
  { day: 1, focus: 'skip', note: 'день оформления — окно уже открывал prepacc, второй раз не лезем' },
  // Дни 2-3: чистое потребление. В эти же сутки prepacc вторым заходом меняет ник — поэтому
  // письменных действий тут нет в принципе: правка профиля + активность в один день это и есть
  // картинка перехваченного аккаунта.
  { day: 2, focus: 'none', feedMin: [8, 13], stories: [8, 14], visits: [1, 3], explore: [0, 1],
    note: 'день смены ника — только смотрим, ничего не жмём' },
  { day: 3, focus: 'none', feedMin: [10, 15], stories: [8, 15], visits: [2, 4], explore: [1, 2],
    note: 'третьи сутки пассива — акк набирает историю просмотров' },
  // День 4: первое письменное действие в жизни акка. Только лайки, 5-10 (нижняя граница
  // источников для дней 4-7: conbersa «лайкать 1 пост из 10-15 пролистанных», shadowphone
  // «дни 8-14 всего 5-10 лайков»). Ничего, кроме лайков, в этот день не делается.
  { day: 4, focus: 'like', feedMin: [10, 15], stories: [8, 14], visits: [1, 3], explore: [1, 2], likes: [4, 7], saves: [0, 1],
    note: 'вводим лайки — единственный новый тип за сутки' },
  { day: 5, focus: 'like', feedMin: [10, 16], stories: [8, 15], visits: [2, 4], explore: [1, 2], likes: [5, 9], saves: [0, 2],
    note: 'закрепляем лайки — новый тип должен отстояться сутки в одиночку' },
  // День 6: подписки. Лайков в этот день НЕТ — не смешиваем типы в одной сессии.
  // 0-3 подписки в сутки: нижняя граница из conbersa (дни 4-6: 1-3/сут).
  { day: 6, focus: 'follow', feedMin: [8, 14], stories: [6, 12], visits: [2, 4], explore: [1, 2], follows: [2, 3],
    note: 'вводим подписки — в этот день ни одного лайка' },
  // День 7: ПЕРВЫЙ ПОСТ. Раньше седьмого дня не публикуем ни при каких условиях: consensus
  // источников по первой публикации — день 7-10 (conbersa), не раньше дня 6 (multilogin),
  // 5-7 дней (ssemble). «Публикация нескольких роликов в день заведения аккаунта — один из
  // сильнейших спам-сигналов, какие есть» (ssemble). Сам пост — уже событие дня, поэтому
  // письменный фокус дня мягкий: лайки, и не больше.
  { day: 7, focus: 'like', feedMin: [10, 16], stories: [8, 14], visits: [2, 4], explore: [1, 3], likes: [5, 9], saves: [1, 2],
    post: true, note: 'ПЕРВЫЙ ПОСТ разрешён (если сошлись признаки готовности, см. --check)' },
  { day: 8, focus: 'follow', feedMin: [8, 14], stories: [6, 12], visits: [3, 5], explore: [1, 2], follows: [3, 4], post: true, note: '' },
  { day: 9, focus: 'like', feedMin: [10, 16], stories: [6, 12], visits: [2, 4], explore: [1, 3], likes: [7, 11], saves: [1, 2], post: true, note: '' },
  // Дни 10-11: ОТДЫХ. Прямо из BHW-схемы. Постить в эти дни можно — отдыхает прогрев, а не акк.
  { day: 10, focus: 'rest', feedMin: [4, 8], stories: [4, 8], visits: [0, 2], explore: [0, 1], post: true,
    note: 'день отдыха — только полистать; у живого человека такие дни бывают, у бота нет' },
  { day: 11, focus: 'rest', feedMin: [4, 8], stories: [4, 8], visits: [0, 2], explore: [0, 1], post: true, note: 'второй день отдыха' },
  { day: 12, focus: 'follow', feedMin: [8, 14], stories: [6, 12], visits: [3, 6], explore: [1, 2], follows: [4, 6], post: true, note: '' },
  { day: 13, focus: 'like', feedMin: [10, 16], stories: [6, 12], visits: [2, 4], explore: [1, 3], likes: [8, 13], saves: [1, 3], post: true, note: '' },
  { day: 14, focus: 'follow', feedMin: [8, 14], stories: [6, 12], visits: [3, 6], explore: [1, 3], follows: [4, 6], post: true,
    note: 'конец базового прогрева — дальше поддерживающий режим' },
];

// РЕЖИМ ВЗРОСЛОГО АККА (день 15 и дальше). Специально НЕ растёт: цель прогрева не «раскачать акк
// до потолка», а перестать выглядеть машиной. Даже прогретый акк держим втрое ниже нижней оценки
// стабильного потолка (20-30 подписок и 70-90 лайков в сутки).
// Фокус чередуется по номеру дня, чтобы типы не смешивались и здесь: каждый седьмой день отдых,
// чётные — лайки, нечётные — подписки.
function adultPlan(day) {
  if (day % 7 === 0) {
    return { day, focus: 'rest', feedMin: [4, 9], stories: [4, 9], visits: [0, 2], explore: [0, 1], post: true,
      note: 'поддерживающий режим: день отдыха' };
  }
  if (day % 2 === 0) {
    return { day, focus: 'like', feedMin: [8, 15], stories: [5, 12], visits: [2, 4], explore: [1, 3], likes: [7, 12], saves: [1, 3], post: true,
      note: 'поддерживающий режим: день лайков' };
  }
  return { day, focus: 'follow', feedMin: [7, 13], stories: [5, 10], visits: [3, 6], explore: [1, 2], follows: [3, 6], post: true,
    note: 'поддерживающий режим: день подписок' };
}

// ПАУЗА МЕЖДУ ПИСЬМЕННЫМИ ДЕЙСТВИЯМИ, миллисекунды. Нижняя граница источников для акка первых
// недель — 30-50 сек; мы держим 40-90 и снижаем только у взрослых акков. Пауза случайная:
// «идеально ровный, машинный ритм» назван триггером сам по себе, отдельно от объёма.
const gapWrite = (day) => (day < 8 ? rnd(45000, 100000) : day < 15 ? rnd(35000, 80000) : rnd(28000, 65000));
// Почасовой предохранитель. Для нового акка практики называют 5-25 действий в час суммарно.
// В нормальной работе не срабатывает (дневной бюджет меньше часового потолка) — он нужен на
// случай наложения сессий или параллельного запуска followbeauty.
const HOURLY_CAP = Number(process.env.WARMUP_HOURLY_CAP || 10);

// Кого подписываем. Список ЗЕРКАЛИТ followbeauty.cjs — держать синхронно руками; свести в один
// модуль стоит, но не ценой правки чужого рабочего скрипта в этой задаче.
// Подписка — единственное действие прогрева, которое видно посторонним и остаётся на профиле
// навсегда. Случайных аккаунтов тут быть не должно: список правится только руками.
const FOLLOW_TARGETS = [
  'thevoicemag_ru', 'cosmopolitan_russia', 'elleru', 'grazia_russia', 'glamour_russia',
  'peopletalkru', 'thesymbol.ru', 'beautyhack.ru', 'flacon_magazine',
  'gerasimovabeauty', 'anna_lunegova', 'makeup_gubkina', 'olga_kalinina_makeup',
  'beauty.blogger.ru', 'krasota_bez_zhertv', 'skincare.ru.official',
  'letoile_official', 'goldapple_ru', 'rivegauche_official', 'podrygka_official',
  'natura_siberica', 'librederm', 'artcosmetics_ru',
];
// Теги для explore. Смысл не в действиях, а в интерес-профиле: по просмотрам алгоритм решает,
// кому показывать наши рилсы. Акк модели, который смотрит бьюти, потом получает бьюти-охват.
const EXPLORE_TAGS = ['красота', 'макияж', 'уходзалицом', 'бьюти', 'нейросети', 'стиль', 'маникюр', 'прическа'];

// Признаки придержания действий. ЭТО НЕ БАН: «Try Again Later» означает, что площадка сочла темп
// подозрительным и просит остановиться. Единственная правильная реакция — остановиться немедленно.
// Первое такое придержание длится от получаса до 72 часов; второе и третье эскалируют до 7-14
// суток, и порог для акка после блока остаётся пониженным НАВСЕГДА. Поэтому продолжать перебор
// целей после первого признака (как делал followbeauty) — это торговать неделей ради одной подписки.
const BLOCK_RX = /try again later|action blocked|we restrict certain activity|temporarily blocked|please wait a few minutes|попробуйте позже|действие заблокировано|подождите несколько минут/i;

// ── закрытие окна ───────────────────────────────────────────────────────────
// Правило проекта: НИКОГДА pkill (сносит все окна Orbita, включая личные окна начальника).
// Закрываемся только через stopLocal и обязательно с posting:true — иначе профиль не коммитится
// и акк разлогинивается, то есть прогрев своими руками ломает сессию, которую пришёл беречь.
global.__GL = null; let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try {
    await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(8000)]);
    if (typeof gl.killBrowser === 'function') gl.killBrowser();
    console.log(`  ⏹ окно закрыто (${why})`);
  } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });

// ── человеческие паузы просмотра ────────────────────────────────────────────
// Три разных распределения вместо одного: быстрый скип, обычный просмотр, залипание — примерно в
// тех долях, в каких это делает человек. Одно равномерное распределение даёт слишком ровную
// гистограмму времени на экране, и это видно без всякого анализа действий.
function dwellMs() {
  const r = Math.random();
  if (r < 0.45) return rnd(1200, 3000);    // пролистал, не заинтересовало
  if (r < 0.88) return rnd(3000, 9000);    // посмотрел
  return rnd(9000, 26000);                 // залип
}

(async () => {
  if (!SLUG) { console.log('usage: node warmup.cjs <slug> [--check|--plan] [--force]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const row = (await c.query(
    `SELECT a.id, a.slug, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies, a.gologin_profile_id pid,
            coalesce(a.platform,'instagram') platform, a.session_status ss, coalesce(a.ig_status,'') ig,
            coalesce(a.health_state,'') hs, a.dressed_at, a.nick_changed_at, a.warmup_started_at, a.warmup_at,
            a.created_at, a.last_egress_ip, g.gologin_token tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }

  const ev = async (sql, args) => (await c.query(sql, args).catch(() => ({ rows: [] }))).rows;

  // ── ФАКТЫ ИЗ ЛОГА (всё дальше считается по ним, а не по памяти скрипта) ──
  const spent = {}; const spentHour = {};
  for (const r of await ev(
    `SELECT kind, count(*)::int n FROM account_events
      WHERE account_id=$1 AND created_at > now() - interval '24 hours' GROUP BY kind`, [row.id])) spent[r.kind] = r.n;
  for (const r of await ev(
    `SELECT kind, count(*)::int n FROM account_events
      WHERE account_id=$1 AND created_at > now() - interval '1 hour' GROUP BY kind`, [row.id])) spentHour[r.kind] = r.n;
  const totals = {};
  for (const r of await ev(
    `SELECT kind, count(*)::int n FROM account_events WHERE account_id=$1 GROUP BY kind`, [row.id])) totals[r.kind] = r.n;

  // Сколько РАЗНЫХ дней акк реально грелся. Именно дней, а не сессий: две сессии за сутки
  // прогревом на двое суток не становятся.
  const doneDays = Number((await ev(
    `SELECT count(DISTINCT date_trunc('day', created_at))::int n FROM account_events
      WHERE account_id=$1 AND kind='warmup_session'`, [row.id]))[0]?.n || 0);
  const lastSession = (await ev(
    `SELECT max(created_at) t FROM account_events WHERE account_id=$1 AND kind='warmup_session'`, [row.id]))[0]?.t || null;
  // Свежие тревожные события — после них прогрев не возобновляем, пока акк не отлежится.
  const trouble = await ev(
    `SELECT kind, created_at FROM account_events
      WHERE account_id=$1 AND kind IN ('warmup_block','restriction','challenge','captcha')
        AND created_at > now() - interval '72 hours' ORDER BY created_at DESC LIMIT 5`, [row.id]);

  // ── КАКОЙ СЕГОДНЯ ДЕНЬ ПРОГРЕВА ──
  // По календарю день считается от dressed_at. Но календарь врёт, если акк лежал мёртвым: акк,
  // который трое суток был dead, не «прогрет на 4 день» — он прогрет на столько дней, сколько
  // реально работал. Поэтому день ограничен сверху календарём, а растёт от числа проведённых
  // сессий: воскресший через неделю акк начинает с пассива, а не получает сразу взрослый бюджет,
  // то есть не делает того самого скачка плотности, от которого мы и лечимся.
  //
  // Смещение на 2, а не на 1: день 1 это сутки оформления, прогрев в них не запускается по
  // построению (окно уже открывал prepacc). Значит ПЕРВАЯ сессия прогрева — это всегда ступень 2.
  // Со смещением 1 получался тупик: у акка, оформленного позавчера, выходило min(3, 0+1)=1, то
  // есть «день оформления» и пропуск — и так каждый запуск, вечно. Поймано на @darya.smirnova13.
  const dressedAgoH = row.dressed_at ? (Date.now() - new Date(row.dressed_at).getTime()) / 3600000 : null;
  const calDay = row.dressed_at ? Math.floor(dressedAgoH / 24) + 1 : 0;
  let effDay = !row.dressed_at ? 0 : calDay <= 1 ? 1 : Math.max(2, Math.min(calDay, doneDays + 2));
  // Неоформленный акк — вообще не наш случай: греть чужую аву и чужие посты бессмысленно, сначала
  // prepacc. Отдельная ветка нужна, чтобы --plan не показывал ерунду от adultPlan(0).
  let plan = effDay === 0
    ? { day: 0, focus: 'skip', note: 'акк не оформлен — сначала prepacc.cjs, греть нечего' }
    : (DAYS.find((x) => x.day === effDay) || adultPlan(effDay));

  // ПРАВКА ПРОФИЛЯ ПЕРЕБИВАЕТ КАЛЕНДАРЬ. Если ник (или ава) менялись меньше суток назад — день
  // принудительно становится пассивным, чем бы он ни был по расписанию. Смена ника это смена
  // ЛОГИНА, самое заметное для площадки изменение из возможных; активность поверх него в те же
  // сутки — картинка угона. Отдельно стоит помнить: у смены ника жёсткий потолок 2 раза за 14
  // суток, после чего поле блокируется, а старый ник ещё 14 суток зарезервирован.
  const nickAgoH = row.nick_changed_at ? (Date.now() - new Date(row.nick_changed_at).getTime()) / 3600000 : null;
  const editAgoH = Math.min(nickAgoH ?? 1e9, dressedAgoH ?? 1e9);
  let downgraded = null;
  if (editAgoH < 24 && plan.focus !== 'skip' && plan.focus !== 'none' && plan.focus !== 'rest') {
    downgraded = `профиль менялся ${Math.round(editAgoH)}ч назад`;
    plan = { ...plan, focus: 'none', likes: 0, saves: 0, follows: 0,
      note: `${plan.note || ''} → понижено до пассива: ${downgraded}`.trim() };
  }

  console.log(`ПРОГРЕВ @${row.h} (${row.persona || 'без модели'})`);
  console.log(`  оформлен: ${row.dressed_at
    ? new Date(row.dressed_at).toISOString().slice(0, 16).replace('T', ' ') + ` (${Math.round(dressedAgoH)}ч назад)`
    : 'НЕТ — прогревать нечего'}`);
  console.log(`  день прогрева: ${effDay}${calDay !== effDay ? ` (по календарю ${calDay}, но реально грелись ${doneDays} дн. — идём по факту)` : ''}`);
  console.log(`  фокус дня: ${plan.focus}${plan.note ? ` — ${plan.note}` : ''}`);
  console.log(`  за сутки уже сделано: ${JSON.stringify(spent)}`);

  // ── ПРИЗНАКИ ГОТОВНОСТИ К ПУБЛИКАЦИИ ──
  // Вопрос «прогрет или сырой» решается проверяемыми фактами, а не сроком. Срок сам по себе не
  // значит ничего: акк, который трое суток простоял с живыми куками и НЕ делал ничего, с точки
  // зрения площадки выглядит хуже, чем акк, который эти трое суток листал ленту — у первого нет
  // поведенческого отпечатка вообще, и это отдельно названный признак «свежесозданной пустышки».
  const READY = [
    ['сессия live', row.ss === 'live', `session_status=${row.ss}`],
    ['не ограничен', !['restricted', 'suspended', 'captcha', 'challenge'].includes(row.ig) && row.hs !== 'restricted',
      `ig_status=${row.ig || '-'}, health=${row.hs || '-'}`],
    ['оформлен', !!row.dressed_at, row.dressed_at ? 'да' : 'prepacc не отработал'],
    // 144ч = начало дня 7. Это нижняя граница «первой публикации» по всем разобранным схемам.
    // Гейт в worker.ts требует 36ч — это абсолютный минимум, ниже которого нельзя; прогрев
    // требует больше, потому что за 36 часов акк физически не успевает пройти три ступени
    // (пассив → лайки → подписки), а историю создаёт именно последовательность ступеней.
    ['прошло ≥6 суток с оформления', dressedAgoH !== null && dressedAgoH >= 144,
      dressedAgoH === null ? 'нет даты' : `${Math.round(dressedAgoH)}ч (нужно 144)`],
    ['ник не менялся последние 18ч', !nickAgoH || nickAgoH >= 18, nickAgoH ? `${Math.round(nickAgoH)}ч назад` : 'не менялся'],
    ['грелись ≥4 разных дней', doneDays >= 4, `${doneDays} дн.`],
    ['история просмотров: ≥25 сторис', (totals.warmup_story || 0) >= 25, `${totals.warmup_story || 0}`],
    ['история вовлечения: ≥12 лайков', (totals.warmup_like || 0) >= 12, `${totals.warmup_like || 0}`],
    ['социальность: ≥3 подписки', (totals.follow || 0) >= 3, `${totals.follow || 0}`],
    ['нет ограничений за 72ч', trouble.length === 0, trouble.length ? trouble.map((t) => t.kind).join(',') : 'чисто'],
    // Прогрет и брошен — это не прогрет. Акк, который грелся неделю назад и с тех пор молчал, на
    // момент публикации снова выглядит спящим ботом, проснувшимся ради поста. Отдельно названный
    // триггер: «резкое изменение после простоя».
    ['грелись ≤36ч назад', !!lastSession && (Date.now() - new Date(lastSession).getTime()) / 3600000 <= 36,
      lastSession ? `${Math.round((Date.now() - new Date(lastSession).getTime()) / 3600000)}ч назад` : 'ни разу'],
  ];
  const readyOk = READY.every((r) => r[1]);

  if (CHECK_ONLY || PLAN_ONLY) {
    console.log('  ── признаки готовности к публикации ──');
    for (const [name, ok, note] of READY) console.log(`   ${ok ? '✓' : '✗'} ${name}: ${note}`);
    console.log(`  ВЕРДИКТ: ${readyOk ? '✅ акк прогрет, публиковать можно'
      : '⏳ акк ещё сырой — ' + READY.filter((r) => !r[1]).map((r) => r[0]).join('; ')}`);
    if (PLAN_ONLY) console.log(`  план дня ${effDay}: ${JSON.stringify(plan)}`);
    console.log(`ИТОГ: ${readyOk ? 'прогрет' : 'сырой'} (день ${effDay})`);
    await c.end(); process.exit(readyOk ? 0 : 2);
  }

  // ── ГЕЙТЫ ДО ОТКРЫТИЯ ОКНА ──
  // Открыть Orbita — самая дорогая и самая рискованная операция в проекте: это заход в аккаунт.
  // Всё, что решается по базе, решаем по базе и окно не трогаем вовсе.
  const stop = async (msg) => { console.log(`ИТОГ: ${msg}`); await c.end(); process.exit(0); };

  if (row.ss !== 'live') await stop(`⏭ сессия ${row.ss} — акк не открываем (прогрев акки не логинит, вход это дело сторожа)`);
  if (['restricted', 'suspended', 'captcha', 'challenge'].includes(row.ig) || row.hs === 'restricted') {
    await stop(`⛔ акк ограничен (ig_status=${row.ig}, health=${row.hs}) — греть ограниченный акк значит добивать его`);
  }
  if (!row.dressed_at) await stop('⏭ акк не оформлен — сначала prepacc.cjs (ава и чистка чужих постов), греть нечего');
  if (!row.pid || !row.ig_cookies) await stop('⏭ нет профиля GoLogin или кук — открывать нечего');
  if (plan.focus === 'skip') await stop(`⏭ день ${effDay}: ${plan.note}`);

  // Свежий след придержания — не возобновляем работу двое суток. Возобновить раньше значит
  // подтвердить площадке, что за аккаунтом стоит скрипт, который не понимает слова «позже».
  // После снятия блока практики советуют возвращаться не на прежний объём, а вдвое ниже —
  // это делает эффективный день (min с doneDays+1) сам собой, потому что дни простоя не считаются.
  if (trouble.length) {
    const agoH = Math.round((Date.now() - new Date(trouble[0].created_at).getTime()) / 3600000);
    if (agoH < 48) await stop(`⏸ ${agoH}ч назад было «${trouble[0].kind}» — держим паузу 48ч, акк не трогаем`);
  }

  // Сегодня уже грелись? Один заход в сутки на молодом акке; с дня 8 разрешаем второй, но не
  // раньше чем через 5 часов: два окна подряд — это опять плотность.
  const sessionsToday = Number((await ev(
    `SELECT count(*)::int n FROM account_events WHERE account_id=$1 AND kind='warmup_session'
       AND created_at > now() - interval '20 hours'`, [row.id]))[0]?.n || 0);
  const maxSessions = effDay >= 8 ? 2 : 1;
  if (!FORCE && sessionsToday >= maxSessions) await stop(`⏭ сегодня уже грелись ${sessionsToday}/${maxSessions} раз(а)`);
  if (!FORCE && lastSession && (Date.now() - new Date(lastSession).getTime()) < 5 * 3600000) {
    await stop(`⏭ прошлая сессия ${Math.round((Date.now() - new Date(lastSession).getTime()) / 60000)} мин назад — между заходами держим 5ч`);
  }

  // Ночь. Русскоязычная модель, листающая ленту в 4 утра по Москве каждый день, — машинный
  // признак, который виден даже без анализа действий. Часовой пояс московский осознанно:
  // легенда у всех персон русская, и время суток обязано ей соответствовать.
  const mskHour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }).slice(0, 2));
  if (process.env.WARMUP_NIGHT !== '1' && mskHour >= 2 && mskHour < 8) {
    await stop(`⏭ ${mskHour}:00 по Москве — ночью акк не будим (живой человек спит), WARMUP_NIGHT=1 чтобы всё равно`);
  }

  // Окно Orbita на маке одно. Если по этому акку уже крутится задача (публикация, подготовка),
  // второе окно либо не откроется, либо откроется поверх — и мы потеряем обе сессии.
  const busy = await ev(
    `SELECT mode FROM local_jobs WHERE status IN ('queued','running') AND slug LIKE '%'||$1||'%' LIMIT 1`, [SLUG]);
  if (busy.length) await stop(`⏭ по акку уже есть задача «${busy[0].mode}» — два окна Orbita на один акк не открываем`);

  // ПАУЗА СЕТИ. 02.08 четыре акка оформили за десять минут и потеряли все четыре. Групповая
  // плотность опасна так же, как индивидуальная: с точки зрения площадки это одна ферма,
  // проснувшаяся разом с одного узла. Между прогревами РАЗНЫХ акков держим интервал.
  const netGap = Number(process.env.WARMUP_NET_GAP_MIN || 12);
  const netLast = (await ev(
    `SELECT max(created_at) t FROM account_events WHERE kind='warmup_session' AND account_id <> $1`, [row.id]))[0]?.t;
  if (netLast && (Date.now() - new Date(netLast).getTime()) < netGap * 60000) {
    await stop(`⏭ другой акк грелся ${Math.round((Date.now() - new Date(netLast).getTime()) / 60000)} мин назад — держим ${netGap} мин между акками сети`);
  }

  // ── БЮДЖЕТ НА ЗАХОД (план дня минус уже сделанное по факту за сутки) ──
  // Письменные бюджеты обнуляются у всех типов, кроме фокуса дня: правило «один тип за сессию».
  const left = (specKind, kind) => Math.max(0, span(specKind) - (spent[kind] || 0));
  const budget = {
    feedMin: span(plan.feedMin) || 5,
    stories: left(plan.stories, 'warmup_story'),
    visits: left(plan.visits, 'warmup_visit'),
    explore: left(plan.explore, 'warmup_explore'),
    likes: plan.focus === 'like' ? left(plan.likes, 'warmup_like') : 0,
    saves: plan.focus === 'like' ? left(plan.saves, 'warmup_save') : 0,
    follows: plan.focus === 'follow' ? left(plan.follows, 'follow') : 0,
  };
  console.log(`  бюджет на заход: ${JSON.stringify(budget)}`);

  // ── ОТКРЫВАЕМ ОКНО ──
  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  const did = { warmup_scroll: 0, warmup_story: 0, warmup_visit: 0, warmup_explore: 0, warmup_like: 0, warmup_save: 0, follow: 0 };
  let missed = 0;          // подряд не подтвердившиеся действия
  let aborted = null;      // причина досрочной остановки
  let terminal = null;     // терминальное состояние акка (бан/челлендж/капча)

  // Одно действие = одна строка, и пишется она ПОСЛЕ положительного подтверждения. Иначе лимиты
  // считаются по намерениям, и первый же не сработавший клик тихо съедает бюджет.
  const mark = async (kind, detail) => {
    did[kind] = (did[kind] || 0) + 1;
    spentHour[kind] = (spentHour[kind] || 0) + 1;
    await c.query(
      `INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [row.id, SLUG, row.platform, kind, JSON.stringify({ day: effDay, ...(detail || {}) })],
    ).catch((e) => console.log(`    ⚠ событие ${kind} не записалось: ${String(e.message).slice(0, 70)}`));
  };
  const hourlyWrites = () => ['warmup_like', 'warmup_save', 'follow'].reduce((s, k) => s + (spentHour[k] || 0), 0);

  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    // С КАКОГО АДРЕСА ВЫХОДИМ. Отдельно названный триггер заморозки: вход из одной страны, а
    // следом активность из другой — система считает акк угнанным. Один лёгкий запрос до захода
    // на Instagram, чтобы разбор потом опирался на факт, а не на догадку «наверное прокси сменился».
    try {
      const ipPage = await ctx.newPage();
      await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const ip = (String(await ipPage.evaluate(() => document.body.innerText).catch(() => '')).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
      await ipPage.close().catch(() => {});
      console.log(`  🌐 выходим с адреса: ${ip || 'не определился'}${ip && row.last_egress_ip && ip !== row.last_egress_ip ? ' (ОТЛИЧАЕТСЯ от прошлого!)' : ''}`);
      if (ip) await c.query(`UPDATE accounts SET last_egress_ip=$2 WHERE id=$1`, [row.id, ip]).catch(() => {});
    } catch { console.log('  🌐 адрес не определился'); }

    // Единая точка выхода при беде. Проверяем экран ПЕРЕД каждым действием и ПОСЛЕ каждого
    // неподтвердившегося клика: «кнопка не сработала» и «нас придержали» выглядят одинаково,
    // и различить их можно только посмотрев на страницу, а не догадкой.
    const guard = async (where) => {
      if (aborted) return false;
      const cls = await L.classifyScreen(ctx, page);
      if (cls.state !== 'logged_in') {
        aborted = `экран «${cls.state}» (${cls.evidence}) на шаге «${where}»`;
        if (/suspend|challenge|captcha|disabled/i.test(cls.state)) terminal = cls.state;
        return false;
      }
      const body = String(await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 3000);
      if (BLOCK_RX.test(body)) { aborted = `придержание действий на шаге «${where}»: «${(body.match(BLOCK_RX) || [])[0]}»`; return false; }
      if (hourlyWrites() >= HOURLY_CAP) { aborted = `почасовой предохранитель: ${hourlyWrites()}/${HOURLY_CAP} действий за час`; return false; }
      return true;
    };

    await page.goto(FEED, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(rnd(4000, 8000));
    await L.clearOverlays(page);
    if (!(await guard('вход'))) throw new Error(aborted);
    console.log('  ✓ в аккаунте, начинаю сессию');

    // ── СЦЕНА 1: уведомления ──
    // Первое, что делает живой человек, открыв приложение. Заодно это ЕДИНСТВЕННОЕ надёжное место,
    // где Instagram пишет «We added a restriction to your account» (урок 01.08): одним естественным
    // действием закрываем и правдоподобие, и гейт здоровья.
    const health = await L.checkAccountStatus(page).catch(() => ({ state: 'unknown', excerpt: '' }));
    if (health.state === 'restricted') { terminal = 'restricted'; aborted = `в уведомлениях висит ограничение: «${health.hit}»`; throw new Error(aborted); }
    console.log(`  🩺 уведомления: ${health.state}`);
    await sleep(dwellMs());

    // ── СЦЕНА 2: сторис ──
    // Идут ДО ленты и до любых письменных действий: это самое безобидное, что вообще можно
    // сделать в аккаунте, и именно на просмотре сторис держатся первые дни всех разобранных схем.
    if (budget.stories > 0) {
      await page.goto(FEED, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(rnd(3000, 6000)); await L.clearOverlays(page);
      if (await openStories(page)) {
        for (let s = 0; s < budget.stories; s++) {
          if (!(await guard('сторис'))) break;
          await sleep(rnd(2500, 9000));                  // сторис короткие, залипать тут неестественно
          await mark('warmup_story');
          await page.keyboard.press('ArrowRight').catch(() => {});
          await sleep(rnd(800, 2200));
          if (!/\/stories\//.test(page.url())) break;    // сторис кончились — вышли сами
        }
        console.log(`  👁 сторис досмотрено: ${did.warmup_story}`);
        // Выходим НАВИГАЦИЕЙ, а не Escape: правило проекта — Escape в интерфейсе Instagram не работает.
        await page.goto(FEED, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
        await sleep(rnd(2000, 4000));
      } else console.log('  👁 сторис: кольца в шапке нет (никто не выкладывал) — пропускаю');
    }

    // ── СЦЕНА 3: лента ──
    // Отмеряем ВРЕМЕНЕМ, а не числом экранов: площадка видит время на экране, а не наши счётчики.
    // Лайки делаются ВНУТРИ листания, а не пачкой: человек лайкает то, что сейчас видит. Пачка из
    // пяти лайков подряд — машинный след, даже если пауз между ними хватает.
    if (!aborted) {
      await page.goto(FEED, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(rnd(3000, 6000)); await L.clearOverlays(page);
      const until = Date.now() + budget.feedMin * 60000;
      let screens = 0; let lastWrite = 0;
      while (Date.now() < until && !aborted) {
        if (!(await guard('лента'))) break;
        await sleep(dwellMs());
        screens++;

        // Лайк «того, что сейчас на экране». Успех подтверждаем ФАКТОМ: сердечко сменило состояние
        // Like → Unlike. «Клик не упал» доказательством не является.
        const canWrite = Date.now() - lastWrite > gapWrite(effDay);
        if (did.warmup_like < budget.likes && canWrite && chance(0.5)) {
          const r = await tryToggle(page, 'svg[aria-label="Like"]', 'svg[aria-label="Unlike"]', 'лайк');
          if (r.ok) { await mark('warmup_like'); lastWrite = Date.now(); missed = 0; console.log(`  ♥ лайк ${did.warmup_like}/${budget.likes}`); }
          else if (r.blocked) { aborted = `лайк придержан: ${r.why}`; break; }
          else if (++missed >= 3) { aborted = `три действия подряд не подтвердились (последнее: ${r.why})`; break; }
        }
        // Сохранение — самое незаметное действие: его не видит ни автор, ни подписчики, но для
        // алгоритма это более сильный сигнал интереса, чем лайк. Ставим редко и только в день лайков.
        else if (did.warmup_save < budget.saves && canWrite && chance(0.2)) {
          const r = await tryToggle(page, 'svg[aria-label="Save"]', 'svg[aria-label="Remove"]', 'сохранение');
          if (r.ok) { await mark('warmup_save'); lastWrite = Date.now(); console.log(`  🔖 сохранил ${did.warmup_save}/${budget.saves}`); }
          else if (r.blocked) { aborted = `сохранение придержано: ${r.why}`; break; }
        }

        if (chance(0.09)) await sleep(rnd(12000, 40000));                                  // отвлёкся: телефон, чайник
        if (chance(0.07)) { await page.mouse.wheel(0, -rnd(400, 900)).catch(() => {}); await sleep(rnd(1500, 4000)); } // вернулся посмотреть
        if (chance(0.75)) await page.mouse.wheel(0, rnd(500, 1300)).catch(() => {});       // жест варьируем: колесо
        else await page.keyboard.press('ArrowDown').catch(() => {});                        // или стрелка
      }
      if (screens) await mark('warmup_scroll', { screens, minutes: budget.feedMin });
      console.log(`  📜 лента: ${screens} экранов за ~${budget.feedMin} мин`);
    }

    // ── СЦЕНА 4: explore и теги ──
    // Ноль риска и максимальная польза: по просмотрам алгоритм решает, в какой тематический пул
    // положить аккаунт. Акк модели, который смотрит бьюти-теги, потом получает бьюти-охват.
    for (let e = 0; e < budget.explore && !aborted; e++) {
      if (!(await guard('explore'))) break;
      const tag = pick(EXPLORE_TAGS);
      const url = chance(0.5) ? 'https://www.instagram.com/explore/' : `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await sleep(rnd(3000, 6000)); await L.clearOverlays(page);
      for (let k = 0; k < rnd(2, 5); k++) { await page.mouse.wheel(0, rnd(400, 1100)).catch(() => {}); await sleep(dwellMs()); }
      await mark('warmup_explore', { what: url.includes('tags') ? tag : 'explore' });
      console.log(`  🔎 explore: ${url.includes('tags') ? '#' + tag : 'лента интересного'}`);
      await sleep(rnd(4000, 12000));
    }

    // ── СЦЕНА 5: чужие профили и подписки ──
    // Подписка ВСЕГДА идёт после просмотра профиля и никогда наоборот. Подписка «вслепую», без
    // захода на страницу, — действие, которого у живого человека физически не бывает: он не может
    // подписаться на того, чью страницу не открывал. В дни без фокуса 'follow' сюда всё равно
    // заходим, но только смотрим: заходы на чужие профили это тоже поведенческий след.
    const already = new Set((await ev(
      `SELECT detail->>'target' t FROM account_events WHERE account_id=$1 AND kind='follow'`, [row.id]))
      .map((x) => x.t).filter(Boolean));
    const pool = FOLLOW_TARGETS.filter((t) => !already.has(t)).sort(() => Math.random() - 0.5);
    const visitsWanted = Math.max(budget.visits, budget.follows);

    for (let v = 0; v < visitsWanted && !aborted; v++) {
      const target = pool[v];
      if (!target) break;
      if (!(await guard('профиль'))) break;
      await page.goto(`https://www.instagram.com/${target}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(rnd(4000, 9000)); await L.clearOverlays(page);
      // Посмотреть профиль по-настоящему: пролистать сетку. Заход-и-сразу-подписка — машинный след.
      for (let k = 0; k < rnd(1, 3); k++) { await page.mouse.wheel(0, rnd(300, 900)).catch(() => {}); await sleep(dwellMs()); }
      await mark('warmup_visit', { target });

      if (did.follow >= budget.follows) { await sleep(rnd(5000, 15000)); continue; }

      const btn = page.getByRole('button', { name: /^(Follow|Подписаться)$/i }).first();
      if (!(await btn.isVisible({ timeout: 6000 }).catch(() => false))) {
        console.log(`  – @${target}: кнопки Follow нет (уже подписаны либо профиль закрыт)`);
        await sleep(rnd(5000, 15000));
        continue;
      }
      await L.clickSafe(page, btn, `подписка на ${target}`).catch(() => {});
      await sleep(rnd(2500, 5000));
      // Успех = кнопка сменилась. Проверяем фактом, а не тем, что клик не упал.
      const ok = await page.getByRole('button', { name: /^(Following|Requested|Вы подписаны|Запрос отправлен)$/i })
        .first().isVisible({ timeout: 6000 }).catch(() => false);
      if (ok) {
        await mark('follow', { target, via: 'warmup' });
        missed = 0;
        console.log(`  ➕ подписка на @${target} (${did.follow}/${budget.follows})`);
      } else {
        // Не подтвердилось — НЕ гадаем о причине, а смотрим, что реально на экране. Догадка
        // «наверное лимит» так же часто оказывается «просто другое слово на кнопке».
        const seen = await page.evaluate(() => ({
          buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
            .map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 12),
          body: (document.body.innerText || '').slice(0, 400),
        })).catch(() => ({ buttons: [], body: '' }));
        console.log(`  ⚠ @${target}: подписка не подтвердилась, кнопки: ${JSON.stringify(seen.buttons)}`);
        if (BLOCK_RX.test(String(seen.body))) { aborted = `подписки придержаны на @${target}`; break; }
        // Одна осечка бывает от медленного интерфейса. Две подряд — уже система, и продолжать
        // перебор целей значит долбиться в закрытую дверь (ошибка followbeauty 03.08).
        if (++missed >= 2) { aborted = 'две подписки подряд не подтвердились — дальше не пробуем'; break; }
      }
      if (did.follow < budget.follows) await sleep(gapWrite(effDay));
    }

    // ── СЦЕНА 6: вернуться в ленту и уйти ──
    // Сессия, обрывающаяся сразу после подписки, читается как «зашёл, сделал дело, ушёл».
    // Живой человек после подписки ещё немного листает и только потом закрывает приложение.
    if (!aborted) {
      await page.goto(FEED, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await sleep(rnd(3000, 6000));
      for (let k = 0; k < rnd(2, 5); k++) { await page.mouse.wheel(0, rnd(500, 1200)).catch(() => {}); await sleep(dwellMs()); }
    }

    // ЗАМКНУТЬ КРУГ КУК: за время прогрева сессия обновилась. Не сохранить — значит подсунуть
    // постеру старые куки и увидеть разлогин там, где всё было в порядке.
    try {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) {
        await c.query(`UPDATE accounts SET ig_cookies=$2 WHERE id=$1`, [row.id, JSON.stringify(fresh)]);
        console.log(`  🔄 куки пересохранены (${fresh.length})`);
      }
    } catch {}
    await b.close().catch(() => {});
  } catch (e) {
    if (!aborted) aborted = String(e.message).slice(0, 200);
  }
  await closeLocal('finish');

  // ── ЧТО ЗАПИСАТЬ ПО ИТОГУ ──
  if (aborted) {
    if (terminal && terminal !== 'restricted') {
      // Бан, челлендж, капча. Прогревом и ретраями не лечится: выводим акк из работы и снимаем
      // неотправленные посты — иначе воркер будет долбиться в мёртвый акк (02.08: 102 захода подряд).
      await c.query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead',
                       health_state='restricted', health_note=$3 WHERE id=$1`,
        [row.id, terminal, `warmup: ${aborted}`.slice(0, 300)]).catch(() => {});
      await c.query(`UPDATE posts SET status='cancelled', error='акк заблокирован (warmup)'
                      WHERE account_id=$1 AND status IN ('approved','publishing') AND post_submitted=false`, [row.id]).catch(() => {});
      await c.query(`INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,'restriction',$4::jsonb)`,
        [row.id, SLUG, row.platform, JSON.stringify({ state: terminal, reason: aborted, day: effDay, done: did })]).catch(() => {});
      console.log(`ИТОГ: ⛔ акк ${terminal} — выведен из работы, посты сняты: ${aborted}`);
    } else if (terminal === 'restricted') {
      await c.query(`UPDATE accounts SET health_state='restricted', health_note=$2 WHERE id=$1`,
        [row.id, `warmup: ${aborted}`.slice(0, 300)]).catch(() => {});
      await c.query(`INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,'restriction',$4::jsonb)`,
        [row.id, SLUG, row.platform, JSON.stringify({ reason: aborted, day: effDay, done: did })]).catch(() => {});
      console.log(`ИТОГ: ⛔ на акке ограничение — в работу не пускаем: ${aborted}`);
    } else {
      // Мягкое придержание. Акк не забанен, но работать сейчас нельзя. Помечаем событием (по нему
      // следующий запуск сам уйдёт в паузу на 48ч) и отодвигаем публикации на сутки: опубликовать
      // через час после «Try Again Later» — это способ превратить предупреждение в блокировку,
      // а второе придержание уже стоит 7-14 суток и навсегда пониженного потолка.
      await c.query(`INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,'warmup_block',$4::jsonb)`,
        [row.id, SLUG, row.platform, JSON.stringify({ reason: aborted, day: effDay, done: did })]).catch(() => {});
      await c.query(`UPDATE accounts SET health_note=$2 WHERE id=$1`,
        [row.id, `warmup: придержание — ${aborted}`.slice(0, 300)]).catch(() => {});
      if (process.env.WARMUP_NO_POSTPONE !== '1') {
        const moved = await c.query(
          `UPDATE posts SET scheduled_at = greatest(coalesce(scheduled_at, now()), now() + interval '24 hours'),
                            error='отложен: на акке придержание действий (warmup)'
            WHERE account_id=$1 AND status='approved' AND post_submitted=false RETURNING id`, [row.id]).catch(() => ({ rowCount: 0 }));
        if (moved.rowCount) console.log(`  ⏸ публикации акка отодвинуты на сутки: ${moved.rowCount}`);
      }
      console.log(`ИТОГ: ⚠ прогрев остановлен — ${aborted}. Сделано: ${JSON.stringify(did)}`);
    }
    await c.end(); process.exit(0);
  }

  // Успешная сессия. warmup_started_at ставим ОДИН раз: от неё batchplan считает возраст акка,
  // и сбивать её каждым заходом нельзя — иначе акк вечно будет «первого дня» и никогда не выйдет
  // на нормальный суточный лимит публикаций.
  await c.query(
    `INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,'warmup_session',$4::jsonb)`,
    [row.id, SLUG, row.platform, JSON.stringify({ day: effDay, calendar_day: calDay, focus: plan.focus, done: did, budget, downgraded })]).catch(() => {});
  await c.query(
    `UPDATE accounts SET warmup_at=now(), warmup_started_at=coalesce(warmup_started_at, now()) WHERE id=$1`, [row.id]).catch(() => {});

  // Пересчитываем готовность ПОСЛЕ сессии: этот заход мог стать тем самым четвёртым днём.
  // Метку warmup_ready ставим один раз — по ней гейт публикации сможет отличать прогретый акк от
  // сырого одним EXISTS, не повторяя всю эту логику в SQL.
  const nowDays = Number((await ev(
    `SELECT count(DISTINCT date_trunc('day', created_at))::int n FROM account_events
      WHERE account_id=$1 AND kind='warmup_session'`, [row.id]))[0]?.n || 0);
  const nowTot = {};
  for (const r of await ev(`SELECT kind, count(*)::int n FROM account_events WHERE account_id=$1 GROUP BY kind`, [row.id])) nowTot[r.kind] = r.n;
  const nowReady = nowDays >= 4 && dressedAgoH >= 144 && (nowTot.warmup_like || 0) >= 12
    && (nowTot.warmup_story || 0) >= 25 && (nowTot.follow || 0) >= 3;
  if (nowReady && !(await ev(`SELECT 1 FROM account_events WHERE account_id=$1 AND kind='warmup_ready' LIMIT 1`, [row.id])).length) {
    await c.query(`INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,'warmup_ready',$4::jsonb)`,
      [row.id, SLUG, row.platform, JSON.stringify({ day: effDay, days: nowDays, totals: nowTot })]).catch(() => {});
    console.log('  🎓 акк добрал признаки прогретого — поставлена метка warmup_ready');
  }

  console.log(`ИТОГ: ✅ день ${effDay} (${plan.focus}) отработан — ${JSON.stringify(did)}; ` +
    `публикация ${plan.post ? (nowReady ? 'разрешена' : 'по календарю можно, но признаки готовности собраны не все — см. --check') : `не раньше дня 7 (сейчас ${effDay})`}`);
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });

// ── ПОМОЩНИКИ ───────────────────────────────────────────────────────────────

// Переключатель с ПОЛОЖИТЕЛЬНЫМ доказательством: лайк засчитан, только если сердечко реально
// сменило состояние (Like → Unlike). Считаем по количеству иконок на странице, а не следим за
// одной конкретной: в ленте посты подгружаются, и элемент под курсором мог уехать.
// Урок проекта: «клик не упал» доказательством не является — именно так followbeauty месяцами
// «подписывался» на аккаунты, на которые не подписывался.
async function tryToggle(page, fromSel, toSel, what) {
  const before = await page.locator(toSel).count().catch(() => 0);
  const icons = page.locator(fromSel);
  const n = await icons.count().catch(() => 0);
  // Берём ВИДИМЫЙ элемент: в DOM Instagram полно скрытых дублей от выгруженных постов, и клик
  // по первому попавшемуся уходит в никуда (то же правило, что у visEdit в iglib).
  let target = null;
  for (let i = 0; i < Math.min(n, 8); i++) {
    const el = icons.nth(i);
    if (await el.isVisible().catch(() => false)) { target = el; break; }
  }
  if (!target) return { ok: false, why: `нет видимой иконки «${what}»` };
  try { await L.clickSafe(page, target, what); } catch (e) { return { ok: false, why: String(e.message).slice(0, 90) }; }
  await L.sleep(1200 + Math.random() * 1800);
  const after = await page.locator(toSel).count().catch(() => 0);
  if (after > before) return { ok: true };
  const body = String(await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 1500);
  const blocked = /try again later|action blocked|попробуйте позже/i.test(body);
  return { ok: false, blocked, why: blocked ? 'экран просит подождать' : `состояние не сменилось (${before}→${after})` };
}

// Открыть ленту сторис. Кольцо аватарки в шапке ленты — это <canvas> внутри кликабельного
// контейнера; текстовых признаков у него нет, поэтому ищем структурно (то же правило, что у
// isWorkDialog в iglib: свободный текст к классификации не допускать).
// Успех подтверждаем URL: после открытия адрес обязан содержать /stories/. Никаких «наверное
// открылось» — иначе дальше мы будем жать стрелки в ленте и листать её вслепую.
async function openStories(page) {
  const ring = page.locator('main canvas, section canvas').first();
  if (!(await ring.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  try { await L.clickSafe(page, ring, 'кольцо сторис'); } catch { return false; }
  await L.sleep(3500);
  return /\/stories\//.test(page.url());
}
