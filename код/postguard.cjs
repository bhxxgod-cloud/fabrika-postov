// ЕДИНЫЙ ПРЕДОХРАНИТЕЛЬ ПУБЛИКАЦИИ (06.08, приказ владельца «делай предохранители»).
//
// ЗАЧЕМ. Задачи публикации (local_jobs.mode='igpost') создавали ЧЕТЫРЕ разных источника, и у
// каждого был свой набор проверок или их отсутствие. Итог одного дня:
//   • cherry.mood59 (case17002) получил 25 заходов подряд ночью и 42 провала за час днём —
//     на аккаунте, которому Instagram уже выписал ограничение. Мы его добивали своими руками;
//   • ретрай в postdaemon.cjs ставил новую задачу сразу после провала → вечный цикл;
//   • ручной раздатчик blast_one_each.cjs не смотрел ни на провалы, ни на статус акка;
//   • акк с чекпоинтом мог уехать под автозамену вместе с профилем GoLogin.
// Дальше «добавить проверку в каждый скрипт» не работает: пятый скрипт напишется без неё.
// Поэтому решение НЕ в проверках по месту, а в ОДНОЙ функции, через которую обязаны проходить
// все источники, плюс финальный гейт в самом публикаторе (igpost2) — чтобы даже задача,
// поставленная руками через SQL, не открыла окно браузера на больном акке.
//
// КАК ПОЛЬЗОВАТЬСЯ.
//   const PG = require('./postguard.cjs');
//   const v = await PG.canPost(slug, { client: c });        // источник задач (стадия 'queue')
//   if (!v.ok) { console.log(v.reason); continue; }
//   const v = await PG.canPost(slug, { client: c, stage: 'run' });  // публикатор перед окном
//   await PG.noteFailure({ client: c, slug, error, jobId }); // после провала: учёт + алерт в ТГ
//
// CLI (проверка глазами):
//   node postguard.cjs              → таблица по всем живым аккам «можно постить / причина»
//   node postguard.cjs <slug|id>    → подробный разбор одного акка
//
// ДВЕ СТАДИИ. 'queue' (по умолчанию) — источник ставит задачу, проверяем ВСЁ. 'run' — публикатор
// уже держит задачу в руках, поэтому свою живую задачу не считаем занятостью, а межпостовый
// интервал не перепроверяем: он был решён в момент постановки (владелец сознательно обходит гэп
// прямым приказом через blast_one_each, и ронять уже поставленный пост на этом нельзя).
//
// ДВА КЛАССА ОТКАЗОВ. hard=true — безопасность аккаунта (статус, здоровье, сессия, провалы,
// дубль задачи, кулдаун оформления). Обойти нельзя НИЧЕМ, флага выключения нет и не будет.
// hard=false — темп (дневной лимит, интервал). Только их снимает POSTGUARD_PACING_OFF=1,
// и только под прямой приказ «гони сейчас».
'use strict';
const fs = require('node:fs');

// ─────────────────────────── ПОРОГИ (откуда взялось каждое число) ───────────────────────────

// Провалы. 2 за 3 часа = стоп: порог родился в postdaemon 05.08, когда damari1735 намотал
// 4 захода за полчаса на «чужие посты в сетке». Третий провал = акк болен → снимаем с постинга.
const FAIL_WINDOW_H = 3;
const FAIL_MAX = 2;
const FAIL_PAUSE = 3;
// Любой провал за последние 30 минут = стоп. Это ГЛАВНАЯ защита от долбёжки: 06.08 ретрай ставил
// новую задачу в ту же минуту, что и провал (заходы шли раз в минуту, 42 штуки за час). Полчаса —
// минимальная пауза, за которую человек успевает увидеть алерт и вмешаться.
const FAIL_QUIET_MIN = 30;

