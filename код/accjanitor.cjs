// УБОРЩИК АККАУНТОВ — ОДИН КРУГ (06.08, приказ начальника: «нужно сделать отдельного агента,
// который будет акки смотреть, ники проверять, авы, посты и тд, уборщик будет хвостов, щас пизда:
// рандом ники, фото и тд, то есть посты то нет. нужен автономный агент 24/7 чтобы проверял»).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КОНТУР, ЕСЛИ ЧЕКИ УЖЕ ЕСТЬ. Проверки по отдельности существуют, но никто не
// смотрит на ферму КАК НА ЦЕЛОЕ и никто не доводит найденное до починки:
//   • accheck.cjs читает профиль снаружи и сверяет лица, но ничего не чинит и не знает про базу;
//   • postguard.cjs решает «можно ли постить», но не спрашивает «а почему этот акк вообще болен»;
//   • postreconcile.cjs разбирает исходы публикаций, но только по команде руками;
//   • glrename.cjs переименовывает профили GoLogin, но только когда его запустят;
//   • несоответствия полей в базе не смотрел НИКТО — сегодняшний аудит нашёл 17 акков с
//     противоречиями (session_status='dead' при ig_status='login_ok', шесть suspended без paused,
//     paused при health_state='ok'). Каждое такое противоречие это либо сожжённые попытки входа,
//     либо акк, который автоматика молча не замечает.
// Уборщик — ДИРИЖЁР над готовыми инструментами плюс те проверки, которых не было ни у кого:
// мусорный ник прежнего владельца, чужие посты в сетке, сверка полей базы с контрактом.
//
// ГЛАВНЫЙ ПРИНЦИП: ЧИТАЕМ СНАРУЖИ, ВХОДИМ ТОЛЬКО НА ПОЧИНКУ. Заход в аккаунт это самый дорогой и
// самый опасный жест: именно на плотных заходах 03.08 сгорели четыре акка, и именно поэтому вся
// диагностика здесь идёт анонимным curl без единой куки (ноль сессий, ноль окон, ноль поводов для
// бана). Вход разрешён только под конкретную починку и только в пределах порогов ниже.
//
// ЧТО НИКОГДА НЕ ДЕЛАЕТ (жёстко, это не настройка):
//   • не удаляет аккаунты и не сносит профили GoLogin (приказ начальника);
//   • не делает pkill по Orbita/gologin (снесёт окна начальника и чужих чатов, теряются куки);
//   • не шлёт служебные уведомления в телеграм (приказ «выключи эту хуету»): всё в отчёт и в базу,
//     канал есть, но по умолчанию выключен (JANITOR_TG=1);
//   • не возвращает посты в очередь после клика Share (инвариант постинга) и не ставит задачи
//     публикации мимо postguard.canPost;
//   • НЕ СТАВИТ paused терминальным аккам, пока не убедится ФАКТОМ, что замок автосноса работает.
//     Это стоило нам семи аккаунтов на приёмке 06.08: починка инварианта 1 законна по контракту,
//     но в ПРОДЕ оба замка §3 не задеплоены (лежат в незакоммиченном src/worker.ts), и paused на
//     терминальном акке означает снос вместе с профилем GoLogin через 20 минут — даже с keep.
//     Проверка C0 каждый круг спрашивает: снесён ли за неделю акк с health_state='keep'? Снесён —
//     значит замка нет, паузу не ставим, пишем начальнику. Обход: JANITOR_PAUSE_TERMINAL=1.
//
// Запуск:
//   node accjanitor.cjs                  — СУХОЙ круг (по умолчанию): только читает и пишет отчёт
//   node accjanitor.cjs --fix            — круг с безопасной починкой (поля базы, имена профилей
//                                          GoLogin, зависшие задачи, фиксация исходов постов)
//   node accjanitor.cjs --fix --accheck  — плюс запустить платную сверку лиц (accheck.cjs)
//   node accjanitor.cjs <slug>           — один акк
// Автономность: ./accjanitorloop.sh (крон на этом маке не работает, см. accheckloop.sh).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const PV = require('./postverify.cjs');   // чтение ленты снаружи (готовое, не дублируем)
const PG = require('./postguard.cjs');    // единая точка допуска к публикации (её решения не повторяем)
const { armWatchdog } = require('./watchdog.cjs');
const igp = require('./igprofile.cjs');   // общий разбор ответа IG + подтверждение вердикта с разных прокси

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ARGS = process.argv.slice(2);
const FIX = ARGS.includes('--fix') && !ARGS.includes('--dry');
const RUN_ACCHECK = ARGS.includes('--accheck');
const ONLY = ARGS.find((a) => !a.startsWith('--')) || null;
const OUT_DIR = process.env.JANITOR_DIR || '/tmp/accjanitor';
const LAP_LOCK = '/tmp/accjanitor.lock';

// ─────────────────────────── ПОРОГИ (откуда взялось каждое число) ───────────────────────────
// Пауза между внешними запросами. То же число, что в accheck.cjs: запросы анонимные и для акка
// безопасные, но с одного IP частить по всей ферме незачем.
const GAP_MS = Math.max(800, Number(process.env.JANITOR_GAP_MS) || 2500);
// Как часто отдаём круг платной сверке лиц (accheck.cjs с vision). Лицо меняется редко, а каждая
// сверка это деньги, поэтому раз в 6 часов — как и было у accheckloop.sh.
const ACCHECK_EVERY_H = Number(process.env.JANITOR_ACCHECK_EVERY_H) || 6;
// АНТИ-БАН ДЛЯ ПОЧИНКИ ВХОДОМ. Числа не сочинены, а сняты с инцидентов:
//   03.08 четыре акка сгорели на кластере «подъём + чистка + ава + ник» подряд за 10 минут →
//   больше двух заходов за круг не делаем и между заходами держим паузу;
//   один акк не трогаем чаще раза в сутки: смена авы/ника каждые пару часов выглядит как борьба
//   за перехваченный аккаунт;
//   свежая публикация или живая задача публикации = акк прямо сейчас в работе, второе окно на нём
//   это двойная сессия (главный убийца акков, память «мульти-сессия»).
const LOGIN_MAX = Number(process.env.JANITOR_LOGIN_MAX) || 2;
const LOGIN_GAP_MIN = Number(process.env.JANITOR_LOGIN_GAP_MIN) || 20;
const ACC_LOGIN_COOLDOWN_H = Number(process.env.JANITOR_ACC_COOLDOWN_H) || 24;
const POST_QUIET_MIN = Number(process.env.JANITOR_POST_QUIET_MIN) || 60;
// Входы включаются ОТДЕЛЬНЫМ флагом и по умолчанию выключены: первый заход уборщика только
// помечает «нужен вход», чтобы начальник увидел список до того, как в акки полезут окна.
const LOGIN_ON = /^(1|true|yes)$/i.test(String(process.env.JANITOR_LOGIN || ''));
// Зависшая задача публикации: тот же порог, что у предохранителя (раннер убивает публикатора на
// 20-й минуте, 45 минут = двойной запас, живую работу не обрубаем).
const STALE_JOB_MIN = 45;
// «Подъём залип»: акк мёртв дольше этого и попытки входа не было — значит его не берёт ни один
// подъёмник. Корень «релогин 0/24ч» из диагностики 22.07.
const DEAD_STUCK_H = Number(process.env.JANITOR_DEAD_STUCK_H) || 6;
// МИНИМАЛЬНЫЙ ЗАЗОР МЕЖДУ ВНЕШНИМИ ОБХОДАМИ. Причина ровно одна и она известна: на приёмке 06.08
// я прогнал шесть кругов и два accheck за 25 минут (~110 анонимных запросов с одного IP), и
// Instagram закрыл endpoint фразой «Please wait a few minutes» больше чем на час — все круги после
// этого шли без вердиктов. В нормальном режиме (круг в час, ~28 запросов) стены нет. Поэтому обход
// не повторяется чаще, чем раз в 45 минут, даже если круг запустили руками сразу после цикла.
const EXT_GAP_MIN = Number(process.env.JANITOR_EXT_GAP_MIN) || 45;
const EXT_STAMP = '/tmp/accjanitor.extpass';
// Служебные записи, которые аккаунтами не являются (те же исключения, что в accheck.cjs).
const SERVICE = new Set(['TT2 KZ', 'TT KZ SELF 1', 'TT KZ SELF 5 (пустой дубль)', 'акк 2', 'акк 5', 'поисковик']);

const UA_MOB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const BRAND_RE = /нейронка\s*[.\s]?\s*(про|pro)|neironka\s*[.\s]?\s*pro|нейронка\.про/i;
const REFS_DIR = path.join(__dirname, 'refs');
// Терминальные ig_status: акк болен так, что попытки входа только жгут его. Список ровно как в
// ARCHITECTURE §3 плюс action_block (его ставит комментинг по факту отказа IG).
const TERMINAL_IG = ['suspended', 'captcha', 'challenge', 'bad_login', 'restricted', 'action_block'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hoursAgo = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3600e3 : null);