// Кулдаун после оформления. 03.08 четыре акка сгорели на кластере «подъём + чистка + ава + ник +
// первый пост» в одну минуту: для IG это выглядит как перехваченный аккаунт, который сразу погнали
// в работу. postdaemon держит 12 часов, здесь то же число (в облачном maybePushPromo стоит 6 —
// расхождение отмечено в отчёте, здесь берём строгий вариант).
// 07.08: начальник оформляет партию акков и постить с них хочет ЧЕРЕЗ 6 ЧАСОВ. Приводим к
// облачному числу (в maybePushPromo стоит 6), чтобы два места не спорили, и потому что 12 часов
// это была наша перестраховка, а не измеренный порог. Меняется одной переменной DRESS_COOLDOWN_H.
const DRESS_COOLDOWN_H = Number(process.env.DRESS_COOLDOWN_H || 6);

// Темп. Начальник 05.08: «на акках прогретые 5 постов в сутки, не гретые 2». Прогретость считаем
// по факту опубликованных НАШИХ постов (WARM_POSTS), интервалы оттуда же. Личный posts_per_day
// перебивает общий лимит, если он больше (у cherry.mood59 стоял 6 при 1437 просмотрах).
const WARM_POSTS = Number(process.env.WARM_POSTS || 5);
const DAY_WARM = 5;
const DAY_COLD = 2;
const GAP_WARM_H = 3;
const GAP_COLD_H = 6;
const GAP_FAST_H = 2; // при личном лимите 6+ постов в сутки 3 часа физически не укладываются

// Здоровье и статусы, при которых постить нельзя.
// status: 'paused' терминален по контракту (ARCHITECTURE §3), 'trash' — корзина.
const BLOCK_STATUS = ['paused', 'trash'];
// ПРАВКА НАЧАЛЬНИКА 06.08 («убери бред про здоровье»): блокируем ТОЛЬКО реально терминальное.
// Почему список был сокращён: поля здоровья в базе устаревают, и предохранитель глушил акки,
// которые фактически публиковали весь день (у шести из восьми стояли метки defect/dead при живых
// публикациях). Ограничение от Instagram всё равно ловится ФАКТОМ в igpost2 при заходе, а бан и
// требование живой верификации это единственные состояния, где заход бессмысленен и вреден.
// 'restricted' в список НЕ возвращать без разбора: акк с ограничением снимается по факту, а не
// по метке, иначе одна старая метка навсегда выключает рабочий аккаунт.
const BLOCK_HEALTH = ['banned', 'needs_human_verify'];

const LIMITS = {
  FAIL_WINDOW_H, FAIL_MAX, FAIL_PAUSE, FAIL_QUIET_MIN, DRESS_COOLDOWN_H,
  WARM_POSTS, DAY_WARM, DAY_COLD, GAP_WARM_H, GAP_COLD_H, GAP_FAST_H,
  BLOCK_STATUS, BLOCK_HEALTH,
};

// ПРИЗНАК ПРОВАЛА в local_jobs.result. Успех публикатор пишет одной фразой «✅ опубликовано → …»,
// всё остальное (вернул в очередь, ambiguous, брак, FATAL) считаем провалом. Пустой result не
// считаем: это ещё не закрытая или отменённая руками задача, а не провал акка.
// ФИКС 06.08 (аудит, пункт 14): отказы САМОГО предохранителя («ПРЕДОХРАНИТЕЛЬ [day_limit]» и
// прочие) считались провалами аккаунта, и исправные постеры глушились за 3 минуты: отказ по
// лимиту → провал 1 → fail_recent → провал 2 → fail_burst → акк снят. Свои отказы провалом НЕ
// считаем: провал это только реальный исход попытки публикации в Instagram.
const FAIL_PREDICATE = `j.status IN ('done','error')
   AND coalesce(j.result,'') <> '' AND j.result NOT ILIKE '%опубликовано%'
   AND j.result NOT ILIKE '%ПРЕДОХРАНИТЕЛЬ%'`;

// ─────────────────────────── доступ к базе ───────────────────────────

function dburl() {
  return process.env.DB_PUBLIC_URL || process.env.DATABASE_URL
    || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
}