// ─────────────────────────── ЗАМОК КРУГА ───────────────────────────
// СДЕЛАН НАРОЧНО НЕ ЧЕРЕЗ pgrep. В runners3.sh сторож написан как
// `pgrep -f "RUNNER_ID=$N node localrunner.cjs"` и не срабатывает НИКОГДА: присваивание
// переменной окружения выполняет шелл, в argv процесса его нет, значит шаблон не совпадает и
// раннеры плодятся. Здесь замок это файл, созданный атомарно (flag 'wx'), а живость владельца
// проверяется двумя независимыми способами: сигнал 0 (процесс существует) и `ps -o command=`
// (это действительно наш скрипт, а не переиспользованный pid).
function ownerAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return /accjanitor\.cjs/.test(out);
  } catch { return false; }
}
function takeLap() {
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(LAP_LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch {
      let st = null;
      try { st = JSON.parse(fs.readFileSync(LAP_LOCK, 'utf8')); } catch {}
      const pid = Number((st && st.pid) || 0);
      if (ownerAlive(pid)) { console.log(`круг уже идёт (pid ${pid}, начат ${st && st.at}) — выхожу`); return false; }
      // Владельца нет (упал, убит, pid переиспользован) — замок снимаем сами, иначе один
      // аварийный выход выключает автономность навсегда.
      try { fs.unlinkSync(LAP_LOCK); } catch {}
    }
  }
  return false;
}
function freeLap() {
  try {
    const st = JSON.parse(fs.readFileSync(LAP_LOCK, 'utf8'));
    if (Number(st.pid) === process.pid) fs.unlinkSync(LAP_LOCK);
  } catch {}
}

// ─────────────────────────── ПРОФИЛЬ СНАРУЖИ ───────────────────────────
// Тот же анонимный endpoint, которым живут accheck.cjs / accaudit.cjs / postverify.cjs. Читаем
// его здесь своей функцией по единственной причине: accheck и accaudit — скрипты, они ничего не
// экспортируют, а postverify.readFeed отдаёт только список медиа и выбрасывает сам профиль
// (имя, био, ава). Один curl на акк даёт сразу всё, что нужно дешёвым проверкам, а ДОРОГУЮ
// сверку лиц мы не повторяем — её делает accheck.cjs, мы только читаем её вердикт из базы.
// ЧЕТЫРЕ ИСХОДА, путать нельзя (урок accaudit.cjs): сбой IG (вердикта нет), профиля нет,
// ПРОФИЛЬ СПРЯТАН от анонима (ник занят, данные не отдаются), профиль есть.
// Сам разбор ответа — общий, в igprofile.cjs: своя копия тут была пятой в проекте, и копии уже
// разъезжались (дыру «ответ без user = профиля нет» в accheck закрыли 07.08, а здесь она жила
// дальше, и уборщик писал «акк потерян» по живому).
// ЧИТАЕМ ЧЕРЕЗ ПУЛ ПРОКСИ, А НЕ СО СВОЕГО АЙПИ (10.08). Причина в самой ФАЗЕ 0: наш адрес
// Instagram душит после сотни анонимных запросов, и тогда уборщик честно, но бесполезно пропускает
// весь внешний обход — круг за кругом. Отчёт при этом помечается «недостоверен», то есть про
// спрятанные акки мы не узнаём вообще. Пул анонимных прокси снимает именно это: обход идёт не с
// нашего адреса, а зазор EXT_GAP_MIN и обрыв по трём лимитам подряд остаются как были.
// JANITOR_DIRECT=1 возвращает прежнее поведение (читать напрямую).
const READ_PX = String(process.env.JANITOR_DIRECT || '') === '1' ? [] : igp.proxies();
let readTurn = 0;
function profileOf(handle, proxy) {
  const px = proxy || (READ_PX.length ? READ_PX[readTurn++ % READ_PX.length] : null);
  const r = igp.ask(handle, px, { ua: UA_MOB });
  if (r.kind === 'сбой') return { glitch: true, why: r.why || 'сбой IG' };
  if (r.kind === 'нет-ника' || r.kind === 'нет-профиля') return { gone: true };
  if (r.kind === 'спрятан') return { hidden: true };
  const u = r.user;
  const media = u.edge_owner_to_timeline_media || {};
  return {
    name: (u.full_name || '').trim(),
    bio: (u.biography || '').trim(),
    pic: u.profile_pic_url_hd || u.profile_pic_url || '',
    posts: media.count ?? null,
    followers: (u.edge_followed_by || {}).count ?? null,
    following: (u.edge_follow || {}).count ?? null,
    private: !!u.is_private,
    feed: (media.edges || []).map((e) => PV.normMedia(e)).filter(Boolean),
  };
}

// ─────────────────────────── НИК ───────────────────────────
// ПОВОД (прямая цитата начальника): «щас пизда: рандом ники, фото и тд». Ники вида bryan436344 и
// damari1735 — это логины ПРЕЖНИХ владельцев купленных акков: буквенное имя плюс хвост цифр.
// Предикат повторяет isJunkNick из prepacc.cjs дословно. Почему копия, а не require: prepacc.cjs
// это скрипт, он при подключении сразу начинает работу (открывает профиль и чистит сетку), и его
// файл прямо сейчас правит другой чат — трогать чужое незакоммиченное нельзя (дисциплина деплоя).
// Если предикат меняется, менять надо в обоих местах, поэтому он вынесен отдельной функцией.
const MALE = /(?:^|[^a-z])(bryan|braylen|jaylon|landen|oliver|rylan|hassan|miguel|tristen|alfonso|christian|amari|kasey|case|riley|zander|carter|savion|tyree|darius|ivan|maxim|artem|dmitry|sergey|andrew|john|mike|alex)(?![a-z])/i;
function junkNick(h) {
  const s = String(h || '').trim();
  if (!s) return 'ник пуст';
  if (/^(FOL|TT)[\s_]/i.test(s) || /^акк\s/i.test(s)) return 'ник это служебный слаг, а не @ник';
  if (/^[a-z]+\d{4,}$/i.test(s)) return 'ник прежнего владельца (имя + хвост цифр)';
  if (/\d{4,}/.test(s)) return 'в нике 4+ цифр подряд (машинный ник)';
  if (MALE.test(s)) return 'в нике мужское имя, а акк ведёт девушка';
  return null;
}

// Эталон лица модели. Проверяем ФАЙЛОМ, а не полем face_state: 06.08 у «Розовой» в базе висело
// face_state='no_ref', хотя refs/Розовая.jpg лежит на месте. Причина в том, что accheck пишет
// face_state только когда сверка реально состоялась, а у акка с пустой лентой сверять нечего —
// и старая метка живёт вечно, превращаясь в ложное «нет эталона» в отчёте.
function hasRef(persona) {
  if (!persona) return false;
  const want = String(persona).trim().toLowerCase();
  let list = [];
  try { list = fs.readdirSync(REFS_DIR); } catch { return false; }
  return list.some((f) => path.parse(f).name.toLowerCase() === want && /\.(jpg|jpeg|png)$/i.test(f));
}

// ─────────────────────────── ЗАПИСЬ НАХОДОК ───────────────────────────
// Пишем в account_events: это уже существующий «лог жизни аккаунта», он переживает удаление акка
// и по нему делаются выводы. Своей таблицы не заводим (правило: новая общая таблица только через
// schema.sql, а здесь она и не нужна).
async function logEvent(c, a, kind, detail) {
  await c.query(`INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,$4,$5)`,
    [a.id || null, a.slug, a.platform || null, kind, JSON.stringify(detail)]).catch(() => {});
}

// ─────────────────────────── ГЕЙТЫ: НЕ НАСТУПАТЬ НА ПЯТКИ ───────────────────────────
// Уборщик работает по кругу и обязан уступать конвейеру. Два источника занятости:
//   1) /tmp/genposts.lock — им фабрика постов держит браузерный профиль neironka.pro. Живой замок
//      значит «прямо сейчас идёт генерация», окна в это время не открываем;
//   2) живая igpost-задача в local_jobs по акку — по нему прямо сейчас идёт публикация, второе
//      окно на том же акке это двойная сессия.
function genpostsBusy() {
  try {
    const pid = Number(String(fs.readFileSync('/tmp/genposts.lock', 'utf8')).trim() || 0);
    if (!pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    // Тот же TTL, что в genposts.cjs: генерация не живёт дольше 45 минут.
    if (Date.now() - fs.statSync('/tmp/genposts.lock').mtimeMs > 45 * 60000) return false;
    return true;
  } catch { return false; }
}

// ─────────────────────────── ПРОВЕРКА ОДНОГО АККА ───────────────────────────
// hard  — дефект: акк выглядит не как наш, надо править.
// soft  — замечание: видеть, но не бить тревогу.
// need  — что именно требует ВХОДА в акк (список работ для фазы починки).
// human — что автоматика решить не вправе (нужен начальник).
async function checkAccount(c, a, ourCodes, ourFloor) {
  const r = { slug: a.slug, h: a.h, persona: a.persona || '', platform: a.platform,
    hard: [], soft: [], need: [], human: [], ext: null };

  // ДВА РОЛЕВЫХ НАБОРА ПРАВИЛ (взято из accheck.cjs, там это уже проверено). Модельный акк (есть
  // персона) обязан выглядеть нашей моделью: ник, ава, био со ссылкой, своё лицо в ленте. Ферма
  // комментинга (FOL_*, персоны нет) живёт по ЧУЖОЙ легенде — требовать от неё наш ник и нашу
  // ссылку бессмысленно: первый прогон accheck так дал 22 дефекта из 24 и стал нечитаемым.
  const isModel = !!a.persona;
  // РАБОТУ НАЗНАЧАЕМ ТОЛЬКО ТОМУ, КОГО МОЖНО ПОЧИНИТЬ. Первый прогон 06.08 выписал «сменить ник»
  // четырём забаненным акккам (mark755876, nick95738, nico838020, jerimiah56338), у которых профиля
  // снаружи вообще нет: заходить туда некуда, а список работ становится нечитаемым. Поэтому дефект
  // в таблице показываем всегда, а наряд на вход выдаём только при живом профиле.
  r.nickBad = isModel ? junkNick(a.h) : null;
  const order = (what, how, why) => r.need.push({ what, how, why });

  // --- 2. ИМЯ ПРОФИЛЯ GOLOGIN «<acc_no> <ig_login>» (правило начальника 06.08) ---
  // Сверка и починка живут в glrename.cjs, здесь только фиксируем факт расхождения по его отчёту
  // (см. фазу «безопасная починка»): вызывать GoLogin по акку отдельно незачем.
  if (!a.has_pid && a.session_status === 'live') {
    r.hard.push('нет профиля GoLogin (gologin_profile_id пуст) при живой сессии');
    r.human.push('акк без профиля GoLogin: завести профиль или разобраться, куда он пропал');
  }

  // --- 3. ВНЕШНЕЕ ЧТЕНИЕ (анонимно, ноль риска) ---
  let p = profileOf(a.h);
  r.ext = p;
  if (p.glitch) { r.soft.push(`СБОЙ IG (${p.why}) — вердикта по профилю нет`); return r; }
  // Спрятан: не «потерян» и не «здоров». Дальше проверять аву и био бессмысленно (профиль не
  // отдаётся), поэтому выходим, но с честной формулировкой и наказом проверить вход.
  if (p.hidden) {
    // ОДНОГО ОТВЕТА МАЛО. С придушенного айпи «спрятан» и «нас душат лимитом» выглядят одинаково,
    // а уборщик читает профили пачкой с одного адреса и в стену упирается регулярно (§9). Поэтому
    // переспрашиваем с РАЗНЫХ прокси (igprofile.probe, 401 в счёт не идёт) и только согласие
    // нескольких каналов делаем дефектом. Не подтвердилось — это замечание, а не находка.
    const v = await igp.probe(a.h, { tries: 4, minConfirm: 2 });
    if (v.kind === 'спрятан') {
      r.hard.push(`профиль СПРЯТАН снаружи: ник есть, но профиль не отдаётся анониму (${v.why})`);
      r.human.push('проверить входом: чекпоинт или бан. Пока акк спрятан, его посты снаружи не видны. '
        + 'Автоснос и автозамену по этому НЕ запускать: анонимно приговор не выносится');
      return r;
    }
    if (v.kind !== 'виден') {
      r.soft.push(`похоже, профиль спрятан от анонима, но подтверждения нет: ${v.why}`);
      return r;
    }
    // Другой канал профиль отдал — значит первый ответ был про наш доступ. Дальше читаем как обычно.
    p = profileOf(a.h);
    if (p.glitch || p.hidden) { r.soft.push('профиль то отдаётся, то нет — вердикта по нему нет'); return r; }
    r.ext = p;
  }
  if (p.gone) {
    r.hard.push('профиля нет снаружи (снесён или забанен)');
    if (r.nickBad) r.hard.push(`НИК: ${r.nickBad} («${a.h}») — но чинить нечего, профиля нет`);
    if (a.session_status === 'live') r.human.push('в базе session_status=live, а профиля снаружи нет — акк потерян');
    return r;
  }

  // Профиль есть — вот теперь наряды на вход имеют смысл.
  if (r.nickBad) { r.hard.push(`НИК: ${r.nickBad} («${a.h}»)`); order('nick', `SAME_DAY_NICK=0 node prepacc.cjs ${JSON.stringify(a.slug)}`, r.nickBad); }

  // --- 4. АВА ---
  const noAva = !p.pic || /anonymousUser|profilePicDefault/i.test(p.pic);
  if (noAva) {
    r.hard.push('нет авы (дефолтная)');
    order('avatar', `node prepacc.cjs ${JSON.stringify(a.slug)}`, 'ава дефолтная');
  }
  // Лицо сверяет accheck.cjs (это платная vision-сверка, повторять её здесь нельзя). Мы читаем
  // ЕГО вердикт из базы и трактуем по роли акка. Про эталон спрашиваем ФАЙЛОВУЮ СИСТЕМУ, а не
  // старую метку face_state (см. hasRef: метка 'no_ref' живёт вечно у акка с пустой лентой).
  if (isModel && !hasRef(a.persona)) {
    r.human.push(`нет эталона refs/${a.persona}.jpg — лицо сверять нечем, подмена пройдёт молча`);
  }
  if (a.face_state === 'mismatch') {
    // Подробность берём из health_note ТОЛЬКО если она действительно про лицо: заметку перетирают
    // и другие писатели (сегодня у ai.photo.vibe там лежало «возвращён 06.08: снят предохранителем
    // ошибочно»), и без проверки отчёт цитировал бы в дефекте лица чужой текст.
    const why = /ЧУЖОЕ ЛИЦО/.test(String(a.health_note || ''))
      ? String(a.health_note).replace(/^.*?ЧУЖОЕ ЛИЦО:\s*/, '').slice(0, 90)
      : 'подробность стёрта другой записью, смотреть кадры в /tmp/accheck';
    r.hard.push(`ЧУЖОЕ ЛИЦО (сверка ${a.hchk || 'accheck'}): ${why}`);
    order('avatar', `node prepacc.cjs ${JSON.stringify(a.slug)}`, 'на аве или в ленте не наша модель');
  } else if (a.face_state === 'ok' && isModel) {
    // ПРАВИЛО МУЛЬТИАККОВ (05.08): акки это обучалки по промптам, лицо модели и её имя в профиль
    // НЕ ставим, ава «промптовая» без лица. Ава с узнаваемым лицом модели этому правилу
    // противоречит, но автоматом её менять нельзя: смена авы это вход в акк и решение по легенде.
    r.soft.push('на аве лицо модели (по правилу мультиакков ава должна быть промптовой, без лица)');
  } else if (isModel && (!a.face_state || a.face_state === 'no_ref' || a.face_state === 'unknown')) {
    // Сверка не состоялась. Причину называем точно: пустая лента (сверять не с чем) это НЕ то же
    // самое, что «до акка не дошёл чек».
    r.soft.push(!p.posts ? 'лицо не сверено: в ленте нет кадров' : 'лицо ни разу не сверялось (accheck по акку не проходил)');
  }

  // --- 5. БИО ---
  if (isModel) {
    if (!p.bio) {
      r.hard.push('пустое био');
      order('bio', `node setbio.cjs ${JSON.stringify(a.slug)}`, 'био пустое');
    } else if (!BRAND_RE.test(p.bio)) {
      r.soft.push('в био нет нашей ссылки');
      order('bio', `node setbio.cjs ${JSON.stringify(a.slug)}`, 'в био нет ссылки');
    }
  }
  if (!p.name) r.hard.push('имя профиля пусто');
  if (p.private) r.hard.push('профиль закрыт (нас не видно)');

  // --- 6. ПОСТЫ: есть ли вообще и нет ли ЧУЖИХ в сетке (новая проверка) ---
  // ПОВОД (02.08): @amari277525 ушёл в постинг с двумя стоковыми постами прежнего владельца и
  // нашим роликом между ними — профиль читается как угнанный. accheck сверяет ЛИЦА в ленте, но
  // не знает, наши ли это публикации; postreconcile показывает сирот только у зависших постов.
  // Здесь сверяем ленту со своей таблицей posts целиком.
  if (isModel) {
    if (!p.posts) {
      r.hard.push('в ленте НЕТ постов' + (a.dressed_at ? ' у оформленного акка' : ''));
      r.human.push('акк оформлен, но не публикует: проверить, доходят ли до него задачи');
    }
    const orphans = (p.feed || []).filter((m) => !ourCodes.has(m.code));
    // Сироту старше нашей первой записи по этому акку мы физически не могли опубликовать —
    // значит это пост прежнего владельца. Более свежая сирота это НАШ пост с потерянным исходом
    // (external_url не доехал), его разбирает postreconcile, а не чистка.
    const foreign = orphans.filter((m) => !ourFloor || (m.taken_at && m.taken_at < ourFloor));
    const lost = orphans.filter((m) => !foreign.includes(m));
    if (foreign.length) {
      r.hard.push(`ЧУЖИЕ ПОСТЫ В СЕТКЕ: ${foreign.length} (${foreign.slice(0, 4).map((m) => m.code).join(', ')})`);
      order('grid', `CLEAN_ONLY=1 node prepacc.cjs ${JSON.stringify(a.slug)}`, `${foreign.length} чужих постов прежнего владельца`);
    }
    r.foreign = foreign.length;
    if (lost.length) r.soft.push(`в ленте ${lost.length} наших публикаций без ссылки в базе (потерянный исход) → postreconcile`);
  }

  return r;
}

// ─────────────────────────── КРУГ ───────────────────────────
// СТОРОЖ КРУГА (07.08). Круг зовут из accjanitorloop.sh обычным `node accjanitor.cjs` БЕЗ внешнего
// таймаута, то есть повисший круг останавливает всё дежурство навсегда, и снаружи это видно только
// по молчанию лога. Лимит 90 минут: внутри круга живут синхронные дети с таймаутами 40+10+20 минут
// (accheck, glrename, postreconcile), плюс обход фермы курлом.
const wd = armWatchdog({ minutes: Number(process.env.JANITOR_MINUTES || 90), stallMinutes: 12,
  label: 'круг уборщика акков' });

(async () => {
  if (!takeLap()) { wd.done(0, 'круг уже идёт в другом процессе, выхожу'); return; }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date();
  const L = [];                                       // строки отчёта
  const say = (s = '') => { console.log(s); L.push(s); };
  const fixed = [];                                   // что починили сами
  const forHuman = [];                                // что требует начальника
  const needLogin = [];                               // что требует входа в акк

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = (sql, par) => c.query(sql, par);

  say(`УБОРЩИК АККОВ — круг ${started.toISOString().slice(0, 16).replace('T', ' ')} `
    + `(${FIX ? 'С ПОЧИНКОЙ безопасного' : 'СУХОЙ ПРОГОН, ничего не меняю'})`);
  say(`входы в акки: ${LOGIN_ON ? `разрешены, не больше ${LOGIN_MAX} за круг` : 'ВЫКЛЮЧЕНЫ (только помечаю «нужен вход»)'}`
    + `; фабрика постов ${genpostsBusy() ? 'ЗАНЯТА (окна не открываем)' : 'свободна'}`);
  say('');

  wd.stage('фаза 0: пробный запрос в инстаграм');
  // ── ФАЗА 0. Пробный запрос: не режет ли нас Instagram ───────────────────────────────────────
  // Один анонимный запрос ДО всего остального. Если IP в троттлинге, то и платная сверка лиц, и
  // обход фермы дадут только «подождите пару минут»: accheck сожжёт vision-запросы впустую, а
  // отчёт выйдет пустым. Проверки по базе (фазы 3-5) от этого не зависят и идут как обычно.
  // Сначала дешёвая проверка по часам: если обход был меньше EXT_GAP_MIN назад, второй раз не идём
  // (см. EXT_GAP_MIN — именно так мы и заработали стену от IG на приёмке). Ручной запуск с --accheck
  // это правило снимает: значит человек осознанно хочет свежий обход.
  let extAgoMin = Infinity;
  try { extAgoMin = (Date.now() - fs.statSync(EXT_STAMP).mtimeMs) / 60000; } catch {}
  const tooSoon = !RUN_ACCHECK && !ONLY && extAgoMin < EXT_GAP_MIN;
  const probeH = tooSoon ? null : (await q(`SELECT coalesce(ig_login,slug) h FROM accounts
     WHERE deleted_at IS NULL AND session_status='live' AND coalesce(persona,'')<>'' LIMIT 1`)).rows[0];
  const probe = probeH ? profileOf(probeH.h) : null;
  const igThrottled = tooSoon || !!(probe && probe.glitch && igp.isThrottle(probe.why));
  if (tooSoon) {
    say(`ФАЗА 0: внешний обход был ${extAgoMin.toFixed(0)} мин назад (зазор ${EXT_GAP_MIN} мин) — снаружи в этом круге не хожу.`);
    say('  Проверки по базе и хвосты идут как обычно. Так мы не заработаем стену «подождите пару минут» от Instagram.');
    say('');
  } else if (igThrottled) {
    say(`ФАЗА 0: Instagram троттлит наш IP («${probe.why}») — внешнее чтение и сверку лиц в этом круге ПРОПУСКАЮ.`);
    say('  Проверки по базе и хвосты идут как обычно. Вердиктов по профилям в этом круге не будет.');
    forHuman.push('Instagram троттлил наш IP на входе в круг — внешние проверки пропущены. Если это повторяется каждый круг, увеличить JANITOR_EVERY или пустить анонимное чтение через прокси из proxy_pool');
    say('');
  }

  wd.stage('фаза 1: сверка лиц');
  // ── ФАЗА 1. Платная сверка лиц отдаётся accheck.cjs, и только если она устарела ──────────────
  // Своей сверки лиц здесь нет и не будет: две реализации одного vision-вопроса разъедутся.
  const stale = (await q(`SELECT count(*) n FROM accounts WHERE deleted_at IS NULL AND session_status='live'
      AND (health_checked_at IS NULL OR health_checked_at < now() - ($1 || ' hours')::interval)`,
    [String(ACCHECK_EVERY_H)])).rows[0].n;
  if (!igThrottled && (RUN_ACCHECK || (FIX && Number(stale) > 0))) {
    say(`ФАЗА 1: сверка лиц (accheck.cjs) — устаревших вердиктов ${stale}`);
    const rr = spawnSync('node', [path.join(__dirname, 'accheck.cjs')].concat(ONLY ? [ONLY] : []),
      { cwd: __dirname, encoding: 'utf8', timeout: 40 * 60000, env: process.env });
    wd.poke('сверка лиц закончилась, разбираю вывод');
    const out = String(rr.stdout || '') + String(rr.stderr || '');
    fs.writeFileSync(path.join(OUT_DIR, 'accheck-last.txt'), out);
    const itог = out.split('\n').filter((x) => /^ИТОГ:/.test(x)).pop() || 'accheck не дал итога';
    say(`  ${itог}  (полный вывод: ${path.join(OUT_DIR, 'accheck-last.txt')})`);
  } else {
    say(`ФАЗА 1: сверку лиц не гоню (${igThrottled ? (tooSoon ? 'внешний обход в этом круге пропущен' : 'IG троттлит') : `устаревших вердиктов ${stale}, порог ${ACCHECK_EVERY_H}ч, `
      + 'в сухом прогоне платная сверка не запускается — нужен --accheck'})`);
  }
  say('');

  wd.stage('фаза 2: обход акков снаружи');
  // ── ФАЗА 2. Каждый акк снаружи + ник + сетка ─────────────────────────────────────────────────
  const where = [`a.deleted_at IS NULL`, `a.platform IN ('promo','comments')`];
  const par = [];
  if (ONLY) { par.push(ONLY); where.push(`(a.slug=$1 OR a.ig_login=$1 OR a.persona=$1)`); }
  const accs = (await q(`SELECT a.id, a.slug, a.acc_no, coalesce(a.ig_login,a.slug) h, a.persona, a.platform,
      a.status, a.ig_status, a.session_status, a.health_state, a.health_note, a.face_state,
      a.dressed_at, a.dress_at, a.ig_proxy, a.proxy_status, a.relogin_try_at, a.is_spare,
      (a.gologin_profile_id IS NOT NULL) has_pid, coalesce(a.ig_password,'')<>'' has_pass,
      to_char(a.health_checked_at,'MM-DD HH24:MI') hchk,
      (SELECT max(p.published_at) FROM posts p WHERE p.account_id=a.id AND p.status='published') last_pub,
      (SELECT min(p.created_at) FROM posts p WHERE p.account_id=a.id) first_row,
      (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published') pub_cnt
     FROM accounts a WHERE ${where.join(' AND ')}
    ORDER BY (coalesce(a.persona,'')='') , a.persona, a.slug`, par)).rows
    .filter((a) => !SERVICE.has(a.slug));

  // Внешнее чтение имеет смысл для живых и для всех модельных (мёртвая модель — это тоже наша
  // витрина, её профиль надо видеть). Остальным хватает проверок по базе.
  const toRead = igThrottled ? [] : accs.filter((a) => a.session_status === 'live' || a.persona);
  say(igThrottled ? `ФАЗА 2: внешний обход пропущен (${tooSoon ? `был ${extAgoMin.toFixed(0)} мин назад` : 'IG троттлит наш IP'})`
    : `ФАЗА 2: смотрю снаружи ${toRead.length} акк(ов) из ${accs.length} (анонимно, без входов и окон)`);
  // Метку ставим ДО обхода: если круг упадёт на середине, зазор всё равно отсчитается от начала —
  // повторить обход через минуту после падения хуже, чем пропустить один круг.
  if (!igThrottled && toRead.length) { try { fs.writeFileSync(EXT_STAMP, new Date().toISOString()); } catch {} }

  // ЗАЩИТА ОТ ТРОТТЛИНГА IG (поймано на приёмке 06.08). После четырёх кругов подряд плюс accheck
  // Instagram начал отвечать «Please wait a few minutes before you try again» на ВСЕ анонимные
  // запросы с нашего IP. Дальше долбить ферму бессмысленно и вредно: 27 запросов в стену только
  // продлевают наказание, а отчёт получается пустой. Три подряд таких ответа = круг прерываем и
  // говорим прямо, что он НЕДОСТОВЕРЕН. Своё состояние в базе при этом не портится: вердикты по
  // профилю мы вообще не пишем, а accheck при сбое IG базу не трогает по своему контракту.
  let rlRow = 0, throttled = false;
  const results = [];
  for (const [ai, a] of toRead.entries()) {
    if (throttled) break;
    // Сердцебиение обхода: без него самая длинная фаза круга снаружи выглядит как висяк.
    wd.poke(`фаза 2: акк ${ai + 1} из ${toRead.length} (${a.slug})`);
    const ours = new Set((await q(`SELECT external_url FROM posts WHERE account_id=$1 AND external_url IS NOT NULL`,
      [a.id])).rows.map((x) => PV.codeOf(x.external_url)).filter(Boolean));
    const floor = a.first_row ? new Date(a.first_row) : null;
    const r = await checkAccount(c, a, ours, floor).catch((e) => ({
      slug: a.slug, h: a.h, persona: a.persona || '', platform: a.platform,
      hard: [`ошибка проверки: ${String(e.message).slice(0, 70)}`], soft: [], need: [], human: [], ext: null }));
    r.acc = a;
    results.push(r);
    const mark = r.hard.length ? '✗' : (r.soft.length ? '·' : '✓');
    say(`  ${mark} ${String(r.h).padEnd(28)} ${r.hard.length ? r.hard.join('; ') : (r.soft.length ? r.soft.join('; ') : 'ОК')}`);
    for (const n of r.need) needLogin.push({ slug: a.slug, h: a.h, ...n });
    for (const x of r.human) forHuman.push(`@${a.h}: ${x}`);
    if (r.ext && r.ext.glitch && igp.isThrottle(r.ext.why)) {
      if (++rlRow >= 3) {
        throttled = true;
        say(`  ⛔ Instagram троттлит наш IP («${r.ext.why}») — круг ПРЕРВАН на ${results.length}-м акке.`);
        say('     Вердиктов по профилям в этом круге нет; следующий круг возьмёт их заново.');
        forHuman.push('круг снаружи НЕДОСТОВЕРЕН: Instagram троттлил наш IP («подождите пару минут»). Если повторяется каждый круг — увеличить JANITOR_EVERY или пустить чтение через анонимные прокси из proxy_pool');
      }
    } else rlRow = 0;
    await sleep(GAP_MS);
  }
  say('');

  wd.stage('фаза 3: сверка полей базы с контрактом');
  // ── ФАЗА 3. ПОЛЯ БАЗЫ ПРОТИВ КОНТРАКТА (ARCHITECTURE §3) ────────────────────────────────────
  // Этого не проверял никто, и именно здесь копятся сожжённые попытки входа. Каждая проверка —
  // ссылка на инвариант, а не «мне так кажется».
  say('ФАЗА 3: сверка полей в базе с контрактом (ARCHITECTURE §3)');
  const drift = [];

  // C0. РАБОТАЕТ ЛИ ЗАМОК АВТОСНОСА — проверяем ФАКТОМ, прежде чем на него опираться.
  //
  // Почему это первая проверка круга. Контракт §3 обещает: «ни один автомат не сносит акк с
  // health_state='keep' или с нашими публикациями». 06.08 выяснилось, что в ПРОДЕ этого обещания
  // нет: оба замка написаны, но лежат в НЕЗАКОММИЧЕННОМ src/worker.ts, а на Railway крутится сборка
  // без них (`git show HEAD:src/worker.ts` не содержит слова keep вовсе). Поэтому paused +
  // терминальный ig_status = снос в течение 20 минут, до 3 акков за цикл, невзирая на keep. Так
  // ушли zander33579 (14:16, ещё до уборщика), nico838020, devan47310, cason51726 — все с keep.
  //
  // Вывод, вшитый в код: уборщик НЕ ставит paused, пока не убедится, что замок держит. Проверка
  // простая и честная — снесли ли за последнюю неделю хоть один акк, у которого стоял keep.
  // Если да, замка в проде нет, и наша «починка инварианта 1» превращается в шредер фермы.
  const keepKilled = (await q(`SELECT slug, to_char(deleted_at,'MM-DD HH24:MI') del FROM accounts
     WHERE deleted_at > now() - interval '7 days' AND coalesce(health_state,'')='keep'
     ORDER BY deleted_at DESC LIMIT 5`)).rows;
  const PAUSE_FORCED = /^(1|true|yes)$/i.test(String(process.env.JANITOR_PAUSE_TERMINAL || ''));
  const lockBroken = keepKilled.length > 0 && !PAUSE_FORCED;
  if (keepKilled.length) {
    say(`  ⛔ ЗАМОК АВТОСНОСА НЕ РАБОТАЕТ В ПРОДЕ: за неделю снесено ${keepKilled.length} акк(ов) с health_state='keep' `
      + `(${keepKilled.map((x) => `${x.slug} в ${x.del}`).join(', ')})`);
    say(`     ${lockBroken ? 'Паузу по инварианту 1 НЕ СТАВЛЮ' : 'JANITOR_PAUSE_TERMINAL=1 — ставлю паузу под вашу ответственность'}: `
      + 'paused + терминальный ig_status = снос акка вместе с профилем в течение 20 минут.');
    forHuman.push(`ЗАМОК АВТОСНОСА НЕ ЗАДЕПЛОЕН. Оба замка (health_state='keep' и «есть наши публикации») написаны в src/worker.ts, но файл НЕ закоммичен, а на Railway работает сборка без них — снесено ${keepKilled.length} акк(ов) с keep за неделю. Пока не задеплоено, уборщик не ставит paused терминальным аккам (иначе он их убивает). Нужно: закоммитить и задеплоить src/worker.ts ЛИБО поставить AUTO_REPLACE_OFF=1 на web`);
  }

  // C1. Инвариант 1: терминальный ig_status ОБЯЗАН иметь status='paused'. Иначе maybeRelogin
  // каждые 20 минут жжёт попытки входа в забаненный акк, а замена его не подхватывает.
  // profile_lost сюда НЕ входит (инвариант 5: он остаётся warming, его поднимает rebuild).
  //
  // ⚠ ГЛАВНЫЙ УРОК ПРИЁМКИ 06.08, НЕ УДАЛЯТЬ ЭТОТ КОММЕНТАРИЙ. Первый прогон с починкой поставил
  // paused семи забаненным аккам — и через 20 минут воркер (maybeReplaceBlocked) СНЁС три из них
  // вместе с профилями GoLogin (jerimiah56338, mark755876, nick95738). Формально это контракт §3
  // (paused + терминальный = замена), но приказ начальника прямой: аккаунты не удалять никогда.
  // Оба замка автосноса их не держали: публикаций у них не было, а health_state='keep' никто не
  // успел поставить руками — человек физически не успевает за 20 минут.
  // Поэтому пауза ставится ТОЛЬКО ВМЕСТЕ с замком keep, одним UPDATE, без окна между ними.
  // Прежнее health_state не теряем: пишем его в health_note. Снять замок = health_state=NULL.
  const c1 = (await q(`SELECT id, slug, platform, ig_status, status, health_state,
      (SELECT count(*) FROM posts p WHERE p.account_id=accounts.id AND p.status='published') pub
     FROM accounts WHERE deleted_at IS NULL
       AND ig_status IN ('suspended','captcha','challenge','bad_login')
       AND status NOT IN ('paused','trash')`)).rows;
  for (const x of c1) {
    // Замок в проде не работает (C0) → пауза равна сносу акка. Тогда это не починка, а находка
    // для начальника: сначала деплой замков или AUTO_REPLACE_OFF=1, потом пауза.
    if (lockBroken) {
      forHuman.push(`@${x.slug}: нарушен инвариант 1 (ig_status='${x.ig_status}' при status='${x.status}') — НЕ чиню, потому что paused сейчас означает снос акка (см. замок автосноса выше). maybeRelogin тем временем жжёт попытки входа`);
      continue;
    }
    drift.push({ slug: x.slug, x,
      что: `ig_status='${x.ig_status}' при status='${x.status}'`,
      контракт: 'инвариант 1: терминальный статус обязан быть paused',
      // Замок keep нужен только тому, кого не держит замок «есть наши публикации».
      починка: Number(x.pub) ? `status='paused'` : `status='paused' + health_state='keep' (замок автосноса)`,
      sql: Number(x.pub)
        ? { text: `UPDATE accounts SET status='paused' WHERE id=$1`, par: [x.id] }
        : { text: `UPDATE accounts SET status='paused', health_state='keep',
              health_note=left(concat('уборщик: paused по инварианту 1 (ig_status=', $2::text,
                '), замок автосноса keep поставлен уборщиком, прежнее health_state=',
                coalesce(health_state,'-'), '. ', coalesce(health_note,'')), 400)
            WHERE id=$1`, par: [x.id, String(x.ig_status)] } });
  }

  // C2. Забаненный акк не может иметь живую сессию: suspended/captcha ставятся вместе с dead.
  const c2 = (await q(`SELECT id, slug, platform, ig_status, session_status FROM accounts
     WHERE deleted_at IS NULL AND ig_status IN ('suspended','captcha') AND session_status='live'`)).rows;
  for (const x of c2) {
    drift.push({ slug: x.slug, x, что: `ig_status='${x.ig_status}' при session_status='live'`,
      контракт: 'suspend/captcha ставятся вместе с session_status=dead', починка: `session_status='dead'`,
      sql: { text: `UPDATE accounts SET session_status='dead' WHERE id=$1`, par: [x.id] } });
  }

  // C3. Инвариант 5: profile_lost остаётся warming. Если его кто-то поставил на paused, акк
  // выпадает из maybeRebuildLostProfiles и профиль не пересоздаётся никогда.
  const c3 = (await q(`SELECT id, slug, platform, status FROM accounts
     WHERE deleted_at IS NULL AND ig_status='profile_lost' AND status='paused'`)).rows;
  for (const x of c3) {
    drift.push({ slug: x.slug, x, что: `profile_lost при status='paused'`,
      контракт: 'инвариант 5: profile_lost остаётся warming', починка: `status='warming'`,
      sql: { text: `UPDATE accounts SET status='warming' WHERE id=$1`, par: [x.id] } });
  }

  // C4. Пауза без терминальной причины. Разделено на ДВА случая, потому что путать их вредно:
  //   • health_state='need_login' — это ЗАКОННАЯ пауза куки-акка без пароля: авто-подъёма у него
  //     нет по контракту (инвариант 4), поднимают руками. Одна строка списком, не девять абзацев;
  //   • всё остальное — «залипшая пауза»: акк выглядит здоровым, а стоит. Снимать автоматом
  //     НЕЛЬЗЯ (paused терминален по контракту), снятие это решение человека через revive.
  const c4 = (await q(`SELECT slug, ig_status, health_state, session_status, left(coalesce(health_note,''),80) note
     FROM accounts WHERE deleted_at IS NULL AND status='paused'
       AND coalesce(ig_status,'') <> ALL ($1::text[])
       AND coalesce(health_state,'') NOT IN ('banned','restricted','needs_human_verify','suspended')`,
    [TERMINAL_IG])).rows;
  const waitHand = c4.filter((x) => x.health_state === 'need_login');
  if (waitHand.length) say(`  ждут РУЧНОГО входа (куки-акки без пароля, авто-подъёма нет по контракту): ${waitHand.length} — ${waitHand.map((x) => x.slug).join(', ')}`);
  for (const x of c4.filter((x) => x.health_state !== 'need_login')) {
    forHuman.push(`@${x.slug}: на паузе без терминальной причины (ig_status='${x.ig_status || '-'}', health='${x.health_state || '-'}', «${x.note}») — снимать только вашим решением (revive)`);
  }

  // C5. Подъём залип: акк мёртв, не на паузе, пароль есть, а попытки входа не было. Это тот самый
  // «релогин 0 за 24ч» из диагностики 22.07 — цикл жив, но акки не поднимаются. Терминальные
  // ig_status сюда НЕ берём: они попадают в C1 и после починки уйдут на paused, то есть их не
  // должен поднимать никто, и в списке «залип подъём» им делать нечего.
  const c5 = (await q(`SELECT slug, session_status, ig_status, relogin_try_at, session_checked_at,
      (SELECT count(*) FROM posts p WHERE p.account_id=accounts.id AND p.status='published') pub
     FROM accounts WHERE deleted_at IS NULL AND session_status='dead' AND status NOT IN ('paused','trash')
       AND coalesce(ig_password,'')<>'' AND coalesce(ig_status,'') <> ALL ($2::text[])
       AND (relogin_try_at IS NULL OR relogin_try_at < now() - ($1 || ' hours')::interval)`,
    [String(DEAD_STUCK_H), TERMINAL_IG])).rows;
  if (c5.length) forHuman.push(`подъём залип на ${c5.length} акк(ах): ${c5.map((x) => `${x.slug}${Number(x.pub) ? `(есть ${x.pub} публикаций!)` : ''}`).join(', ')}`
    + ` — мертвы, не на паузе, пароль есть, а попытки входа не было ${DEAD_STUCK_H}ч+ (relogin_try_at пуст)`);

  // C6. Живой акк, которого чек не видел сутки: значит наблюдение до него не доходит.
  const c6 = (await q(`SELECT slug, to_char(health_checked_at,'MM-DD HH24:MI') hchk FROM accounts
     WHERE deleted_at IS NULL AND session_status='live'
       AND (health_checked_at IS NULL OR health_checked_at < now() - interval '24 hours')`)).rows
    .filter((x) => !SERVICE.has(x.slug));
  if (c6.length) forHuman.push(`чек не доходит до ${c6.length} живых акк(ов): ${c6.map((x) => `${x.slug}(${x.hchk || 'никогда'})`).join(', ')}`);

  // C7. Наши публикации есть в базе, а снаружи постов ноль: так выглядит акк, спрятанный
  // чекпоинтом (06.08 так почти потеряли darya.smirnova13 с 16 публикациями). Автоматике здесь
  // делать нечего, это разбор человеком.
  for (const r of results) {
    if (r.ext && !r.ext.glitch && !r.ext.gone && Number(r.acc.pub_cnt) > 0 && !r.ext.posts) {
      forHuman.push(`@${r.h}: в базе ${r.acc.pub_cnt} наших публикаций, а снаружи лента ПУСТАЯ — похоже на чекпоинт, разобрать руками (не сносить)`);
    }
  }

  // C8. Реально без прокси. Акки на встроенном прокси GoLogin (proxy_status='gologin_*') сюда не
  // попадают: у них своего ig_proxy нет по замыслу (перевод на бесплатные прокси GoLogin 06.08),
  // и без этой оговорки отчёт врал бы про 20 «акков без прокси».
  const c8 = (await q(`SELECT slug, proxy_status FROM accounts WHERE deleted_at IS NULL
     AND session_status='live' AND ig_proxy IS NULL AND coalesce(proxy_status,'') NOT LIKE 'gologin%'`)).rows
    .filter((x) => !SERVICE.has(x.slug));
  if (c8.length) forHuman.push(`без прокси ${c8.length} живых акк(ов): ${c8.map((x) => x.slug).join(', ')}`);

  // C10. ЧТО ФЕРМА ПОТЕРЯЛА ЗА СУТКИ. Уборщик сам не удаляет ничего, но автозамена в воркере
  // удаляет, и начальник обязан это видеть в одном месте, а не узнавать по счёту акков. Повод:
  // 06.08 через 20 минут после починки инварианта 1 воркер снёс три акка вместе с профилями.
  const c10 = (await q(`SELECT slug, ig_status, to_char(deleted_at,'MM-DD HH24:MI') del FROM accounts
     WHERE deleted_at > now() - interval '24 hours' ORDER BY deleted_at`)).rows;
  if (c10.length) forHuman.push(`ферма потеряла ${c10.length} акк(ов) за сутки (снесла автозамена воркера, не уборщик): `
    + c10.map((x) => `${x.slug}/${x.ig_status || '-'} в ${x.del}`).join(', '));

  // C11. ДЫРА В ЗАМКЕ АВТОСНОСА. Замок §3 читает health_state='keep', а accheck.cjs его в своём
  // списке неприкосновенных (KEEP_STATE) НЕ держит: на живом акке очередной чек перепишет 'keep'
  // на 'ok'/'defect' и молча снимет защиту. Пока это не исправлено в accheck, замок ВОССТАНАВЛИВАЕМ
  // сами: акк, которого уборщик защищал (событие janitor_fix со словом keep), обязан остаться keep.
  // ГРАНИЦА, ЧТОБЫ НЕ СПОРИТЬ С НАЧАЛЬНИКОМ: восстанавливаем замок ТОЛЬКО если на его месте
  // оказался косметический вердикт чека (ok/defect/unknown/error) — это и есть след перезаписи.
  // Если начальник снял замок сам (NULL или любое другое значение), уборщик его не возвращает:
  // «разрешаю замену» должно оставаться исполнимым решением.
  const c11 = (await q(`SELECT a.id, a.slug, a.health_state FROM accounts a
     WHERE a.deleted_at IS NULL AND coalesce(a.health_state,'') IN ('ok','defect','unknown','error')
       AND EXISTS (SELECT 1 FROM account_events e WHERE e.slug=a.slug AND e.kind='janitor_fix'
                     AND e.detail->>'починка' LIKE '%keep%')`)).rows;
  for (const x of c11) {
    say(`  ⚠ ${x.slug}: замок автосноса keep потерян (сейчас health_state='${x.health_state || '-'}')`);
    if (FIX) {
      await q(`UPDATE accounts SET health_state='keep' WHERE id=$1`, [x.id]).catch(() => {});
      fixed.push(`${x.slug}: замок автосноса keep восстановлен (его перетёр другой чек)`);
    }
  }
  if (c11.length) forHuman.push(`замок автосноса health_state='keep' перетирается чеками (accheck.cjs не держит 'keep' в KEEP_STATE) — уборщик восстанавливает его каждый круг, но правильное место починки в accheck`
    + (lockBroken ? '. И помните: пока замок не задеплоен (см. выше), сам keep всё равно ничего не защищает' : ''));

  // C9. Пул прокси. Пустой пул = восстановление софт-блока и замена мёртвого прокси упираются
  // в «пул пуст» и тихо ничего не делают (worker: maybeFixProxy/maybeSoftblockRecover).
  const pool = (await q(`SELECT coalesce(status,'?') s, count(*) n FROM proxy_pool GROUP BY 1`)).rows;
  const free = Number((pool.find((x) => x.s === 'free') || {}).n || 0);
  say(`  пул прокси: ${pool.map((x) => `${x.s} ${x.n}`).join(', ') || 'пусто'}`);
  if (!free) forHuman.push('пул прокси ПУСТ (свободных 0): восстановление софт-блока и замена мёртвого прокси работать не будут — нужны новые sticky');

  for (const d of drift) say(`  ⚠ ${d.slug}: ${d.что} → ${d.контракт}`);
  if (!drift.length) say('  расхождений с контрактом нет');
  say('');

  wd.stage('фаза 4: хвосты');
  // ── ФАЗА 4. ХВОСТЫ ───────────────────────────────────────────────────────────────────────────
  say('ФАЗА 4: хвосты (посты и задачи в подвешенном состоянии)');

  // Х1. Зависшие задачи публикации. Порог и починка живут в предохранителе (reapStale), свою
  // копию не пишем.
  const t1 = (await q(`SELECT id, slug, to_char(updated_at,'MM-DD HH24:MI') upd FROM local_jobs
     WHERE mode='igpost' AND status='running' AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(STALE_JOB_MIN)])).rows;
  say(`  зависших igpost-задач (>${STALE_JOB_MIN} мин в running): ${t1.length}${t1.length ? ' — ' + t1.map((x) => `job#${x.id}/${x.slug}`).join(', ') : ''}`);

  // Х1б. Очередь стоит: задачи есть, а раннер их не берёт.
  const t1b = (await q(`SELECT count(*) n, min(created_at) old FROM local_jobs WHERE status='queued'`)).rows[0];
  if (Number(t1b.n) > 0) {
    const ageH = hoursAgo(t1b.old);
    say(`  задач в очереди: ${t1b.n}, самая старая ${ageH ? ageH.toFixed(1) : '?'}ч`);
    if (ageH && ageH > 1) forHuman.push(`очередь local_jobs стоит: ${t1b.n} задач, самая старая ${ageH.toFixed(1)}ч — проверить localrunner (./runners3.sh)`);
  } else say('  задач в очереди нет');

  // Х2. Посты с потерянным исходом (ambiguous/publishing без ссылки). Разбор — postreconcile.cjs,
  // он читает ленту снаружи и НИКОГДА не возвращает пост в очередь (инвариант: после Share ретрая нет).
  // Считаем ДВА числа и не смешиваем их: «висит прямо сейчас» (publishing/ambiguous — это живой
  // хвост, статистика врёт) и «всего без ссылки» (в него попадают уже закрытые failed/cancelled,
  // их postreconcile перепроверяет, но проблемой они не являются).
  const t2 = (await q(`SELECT p.id, p.status, a.slug FROM posts p JOIN accounts a ON a.id=p.account_id
     WHERE p.post_submitted=true AND p.external_url IS NULL AND p.status <> 'published'`)).rows;
  const t2live = t2.filter((x) => ['publishing', 'ambiguous', 'draft', 'approved'].includes(x.status));
  say(`  постов ВИСЯТ с потерянным исходом: ${t2live.length}${t2live.length ? ' — ' + t2live.map((x) => `${x.id.slice(0, 8)}/${x.slug}(${x.status})`).join(', ') : ''}`);
  say(`  всего строк без ссылки после Share: ${t2.length} (остальные уже закрыты как failed/cancelled)`);

  // Х3. Дыра ретраев раннера (память «дыра ретраев»): пост approved, слот в прошлом, живой задачи
  // нет — он не опубликуется никогда сам. Почему не ставим задачу автоматом: постановка задачи
  // публикации разрешена ТОЛЬКО через postguard.canPost (инвариант 8), и это уже действие, а не
  // уборка. Поэтому показываем факт и справку из предохранителя, а решение за начальником.
  const t3 = (await q(`SELECT p.id, a.slug, coalesce(a.ig_login,a.slug) h, to_char(p.scheduled_at,'MM-DD HH24:MI') sch
     FROM posts p JOIN accounts a ON a.id=p.account_id
    WHERE p.status='approved' AND p.scheduled_at < now() AND a.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM local_jobs j WHERE j.slug=a.slug AND j.mode='igpost' AND j.status IN ('queued','running'))
    ORDER BY p.scheduled_at`)).rows;
  say(`  approved со слотом в прошлом и без задачи: ${t3.length}`);
  const bySlug = new Map();
  for (const x of t3) { if (!bySlug.has(x.slug)) bySlug.set(x.slug, []); bySlug.get(x.slug).push(x); }
  for (const [slug, list] of bySlug) {
    // snapshot читает и НЕ пишет (в отличие от canPost, который попутно подметает задачи) —
    // поэтому сухой прогон остаётся честно сухим.
    const s = await PG.snapshot(q, slug).catch(() => null);
    const why = !s ? 'акк не найден'
      : s.status === 'paused' ? `акк на паузе (${String(s.hn || '').slice(0, 60)})`
      : s.session_status !== 'live' ? `сессии нет (session_status='${s.session_status}')`
      : s.ig_status !== 'login_ok' ? `ig_status='${s.ig_status}'`
      : Number(s.fails) ? `провалов за 3ч: ${s.fails}`
      : 'акк здоров — это дыра ретраев: задачу никто не поставил';
    say(`    ${slug}: ${list.length} пост(ов) (слоты ${list.map((x) => x.sch).join(', ')}) — ${why}`);
    forHuman.push(`@${list[0].h}: ${list.length} пост(ов) approved со слотом в прошлом без задачи — ${why}`);
  }
  say('');

  wd.stage('фаза 5: безопасная починка');
  // ── ФАЗА 5. БЕЗОПАСНАЯ ПОЧИНКА ───────────────────────────────────────────────────────────────
  // Безопасно = не открывает окно акка, не пишет в Instagram, не удаляет ничего. Ровно три вещи:
  // поля в базе по контракту, имена профилей GoLogin, снятие зависших задач и фиксация исходов.
  say(`ФАЗА 5: ${FIX ? 'починка безопасного' : 'что починил бы (сухой прогон)'}`);

  // Каждая починка несёт СВОЙ готовый UPDATE (d.sql), а не строку, которую надо разбирать: разбор
  // «status='paused'» на колонку и значение не умеет ставить два поля одним запросом, а замок keep
  // обязан встать в ТОМ ЖЕ UPDATE, что и пауза (см. урок в C1: между двумя запросами воркер успел
  // снести три акка).
  for (const d of drift) {
    const line = `${d.slug}: ${d.что} → ${d.починка}`;
    if (!FIX) { say(`  ~ ${line}`); continue; }
    const r = await q(d.sql.text, d.sql.par).catch((e) => { say(`  ✗ ${d.slug}: ${e.message.slice(0, 70)}`); return null; });
    if (!r) continue;
    await logEvent(c, { id: d.x.id, slug: d.slug, platform: d.x.platform }, 'janitor_fix',
      { что: d.что, контракт: d.контракт, починка: d.починка });
    fixed.push(line);
    say(`  ✓ ${line}`);
    if (/keep/.test(d.починка)) {
      forHuman.push(`@${d.slug}: снят с работы по инварианту 1 (${d.x.ig_status}) и ЗАЩИЩЁН от автосноса замком health_state='keep' — воркер его не удалит. Решите сами: держать или разрешить замену (health_state=NULL)`);
    }
  }

  // Имена профилей GoLogin «<acc_no> <ig_login>» — своя реализация не нужна, это glrename.cjs.
  {
    const rr = spawnSync('node', [path.join(__dirname, 'glrename.cjs')].concat(FIX ? [] : ['--dry']),
      { cwd: __dirname, encoding: 'utf8', timeout: 10 * 60000, env: process.env });
    const out = String(rr.stdout || '') + String(rr.stderr || '');
    const it = out.split('\n').filter((x) => /^ИТОГ:/.test(x)).pop() || 'glrename не ответил';
    say(`  GoLogin, имена профилей: ${it}`);
    for (const l of out.split('\n').filter((x) => /^[✓~]/.test(x.trim()))) say(`    ${l.trim()}`);
    if (FIX && /переименовано [1-9]/.test(it)) fixed.push(`GoLogin: ${it}`);
  }

  // Зависшие задачи публикации — снимает предохранитель, порог его же.
  if (t1.length) {
    if (FIX) { const n = await PG.reapStale(q); fixed.push(`снято зависших igpost-задач: ${n}`); say(`  ✓ снято зависших задач: ${n}`); }
    else say(`  ~ снял бы ${t1.length} зависших задач (postguard.reapStale)`);
  }

  // Исходы постов — postreconcile.cjs (читает ленту снаружи, ретраев не делает). Зовём ТОЛЬКО
  // когда есть живой хвост: у уже закрытых failed он лишь перепишет текст ошибки, а круг идёт
  // каждый час — такая молотилка засоряет и лог, и историю постов.
  if (t2live.length) {
    const rr = spawnSync('node', [path.join(__dirname, 'postreconcile.cjs')].concat(FIX ? ['--apply'] : []),
      { cwd: __dirname, encoding: 'utf8', timeout: 20 * 60000, env: process.env });
    const out = String(rr.stdout || '') + String(rr.stderr || '');
    fs.writeFileSync(path.join(OUT_DIR, 'postreconcile-last.txt'), out);
    const it = out.split('\n').filter((x) => /^ИТОГ:/.test(x)).pop() || 'postreconcile не дал итога';
    say(`  исходы постов: ${it}`);
    if (FIX) fixed.push(`исходы постов: ${it}`);
  }
  say('');

  wd.stage('фаза 6: починка входом');
  // ── ФАЗА 6. ПОЧИНКА ВХОДОМ (по умолчанию только помечаем) ────────────────────────────────────
  // Порядок работ внутри одного захода уже решён в prepacc.cjs (чистка → ава → ник, ник другим
  // днём) — свой порядок не выдумываем, просто зовём его по одному акку.
  say(`ФАЗА 6: работы, требующие входа в акк — ${needLogin.length}`);
  const byAcc = new Map();
  for (const n of needLogin) { if (!byAcc.has(n.slug)) byAcc.set(n.slug, []); byAcc.get(n.slug).push(n); }

  // ЕДИНЫЙ ОТБОР «можно ли сейчас входить». Считается ОДИН раз и печатается рядом с каждой работой,
  // чтобы список читался как план: сначала видно, что мешает, потом уже кто пойдёт в работу.
  // Пороги здесь не про качество работы, а про ЧАСТОТУ заходов: акки жжёт именно она (03.08).
  const busy = new Set((await q(`SELECT slug FROM local_jobs WHERE mode='igpost' AND status IN ('queued','running')`)).rows.map((x) => x.slug));
  const recentLogin = new Set((await q(`SELECT slug FROM account_events WHERE kind='janitor_login'
      AND created_at > now() - ($1 || ' hours')::interval`, [String(ACC_LOGIN_COOLDOWN_H)])).rows.map((x) => x.slug));
  const blocker = (a) => !a ? 'акка нет в выборке'
    : busy.has(a.slug) ? 'по акку идёт публикация'
    : recentLogin.has(a.slug) ? `уборщик заходил меньше ${ACC_LOGIN_COOLDOWN_H}ч назад`
    : (a.status === 'paused' || a.status === 'trash') ? `status='${a.status}' (сначала ваше решение)`
    : ['banned', 'restricted', 'needs_human_verify'].includes(String(a.health_state)) ? `health_state='${a.health_state}'`
    : a.session_status !== 'live' ? `сессии нет (session_status='${a.session_status}') — сначала подъём`
    : (hoursAgo(a.last_pub) !== null && hoursAgo(a.last_pub) * 60 < POST_QUIET_MIN) ? `публиковал ${Math.round(hoursAgo(a.last_pub) * 60)} мин назад, тишина ${POST_QUIET_MIN} мин`
    : genpostsBusy() ? 'занят /tmp/genposts.lock (идёт генерация)'
    : null;
  for (const [slug, list] of byAcc) {
    const a = accs.find((x) => x.slug === slug);
    const b = blocker(a);
    list.blocker = b;
    say(`  @${(list[0].h)}: ${list.map((x) => `${x.what} (${x.why})`).join('; ')}`);
    say(`      команда: ${list[0].how}${b ? `   [сейчас нельзя: ${b}]` : '   [можно входить]'}`);
  }
  if (!LOGIN_ON) {
    say(`  входы ВЫКЛЮЧЕНЫ (JANITOR_LOGIN=1 включает). Пороги анти-бана, когда включите:`);
    say(`      не больше ${LOGIN_MAX} заходов за круг, пауза ${LOGIN_GAP_MIN} мин между ними,`);
    say(`      один акк не чаще раза в ${ACC_LOGIN_COOLDOWN_H}ч, тишина ${POST_QUIET_MIN} мин после публикации,`);
    say(`      никогда: при живой igpost-задаче, при занятом /tmp/genposts.lock, на paused/banned/restricted.`);
  } else {
    // Сами заходы выполняет prepacc/dressup, уборщик только решает КОГО и СКОЛЬКО.
    let done = 0;
    for (const [slug, list] of byAcc) {
      if (done >= LOGIN_MAX) { say(`  стоп: за круг уже ${done} заход(а), больше не открываем`); break; }
      const a = accs.find((x) => x.slug === slug);
      if (!a) continue;
      // Гейты перечитываем перед КАЖДЫМ заходом: между заходами проходят минуты, и за это время
      // конвейер мог занять и акк, и профиль браузера.
      const skip = blocker(a);
      if (skip) { say(`  · ${slug}: вход пропускаю — ${skip}`); continue; }
      say(`  → ${slug}: ${list[0].how}`);
      const rr = spawnSync('sh', ['-c', list[0].how], { cwd: __dirname, encoding: 'utf8', timeout: 20 * 60000, env: process.env });
      const out = String(rr.stdout || '') + String(rr.stderr || '');
      fs.writeFileSync(path.join(OUT_DIR, `login-${slug.replace(/[^\w.-]+/g, '_')}.txt`), out);
      const it = out.split('\n').filter((x) => /^ИТОГ:/.test(x)).pop() || 'без итога';
      say(`     ${it}`);
      await logEvent(c, a, 'janitor_login', { работы: list.map((x) => x.what), итог: it.slice(0, 200) });
      fixed.push(`${slug}: вход — ${it.slice(0, 120)}`);
      // Кулдаун акка держим в памяти сразу, не дожидаясь следующего круга: событие в базе уже есть,
      // но пересчитывать сет на каждом шаге дороже, чем добавить один slug.
      recentLogin.add(slug);
      for (const x of (await q(`SELECT slug FROM local_jobs WHERE mode='igpost' AND status IN ('queued','running')`)).rows) busy.add(x.slug);
      done++;
      if (done < LOGIN_MAX) { say(`     пауза ${LOGIN_GAP_MIN} мин перед следующим заходом (анти-бан)`); await sleep(LOGIN_GAP_MIN * 60000); }
    }
  }
  say('');

  // ── ИТОГ И ОТЧЁТ ─────────────────────────────────────────────────────────────────────────────
  const bad = results.filter((r) => r.hard.length);
  say('═══ ИТОГ КРУГА ═══');
  if (igThrottled || throttled) {
    say(tooSoon
      ? `· внешних проверок в этом круге не было (обход делался ${extAgoMin.toFixed(0)} мин назад, зазор ${EXT_GAP_MIN} мин) — смотрите предыдущий отчёт в ${OUT_DIR}`
      : '⛔ ВНИМАНИЕ: внешние проверки в этом круге НЕДОСТОВЕРНЫ (Instagram троттлил наш IP). «Дефектов 0» тут не значит «всё хорошо».');
  }
  say(`проверено акков: ${accs.length} (снаружи ${results.length}), дефектных ${bad.length}`);
  say(`расхождений с контрактом: ${drift.length}${FIX ? `, починено ${fixed.length}` : ' (сухой прогон)'}`);
  say(`требуют входа в акк: ${byAcc.size}`);
  say('');
  if (fixed.length) { say('ПОЧИНЕНО САМО:'); for (const x of fixed) say(`  ✓ ${x}`); say(''); }
  if (byAcc.size) {
    // Сначала те, куда войти МОЖНО прямо сейчас: это и есть рабочий список на ближайший круг.
    const ready = [...byAcc].filter(([, l]) => !l.blocker);
    const later = [...byAcc].filter(([, l]) => l.blocker);
    say(`ТРЕБУЕТ ВХОДА В АКК (по одному, с паузами) — можно сейчас ${ready.length}, ждут ${later.length}:`);
    for (const [slug, list] of ready) say(`  ▸ ${slug}: ${list.map((x) => x.what).join(', ')} → ${list[0].how}`);
    for (const [slug, list] of later) say(`  · ${slug}: ${list.map((x) => x.what).join(', ')} — ждёт: ${list.blocker}`);
    say('');
  }
  if (forHuman.length) {
    say('ТРЕБУЕТ НАЧАЛЬНИКА (автоматика решать не вправе):');
    for (const x of [...new Set(forHuman)]) say(`  ! ${x}`);
    say('');
  }

  // Таблица по аккам — чтобы состояние читалось одним взглядом, без лазанья в базу.
  say('ТАБЛИЦА:');
  const cols = [['акк', 26], ['персона', 8], ['вердикт', 8], ['ник', 10], ['ава', 5], ['лицо', 9], ['био', 6], ['постов', 6], ['чужих', 6], ['статус базы', 26]];
  const line = (v) => v.map((x, i) => String(x == null ? '' : x).slice(0, cols[i][1]).padEnd(cols[i][1])).join(' | ');
  say(line(cols.map((x) => x[0])));
  say('-'.repeat(cols.reduce((s, x) => s + x[1] + 3, 0)));
  for (const r of results) {
    const a = r.acc; const p = r.ext || {};
    // Профиль не прочитан (сбой IG или профиля нет) — ставим «?»/«—», а НЕ «НЕТ»: иначе сбой сети
    // читается в таблице как «у акка нет авы», и человек идёт чинить то, чего не видел.
    const unread = !!(p.glitch || p.gone);
    const cell = (v) => (unread ? (p.gone ? '—' : '?') : v);
    say(line([r.h, r.persona,
      r.hard.length ? 'ДЕФЕКТ' : (p.glitch ? 'не прочтён' : (r.soft.length ? 'ок(зам)' : 'ОК')),
      a.persona ? (r.nickBad ? 'МУСОР' : 'ок') : '—',
      cell(p.pic && !/anonymousUser|profilePicDefault/i.test(p.pic) ? 'есть' : 'НЕТ'),
      // Метка 'no_ref' при живом файле эталона это устаревшая запись, а не проблема акка.
      a.face_state === 'no_ref' && hasRef(a.persona) ? 'устарел' : (a.face_state || '—'),
      cell(p.bio ? (BRAND_RE.test(p.bio) ? 'ссылка' : 'есть') : 'ПУСТО'),
      unread ? (p.gone ? '—' : '?') : p.posts, unread ? '?' : (r.foreign || 0),
      `${a.status}/${a.ig_status || '-'}/${a.session_status}`]));
  }

  const body = L.join('\n') + '\n';
  const stamp = started.toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');
  fs.writeFileSync(path.join(OUT_DIR, `report-${stamp}.txt`), body);
  fs.writeFileSync(path.join(OUT_DIR, 'last.txt'), body);
  console.log(`\nотчёт: ${path.join(OUT_DIR, 'last.txt')} (и report-${stamp}.txt)`);

  // Сводка круга в базу: по ней видно историю уборки, даже если файлы на маке потеряются.
  await c.query(`INSERT INTO account_events (slug, kind, detail) VALUES ('*','janitor_lap',$1)`,
    [JSON.stringify({ режим: FIX ? 'fix' : 'dry', проверено: accs.length, снаружи: results.length,
      троттлинг: igThrottled || throttled || undefined,
      дефектных: bad.length, расхождений: drift.length, починено: fixed.length,
      нужен_вход: byAcc.size, начальнику: [...new Set(forHuman)].length,
      минут: Number(((Date.now() - started.getTime()) / 60000).toFixed(1)) })]).catch(() => {});

  // Телеграм по умолчанию МОЛЧИТ (приказ начальника «выключи эту хуету»): канал есть, но включается
  // явным JANITOR_TG=1, и уходит только короткая сводка, не поток служебных сообщений.
  if (/^(1|true|yes)$/i.test(String(process.env.JANITOR_TG || '')) && (fixed.length || forHuman.length)) {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
    const token = process.env.TELEGRAM_BOT_TOKEN || read('/tmp/.tgtok') || read('/tmp/tg_bot.txt');
    const chat = process.env.TELEGRAM_CHAT_ID || read('/tmp/.tgchat') || read('/tmp/tg_chat.txt');
    if (token && chat) {
      const txt = `🧹 уборщик: проверено ${accs.length}, дефектных ${bad.length}, починено ${fixed.length}, `
        + `нужен вход ${byAcc.size}, вам ${[...new Set(forHuman)].length}`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: txt, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000) }).catch(() => {});
    }
  }

  await c.end();
  freeLap();
  // ЯВНЫЙ ВЫХОД (07.08). Круг зовут из accjanitorloop.sh без внешнего таймаута: повисший круг
  // останавливает дежурство навсегда, а лог просто перестаёт расти. Здесь мы всегда завершаемся
  // сами, а если работа встала внутри, нас снимет сторож ненулевым кодом.
  wd.done(0);
})().catch((e) => { freeLap(); wd.fail(e); });
process.on('exit', freeLap);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLap(); process.exit(0); });