// Предохранитель зовут и из .cjs-скриптов (свой pg.Client), и из воркера на TS (свой пул с
// хелпером query). Поэтому внутри работаем с ОДНОЙ абстракцией: q(sql, params) → {rows}.
// Свой коннект открываем только если ничего не дали — иначе жгли бы соединение на каждый акк.
async function withQuery(opts, fn) {
  if (typeof opts.query === 'function') return fn(opts.query);
  if (opts.client) return fn((sql, params) => opts.client.query(sql, params));
  const { Client } = require('pg');
  const c = new Client({ connectionString: dburl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return await fn((sql, params) => c.query(sql, params)); }
  finally { await c.end().catch(() => {}); }
}

const hours = (ms) => ms / 3600000;
const pacingOff = () => /^(1|true|yes)$/i.test(String(process.env.POSTGUARD_PACING_OFF || ''));

// ЗАВИСШАЯ ЗАДАЧА НЕ ДОЛЖНА БЛОКИРОВАТЬ АКК НАВСЕГДА.
// Раннер убивает публикатора по таймауту 20 минут и сам закрывает задачу. Но если убили сам
// раннер (это делает его сторож runnerguard.sh при зависании), задача остаётся в статусе
// 'running' навечно — и предохранитель честно отвечает «акк занят» до конца времён, то есть
// защита превращается в самоблокировку. Поэтому старше STALE_JOB_MIN закрываем сами и пишем
// человеческую причину: она же посчитается провалом (текста «опубликовано» в ней нет).
// 45 минут = таймаут раннера 20 мин с двойным запасом: живую работу не обрубаем.
const STALE_JOB_MIN = 45;
let lastReap = 0;
async function reapStale(q) {
  const r = await q(`UPDATE local_jobs SET status='done', updated_at=now(),
      result=concat(coalesce(result,''), 'ИТОГ: ✗ задача зависла (раннер умер, не закрыл её) — закрыта предохранителем')
    WHERE mode='igpost' AND status='running'
      AND updated_at < now() - ($1 || ' minutes')::interval
    RETURNING id, slug`, [String(STALE_JOB_MIN)]).catch(() => ({ rows: [] }));
  for (const j of r.rows || []) console.log(`[postguard] зависшая задача job#${j.id} (${j.slug}) закрыта: висела больше ${STALE_JOB_MIN} мин`);
  return (r.rows || []).length;
}

// ─────────────────────────── СНИМОК АККА ───────────────────────────
// Один запрос вместо шести: предохранитель зовут в цикле по всей ферме, и шесть round-trip'ов
// на акк превращали проверку в самую долгую часть тика.
async function snapshot(q, slugOrId) {
  const r = await q(`
    SELECT a.id, a.slug, coalesce(a.ig_login, a.slug) h, coalesce(a.persona,'') persona,
           coalesce(a.status,'') status, coalesce(a.ig_status,'') ig_status,
           coalesce(a.session_status,'') session_status, coalesce(a.health_state,'') hs,
           coalesce(a.health_note,'') hn, coalesce(a.posts_per_day,1) ppd,
           a.deleted_at, a.dress_at, a.dressed_at,
           (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published') total,
           (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published'
              AND p.published_at > now() - interval '24 hours') today,
           (SELECT max(p.published_at) FROM posts p WHERE p.account_id=a.id AND p.status='published') last_at,
           (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published') total_pub,
           (SELECT count(*) FROM local_jobs j WHERE j.slug=a.slug AND j.mode='igpost'
              AND j.status IN ('queued','running')) busy,
           (SELECT string_agg(j.id::text, ',') FROM local_jobs j WHERE j.slug=a.slug AND j.mode='igpost'
              AND j.status IN ('queued','running')) busy_ids,
           (SELECT count(*) FROM local_jobs j WHERE j.slug=a.slug AND j.mode='igpost'
              AND j.updated_at > now() - ($2 || ' hours')::interval AND ${FAIL_PREDICATE}) fails,
           (SELECT max(j.updated_at) FROM local_jobs j WHERE j.slug=a.slug AND j.mode='igpost'
              AND j.updated_at > now() - ($2 || ' hours')::interval AND ${FAIL_PREDICATE}) last_fail,
           -- Текст последнего провала берём ТОЛЬКО из окна: иначе в отказе цитировалась авария
           -- трёхдневной давности и человек шёл искать проблему, которой сейчас нет.
           (SELECT left(j.result, 200) FROM local_jobs j WHERE j.slug=a.slug AND j.mode='igpost'
              AND j.updated_at > now() - ($2 || ' hours')::interval AND ${FAIL_PREDICATE}
            ORDER BY j.updated_at DESC LIMIT 1) last_fail_text
      FROM accounts a
     WHERE a.slug = $1 OR a.id::text = $1
     LIMIT 1`, [String(slugOrId), String(FAIL_WINDOW_H)]);
  return r.rows[0] || null;
}

// ─────────────────────────── ГЛАВНАЯ ФУНКЦИЯ ───────────────────────────
// canPost(slugOrId, { client|query, stage, ignoreJobId }) → { ok, code, reason, hard, info }
async function canPost(slugOrId, opts = {}) {
  return withQuery(opts, async (q) => {
    const stage = opts.stage === 'run' ? 'run' : 'queue';
    // Подметаем зависшие задачи не чаще раза в минуту: canPost зовут в цикле по всей ферме,
    // и лишний UPDATE на каждый акк никому не нужен.
    if (Date.now() - lastReap > 60000) { lastReap = Date.now(); await reapStale(q); }
    const a = await snapshot(q, slugOrId);
    if (!a) return { ok: false, hard: true, code: 'no_account', reason: `акк «${slugOrId}» не найден в базе`, info: null };

    const who = `@${a.h}`;
    const deny = (code, reason, hard = true) => ({ ok: false, hard, code, reason, info: a });

    if (a.deleted_at) return deny('deleted', `${who}: акк удалён (deleted_at)`);
    if (BLOCK_STATUS.includes(a.status)) {
      return deny('status_paused', `${who}: status='${a.status}' — терминальный стоп-флаг${a.hn ? ` (${a.hn.slice(0, 90)})` : ''}`);
    }
    if (BLOCK_HEALTH.includes(a.hs)) {
      return deny('health_block', `${who}: health_state='${a.hs}' — постить запрещено${a.hn ? ` (${a.hn.slice(0, 90)})` : ''}`);
    }
    if (a.ig_status !== 'login_ok') {
      return deny('ig_not_ok', `${who}: ig_status='${a.ig_status || 'нет'}' (нужен login_ok) — сначала подъём`);
    }
    if (a.session_status !== 'live') {
      return deny('session_not_live', `${who}: session_status='${a.session_status || 'нет'}' (нужен live) — сессии нет`);
    }

    // Кулдаун после оформления: смена авы/ника + первый пост в один час = кластер, который убил
    // 4 акка 03.08. Берём самую позднюю из двух метрик — dress_at ставится в начале, dressed_at в конце.
    // ВАЖНАЯ ОГОВОРКА: кулдаун ловит именно связку «оформили → сразу первый пост». Если акк ПОСЛЕ
    // оформления уже успешно опубликовал, кластер состоялся или не состоялся, и держать акк ещё
    // 12 часов бессмысленно — а вреда много: prepacc/dressup бампают dress_at на каждом косметическом
    // прогоне, и без этой оговорки один прогон подготовки замораживает всю рабочую ферму на сутки.
    const dressedTs = Math.max(
      a.dress_at ? new Date(a.dress_at).getTime() : 0,
      a.dressed_at ? new Date(a.dressed_at).getTime() : 0,
    );
    const pubAfterDress = a.last_at && dressedTs && new Date(a.last_at).getTime() > dressedTs;
    // Кулдаун оформления нужен только НОВОМУ акку: связка «подъём, ава, ник, первый пост» в одну
    // минуту палит перехваченный аккаунт. У акка с историей публикаций это уже пройденный этап, а
    // косметическая смена авы (агенты сегодня меняли чужие лица) не должна выключать рабочую ферму
    // на 12 часов: так два постера с четырьмя и двумя публикациями встали ни за что.
    const hasHistory = Number(a.total_pub || 0) > 0;
    if (dressedTs && !pubAfterDress && !hasHistory && (Date.now() - dressedTs) < DRESS_COOLDOWN_H * 3600e3) {
      const left = (DRESS_COOLDOWN_H - hours(Date.now() - dressedTs)).toFixed(1);
      return deny('dress_cooldown', `${who}: оформлен ${hours(Date.now() - dressedTs).toFixed(1)}ч назад и с тех пор не постил — кулдаун ${DRESS_COOLDOWN_H}ч, ещё ${left}ч`);
    }

    // ПРОВАЛЫ. Два независимых правила: «серия» (акк болен) и «тишина» (не долбим сразу после провала).
    const fails = Number(a.fails || 0);
    if (fails >= FAIL_MAX) {
      return deny('fail_burst', `${who}: ${fails} провала за ${FAIL_WINDOW_H}ч — нужна ручная починка` +
        (a.last_fail_text ? ` | последняя причина: ${String(a.last_fail_text).replace(/\s+/g, ' ').slice(0, 110)}` : ''));
    }
    if (a.last_fail) {
      const minAgo = (Date.now() - new Date(a.last_fail).getTime()) / 60000;
      if (minAgo < FAIL_QUIET_MIN) {
        return deny('fail_recent', `${who}: провал ${minAgo.toFixed(0)} мин назад — тишина ${FAIL_QUIET_MIN} мин` +
          (a.last_fail_text ? ` | ${String(a.last_fail_text).replace(/\s+/g, ' ').slice(0, 110)}` : ''));
      }
    }

    // ДУБЛЬ ЗАДАЧИ. Две живые задачи на акк = две сессии = мёртвый акк. На стадии 'run' своя
    // задача уже в статусе running, поэтому её исключаем (по id, если он передан, иначе по счёту).
    const busyIds = String(a.busy_ids || '').split(',').filter(Boolean);
    const others = opts.ignoreJobId
      ? busyIds.filter((x) => String(x) !== String(opts.ignoreJobId))
      : (stage === 'run' ? busyIds.slice(1) : busyIds);
    if (others.length) {
      return deny('busy_job', `${who}: уже есть живая igpost-задача (job#${others.join(', #')}) — вторую не ставим`);
    }

    // ─── ТЕМП. Не безопасность акка, а дисциплина ленты: снимается POSTGUARD_PACING_OFF=1.
    const warm = Number(a.total) >= WARM_POSTS;
    const base = warm ? DAY_WARM : DAY_COLD;
    const limit = Math.max(base, Number(a.ppd) > 1 ? Number(a.ppd) : 0);
    const gapH = limit >= 6 ? GAP_FAST_H : (warm ? GAP_WARM_H : GAP_COLD_H);
    const skipPacing = pacingOff();
    if (!skipPacing && Number(a.today) >= limit) {
      return deny('day_limit', `${who}: дневной лимит ${a.today}/${limit} (${warm ? 'прогрет' : 'не грет'}${Number(a.ppd) > 1 ? `, личный ppd=${a.ppd}` : ''})`, false);
    }
    // Интервал на стадии 'run' не перепроверяем: он решён при постановке задачи.
    if (!skipPacing && stage === 'queue' && a.last_at) {
      const sinceH = hours(Date.now() - new Date(a.last_at).getTime());
      if (sinceH < gapH) {
        return deny('gap', `${who}: прошло ${sinceH.toFixed(1)}ч из ${gapH}ч интервала`, false);
      }
    }

    return {
      ok: true, hard: false, code: 'ok',
      reason: `${who}: можно (${warm ? 'прогрет' : 'не грет'}, ${a.today}/${limit} за сутки, шаг ${gapH}ч)`,
      info: { ...a, warm, limit, gapH },
    };
  });
}

// ─────────────────────────── АЛЕРТ В ТЕЛЕГРАМ ───────────────────────────
// Почему не через tgsend.cjs --service: tgsend умеет отправлять только медиа (без файла он
// выходит с ошибкой «не передано ни одного существующего файла»), а здесь нужен ЧИСТЫЙ текст.
// Токен и чат берём из тех же мест, что tgsend, чтобы не заводить второй источник правды.
function tgCreds() {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  const token = (process.env.TELEGRAM_BOT_TOKEN || read('/tmp/.tgtok') || read('/tmp/tg_bot.txt')).trim();
  const chat = (process.env.TELEGRAM_CHAT_ID || read('/tmp/.tgchat') || read('/tmp/tg_chat.txt')).trim();
  return { token, chat };
}

async function tgText(text) {
  // АЛЕРТЫ ПО УМОЛЧАНИЮ МОЛЧАТ (приказ начальника 06.08 «выключи эту хуету», «перестань слать
  // уведы о тестах»): поток служебных сообщений про предохранитель забил группу и мешал смотреть
  // сами посты. Всё пишется в лог, а в телеграм уходит ТОЛЬКО при явном POSTGUARD_ALERTS=1.
  if (!/^(1|true|yes)$/i.test(String(process.env.POSTGUARD_ALERTS || ''))) {
    console.log(`[postguard] алерт (в ТГ не шлём, POSTGUARD_ALERTS выкл):\n${text}`);
    return false;
  }
  // POSTGUARD_ALERT_DRY=1 — прогнать логику алерта БЕЗ отправки (проверка на подставных данных,
  // чтобы не сыпать в группу сообщениями о провалах, которых не было).
  if (/^(1|true|yes)$/i.test(String(process.env.POSTGUARD_ALERT_DRY || ''))) {
    console.log(`[postguard] (dry) алерт не отправлен, текст:\n${text}`);
    return true;
  }
  const { token, chat } = tgCreds();
  if (!token || !chat) { console.log('[postguard] ТГ не настроен (нет токена/чата) — алерт только в лог'); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { console.log(`[postguard] ТГ не принял алерт: ${j.description || r.status}`); return false; }
    return true;
  } catch (e) { console.log(`[postguard] ТГ недоступен: ${String(e.message).slice(0, 80)}`); return false; }
}

// noteFailure — единственная точка «случился провал публикации».
// ЗАЧЕМ: раньше про провал узнавали из лога через полчаса, когда акк уже получил 40 заходов.
// Теперь на ПЕРВОМ провале уходит сообщение владельцу: акк, персона, точный текст ошибки,
// счётчик за окно и что предохранитель после этого делает. Плюс тут же автоснятие с постинга
// на третьем провале — чтобы решение принималось в одном месте, а не в каждом планировщике.
// Алерты не спамят: шлём на 1-м провале (проблема началась) и на пороговом (постинг закрыт).
async function noteFailure({ client, query, slug, error, jobId } = {}) {
  return withQuery({ client, query }, async (q) => {
    const a = await snapshot(q, slug);
    if (!a) { console.log(`[postguard] провал по неизвестному акку «${slug}»`); return { fails: 0, alerted: false, paused: false }; }
    const fails = Number(a.fails || 0);
    let paused = false;
    const text = String(error || a.last_fail_text || '');

    // ОГРАНИЧЕНИЕ ОТ INSTAGRAM = стоп С ПЕРВОГО РАЗА, без счётчика. Именно здесь вся цена
    // инцидента 06.08: постер честно увидел «added a restriction to your account», написал это в
    // лог, вернул пост в очередь — и НИКУДА не записал. Для базы акк остался здоровым, поэтому
    // очередь подала его снова, и так 43 раза. Ждать трёх провалов, когда IG сказал прямым текстом,
    // бессмысленно. status='paused' здесь безопасен: автозамена сносит только challenge/suspended/
    // captcha/bad_login, а ig_status мы не трогаем (постер акки не судит — это его контракт).
    const RESTRICT_RX = /АККАУНТ ОГРАНИЧЕН|added a restriction|restricted your account|action_block|Couldn'?t post|We restrict certain activity/i;
    if (RESTRICT_RX.test(text) && (a.hs !== 'restricted' || !BLOCK_STATUS.includes(a.status))) {
      await q(`UPDATE accounts SET status='paused', health_state='restricted',
                 health_note=concat('снят предохранителем: IG сообщил об ограничении. ', $2::text)
               WHERE id=$1`, [a.id, text.replace(/\s+/g, ' ').slice(0, 260)]).catch(() => {});
      paused = true;
    }

    // Третий провал за окно = акк реально болен. Снимаем с постинга сами: очередь его иначе
    // долбит каждые 10 минут (06.08: cherry.mood59, 25 заходов в «аккаунт ограничен»).
    if (!paused && fails >= FAIL_PAUSE && !BLOCK_STATUS.includes(a.status)) {
      await q(`UPDATE accounts SET status='paused',
                 health_note=concat('снят предохранителем: ', $2::text, ' провалов за ', $3::text, 'ч')
               WHERE id=$1`, [a.id, String(fails), String(FAIL_WINDOW_H)]).catch(() => {});
      paused = true;
    }

    const verdict = await canPost(a.slug, { query: q });
    let alerted = false;
    if (fails === 1 || fails === FAIL_MAX || paused) {
      const lines = [
        `🚫 ПОСТИНГ: провал на @${a.h}${a.persona ? ` (${a.persona})` : ''}`,
        `ошибка: ${String(error || a.last_fail_text || 'текст не передан').replace(/\s+/g, ' ').slice(0, 400)}`,
        `провалов за ${FAIL_WINDOW_H}ч: ${fails}${jobId ? ` (последняя задача job#${jobId})` : ''}`,
        `предохранитель: ${verdict.ok ? 'постинг пока разрешён, следующий провал закроет' : verdict.reason}`,
      ];
      if (paused) lines.push(`акк СНЯТ с постинга (status=paused) — нужна ручная разборка`);
      alerted = await tgText(lines.join('\n'));
    }
    console.log(`[postguard] @${a.h}: провалов за ${FAIL_WINDOW_H}ч ${fails}${paused ? ', акк снят с постинга' : ''}${alerted ? ', алерт ушёл' : ''}`);
    return { fails, alerted, paused, verdict };
  });
}

module.exports = { canPost, noteFailure, reapStale, LIMITS, snapshot };

// ─────────────────────────── CLI ───────────────────────────
if (require.main === module) {
  const arg = process.argv[2];
  (async () => {
    const { Client } = require('pg');
    const c = new Client({ connectionString: dburl(), ssl: { rejectUnauthorized: false } });
    await c.connect();
    try {
      // Проверка канала алертов: без неё «алерт настроен» проверяется только настоящей аварией.
      if (arg === '--test-alert') {
        const ok = await tgText('🛡 ПРОВЕРКА СВЯЗИ предохранителя публикации (postguard.cjs).\n'
          + 'Так будет выглядеть сообщение о провале: акк, персона, текст ошибки, счётчик провалов за 3ч и что предохранитель сделал.');
        console.log(ok ? '✓ алерт доставлен в ТГ' : '⛔ алерт не доставлен (смотри сообщение выше)');
        return;
      }
      if (arg) {
        const v = await canPost(arg, { client: c, stage: process.argv.includes('--run') ? 'run' : 'queue' });
        console.log(v.ok ? `✅ МОЖНО — ${v.reason}` : `⛔ НЕЛЬЗЯ [${v.code}${v.hard ? '/жёстко' : '/темп'}] — ${v.reason}`);
        if (v.info) {
          const i = v.info;
          console.log(`   status=${i.status} ig=${i.ig_status} sess=${i.session_status} health=${i.hs} ppd=${i.ppd}`);
          console.log(`   опубликовано всего ${i.total}, за сутки ${i.today}, провалов за ${FAIL_WINDOW_H}ч ${i.fails}, живых задач ${i.busy}`);
          if (i.last_fail_text) console.log(`   последний провал: ${String(i.last_fail_text).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        return;
      }
      // Таблица по всей ферме. Смотрим ВСЕ неудалённые акки, а не только «живые»: половина
      // смысла отчёта — увидеть, что больные акки действительно получают отказ.
      const list = (await c.query(`SELECT slug, coalesce(ig_login,slug) h, coalesce(persona,'') persona
        FROM accounts WHERE deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY coalesce(ig_login,slug)`)).rows;
      const rows = [];
      for (const a of list) {
        const v = await canPost(a.slug, { client: c });
        rows.push({
          акк: a.h, персона: a.persona || '—',
          можно: v.ok ? 'ДА' : 'нет',
          класс: v.ok ? '' : (v.hard ? 'жёстко' : 'темп'),
          код: v.code,
          причина: v.ok ? '' : v.reason.replace(/^@\S+:\s*/, '').slice(0, 78),
        });
      }
      console.table(rows);
      console.log(`ИТОГ: можно постить ${rows.filter((r) => r.можно === 'ДА').length} из ${rows.length}`);
    } finally { await c.end().catch(() => {}); }
  })().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
}
