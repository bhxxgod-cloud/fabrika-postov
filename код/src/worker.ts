import { query, leaseDuePost, logAccountEvent, accountSnapshot } from './db/index.js';
import { connect, disconnect, checkSessionFast, probeEgress, lockKey, deleteCloudProfile, createCloudProfile, setProfileProxy, parseProxy, isInfraErr, gologinHealth, listAllProfiles } from './gologin.js';
import { driverFor, SessionError, CaptchaError } from './drivers/index.js';
import { runWarmupSession } from './warmup.js';
import { runSeedSession, runRadarEngagement, type EngagementResult } from './commenting.js';
import { generateRadarReply, generatePostPrompt, pickBrandBase } from './ai.js';
import { maybeRadar, ensureLoggedIn, passwordLogin, tiktokLogin, classifyIgScreen, type IgScreenInfo } from './radar.js';
import { isNightNow, networkGapClear, warmupDay, warmingDaysFor } from './scheduler.js';
import { withBrowserLock, withLoginSlot, tryReserveProfile, releaseProfile } from './lock.js';
import { startActivity, finishActivity, updateActivity } from './status.js';
import { notifyOwner, notifyPhoto, startTelegramPoll } from './notify.js';
import { uniquifyVideo, ffmpegAvailable } from './uniquify.js';
import { diagnoseProxy } from './proxycheck.js';
import { dismissAll, readyForWork } from './igdialogs.js';
import { analyzeScreenPage } from './screenanalyst.js';
import { drawProxy, poolFreeCount, releaseProxyBack } from './proxypool.js';
import { enterAlarm, dutyStatus } from './lock.js';
import { canPost } from './postguard.js';

const PUBLISH_EVERY = 60 * 1000;      // тик публикации — раз в минуту
const SESSIONS_EVERY = 30 * 60 * 1000; // проверка сессий — раз в 30 мин
const WARMUP_EVERY = 12 * 60 * 1000;   // тик прогрева — раз в ~12 мин
const SEED_EVERY = 15 * 60 * 1000;     // тик комментинг-фермы — раз в ~15 мин
const RELOGIN_EVERY = 20 * 60 * 1000;  // тик авто-релогина просевших акков — раз в ~20 мин
const WARMUP_CADENCE_MS = 8 * 60 * 60 * 1000; // каждый аккаунт греется раз в ~8 ч (≈2-3 раза в сутки)

let lastSessions = 0;
let lastWarmup = 0;
let lastSeed = 0;
let lastRelogin = 0;
let lastReplace = 0;
const REPLACE_EVERY = 20 * 60 * 1000; // тик авто-замены блокнутых акков — раз в ~20 мин
let lastFixProxy = 0; const FIXPROXY_EVERY = 10 * 60 * 1000;   // авто-реассайн прокси из пула (з.2)
let lastRebuild = 0; const REBUILD_EVERY = 15 * 60 * 1000;     // завод исчезнувших профилей profile_lost (з.3)
let lastReconcile = 0; const RECONCILE_EVERY = 60 * 60 * 1000; // сверка БД↔GoLogin, порт glreconcile (з.3)
let lastPoolLowAlert = 0;                                       // троттлинг алерта «резерв прокси на исходе»
const POOL_LOW = Math.max(1, Number(process.env.POOL_LOW) || 10);
// ВОТЧДОГ ЭФФЕКТИВНОСТИ РЕЛОГИНА («цикл жив, но НЕ поднимает акки»). lastReloginOk=now на старте — грейс
// на окно, чтобы свежий буст не алертил сразу. Успех любого входа сбрасывает эпизод.
let lastReloginOk = Date.now();
let reloginWatchAlerted = false;
let lastReloginWatch = 0; const RELOGIN_WATCH_EVERY = 30 * 60 * 1000;
const RELOGIN_WATCH_WINDOW = Math.max(30 * 60 * 1000, Number(process.env.RELOGIN_WATCH_WINDOW_MS) || 3 * 60 * 60 * 1000);
function noteReloginOk(): void { lastReloginOk = Date.now(); reloginWatchAlerted = false; } // успех → эпизод снят
// Кап пула logger для глобального семафора слотов: базово 3, в ЭКСТРЕНКЕ 5 (сработал relogin-watchdog =
// есть подъёмные акки при 0 успехов). Лишние 2 берутся из общего запаса, total семафор держит ≤15.
function loggerCap(): number { return reloginWatchAlerted ? 5 : 3; }

// Алерт владельцу: лог + Телеграм (если заданы TELEGRAM_* env). Fire-and-forget.
function alertOwner(msg: string) {
  void notifyOwner(msg);
}

// ИНСТРУМЕНТАЦИЯ провала входа: раздельная причина в account_events (detail->>'reason'), чтобы ВИДЕТЬ,
// где именно 0 успехов. Доменный исход passwordLogin → loginFailReason; throw из connect() → connectFailReason.
function loginFailReason(res: string): string { return res; } // challenge|captcha|bad_creds|need_login|error
function connectFailReason(msg: string): string { return /50[23]/.test(msg) ? '503' : isInfraErr(msg) ? 'connect_fail' : 'error'; }

// Алерт о паузе после 3× неудачных входов — С АВТО-ДИАГНОЗОМ прокси (частая причина: ротирующий/мёртвый прокси).
// Проверяет прокси акка (2 замера egress) и дописывает вердикт, чтобы не гадать «прокси/креды» вручную.
// ig_proxy добираем из БД по id, если его нет в acc (напр. в maybeRelogin SELECT его не тянем).
async function alertPauseDiag(acc: Record<string, any>, f: number, prefix: string): Promise<void> {
  let proxyRaw: string | null | undefined = acc.ig_proxy;
  if (proxyRaw === undefined) {
    try { proxyRaw = (await query<{ ig_proxy: string | null }>(`SELECT ig_proxy FROM accounts WHERE id=$1`, [acc.id])).rows[0]?.ig_proxy ?? null; }
    catch { proxyRaw = null; }
  }
  let diag = 'диагностика прокси не выполнена';
  try { diag = await diagnoseProxy(proxyRaw); } catch { /* оставим дефолт */ }
  alertOwner(`${prefix} ${acc.slug} не удался ${f}× подряд — на ПАУЗЕ.\n${diag}`);
}

// Вернуть арендованный пост обратно в очередь (аренда снята).
async function releasePost(postId: string) {
  await query(`UPDATE posts SET status='approved', locked_at=NULL WHERE id=$1`, [postId]);
}

// Замер точки выхода прокси, не чаще раза в сутки. Пьётся из уже открытой сессии —
// лишний слот браузера не занимаем. Сверяем гео с ожидаемым (acc.proxy.country).
async function maybeProbeEgress(acc: Record<string, any>, page: any) {
  const last = acc.egress_checked_at ? new Date(acc.egress_checked_at).getTime() : 0;
  if (Date.now() - last < 24 * 3600 * 1000) return; // раз в сутки достаточно
  const eg = await probeEgress(page);
  if (!eg) {
    // ЗАМЕР НЕ СОСТОЯЛСЯ, А НЕ «ПРОКСИ МЁРТВ» (07.08). Это суточный информационный замер, и раньше
    // он писал proxy_status='dead': акк выпадал из сидирования, а авто-починка тянула из пула новый
    // порт под живым прокси. Пишем 'unknown' — авто-реассайн такие акки не трогает (см. maybeFixProxy),
    // а гейт перед входом (ensureEgress) всё равно перепроверит.
    // ДВА СТРАЙКА. Первый провал = 'unknown' (не знаем), второй подряд = 'dead'. Каждый «провал»
    // это уже два разных сервиса по две попытки, так что два провала подряд говорят о канале, а не
    // о доступности одного сайта — и авто-починка (она берёт 'dead'/'mismatch') сможет переставить порт.
    await query(`UPDATE accounts SET proxy_status = CASE WHEN coalesce(proxy_status,'')='unknown' THEN 'dead' ELSE 'unknown' END,
                   egress_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    console.warn(`[egress] ${acc.slug}: замер не состоялся — первый раз 'unknown', второй подряд 'dead'`);
    return;
  }
  const want = String(acc.proxy?.country || '').trim().toUpperCase();
  // eg.country пустой = гео не замерили (ответил только резервный сервис). Пустое значение не есть
  // несовпадение, иначе получим ложный 'mismatch' и реассайн живого прокси.
  const status = !want || !eg.country ? 'ok' : eg.country === want ? 'ok' : 'mismatch';
  await query(
    `UPDATE accounts SET egress_ip=$2, egress_country=$3, proxy_status=$4, egress_checked_at=now() WHERE id=$1`,
    [acc.id, eg.ip, eg.country, status],
  ).catch(() => {});
  if (status === 'mismatch') {
    alertOwner(`Прокси ${acc.platform}/${acc.slug}: гео ${eg.country}, ожидали ${want} (IP ${eg.ip}) — проверь профиль`);
  }
}

// Гейт ПЕРЕД логин-попыткой: убеждаемся, что прокси реально жив (отдаёт egress-IP). Мёртвый прокси → логин
// НЕ пробуем (через него всё равно не зайти, а лишние попытки жгут акк). Гео-mismatch НЕ блокирует — только
// пишем статус. Ошибка самого замера логин не рубит (могла быть транзиентной). Возвращает true = можно логинить.
async function ensureEgress(acc: Record<string, any>, page: any): Promise<boolean> {
  // Троттл: недавно (<3д) подтверждён живым (proxy_status='ok') → probe НЕ жжём. Всё прочее
  // (unknown/dead/mismatch ИЛИ egress старше 3д) — замеряем сейчас. Это и есть гейт «egress>3д → проверить».
  const ts = acc.egress_checked_at ? new Date(acc.egress_checked_at).getTime() : 0;
  if (ts && Date.now() - ts < 3 * 24 * 3600 * 1000 && acc.proxy_status === 'ok') return true;
  try {
    const eg = await probeEgress(page);
    if (!eg) {
      // НЕ ЗАМЕРИЛИ — НЕ ЗНАЧИТ «МЁРТВ» (07.08). Раньше здесь стоял proxy_status='dead', и провал
      // зонда (оба сервиса не ответили) записывался как приговор каналу: авто-починка выдавала акку
      // новый порт из пула, и так пул проедался транзиентными сбоями. Пишем 'unknown'.
      // Вход всё равно НЕ пробуем (return false): непроверенный канал не повод жечь попытку входа,
      // а лишние логины с чужого IP жгут акк. Это нейтральный исход, а не отрицательный вердикт.
      // Два страйка (см. maybeProbeEgress): один провал = 'unknown', второй подряд = 'dead',
      // и тогда авто-починка переставит порт. Так транзиентный сбой зонда не проедает пул прокси.
      await query(`UPDATE accounts SET proxy_status = CASE WHEN coalesce(proxy_status,'')='unknown' THEN 'dead' ELSE 'unknown' END,
                     egress_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
      console.warn(`[egress-гейт] ${acc.slug}: канал не подтверждён (оба сервиса молчат) — вход не пробую, приговор только со второго раза`);
      return false;
    }
    const want = String(acc.proxy?.country || '').trim().toUpperCase();
    const status = !want || !eg.country ? 'ok' : eg.country === want ? 'ok' : 'mismatch';
    await query(`UPDATE accounts SET egress_ip=$2, egress_country=$3, proxy_status=$4, egress_checked_at=now() WHERE id=$1`, [acc.id, eg.ip, eg.country, status]).catch(() => {});
    return true;
  } catch { return true; }
}

// Провал входа (ensureLoggedIn=false): классифицируем ЧТО на экране и пишем честный статус.
// Терминальные (суспенд / вериф номера / чек-поинт / капча) → пауза + событие (сами не выйдут).
// Разлогин/неясно → просто dead (авто-релогин дожмёт паролем). Возвращает метку для честного алерта:
// «вериф номера», а не враньё «разлогинен» (из-за него горел Ismael). Страницу НЕ трогаем — не жжём акк.
async function markLoginFailed(acc: Record<string, any>, page: any): Promise<IgScreenInfo> {
  const scr: IgScreenInfo = await classifyIgScreen(page).catch(() => ({ kind: 'unknown', label: 'неопознанный экран', note: '' } as IgScreenInfo));
  if (scr.kind === 'suspended' || scr.kind === 'challenge_phone' || scr.kind === 'challenge') {
    const st = scr.kind === 'suspended' ? 'suspended' : 'challenge';
    await query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead', session_checked_at=now() WHERE id=$1`, [acc.id, st]).catch(() => {});
    void logAccountEvent(acc.id, acc.slug, acc.platform, st, await accountSnapshot(acc.id));
  } else if (scr.kind === 'unknown' || scr.kind === 'rate_limited') {
    // НЕОПОЗНАННЫЙ ЭКРАН ЭТО НЕ РАЗЛОГИН (07.08). classifyIgScreen отдаёт 'unknown' и когда страница
    // просто не догрузилась (прокси, таймаут, оборванный CDP), и раньше эта ветка писала dead: наша
    // инфраструктура выносила вердикт сессии. 'rate_limited' тем более про частоту наших заходов.
    // Статус оставляем как был, пусть следующий проход посмотрит ещё раз.
    console.warn(`[login-fail] ${acc.slug}: ${scr.label} — экран не опознан, session_status НЕ меняю`);
  } else {
    await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [acc.id]).catch(() => {});
  }
  return scr;
}

async function maybePublish(now: Date) {
  if (isNightNow(now)) return;              // ночная тишина
  if (!(await networkGapClear(now))) return; // min-gap между постами сетки

  const post = (await leaseDuePost(now)) as Record<string, any> | null; // без гонок (FOR UPDATE SKIP LOCKED)
  if (!post) return;

  const { rows } = await query<Record<string, any>>(`SELECT * FROM accounts WHERE id=$1`, [post.account_id]);
  const account = rows[0];
  if (!account || account.status === 'paused') { await releasePost(post.id as string); return; }

  // День первого поста по типу: новорег ~14, купленный ~6. Раньше — не публикуем.
  if (account.status === 'warming') {
    const wDays = warmingDaysFor(account.account_type);
    if (warmupDay(account.warmup_started_at, now) < wDays) {
      await releasePost(post.id as string); // ещё рано постить — держим в очереди
      return;
    }
    // После — максимум 1 пост/сутки в прогреве.
    if (account.last_posted_at && now.getTime() - new Date(account.last_posted_at).getTime() < 24 * 3600 * 1000) {
      await releasePost(post.id as string);
      return;
    }
  }

  // Уникализация видео — ВНЕ замка браузера (транскод не должен держать единственный слот).
  // Оригинал хранится один раз; каждому посту — свой сид, поэтому файлы разные.
  let media: { name: string; mimeType: string; buffer: Buffer } | undefined;
  if (post.media_upload_id) {
    const { rows: mu } = await query<Record<string, any>>(
      `SELECT filename, mime, bytes FROM media_uploads WHERE id=$1`, [post.media_upload_id],
    );
    const up = mu[0];
    if (!up?.bytes) {
      await query(`UPDATE posts SET status='failed', error=$2 WHERE id=$1`, [post.id, 'оригинал видео не найден']);
      alertOwner(`Пост ${post.id}: оригинал видео пропал — не опубликован`);
      return;
    }
    const name = up.filename || 'video.mp4';
    const level = post.uniquify_level || 'medium';
    if (level === 'none') {
      media = { name, mimeType: up.mime || 'video/mp4', buffer: up.bytes as Buffer };
    } else {
      try {
        const uq = await uniquifyVideo(up.bytes as Buffer, Number(post.uniquify_seed) || 0, level);
        media = { name, mimeType: uq.mime, buffer: uq.buffer };
      } catch (e) {
        // НЕ льём одинаковый оригинал на N акков — это был бы дубль (ровно то, от чего уникализируем).
        const msg = e instanceof Error ? e.message : 'ошибка';
        await query(`UPDATE posts SET status='failed', error=$2 WHERE id=$1`, [post.id, 'уникализация не удалась: ' + msg]);
        alertOwner(`Пост ${post.id}: уникализация не удалась — НЕ опубликован (иначе ушёл бы дубль). ${msg}`);
        return;
      }
    }
  }

  const driver = driverFor(account.platform);
  if (!tryReserveProfile(account.gologin_profile_id)) return; // профиль занят — опубликуем в следующий тик
  // Через замок GoLogin-аккаунта публикующего профиля (коннект env-токеном = акк1).
  try {
  await withBrowserLock(async () => {
    let session = null as Awaited<ReturnType<typeof connect>> | null;
    try {
      session = await connect(account.gologin_profile_id, undefined, { pool: 'logger', holder: account.slug });
      const res = await driver.publish(session.page, {
        caption: post.caption,
        mediaUrl: post.media_url,
        mediaType: post.media_type,
        replyText: post.reply_text,
        media,
      });

      if (res.maybePublished) {
        // Клик прошёл, подтверждение не поймали — НЕ ретраим (дубли + бан-сигнал).
        await query(
          `UPDATE posts SET status='failed', post_submitted=true, error=$2 WHERE id=$1`,
          [post.id, 'maybe-published: клик прошёл, подтверждение не поймано — проверь руками'],
        );
        alertOwner(`Пост ${post.id} возможно опубликован — проверь ленту вручную`);
      } else {
        await query(
          `UPDATE posts SET status='published', published_at=now(), external_url=$2 WHERE id=$1`,
          [post.id, res.externalUrl ?? null],
        );
        await query(`UPDATE accounts SET last_posted_at=now(), session_status='live', session_checked_at=now() WHERE id=$1`, [account.id]);
        // Подтягиваем ник/аватар/био из TikTok (best-effort — не роняем публикацию).
        if (session && driver.getProfileInfo) {
          const info = await driver.getProfileInfo(session.page).catch(() => null);
          if (info && (info.nick || info.avatarUrl || info.bio)) {
            await query(
              `UPDATE accounts SET tt_nick=coalesce($2,tt_nick), tt_avatar_url=coalesce($3,tt_avatar_url), tt_bio=coalesce($4,tt_bio), tt_profile_checked_at=now() WHERE id=$1`,
              [account.id, info.nick ?? null, info.avatarUrl ?? null, info.bio ?? null],
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      await handlePublishError(err, post, account, session);
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey());
  } finally { releaseProfile(account.gologin_profile_id); }
}

async function handlePublishError(err: unknown, post: Record<string, any>, account: Record<string, any>, session: any) {
  const message = err instanceof Error ? err.message : String(err);

  // Скриншот момента сбоя (гайдовый DEBUG-инвариант).
  if (session?.page) {
    await session.page.screenshot({ type: 'jpeg' }).then(async (buf: Buffer) => {
      // TODO: залить buf в сторедж и положить URL в meta; пока фиксируем факт.
      await query(`UPDATE posts SET meta = coalesce(meta,'{}'::jsonb) || $2 WHERE id=$1`, [
        post.id,
        JSON.stringify({ lastError: message, screenshotBytes: buf.length }),
      ]).catch(() => {});
    }).catch(() => {});
  }

  if (err instanceof SessionError) {
    await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [account.id]);
    await releasePost(post.id);
    alertOwner(`Сессия ${account.platform}/${account.slug} мертва — перелогинься в GoLogin`);
    return;
  }
  if (err instanceof CaptchaError) {
    await query(`UPDATE accounts SET status='paused' WHERE id=$1`, [account.id]);
    await releasePost(post.id);
    alertOwner(`Капча на ${account.platform}/${account.slug} — аккаунт на паузе, почисти руками`);
    return;
  }

  // Прочие ошибки — до-кликовый фейл, ретраить можно (до 3 попыток).
  const attempts = (post.attempts ?? 0) + 1;
  if (attempts >= 3) {
    await query(`UPDATE posts SET status='failed', attempts=$2, error=$3 WHERE id=$1`, [post.id, attempts, message]);
  } else {
    await query(`UPDATE posts SET status='approved', locked_at=NULL, attempts=$2, error=$3 WHERE id=$1`, [post.id, attempts, message]);
  }
}

async function maybeSessions() {
  // Рутина — БЫСТРЫЙ чек по кукам (REST, без браузера), чтобы не занимать единственный
  // слот профиля. Глубокий чек (браузер) — только по кнопке «Проверить сессии».
  const { rows } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.gologin_profile_id, a.session_status, a.session_checked_at, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.status <> 'paused' AND a.gologin_profile_id IS NOT NULL AND a.deleted_at IS NULL`,
  );
  let died = 0;
  for (const acc of rows) {
    const alive = await checkSessionFast(acc.gologin_profile_id, 'sessionid', acc.group_token).catch(() => null);
    if (alive === null) continue; // API моргнул / 5xx / 401 по токену группы — НЕ вердикт об акке
    // СВЕЖИЙ акк, ни разу не входивший (session_checked_at пуст, сессии ещё нет) — это НОВЫЙ (ПЕРВЫЙ вход впереди),
    // НЕ «перелогин». Не метим dead и НЕ ставим session_checked_at → останется «новый» в панели, maybeRelogin залогинит,
    // тогда станет live. Иначе чекер клеймил бы «перелогин» на акки, которые ещё не заходили ни разу (баг задержки).
    if (!alive && acc.session_checked_at == null && acc.session_status !== 'live' && acc.session_status !== 'dead') continue;
    let next = alive ? 'live' : 'dead';
    // grabli #3: кука врёт после отзыва сессии — dead->live НЕ по быстрому чеку.
    if (acc.session_status === 'dead' && next === 'live') next = 'dead';
    if (next === 'dead' && acc.session_status !== 'dead') died++;
    if (next !== acc.session_status) {
      await query(`UPDATE accounts SET session_status=$2, session_checked_at=now() WHERE id=$1`, [acc.id, next]);
    } else {
      // Отметку времени двигаем ВСЕГДА, даже если статус не изменился: иначе у стабильно живого акка
      // session_checked_at застывает, и вся сортировка «по свежести чека» (maybeRelogin, сторож тишины)
      // работает по мусорным данным.
      await query(`UPDATE accounts SET session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    }
  }
  // Массовая смерть за один проход — это НЕ акки, это инфраструктура (протухший токен группы, шторм
  // GoLogin). Раньше такое тихо уносило всю группу в dead, а храповик не пускал её обратно.
  if (died >= 5 && died >= Math.ceil(rows.length * 0.3)) {
    enterAlarm();  // ТРЕВОГА: резерв дежурных слотов 3→5, чтобы быстрее поднять волну упавших
    const d = dutyStatus();
    alertOwner(`⚠️ ТРЕВОГА: быстрый чек уронил ${died} из ${rows.length} за проход — похоже на инфраструктуру (токен группы/шторм GoLogin). Резерв дежурства поднят до ${d.reserve}/${d.total}. Проверь GOLOGIN-токен группы.`);
  }
}

// === СТОРОЖ ТИШИНЫ ===
// Дыра, которую он закрывает: акк, который никто не использовал (не комментил, не грелся, не был в
// радаре), НЕ проверялся браузером НИКОГДА. Быстрый чек (REST-кука) для него врёт — забаненный акк с
// лежащей в профиле кукой числится live бесконечно. Замкнутый круг: числится живым → никто не трогает
// → продолжает числиться живым. Здесь берём акк с САМЫМ СТАРЫМ реальным подтверждением и проверяем
// его настоящим браузером (ensureLoggedIn + чистый экран). Один акк за тик — дёшево по слотам/трафику.
const SILENCE_EVERY = 45 * 60 * 1000;      // тик сторожа — раз в ~45 мин
const SILENCE_STALE_H = 8;                 // «давно не подтверждали живьём» — старше 8 часов
const SILENCE_REST_CONC = Math.max(1, Number(process.env.SILENCE_REST_CONC) || 5); // параллельных REST-чеков
const SILENCE_WORK_STALE_H = Math.max(1, Number(process.env.SILENCE_WORK_STALE_H) || 30); // «давно не РАБОТАЛ» (для браузер-фазы)
const SILENCE_BROWSER_MAX = Math.max(1, Number(process.env.SILENCE_BROWSER_MAX) || 1); // сколько браузерных перепроверок за тик
let lastSilence = 0;

// #4 БАТЧ-МОЛЧУНЫ: раньше 1 браузер/45мин — не догоняло (82 молчуна). Теперь ФАЗА A — пачкой checkSessionFast
// (REST по кукам, без браузера) по ВСЕМ session_checked_at>8ч; ФАЗА B — браузер только тем, кто по REST live,
// но давно НЕ РАБОТАЛ (last_commented_at, не session_checked_at — его двигает и REST-батч).
async function maybeSilenceWatch() {
  const { rows } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, a.session_status, a.ig_login, a.last_commented_at, a.warmup_at, a.proxy, a.proxy_status, a.egress_checked_at, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.status <> 'paused' AND a.gologin_profile_id IS NOT NULL
       AND a.platform='comments'
       AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
       AND (a.session_checked_at IS NULL OR a.session_checked_at < now() - ($1 || ' hours')::interval)
     ORDER BY a.session_checked_at ASC NULLS FIRST`,
    [String(SILENCE_STALE_H)],
  );
  if (!rows.length) return;
  // ФАЗА A — REST-батч. Ратчет dead→live ТОЛЬКО реальным входом (checkSessionFast по куке врёт).
  const restLive: Record<string, any>[] = [];
  let died = 0, i = 0;
  const restWorker = async () => {
    while (i < rows.length) {
      const acc = rows[i++];
      const alive = await checkSessionFast(acc.gologin_profile_id, 'sessionid', acc.group_token).catch(() => null);
      if (alive === null) continue; // инфра/токен — НЕ вердикт
      let next = alive ? 'live' : 'dead';
      if (acc.session_status === 'dead' && next === 'live') next = 'dead'; // ратчет
      if (next === 'dead' && acc.session_status !== 'dead') died++;
      if (next !== acc.session_status) await query(`UPDATE accounts SET session_status=$2, session_checked_at=now() WHERE id=$1`, [acc.id, next]).catch(() => {});
      else await query(`UPDATE accounts SET session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {}); // двигаем отметку всегда
      if (next === 'live') restLive.push(acc);
    }
  };
  await Promise.all(Array.from({ length: SILENCE_REST_CONC }, restWorker));
  if (died >= 5 && died >= Math.ceil(rows.length * 0.3)) { enterAlarm(); const d = dutyStatus(); alertOwner(`⚠️ ТРЕВОГА: сторож тишины (REST) уронил ${died}/${rows.length} за проход — похоже инфра (токен группы/шторм), не акки. Резерв дежурства ${d.reserve}/${d.total}.`); }
  console.log(`[тишина] REST-батч: проверено ${rows.length}, live ${restLive.length}, died ${died}`);

  // ФАЗА B — браузер только REST-live, кто ДАВНО НЕ РАБОТАЛ (по last_commented_at/warmup_at).
  const staleWork = restLive
    .filter((a) => { const t = a.last_commented_at ? new Date(a.last_commented_at).getTime() : 0; const w = a.warmup_at ? new Date(a.warmup_at).getTime() : 0; return (!t || Date.now() - t > SILENCE_WORK_STALE_H * 3600 * 1000) && (!w || Date.now() - w > SILENCE_WORK_STALE_H * 3600 * 1000); })
    .sort((x, y) => (x.last_commented_at ? new Date(x.last_commented_at).getTime() : 0) - (y.last_commented_at ? new Date(y.last_commented_at).getTime() : 0))
    .slice(0, SILENCE_BROWSER_MAX);
  for (const acc of staleWork) {
    if (!tryReserveProfile(acc.gologin_profile_id)) continue;
    try {
      await withLoginSlot(async () => {
        let session = null as Awaited<ReturnType<typeof connect>> | null;
        try {
          session = await connect(acc.gologin_profile_id, acc.group_token, { pool: 'logger', poolCap: loggerCap(), holder: acc.slug });
          if (!(await ensureEgress(acc, session.page))) return; // прокси мёртв → maybeFixProxy переставит
          const logged = await ensureLoggedIn(session.page).catch(() => false);
          if (logged) {
            const ready = await readyForWork(session.page).catch(() => null);
            await query(`UPDATE accounts SET session_status='live', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
            console.log(`[тишина-браузер] ${acc.slug}: живой ✓ (${ready?.ok ? 'чисто' : ready?.why || '—'})`);
          } else {
            const relogged = await reloginInline(session, acc);
            if (!relogged) {
              await query(`UPDATE accounts SET session_status='dead', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
              if (!acc.ig_login) await reportFailureScreen(session, acc, '🔎 Сторож тишины').catch(() => {});
            }
          }
        } catch (e) {
          console.warn(`[тишина-браузер] ${acc.slug}: инфра-сбой — ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}`);
        } finally { if (session) await disconnect(session); }
      });
    } finally { releaseProfile(acc.gologin_profile_id); }
  }
}

async function maybeWarmup(now: Date) {
  if (isNightNow(now)) return;
  const graceMin = Number(process.env.RELOGIN_GRACE_MIN) || 3; // syncing-race: свежий акк (warmup_at NULL) прогрев хватал секунда-в-секунду, до готовности GoLogin-профиля. Grace-окно.
  // Один аккаунт за тик, чей черёд по каденции (сетка не «оживает» синхронно).
  const due = new Date(now.getTime() - WARMUP_CADENCE_MS);
  // Комменты греются ВСЕГДА (статус там не нужен); видео-акки — только в статусе 'warming'.
  // Паузу и корзину пропускаем в обоих случаях.
  const { rows } = await query<Record<string, any>>(
    `SELECT a.*, g.warmup_comments AS group_comments, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE (a.status='warming' OR a.platform='comments')
       AND coalesce(a.status,'') <> 'paused' AND a.deleted_at IS NULL
       AND a.gologin_profile_id IS NOT NULL
       -- На смене (дежурство watchdog / бэклог backlog) их греет СВОЙ движок реальной работой; воркер НЕ лезет,
       -- иначе две сессии на профиле = крэш/ожог. Забанятся → maintainRoster вернёт их в общий пул, и warmup подхватит снова.
       AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
       AND (a.warmup_at IS NULL OR a.warmup_at < $1)
       AND a.created_at < now() - interval '${graceMin} minutes' -- GRACE (syncing-race): не хватать свежий акк секунда-в-секунду — профиль ещё syncing + окно ручного/панельного входа
     ORDER BY a.warmup_at ASC NULLS FIRST LIMIT 1`,
    [due],
  );
  const acc = rows[0];
  if (!acc) return;
  // Комменты: если акк в группе — берём настройку ГРУППЫ; иначе флаг самого акка.
  const wantComments = acc.group_id ? Boolean(acc.group_comments) : Boolean(acc.warmup_comments);
  const wday = warmupDay(acc.warmup_started_at, now);

  const driver = driverFor(acc.platform);
  if (!tryReserveProfile(acc.gologin_profile_id)) return; // профиль занят ответом/др. задачей — прогреем позже
  // Замок GoLogin-аккаунта этого профиля (комменты-акки = акк2, токен группы).
  try {
  await withBrowserLock(async () => {
    startActivity('warmup', acc.slug || acc.gologin_profile_id);
    let session = null as Awaited<ReturnType<typeof connect>> | null;
    try {
      session = await connect(acc.gologin_profile_id, acc.group_token, { pool: 'logger', poolCap: loggerCap(), holder: acc.slug });
      // ГЕЙТ EGRESS (з.1): прокси мёртв → прогрев не начинаем (заодно пишет egress/proxy_status — заменяет
      // прежний суточный maybeProbeEgress ниже). Ошибка замера не блокирует (ensureEgress вернёт true).
      if (!(await ensureEgress(acc, session.page))) { finishActivity(false, 'прокси мёртв (egress)'); return; }
      // IG-профили (в т.ч. «комменты») стартуют на экране «продолжить как …» — дожимаем
      // вход через сохранённый в GoLogin пароль, иначе прогрев/лайки/комменты падают на логине.
      if (acc.platform === 'instagram' || acc.platform === 'comments') {
        let logged = await ensureLoggedIn(session.page);
        // Акк выкинуло полностью, но у нас есть креды — авто-релогин по паролю (+2FA из сида).
        if (!logged && acc.ig_login && acc.ig_password) {
          const creds = { login: acc.ig_login, password: acc.ig_password, totpSecret: acc.totp_secret, email: acc.ig_email, emailPassword: acc.ig_email_password };
          const res = await passwordLogin(session.page, creds); // visionLogin убран: жёг ~80с и всё равно падал сюда
          if (res === 'ok') {
            logged = true;
          } else if (res === 'challenge' || res === 'captcha' || res === 'bad_creds') {
            // IG просит ручное подтверждение (почта/SMS/капча) ИЛИ неверный пароль — НЕ обходим (капча
            // запрещена) и НЕ долбим: сразу пауза + алерт. Ретраи тут только сожгут дорогой акк.
            const st = res === 'bad_creds' ? 'bad_login' : 'challenge';
            // warmup_at=now() — бэкстоп: даже если запись paused сорвётся, будет пауза в каденцию, не долбёж.
            await query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead', warmup_at=now() WHERE id=$1`, [acc.id, st]).catch(() => {});
            // Скрин момента провала — раньше тут была только текстовая строка, и понять ЧТО на экране
            // (капча? вериф номера? чужая локаль?) было невозможно.
            {
              const shot = session?.page ? await session.page.screenshot({ type: 'jpeg' }).catch(() => null) : null;
              const cap = `IG вход ${acc.slug}: ${res} — акк на ПАУЗЕ, нужен ручной вход`;
              if (shot) await notifyPhoto(cap, shot).catch(() => alertOwner(cap)); else alertOwner(cap);
            }
            finishActivity(false, 'вход: ' + res);
            return;
          } else if (res === 'rate_limited' || res === 'error') {
            // ПОПЫТКА НЕ СОСТОЯЛАСЬ (07.08). 'rate_limited' = IG сказал «попробуйте позже» (про частоту
            // наших заходов), 'error' = исключение внутри входа (упал прокси, оборвался CDP, таймаут).
            // Ни то, ни другое не говорит об аккаунте, поэтому НЕ пишем dead и НЕ увеличиваем
            // login_fails: раньше три таких сбоя подряд ставили живой акк на паузу, а с паузы его
            // забирала автозамена вместе с профилем GoLogin. Просто отступаем до следующего тика.
            await query(`UPDATE accounts SET warmup_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
            finishActivity(false, `вход отложен: ${res} (инфраструктура/частота, статус не меняю)`);
            return;
          } else {
            // need_login/error — транзиентная неудача (прокси/сеть/не подтвердили вход). Считаем;
            // после 3 подряд — пауза (иначе повторные логины с одного IP спалят акк).
            const f = (Number(acc.login_fails) || 0) + 1;
            const stop = f >= 3;
            await query(`UPDATE accounts SET login_fails=$2, session_status='dead'${stop ? `, status='paused'` : `, warmup_at=now()`} WHERE id=$1`, [acc.id, f]).catch(() => {});
            if (stop) await alertPauseDiag(acc, f, 'IG вход');
            finishActivity(false, `вход не удался (попытка ${f}${stop ? ', пауза' : ''})`);
            return;
          }
        }
        if (!logged) {
          await query(`UPDATE accounts SET session_status='dead', warmup_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
          finishActivity(false, 'не залогинен (дожми вход в GoLogin)');
          return;
        }
        // Залогинены — сбрасываем счётчик неудач.
        if (Number(acc.login_fails) > 0) await query(`UPDATE accounts SET login_fails=0 WHERE id=$1`, [acc.id]).catch(() => {});
      }
      // (egress уже замерен гейтом ensureEgress выше — прежний суточный maybeProbeEgress убран, не дублируем)
      const summary = await Promise.race([
        runWarmupSession(session.page, driver, { id: acc.id, warmup_comments: wantComments, warmupDay: wday }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('таймаут прогрева (>15 мин)')), 15 * 60 * 1000)),
      ]);
      finishActivity(true, null, summary);
      await query(`UPDATE accounts SET session_status='live', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    } catch (err) {
      finishActivity(false, err instanceof Error ? err.message.slice(0, 120) : 'ошибка');
      if (err instanceof SessionError) await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [acc.id]).catch(() => {});
      if (err instanceof CaptchaError) {
        await query(`UPDATE accounts SET status='paused' WHERE id=$1`, [acc.id]);
        alertOwner(`Капча в прогреве ${acc.platform}/${acc.slug} — аккаунт на паузе`);
      }
      // Прочее в прогреве best-effort — не алертим, просто отметим время, чтобы не долбить.
      await query(`UPDATE accounts SET warmup_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey(acc.group_token));
  } finally { releaseProfile(acc.gologin_profile_id); }
}

// Ферма комментов: берём один акк из seed-группы, не выбравший дневной лимит,
// пишем один промо-коммент под чужим постом. По одному профилю за раз (тот же слот).
// === АНАЛИТИК СКРИНОВ при провале ===
// Вместо «скрин → владелец решает» показываем экран vision-модели, получаем вердикт+действие и,
// если экран ТЕРМИНАЛЬНЫЙ (капча/суспенд/ограничение) с уверенностью ≥70 — сразу метим акк под
// авто-замену (ig_status=captcha/suspended, status=paused → maybeReplaceBlocked снесёт и поднимет
// замену). Иначе шлём владельцу скрин + вердикт (на 'unknown' — так растим пул типовых экранов).
// Возвращает вердикт, чтобы вызывающий мог по action ('dismiss'/'relogin'/'terminal') решить дальше.
async function reportFailureScreen(session: any, acc: Record<string, any>, prefix: string): Promise<{ kind: string; action: string; terminal: boolean } | null> {
  if (!session?.page) return null;
  const { verdict, png } = await analyzeScreenPage(session.page, { slug: acc.slug }).catch(() => ({ verdict: null as any, png: null }));
  if (!verdict) return null;
  const line = `${prefix} ${acc.slug}: [${verdict.kind} ${verdict.confidence}%] ${verdict.note}`;
  void logAccountEvent(acc.id, acc.slug, acc.platform, 'screen:' + verdict.kind, { action: verdict.action, confidence: verdict.confidence, note: verdict.note, url: session.page.url() }).catch(() => {});
  // Терминальный и уверенный → под авто-замену, владельца не дёргаем зря.
  if (verdict.terminal && verdict.confidence >= 70) {
    const st = verdict.kind === 'suspended' ? 'suspended' : verdict.kind === 'account_restricted' ? 'challenge' : 'captcha';
    await query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead', session_checked_at=now() WHERE id=$1`, [acc.id, st]).catch(() => {});
    alertOwner(`🔴 ${line} — терминально, помечен под авто-замену`);
    return verdict;
  }
  // Не терминальный / низкая уверенность / unknown → показываем владельцу картинку + вердикт.
  const cap = `${line}${verdict.kind === 'unknown' ? ' — НОВЫЙ экран, добавим в пул' : ''}`;
  if (png) await notifyPhoto(cap, png).catch(() => alertOwner(cap)); else alertOwner(cap);
  return verdict;
}

// Разлогин пойман в комментинге → СРАЗУ пробуем войти обратно (пароль+2FA), не ждём 20-мин тик релогина.
// Сессия уже открыта на профиле. Успех → live. Провал → скрин момента в ТГ + пауза/dead (как в maybeRelogin).
// Креды тянем из БД по id — чтобы работало из любого места, не завися от SELECT вызывающего.
async function reloginInline(session: any, acc: Record<string, any>): Promise<boolean> {
  if (!session?.page) return false;
  const r = await query<Record<string, any>>(
    `SELECT ig_login, ig_password, totp_secret, ig_email, ig_email_password, coalesce(login_fails,0) AS login_fails FROM accounts WHERE id=$1`, [acc.id],
  ).catch(() => null);
  const a = r?.rows[0];
  if (!a?.ig_login || !a?.ig_password) return false; // куки-акк без пароля — только вручную
  const creds = { login: a.ig_login, password: a.ig_password, totpSecret: a.totp_secret, email: a.ig_email, emailPassword: a.ig_email_password };
  let res: string;
  try { res = await passwordLogin(session.page, creds); }
  catch { return false; }
  if (res === 'ok') {
    await query(`UPDATE accounts SET session_status='live', ig_status='login_ok', login_fails=0, session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    noteReloginOk();
    console.log(`[inline-relogin] ${acc.slug}: разлогин → вошли ✓`);
    return true;
  }
  const shot = await session.page.screenshot({ type: 'jpeg' }).catch(() => null);
  void logAccountEvent(acc.id, acc.slug, acc.platform, 'login_fail', { reason: loginFailReason(res), stage: 'inline' }).catch(() => {});
  if (res === 'bad_creds') {
    await query(`UPDATE accounts SET ig_status='bad_login', status='paused', session_status='dead', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    const cap = `Коммент ${acc.slug}: разлогин → неверный логин/пароль`;
    if (shot) await notifyPhoto(cap, shot).catch(() => {}); else alertOwner(cap);
    return false;
  }
  if (res === 'challenge' || res === 'captcha') {
    // passwordLogin не различает капчу / суспенд / вериф номера — спрашиваем АНАЛИТИК СКРИНОВ.
    // Он сам пометит терминальные (captcha/suspended) под авто-замену, а неоднозначные покажет владельцу.
    await query(`UPDATE accounts SET ig_status='challenge', status='paused', session_status='dead', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    await reportFailureScreen(session, acc, 'Коммент разлогин→вход').catch(() => {});
    return false;
  }
  // ПОПЫТКА НЕ СОСТОЯЛАСЬ (07.08): рейт-лимит или исключение внутри входа. Это наша инфраструктура и
  // частота заходов, а не аккаунт: статус и счётчик неудач НЕ трогаем (иначе 3 сбоя подряд ставили
  // живой акк на паузу, откуда его забирала автозамена).
  if (res === 'rate_limited' || res === 'error') {
    console.warn(`[inline-relogin] ${acc.slug}: вход не состоялся (${res}) — статус НЕ меняю`);
    return false;
  }
  // need_login — транзиент; считаем попытку, после 3× воркерский maybeRelogin поставит на паузу
  const f = (Number(a.login_fails) || 0) + 1;
  await query(`UPDATE accounts SET session_status='dead', login_fails=$2, session_checked_at=now() WHERE id=$1`, [acc.id, f]).catch(() => {});
  const cap = `Коммент ${acc.slug}: разлогин → авто-вход не удался (${res}, ${f}×)`;
  if (shot) await notifyPhoto(cap, shot).catch(() => {}); else alertOwner(cap);
  return false;
}

let lastSoftblock = 0;
const SOFTBLOCK_EVERY = 30 * 60 * 1000; // тик восстановления софт-блока — раз в ~30 мин
// === #3 ВОССТАНОВЛЕНИЕ LOGIN-СОФТ-БЛОКА (bad_login) ===
// Через 2ч после блока даём чистый шанс: свежий sticky-IP из ПУЛА + вход паролём+2FA на существующем
// профиле (свежий IP — главный рычаг против «login incorrect»; фингерпринт тут вторичен). Не вышло →
// оставляем как есть, maybeReplaceBlocked через SOFTBLOCK_KILL_H снесёт+заменит. Дежурная полоса (withLoginSlot).
async function maybeSoftblockRecover() {
  const { rows } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, a.ig_login, a.ig_password, a.totp_secret, a.ig_email, a.ig_email_password, a.ig_proxy, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.ig_status='bad_login' AND coalesce(a.ig_password,'')<>'' AND a.gologin_profile_id IS NOT NULL
       AND a.blocked_at IS NOT NULL AND a.blocked_at < now() - interval '2 hours'
     ORDER BY a.blocked_at ASC LIMIT 2`).catch(() => ({ rows: [] as Record<string, any>[] }));
  for (const a of rows) {
    if (!a.group_token) continue;
    if (!tryReserveProfile(a.gologin_profile_id)) continue;
    try {
      await withLoginSlot(async () => {
        const newProxy = await drawProxy(a.slug);
        // Пустой пул — не новость и не событие: он пуст сознательно (модели живут на купленных ISP).
        // Раньше на КАЖДЫЙ акк летел свой алерт, и ТГ забивался парами одинаковых строк каждые 20 минут.
        if (!newProxy) { console.warn(`[softblock] ${a.slug}: пул прокси пуст — замену не делаем`); return; }
        const spec = parseProxy(newProxy);
        if (spec) await setProfileProxy(a.gologin_profile_id, spec, a.group_token).catch(() => {});
        await query(`UPDATE accounts SET ig_proxy=$1, login_fails=0 WHERE id=$2`, [newProxy, a.id]).catch(() => {});
        let session = null as Awaited<ReturnType<typeof connect>> | null;
        try {
          session = await connect(a.gologin_profile_id, a.group_token, { pool: 'logger', poolCap: loggerCap(), holder: a.slug });
          const creds = { login: a.ig_login, password: a.ig_password, totpSecret: a.totp_secret, email: a.ig_email, emailPassword: a.ig_email_password };
          const res = await passwordLogin(session.page, creds);
          if (res === 'ok') {
            await query(`UPDATE accounts SET session_status='live', ig_status='login_ok', status='warming', login_fails=0, session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {});
            noteReloginOk();
            console.log(`[softblock] ${a.slug}: восстановлен на свежем sticky ${newProxy.replace(/:[^:@]+@/, ':***@')} ✓`);
          } else {
            await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [a.id]).catch(() => {});
            await reportFailureScreen(session, a, 'Софт-блок восстановление').catch(() => {});
          }
        } finally { if (session) await disconnect(session); }
      });
    } catch (e) {
      console.warn(`[softblock] ${a.slug}: инфра — ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    } finally { releaseProfile(a.gologin_profile_id); }
  }
}

// === #2 АВТО-РАЗДАЧА ПРОКСИ ИЗ ПУЛА + РЕСИНК GoLogin ===
// Акк без прокси (ig_proxy NULL) или с МЁРТВЫМ/mismatch прокси → берём free из proxy_pool → ОБЯЗАТЕЛЬНО
// setProfileProxy в облачный профиль (дожать IP в ПРОФИЛЬ, не только в БД — иначе профиль зайдёт со старого
// IP → челлендж, это и есть корень «релогин 0») → сброс egress → re-verify новой сессией.
// unknown НЕ реассайним (его резолвит ensureEgress/warmup) — иначе зря жжём пул.
async function maybeFixProxy() {
  if (gologinHealth().down) return; // шторм GoLogin — не дёргаем облако
  const { rows } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, a.ig_proxy, a.proxy, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
       AND (a.ig_proxy IS NULL OR a.proxy_status IN ('dead','mismatch'))
       AND coalesce(a.ig_status,'') NOT IN ('profile_lost','suspended','captcha') -- их чинит rebuild/replace
     ORDER BY a.acc_no ASC NULLS LAST LIMIT 2`).catch(() => ({ rows: [] as Record<string, any>[] }));
  for (const a of rows) {
    if (!a.group_token) continue;
    if (!tryReserveProfile(a.gologin_profile_id)) continue;
    try {
      await withLoginSlot(async () => {
        const raw = await drawProxy(a.slug);
        if (!raw) { console.warn(`[reassign] ${a.slug}: пул прокси пуст — реассайн пропущен`); return; }
        const spec = parseProxy(raw);
        if (!spec) { await releaseProxyBack(raw); return; } // нераспознан — вернуть порт, не висеть 'assigned'
        try { await setProfileProxy(a.gologin_profile_id, spec, a.group_token); }
        catch (e) { await releaseProxyBack(raw); console.warn(`[fixproxy] ${a.slug}: setProfileProxy — ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`); return; }
        const old = a.ig_proxy;
        await query(`UPDATE accounts SET ig_proxy=$1, egress_ip=NULL, egress_country=NULL, egress_checked_at=NULL, proxy_status='unknown', login_fails=0 WHERE id=$2`, [raw, a.id]).catch(() => {});
        if (old && old !== raw) await releaseProxyBack(old).catch(() => {});
        // re-verify НОВОЙ сессией (setProfileProxy применяется к следующему старту профиля).
        let session = null as Awaited<ReturnType<typeof connect>> | null;
        try {
          session = await connect(a.gologin_profile_id, a.group_token, { pool: 'logger', poolCap: loggerCap(), holder: a.slug });
          const eg = await probeEgress(session.page);
          // Замер не состоялся — оставляем 'unknown' (его выставили выше при установке прокси).
          // Раньше писали 'dead', и следующий тик снова видел 'dead' в отборе и тянул ЕЩЁ один порт
          // из пула: транзиентный сбой зонда проедал пул прокси (правило 07.08 «сбой не судит»).
          if (!eg) { console.log(`[fixproxy] ${a.slug}: новый прокси не подтверждён замером — оставляю 'unknown', порт не меняю`); }
          else {
            const want = String(a.proxy?.country || '').trim().toUpperCase();
            const st = !want || !eg.country ? 'ok' : eg.country === want ? 'ok' : 'mismatch';
            await query(`UPDATE accounts SET egress_ip=$2, egress_country=$3, proxy_status=$4, egress_checked_at=now() WHERE id=$1`, [a.id, eg.ip, eg.country, st]).catch(() => {});
            console.log(`[fixproxy] ${a.slug}: прокси переставлен → ${eg.country} ${eg.ip} (${st})`);
          }
        } finally { if (session) await disconnect(session); }
      });
    } catch (e) {
      console.warn(`[fixproxy] ${a.slug}: инфра — ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    } finally { releaseProfile(a.gologin_profile_id); }
  }
  // з.5: резерв прокси на исходе.
  // 03.08: троттл 1/ч давал по сообщению в час круглые сутки, при том что пул пуст СОЗНАТЕЛЬНО —
  // модельные акки сидят на купленных ISP (ClickIP), назначаем их вручную, а proxy_pool под
  // ферму комментинга никто не наполняет. Напоминание раз в сутки достаточно.
  const free = await poolFreeCount().catch(() => -1);
  if (free >= 0 && free < POOL_LOW && Date.now() - lastPoolLowAlert > 24 * 60 * 60 * 1000) {
    lastPoolLowAlert = Date.now();
    alertOwner(`⚠️ Резерв прокси < ${POOL_LOW}: свободно ${free} — создай пачку UK-sticky (proxy_pool)`);
  }
}

// === 6-ЧАСОВАЯ ЧИСТКА МЁРТВЫХ (с ВАЛИДАЦИЕЙ перед удалением) ===
// Юзер: «раз в 6ч подчищать мёртвые акки с системы и с гологина, но ВАЛИДИРОВАТЬ, чтобы не ошибиться».
// Два безопасных класса:
//  (1) СИРОТЫ: акк уже в корзине (deleted_at), но GoLogin-профиль висит → сносим профиль (освобождаем слот).
//      Валидация не нужна — акк уже удалён.
//  (2) КАНДИДАТЫ на снос: paused + терминальный (suspended/captcha) + старше суток. ПЕРЕД удалением
//      РЕАЛЬНО открываем браузер и спрашиваем аналитик скринов. Терминально подтвердил → корзина + снос
//      профиля. Аналитик говорит «восстановимо» (лента/логин-форма) → НЕ удаляем, снимаем паузу под релогин.
//      Поверх валидации два замка (те же, что в maybeReplaceBlocked): health_state='keep' и «есть наши
//      публикации». Зачем: тут вместе с акком уходит профиль GoLogin, то есть прогрев и история, а
//      аналитик не отличает чекпоинт живого акка от суспенда. Приказ на снос: REPLACE_KILL_PUBLISHED=1.
let lastCleanup = 0;
const CLEANUP_EVERY = 6 * 60 * 60 * 1000;
async function maybeCleanupDead() {
  // (1) сироты — профили удалённых акков
  const orphans = (await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.gologin_profile_id, a.ig_proxy, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NOT NULL AND a.gologin_profile_id IS NOT NULL LIMIT 20`).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  let freed = 0;
  for (const a of orphans) {
    try { await deleteCloudProfile(a.gologin_profile_id, a.group_token); } catch { /* мог быть уже удалён */ }
    if (a.ig_proxy) await releaseProxyBack(a.ig_proxy).catch(() => {});
    await query(`UPDATE accounts SET gologin_profile_id=NULL WHERE id=$1`, [a.id]).catch(() => {});
    freed++;
  }

  // (2) терминальные кандидаты — валидируем браузером ПЕРЕД удалением
  const cand = (await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, a.ig_proxy, a.ig_login, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.status='paused' AND a.gologin_profile_id IS NOT NULL
       -- Та же защита, что в maybeReplaceBlocked: health_state='keep' = владелец сказал «ждём».
       AND coalesce(a.health_state,'') <> 'keep'
       -- ВТОРОЙ ЗАМОК (06.08), тот же что в maybeReplaceBlocked. Защита выше держится на том, что
       -- кто-то ВРУЧНУЮ успел поставить 'keep', то есть на честном слове: Дарью так и спасли.
       -- Здесь цена ошибки выше, чем у автозамены: сносится ещё и профиль GoLogin, а с ним прогрев
       -- и вся история акка, обратно это не поднять. Валидация браузером от этого не страхует:
       -- чекпоинт после входа с телефона аналитик видит как терминальный экран, и рабочий акк
       -- (Дарья: 16 публикаций, 3618 просмотров) уходит в корзину. Поэтому акк, который УЖЕ
       -- РАБОТАЛ (есть наши публикации), чистка не трогает никогда, такой случай разбирает
       -- человек. Приказ «всё равно снеси» тот же, что у автозамены: REPLACE_KILL_PUBLISHED=1.
       AND (${/^(1|true|yes)$/i.test(String(process.env.REPLACE_KILL_PUBLISHED || '')) ? 'true' : `NOT EXISTS (
             SELECT 1 FROM posts p WHERE p.account_id=a.id AND p.status='published')`})
       AND a.ig_status IN ('suspended','captcha')
       AND a.blocked_at IS NOT NULL AND a.blocked_at < now() - interval '24 hours'
     ORDER BY a.blocked_at ASC LIMIT 3`).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  let deleted = 0, saved = 0;
  for (const a of cand) {
    if (!a.group_token) continue;
    if (!tryReserveProfile(a.gologin_profile_id)) continue;
    try {
      await withLoginSlot(async () => {
        let session = null as Awaited<ReturnType<typeof connect>> | null;
        try {
          session = await connect(a.gologin_profile_id, a.group_token, { pool: 'logger', poolCap: loggerCap(), holder: a.slug });
          await ensureLoggedIn(session.page).catch(() => false);
          const { verdict } = await analyzeScreenPage(session.page, { slug: a.slug });
          if (verdict.terminal && verdict.confidence >= 70) {
            // ПОДТВЕРЖДЕНО терминально → сносим профиль + в корзину
            await disconnect(session); session = null;
            try { await deleteCloudProfile(a.gologin_profile_id, a.group_token); } catch { /* уже нет */ }
            if (a.ig_proxy) await releaseProxyBack(a.ig_proxy).catch(() => {});
            await query(`UPDATE accounts SET deleted_at=now(), gologin_profile_id=NULL WHERE id=$1`, [a.id]).catch(() => {});
            deleted++;
            console.log(`[cleanup] ${a.slug}: подтверждён ${verdict.kind} → удалён + профиль снесён`);
          } else {
            // Аналитик НЕ подтвердил терминальность — акк, возможно, живой/восстановимый. НЕ удаляем.
            await query(`UPDATE accounts SET status='warming', ig_status=NULL, login_fails=0, session_checked_at=NULL WHERE id=$1`, [a.id]).catch(() => {});
            saved++;
            alertOwner(`🛟 Чистка: ${a.slug} помечен ${'терминально'}, но аналитик видит [${verdict.kind} ${verdict.confidence}%] — НЕ удаляю, вернул под релогин`);
          }
        } finally { if (session) await disconnect(session); }
      });
    } catch (e) {
      console.warn(`[cleanup] ${a.slug}: инфра — ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    } finally { releaseProfile(a.gologin_profile_id); }
  }
  if (freed || deleted || saved) console.log(`[cleanup] сироты-профили: ${freed} | удалено терминальных: ${deleted} | спасено валидацией: ${saved}`);
  // Заодно раз в 6ч проверяем запас прокси в пуле — чтобы восстановление софт-блоков не осталось без IP.
  const free = await poolFreeCount().catch(() => -1);
  if (free >= 0 && free < POOL_LOW) alertOwner(`⚠️ Пул запасных прокси < ${POOL_LOW}: свободно ${free} — создай пачку UK-sticky (proxy_pool)`);
}

// === #3 РЕКОНСАЙЛ БД↔GoLogin (порт glreconcile в авто-цикл 1/ч) ===
// Тянет ВСЕ ID профилей каждого GoLogin-аккаунта; акк, чей gologin_profile_id пропал из GoLogin =
// «профиль потерян» → ig_status='profile_lost', dead, ОБНУЛЯЕМ pid (авто-исключает из всех рабочих SELECT),
// status ОСТАётся warming (инвариант profile_lost≠paused). maybeRebuildLostProfiles заведёт заново.
// ⚠️ Любой ok=false (фетч рухнул) → аборт всего прохода: неполный список = ложные profile_lost.
async function maybeReconcileProfiles() {
  if (/^(1|true|yes)$/i.test(String(process.env.RECONCILE_OFF || ''))) return;
  if (gologinHealth().down) return;
  const toks = new Set<string>();
  const gr = await query<{ t: string }>(`SELECT gologin_token t FROM account_groups WHERE gologin_token IS NOT NULL`).catch(() => null);
  for (const r of gr?.rows || []) if (r.t) toks.add(r.t);
  if (process.env.GOLOGIN_API_TOKEN) toks.add(process.env.GOLOGIN_API_TOKEN);
  if (!toks.size) return;
  const all = new Set<string>();
  for (const t of toks) {
    const { ok, ids } = await listAllProfiles(t);
    if (!ok) { console.warn('[reconcile] фетч профилей рухнул — аборт прохода (не метим lost по неполному списку)'); return; }
    for (const id of ids) all.add(id);
  }
  const accs = (await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.gologin_profile_id pid FROM accounts a
     WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND coalesce(a.ig_status,'')<>'profile_lost'`).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  const lost: string[] = [];
  for (const a of accs) {
    if (all.has(String(a.pid))) continue;
    await query(`UPDATE accounts SET ig_status='profile_lost', session_status='dead', gologin_profile_id=NULL, session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {});
    lost.push(a.slug);
  }
  if (lost.length) { console.log(`[reconcile] профиль потерян у ${lost.length}: ${lost.slice(0, 15).join(', ')}`); alertOwner(`🔧 Реконсайл БД↔GoLogin: у ${lost.length} акков профиль исчез из GoLogin → profile_lost, заведу заново: ${lost.slice(0, 10).join(', ')}`); }
}

async function maybeSeed(now: Date) {
  // Анти-дубль (з.B): комментинг живёт в ig-worker (queue_supervisor). На web WORK_QUEUE_OFF=1 → web НЕ комментит
  // (иначе два процесса дерутся за GoLogin-профили и жрут пул commenting дважды).
  if (/^(1|true|yes)$/i.test(String(process.env.WORK_QUEUE_OFF || ''))) return;
  if (isNightNow(now)) return;
  const { rows } = await query<Record<string, any>>(
    `SELECT * FROM (
       SELECT a.id, a.platform, a.gologin_profile_id, a.slug, a.seed_at, a.proxy, a.proxy_status, a.egress_checked_at, g.seed_hashtags, g.seed_per_day, g.gologin_token AS group_token,
         (SELECT count(*) FROM seed_comments s WHERE s.account_id=a.id AND s.created_at > now()-interval '1 day') AS today
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
       WHERE g.seed_enabled=true AND a.platform='comments' AND a.status<>'paused'
         AND coalesce(a.ig_role,'') <> 'reader' AND coalesce(g.watchdog,false)=false -- дежурные не сидируют чужие посты
         AND a.gologin_profile_id IS NOT NULL AND a.session_status<>'dead'
         AND coalesce(a.proxy_status,'')<>'dead' -- з.1: не сидируем на мёртвом прокси
     ) t WHERE t.today < t.seed_per_day ORDER BY t.seed_at ASC NULLS FIRST LIMIT 1`,
  );
  const acc = rows[0];
  if (!acc) return;
  const hashtags = String(acc.seed_hashtags || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (!hashtags.length) return;
  // Отмечаем попытку СРАЗУ (при любом исходе) — иначе провальный акк выбирается каждый тик.
  await query(`UPDATE accounts SET seed_at=now() WHERE id=$1`, [acc.id]).catch(() => {});

  const driver = driverFor(acc.platform);
  if (!tryReserveProfile(acc.gologin_profile_id)) return; // профиль занят ответом/др. задачей — позже
  try {
  await withBrowserLock(async () => {
    startActivity('seed', acc.slug || acc.gologin_profile_id);
    let session = null as Awaited<ReturnType<typeof connect>> | null;
    try {
      session = await connect(acc.gologin_profile_id, acc.group_token, { pool: 'commenting', holder: acc.slug });
      // ГЕЙТ EGRESS (з.1): прокси мёртв → в работу не идём (иначе вход со сломанного IP = вериф-номер).
      // proxy_status уже помечен 'dead' внутри ensureEgress → maybeFixProxy переставит прокси из пула.
      if (!(await ensureEgress(acc, session.page))) { finishActivity(false, 'прокси мёртв (egress)'); return; }
      // === ШЛЮЗ ГОТОВНОСТИ (раньше его тут НЕ БЫЛО) ===
      // Сид-комментинг стартовал без ensureLoggedIn (в отличие от radar-ответов и дежурства): экран
      // был непрочищённый — куки-баннер / «сохранить данные входа» / «включить уведомления» висели
      // поверх ленты, findBox не находил поле коммента, и наверх уходило ложное «не нашёл поле»,
      // которое трактовалось как БЛОК ПОСТА. Теперь: убеждаемся что вошли → гасим весь «строй».
      if (!(await ensureLoggedIn(session.page).catch(() => false))) {
        const relogged = await reloginInline(session, acc);
        if (!relogged) { finishActivity(false, 'разлогинен — авто-вход не удался'); return; }
      }
      const ready = await readyForWork(session.page).catch(() => null);
      if (ready) console.log(`[seed] ${acc.slug}: ${ready.ok ? 'экран чистый' : 'ВНИМАНИЕ ' + ready.why}${ready.dismissed.length ? ' | закрыл: ' + ready.dismissed.join(', ') : ''}`);
      const role = Math.random() < 0.75 ? 'mention' : 'ask';
      const res = await Promise.race([
        runSeedSession(session.page, driver, { id: acc.id }, { hashtags, role }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('таймаут комментинга (>5 мин)')), 5 * 60 * 1000)),
      ]);
      finishActivity(res.posted, res.posted ? null : 'коммент не отправлен (селекторы?)', res.posted ? { comment: res.text } : undefined);
      if (res.posted) await query(`UPDATE accounts SET session_status='live', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
    } catch (err) {
      finishActivity(false, err instanceof Error ? err.message.slice(0, 120) : 'ошибка');
      if (err instanceof SessionError) {
        // Разлогин пойман в комментинге → СРАЗУ пробуем войти обратно (пароль+2FA), не ждём тик релогина.
        // Успех → акк снова live и в след. тик отработает; провал → reloginInline уже пометил dead/паузу + скрин в ТГ.
        const relogged = await reloginInline(session, acc).catch(() => false);
        if (!relogged) await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [acc.id]).catch(() => {});
      }
      if (err instanceof CaptchaError) {
        await query(`UPDATE accounts SET status='paused' WHERE id=$1`, [acc.id]);
        alertOwner(`Капча в комментинге ${acc.platform}/${acc.slug} — акк на паузе`);
      }
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey(acc.group_token));
  } finally { releaseProfile(acc.gologin_profile_id); }
}

// Одна роль (ответы людям ИЛИ бренд+промпт) на списке акков с failover: первый зашедший исполняет.
// tried — какие акки пробовал; shot — скрин момента ошибки/провала входа (для отчёта в ТГ).
async function runReplyRole(
  accounts: Record<string, any>[], url: string,
  cfg: { askerTexts: string[]; brandBase: string; maxAskers: number; doAskers: boolean; doBrand: boolean; fallbackPrompt?: string | null; brandMode?: 'prompt' | 'plain'; claimPost?: string | null },
): Promise<{ ok: boolean; result?: EngagementResult; acc?: Record<string, any>; err?: unknown; note: string; tried: string[]; shot?: Buffer }> {
  let note = 'нет живого акка для роли';
  const tried: string[] = [];
  let lastShot: Buffer | undefined;
  for (const acc of accounts) {
    // Профиль уже занят другим параллельным ответом? — не лезем в тот же браузер, берём следующий акк.
    if (!tryReserveProfile(acc.gologin_profile_id)) {
      console.log(`[radar-reply] роль: ${acc.slug} профиль занят другим ответом — пробую следующий`);
      note = `${acc.slug}: профиль занят`;
      continue;
    }
    console.log(`[radar-reply] роль ${cfg.doAskers ? 'ответы' : 'бренд+промпт'}: пробую ${acc.slug}`);
    tried.push(acc.slug);
    const driver = driverFor(acc.platform);
    try {
      const outcome: { loggedIn: boolean; r?: EngagementResult; err?: unknown; shot?: Buffer; why?: string } = await withBrowserLock(async () => {
        startActivity('radar-reply', acc.slug || acc.gologin_profile_id);
        updateActivity(`запускаю ${acc.slug} в GoLogin…`);
        let session = null as Awaited<ReturnType<typeof connect>> | null;
        const shoot = async (): Promise<Buffer | undefined> => { try { return await session?.page.screenshot({ type: 'jpeg', quality: 55 }); } catch { return undefined; } };
        try {
          session = await connect(acc.gologin_profile_id, acc.group_token, { pool: 'commenting', holder: acc.slug });
          // ГЕЙТ EGRESS (з.1): мёртвый прокси → как «не залогинен», failover возьмёт следующий акк из пула.
          if (!(await ensureEgress(acc, session.page))) return { loggedIn: false, why: 'прокси мёртв (egress)' };
          updateActivity('браузер открыт, вхожу в инстаграм…');
          if (acc.platform === 'instagram' || acc.platform === 'comments') {
            if (!(await ensureLoggedIn(session.page))) {
              const shot = await shoot();
              const scr = await markLoginFailed(acc, session.page); // классифицируем экран + честный статус (терминал→пауза)
              return { loggedIn: false, shot, why: scr.label };
            }
          }
          updateActivity('вошёл, открываю пост…');
          const r = await Promise.race([
            runRadarEngagement(session.page, driver, { url, askerTexts: cfg.askerTexts, brandBase: cfg.brandBase, maxAskers: cfg.maxAskers, doAskers: cfg.doAskers, doBrand: cfg.doBrand, fallbackPrompt: cfg.fallbackPrompt, brandMode: cfg.brandMode, onStep: updateActivity, claim: cfg.claimPost ? { postCode: cfg.claimPost, accountId: acc.id } : undefined }),
            new Promise<EngagementResult>((_, rej) => setTimeout(() => rej(new Error('таймаут ответа (>8 мин)')), 8 * 60 * 1000)),
          ]);
          // Скрин ВСЕГДА (и на успехе, и на провале) — юзер хочет видеть каждый ответ. Скроллим к верху
          // комментов, чтобы в кадр попали наши свежие комменты/ветки.
          await session.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await session.page.waitForTimeout(900);
          const shot = await shoot();
          return { loggedIn: true, r, shot };
        } catch (err) {
          const shot = await shoot();
          return { loggedIn: true, err, shot };
        } finally {
          if (session) await disconnect(session);
        }
      }, lockKey(acc.group_token));
      if (outcome.shot) lastShot = outcome.shot;
      if (!outcome.loggedIn) { note = `${acc.slug}: ${outcome.why || 'не залогинен'}`; continue; }
      if (outcome.err) return { ok: false, acc, err: outcome.err, note, tried, shot: lastShot };
      return { ok: true, acc, result: outcome.r, note, tried, shot: lastShot };
    } finally {
      releaseProfile(acc.gologin_profile_id); // освобождаем профиль для других ответов
    }
  }
  return { ok: false, note, tried, shot: lastShot };
}

// Атомарно берём 1 ожидающий ответ и помечаем 'posting' (+posting_at). FOR UPDATE SKIP LOCKED — на случай
// нескольких процессов; сейчас процесс один, но так надёжнее и без гонок.
async function claimNextReply(): Promise<Record<string, any> | null> {
  const claimed = await query<{ id: string }>(
    `UPDATE radar_replies SET status='posting', posting_at=now()
     WHERE id = (SELECT id FROM radar_replies WHERE status='pending'
                   AND (posting_at IS NULL OR posting_at < now() - interval '20 seconds') -- кулдаун: не хватать только что возвращённый
                   -- Мульти-акк задания ('askers'/'brand') идут по посту ПАРАЛЛЕЛЬНО — дубли исключает
                   -- БРОНЬ комментов (radar_reply_targets). Легаси-'both' держим по одному на пост.
                   AND NOT EXISTS (SELECT 1 FROM radar_replies rp WHERE rp.post_code = radar_replies.post_code AND rp.status='posting'
                                     AND (rp.roles='both' OR radar_replies.roles='both'))
                 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id`).catch(() => ({ rows: [] as { id: string }[] }));
  if (!claimed.rows.length) return null;
  const { rows } = await query<Record<string, any>>(
    `SELECT r.id, r.post_code, r.post_url, r.text, r.account_id, r.fallback_account_id, r.roles,
            r.brand_account_id, r.brand_fallback_id, r.asker_count, r.texts, r.no_prompt, p.caption, p.seq, p.gen_prompt, p.source,
            (SELECT brand_comment FROM radar_config WHERE id=1) AS brand_comment,
            (SELECT default_prompt FROM radar_config WHERE id=1) AS default_prompt
     FROM radar_replies r LEFT JOIN radar_posts p ON p.code=r.post_code WHERE r.id=$1`, [claimed.rows[0].id]);
  return rows[0] || null;
}

// Непрерывный ПУЛ: держим до CONC ответов в работе ОДНОВРЕМЕННО; освободился слот — сразу берём следующий
// из очереди. Так реально заняты все 5 слотов GoLogin, а не 1 батч с простоем. Один прогон обрабатывает до MAX
// (потом уступает тику — очередь докрутится следующим replyTick). Реальную параллельность держит семафор.
async function maybeRadarReply(_now: Date) {
  // Анти-дубль (з.B): ответы-комментинг живёт в ig-worker. На web WORK_QUEUE_OFF=1 → web НЕ комментит.
  if (/^(1|true|yes)$/i.test(String(process.env.WORK_QUEUE_OFF || ''))) return;
  const CONC = Math.max(1, Number(process.env.GOLOGIN_CONCURRENCY) || 5);
  const MAX = Math.max(CONC, Number(process.env.REPLY_MAX_PER_RUN) || 12);
  const inFlight = new Set<Promise<void>>();
  let launched = 0;
  const launch = (rep: Record<string, any>) => {
    const p = (async () => {
      try { await processReply(rep); }
      catch (e) { console.error('[radar-reply] processReply упал:', e instanceof Error ? e.message : e); }
    })();
    inFlight.add(p);
    void p.then(() => inFlight.delete(p), () => inFlight.delete(p));
  };
  while (launched < MAX) {
    while (inFlight.size < CONC && launched < MAX) {
      const rep = await claimNextReply();
      if (!rep) break;                 // очередь пуста
      launched++; launch(rep);
    }
    if (inFlight.size === 0) break;     // очередь пуста и всё доработано
    await Promise.race(inFlight).catch(() => {}); // ждём, пока освободится слот, и добираем следующий
  }
  await Promise.allSettled([...inFlight]); // дождаться хвоста
  if (launched) console.log(`[radar-reply] пул: обработано ${launched} ответов (слотов ${CONC})`);
}

// Один ответ из радара: 1 акк отвечает людям, (опц.) 2-й акк — брендовый коммент + промпт веткой.
// Если 2-й не задан — всё делает один акк. У каждой роли свой авто-failover.
async function processReply(rep: Record<string, any>) {
  // ПУЛ для авто-failover: ТОЛЬКО живые акки. Выпавшие на перелогин (session_status='dead') НЕ трогаем —
  // даже если юзер их указал primary: пока не перелогинился в GoLogin, попытка = гарантированный провал,
  // не тратим слот. Восстановление — через проверку сессий (maybeSessions), не через постинг.
  // Пул только ЖИВЫХ и ПОД ЛИМИТОМ акков (comments_today < daily_limit). Порядок — РОТАЦИЯ: наименее
  // занятый сегодня + дольше всех отдыхавший первым. Так один акк не горит (сегодня акк 3 сделал 14 → бан).
  const { rows: pool } = await query<Record<string, any>>(
    `SELECT a.id, a.gologin_profile_id, a.platform, a.slug, a.proxy, a.proxy_status, a.egress_checked_at, g.gologin_token AS group_token,
            (CASE WHEN a.comments_day = (now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) AS used
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform IN ('comments','instagram') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_role,'') <> 'reader' AND a.deleted_at IS NULL
       AND coalesce(g.watchdog,false)=false -- ДЕЖУРНЫЕ (watchdog-группа) сидят только на своём посту, в обычные ответы не лезут
       AND coalesce(a.session_status,'') <> 'dead'
       AND coalesce(a.proxy_status,'') <> 'dead' -- з.1: мёртвый прокси → maybeFixProxy переставит
       AND (CASE WHEN a.comments_day = (now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) < (SELECT daily_limit FROM radar_config WHERE id=1)
     ORDER BY used ASC, a.last_commented_at ASC NULLS FIRST, substring(a.slug from '\\d+')::int NULLS LAST, a.slug`);
  if (!pool.length) {
    // Пул пуст: либо все под ЛИМИТОМ (тогда вернём в очередь — отдохнут/сутки сбросятся), либо все DEAD (перелогин).
    const { rows: live } = await query<{ n: string }>(
      `SELECT count(*) n FROM accounts WHERE platform IN ('comments','instagram') AND gologin_profile_id IS NOT NULL
         AND coalesce(ig_role,'')<>'reader' AND deleted_at IS NULL AND coalesce(session_status,'')<>'dead'
         AND NOT EXISTS (SELECT 1 FROM account_groups gw WHERE gw.id=accounts.group_id AND gw.watchdog=true)`).catch(() => ({ rows: [{ n: '0' }] }));
    if (Number(live[0]?.n || 0) > 0) { // живые есть, но выбрали дневной лимит — не жжём (авто-раздача сама не создаёт при таком)
      await query(`UPDATE radar_replies SET status='failed', error='все акки выбрали дневной лимит (сброс в полночь)' WHERE id=$1`, [rep.id]).catch(() => {});
      console.log(`[radar-reply] Пост #${rep.seq ?? '?'}: все живые акки выбрали дневной лимит — пропуск`);
      return;
    }
    await query(`UPDATE radar_replies SET status='failed', error='нет живых акков — перелогинь в GoLogin' WHERE id=$1`, [rep.id]).catch(() => {});
    await notifyOwner(`⚠️ Пост #${rep.seq ?? '?'} — все комменты-акки на перелогин (GoLogin), ответ не отправлен.\n${rep.post_url}`, { force: true }).catch(() => {});
    return;
  }
  const byId = new Map(pool.map((a) => [a.id, a]));
  // Список для роли: [primary, ...остальные живые] — но исключаем primary ДРУГОЙ роли, и до 4 попыток.
  const listFor = (primaryId: string | null, otherPrimaryId: string | null) => {
    const primary = primaryId ? byId.get(primaryId) : null;
    const backups = pool.filter((a) => a.id !== primaryId && a.id !== otherPrimaryId);
    return [primary, ...backups].filter(Boolean).slice(0, 4) as Record<string, any>[];
  };
  const askerAccts = listFor(rep.account_id, rep.brand_account_id);
  const brandAccts = rep.brand_account_id ? listFor(rep.brand_account_id, rep.account_id) : [];

  // askerTexts — только ФОЛБЭК: ответы генерятся под каждый коммент при отправке (generateContextualReply).
  // Если юзер прислал свои — используем их; иначе пара generic на случай сбоя генерации.
  const texts: string[] = Array.isArray(rep.texts) ? rep.texts.filter((t: string) => t && t.trim().length >= 3) : [];
  try { if (texts.length < 2) for (const m of await generateRadarReply(rep.caption || '', 3)) if (!texts.includes(m)) texts.push(m); } catch {}
  // Случайный ВАРИАНТ брендового питча (не один и тот же текст — палево + IG банит повторы).
  // В пул входит и текст из настроек (rep.brand_comment), если юзер его задал.
  const brandBase = pickBrandBase(rep.brand_comment);
  // НАШ промпт, если в комментах готового нет: сгенерённый радаром под пост -> сгенерить сейчас -> статик-дефолт.
  let fallbackPrompt = String(rep.gen_prompt || '').trim() || null;
  if (!fallbackPrompt && rep.caption) { try { fallbackPrompt = (await generatePostPrompt(rep.caption)) || null; } catch {} }
  if (!fallbackPrompt) fallbackPrompt = String(rep.default_prompt || '').trim() || null;
  const maxAskers = Math.max(0, Math.min(10, Number(rep.asker_count ?? 3)));
  const sameAcc = !rep.brand_account_id || rep.brand_account_id === rep.account_id;
  // Бренд-коммент ВСЕГДА 'plain' (2026-07-21, решение владельца): строго ОДИН топ-левел «сделали в нейронка про»,
  // БЕЗ промпта и БЕЗ ответа самому себе веткой (старая стратегия «промпт под свой коммент» удалена отовсюду).
  const brandMode: 'prompt' | 'plain' = 'plain';

  // Собираем список ролей: либо один акк делает всё, либо разбиваем на два.
  const roles: { accounts: Record<string, any>[]; label: string; cfg: { askerTexts: string[]; brandBase: string; maxAskers: number; doAskers: boolean; doBrand: boolean; fallbackPrompt: string | null; brandMode: 'prompt' | 'plain'; claimPost?: string | null } }[] = [];
  // ФАН-АУТ (мульти-выбор акков в композере): строка = ОДНА роль СТРОГО указанным акком, без failover
  // (акк выбран юзером явно; подставлять другой = дубли с соседней строкой того же поста).
  const repMode = String(rep.roles || 'both');
  const strictAcc = rep.account_id && byId.get(rep.account_id) ? [byId.get(rep.account_id)!] : [];
  if (repMode === 'askers') {
    roles.push({ accounts: strictAcc, label: 'ответы людям', cfg: { askerTexts: texts, brandBase, maxAskers, doAskers: true, doBrand: false, fallbackPrompt: null, brandMode, claimPost: rep.post_code } });
  } else if (repMode === 'brand') {
    roles.push({ accounts: strictAcc, label: 'бренд+промпт', cfg: { askerTexts: [], brandBase, maxAskers: 0, doAskers: false, doBrand: true, fallbackPrompt, brandMode } });
  } else if (sameAcc) {
    roles.push({ accounts: askerAccts, label: 'всё', cfg: { askerTexts: texts, brandBase, maxAskers, doAskers: maxAskers > 0, doBrand: true, fallbackPrompt, brandMode, claimPost: rep.post_code } });
  } else {
    if (maxAskers > 0) roles.push({ accounts: askerAccts, label: 'ответы людям', cfg: { askerTexts: texts, brandBase, maxAskers, doAskers: true, doBrand: false, fallbackPrompt: null, brandMode, claimPost: rep.post_code } });
    roles.push({ accounts: brandAccts, label: 'бренд+промпт', cfg: { askerTexts: [], brandBase, maxAskers: 0, doAskers: false, doBrand: true, fallbackPrompt, brandMode } });
  }

  const parts: string[] = [];
  let anyPosted = false;
  let postedAcc: Record<string, any> | null = null;
  let firstErr: { err: unknown; acc: Record<string, any> } | null = null;
  let note = 'не удалось войти ни одним аккаунтом';

  // Роли гоняем ПАРАЛЛЕЛЬНО — оба акка открываются разом; семафор придержит если слотов не хватит.
  const outs = await Promise.all(roles.map((role) =>
    role.accounts.length ? runReplyRole(role.accounts, rep.post_url, role.cfg)
      : Promise.resolve({ ok: false, note: `нет акка для роли «${role.label}»`, tried: [] } as Awaited<ReturnType<typeof runReplyRole>>)));
  const triedAll = [...new Set(outs.flatMap((o) => o.tried || []))]; // какие акки пробовали (для отчёта)
  const shot = outs.map((o) => o.shot).find(Boolean); // скрин момента провала
  for (const out of outs) {
    if (out.err) { if (!firstErr) firstErr = { err: out.err, acc: out.acc! }; note = 'ошибка роли'; continue; }
    if (!out.ok) { note = out.note; continue; }
    const r = out.result!;
    const posted = r.askerReplies > 0 || r.brandPosted;
    anyPosted = anyPosted || posted;
    if (posted && !postedAcc) postedAcc = out.acc!;
    // Счётчик комментов этого акка за сутки (бренд + промпт + ответы людям) — для лимита/ротации/отдыха.
    // Сутки — ПО ВАРШАВЕ (везде, где сравниваем comments_day): по UTC ночные комменты (00:00-02:00 по Варшаве)
    // падали во «вчера», и панель показывала «сегодня: 0», хотя комменты были сегодня.
    const nComments = (r.brandPosted ? 1 : 0) + (r.promptPosted ? 1 : 0) + r.askerReplies;
    if (nComments > 0 && out.acc?.id) {
      await query(
        `UPDATE accounts SET comments_today = (CASE WHEN comments_day = (now() at time zone 'Europe/Warsaw')::date THEN comments_today ELSE 0 END) + $2,
                comments_day = (now() at time zone 'Europe/Warsaw')::date, last_commented_at = now() WHERE id = $1`,
        [out.acc.id, nComments],
      ).catch(() => {});
    }
    const promptCell = brandMode === 'plain' ? 'промпт — (креатор)' : `промпт ${r.promptPosted ? 'да' : 'нет'}`;
    const why = !r.brandPosted && r.askerReplies === 0 && r.reason ? ` — ${r.reason}` : '';
    parts.push(`акк ${out.acc!.slug}: ответов ${r.askerReplies}, бренд ${r.brandPosted ? 'да' : 'нет'}, ${promptCell}${why}`);
  }

  // Все профили были заняты параллельными ответами (ничего не пробовали, не ошибка) — это НЕ провал.
  // Возвращаем в очередь: повторится следующим replyTick, когда слот освободится.
  const allBusy = !anyPosted && !firstErr && triedAll.length === 0 && outs.some((o) => /занят/.test(o.note || ''));
  if (allBusy) {
    // status='pending', НО posting_at оставляем (кулдаун в claimNextReply не даст схватить сразу же).
    await query(`UPDATE radar_replies SET status='pending' WHERE id=$1`, [rep.id]).catch(() => {});
    console.log(`[radar-reply] Пост #${rep.seq ?? '?'}: все профили заняты — вернул в очередь на повтор`);
    return;
  }

  if (!anyPosted && parts.length) note = 'зашёл, но НЕ смог оставить коммент — не нашёл окно комментария (капча / чек-поинт / реел?)';
  const summary = parts.join(' · ') || note;
  const triedLine = triedAll.length ? `\nпробовал акки: ${triedAll.join(', ')}` : '';
  console.log(`[radar-reply] итог: ${summary} | пробовал: ${triedAll.join(', ')}`);

  if (anyPosted) {
    await query(`UPDATE radar_replies SET status='posted', posted_at=now(), result=$2, error=NULL, account_id=coalesce($3, account_id) WHERE id=$1`, [rep.id, summary, postedAcc?.id ?? null]);
    // Снапшот «отработан на N комментах» — база для детекта прироста (докомментить, когда набежит ещё).
    await query(`UPDATE radar_posts SET status='replied', worked_count=comment_count WHERE code=$1`, [rep.post_code]).catch(() => {});
    if (postedAcc) await query(`UPDATE accounts SET session_status='live', session_checked_at=now() WHERE id=$1`, [postedAcc.id]).catch(() => {});
    finishActivity(true, null, { comment: summary });
    const okReport = `📩 Пост #${rep.seq ?? '?'} — готово: ${summary}${triedLine}\n${rep.post_url}`;
    if (shot) await notifyPhoto(okReport, shot); else await notifyOwner(okReport, { force: true }); // скрин результата
    return;
  }
  // Ничего не ушло — отчёт + скрин в ТГ. Берём ЧЕСТНЫЙ summary (там реальная причина по каждому акку:
  // «поле есть, но коммент не ушёл» / «поле не найдено»), а не общую заглушку note.
  const msg = firstErr ? (firstErr.err instanceof Error ? firstErr.err.message.slice(0, 200) : 'ошибка') : (summary || note);
  console.warn(`[radar-reply] не запостили: ${msg}`);
  await query(`UPDATE radar_replies SET status='failed', error=$2 WHERE id=$1`, [rep.id, msg]).catch(() => {});
  finishActivity(false, msg.slice(0, 120));
  if (firstErr?.err instanceof SessionError) await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [firstErr.acc.id]).catch(() => {});
  if (firstErr?.err instanceof CaptchaError) await query(`UPDATE accounts SET status='paused' WHERE id=$1`, [firstErr.acc.id]).catch(() => {});
  const report = `⚠️ Пост #${rep.seq ?? '?'} — НЕ прошёл: ${msg}${triedLine}\n${rep.post_url}`;
  if (shot) await notifyPhoto(report, shot); else await notifyOwner(report, { force: true });
}

// АВТО-РЕЛОГИН: держим сессии живыми сами. Раз в ~20 мин находим акки, что ДОЛЖНЫ быть live, но просели
// (есть креды+профиль, не на паузе, не live, кулдаун входа 1ч прошёл) и до-логиниваем — не дожидаясь 8ч прогрева.
// Инфра-сбой (GoLogin 503/коннект) НЕ метим 'dead' — повторим в след. тик, когда облако вернётся. Капча/SMS → пауза+алерт.
async function maybeRelogin() {
  const graceMin = Number(process.env.RELOGIN_GRACE_MIN) || 3; // syncing-race (22.07): профиль GoLogin нового акка синхронизируется ~54с; воркер хватал его через секунды → connect в syncing → ложный no_connect/dead. Не берём акки моложе graceMin минут.
  const { rows } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, a.ig_login, a.ig_password, a.totp_secret, a.ig_email, a.ig_email_password, a.login_fails, a.proxy, a.proxy_status, a.egress_checked_at, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.status <> 'paused' AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_login,'') <> '' AND coalesce(a.ig_password,'') <> ''
       AND coalesce(a.session_status,'') <> 'live'
       AND coalesce(a.proxy_status,'') <> 'dead' -- з.1: мёртвый прокси чинит maybeFixProxy, не логин
       AND a.created_at < now() - interval '${graceMin} minutes' -- GRACE (syncing-race): даём GoLogin досинхронить профиль нового акка (~54с) + окно ручного/панельного входа, не хватаем раньше времени
       -- Кулдаун входа считаем по relogin_try_at (отметка РЕАЛЬНОЙ попытки), НЕ по session_checked_at:
       -- последний бампают фоновые чеки каждые 30 мин. 1ч для всех (механику 2fa_cooldown/4ч убрали 23.07).
       AND (a.relogin_try_at IS NULL OR a.relogin_try_at < now() - interval '1 hour')
     ORDER BY a.relogin_try_at ASC NULLS FIRST
     LIMIT 10`);
  // Вход в один акк (вынесено, чтобы гнать пулом). Сам резервирует/освобождает слот профиля.
  async function reloginOne(acc: Record<string, any>) {
    if (!tryReserveProfile(acc.gologin_profile_id)) return; // профиль занят другой задачей — в след. раз
    let session = null as Awaited<ReturnType<typeof connect>> | null;
    try {
      await withLoginSlot(async () => {                          // локальный кап входов; жёсткий бюджет 15 держит глобальный семафор (logger 3, экстренка 5)
      session = await connect(acc.gologin_profile_id, acc.group_token, { pool: 'logger', poolCap: loggerCap(), holder: acc.slug });
      // ГЕЙТ EGRESS (з.1): не жжём вход через мёртвый прокси (со старого/битого IP = челлендж).
      // proxy_status уже 'dead' → maybeFixProxy переставит прокси; session_status НЕ трогаем (реального входа не было).
      if (!(await ensureEgress(acc, session.page))) return;
      const creds = { login: acc.ig_login, password: acc.ig_password, totpSecret: acc.totp_secret, email: acc.ig_email, emailPassword: acc.ig_email_password };
      let res: string;
      if (acc.platform === 'tiktok') res = await tiktokLogin(session.page, creds);
      else { res = (await ensureLoggedIn(session.page)) ? 'ok' : await passwordLogin(session.page, creds); }
      if (res === 'ok') {
        await query(`UPDATE accounts SET session_status='live', ig_status='login_ok', login_fails=0, session_checked_at=now(), relogin_try_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
        noteReloginOk();
        console.log(`[relogin] ${acc.slug}: live ✓`);
      } else if (res === 'challenge' || res === 'captcha' || res === 'bad_creds') {
        let label = String(res), st = res === 'bad_creds' ? 'bad_login' : 'challenge';
        // Уточняем ЧТО за challenge (вериф номера / чек-поинт / суспенд) — страница сейчас на том экране.
        if (res === 'challenge') {
          const pg = (session as any)?.page;
          const scr = pg ? await classifyIgScreen(pg).catch(() => null) : null;
          if (scr && scr.kind !== 'login' && scr.kind !== 'unknown') { label = `${scr.label} — «${scr.note}»`; if (scr.kind === 'suspended') st = 'suspended'; }
        }
        await query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead', session_checked_at=now(), relogin_try_at=now() WHERE id=$1`, [acc.id, st]).catch(() => {});
        void logAccountEvent(acc.id, acc.slug, acc.platform, 'login_fail', { reason: loginFailReason(res), stage: 'relogin', ...await accountSnapshot(acc.id) });
        alertOwner(`Авто-вход ${acc.slug}: ${label} — акк на ПАУЗЕ, нужен ручной вход`);
      } else if (res === 'rate_limited' || res === 'error') {
        // ПОПЫТКА НЕ СОСТОЯЛАСЬ (07.08): «попробуйте позже» от IG либо исключение входа (прокси/CDP/
        // таймаут). Статус, login_fails и session_checked_at не трогаем — ровно как в инфра-ветке
        // ниже (catch). Раньше это шло в общий транзиент и после 3 сбоев подряд ставило акк на паузу,
        // а паузу подхватывает автозамена и сносит акк с профилем GoLogin насовсем.
        console.warn(`[relogin] ${acc.slug}: вход не состоялся (${res}) — статус НЕ меняю`);
      } else { // need_login (вкл. недовведённый 2FA) — транзиент; после 3× подряд пауза
        const f = (Number(acc.login_fails) || 0) + 1; const stop = f >= 3;
        await query(`UPDATE accounts SET login_fails=$2, session_status='dead', session_checked_at=now(), relogin_try_at=now()${stop ? `, status='paused'` : ''} WHERE id=$1`, [acc.id, f]).catch(() => {});
        void logAccountEvent(acc.id, acc.slug, acc.platform, 'login_fail', { reason: loginFailReason(res), stage: 'relogin', fails: f }).catch(() => {});
        if (stop) await alertPauseDiag(acc, f, 'Авто-вход');
      }
      });
    } catch (e) {
      // ИНФРА (GoLogin 503/403/коннект) — НЕ трогаем статус и session_checked_at: акк переберётся в след. тик,
      // когда облако вернётся. Не метим ложно 'dead'.
      const msg = e instanceof Error ? e.message : String(e);
      // Инструментация: connect_fail/503 логируем ОТДЕЛЬНО (это и есть массовый корень «релогин 0»), но НЕ во
      // время шторма (иначе завалим events дублями) и статус НЕ трогаем.
      if (!gologinHealth().down) void logAccountEvent(acc.id, acc.slug, acc.platform, 'login_fail', { reason: connectFailReason(msg), stage: 'relogin', errmsg: msg.slice(0, 120) }).catch(() => {});
      console.warn(`[relogin] ${acc.slug}: инфра-сбой — ${msg.slice(0, 90)}`);
    } finally {
      if (session) await disconnect(session);
      releaseProfile(acc.gologin_profile_id);
    }
  }
  // Пул из 3 потоков логина; глобальный семафор слотов (бюджет 15: logger 3, экстренка 5) — истинный потолок кросс-процесс.
  const RELOGIN_CONC = 3;
  let idx = 0;
  const runner = async () => { while (idx < rows.length) { await reloginOne(rows[idx++]); } };
  await Promise.all(Array.from({ length: Math.min(RELOGIN_CONC, rows.length) }, runner));
}

let ticking = false;
// === АВТО-ЗАМЕНА БЛОКНУТЫХ === терминально мёртвый акк сносим (GoLogin-профиль + soft-delete) и заводим
// нового из очереди (creds есть, профиля нет) на освободившийся слот; вход нового — maybeRelogin (пароль+2FA).
// ТЕРМИНАЛЬНЫЕ = paused + ig_status challenge/suspended (чек-поинт/вериф номера/капча/суспенд — система уже
// сдалась) ИЛИ paused + bad_login застрял ≥SOFTBLOCK_KILL_H ч. Ложные смерти (ig_status null), 2fa_cooldown,
// ещё-ретраящиеся — НЕ трогаем. Предохранители: лимит AUTO_REPLACE_MAX/прогон; выключить — AUTO_REPLACE_OFF=1.
async function maybeReplaceBlocked() {
  if (/^(1|true|yes)$/i.test(String(process.env.AUTO_REPLACE_OFF || ''))) return;
  // НЕ СНОСИМ АККИ ВО ВРЕМЯ ШТОРМА GoLogin (07.08). Это необратимая операция (профиль удаляется
  // вместе с куками и прогревом), а во время шторма терминальные метки массово ставятся по ложным
  // поводам: недогруженная страница, оборванный CDP, заглушка прокси со словом suspended. Пока
  // инфраструктура штормит, ни один вердикт об аккаунте не считаем достоверным. Акк подождёт,
  // rebuild выше устроен так же (тот же принцип, что и с проверкой картинок: сбой не судит).
  if (gologinHealth().down) { console.warn('[replace] GoLogin штормит — сносы отложены, вердиктам сейчас не верю'); return; }
  const CAP = Math.max(1, Number(process.env.AUTO_REPLACE_MAX) || 3);
  const SOFT_H = Math.max(1, Number(process.env.SOFTBLOCK_KILL_H) || 3);
  const { rows: dead } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, coalesce(a.ig_status,'') AS ig_status, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND a.status='paused'
       -- ЗАЩИТА ОТ СНОСА ПО ПРИКАЗУ (06.08): health_state='keep' значит владелец сказал «не удалять,
       -- ждём». Дарья поймала чекпоинт после входа с телефона, и автозамена снесла бы её вместе с
       -- профилем GoLogin, а это наш самый рабочий акк (16 публикаций, 3618 просмотров).
       AND coalesce(a.health_state,'') <> 'keep'
       -- ВТОРОЙ ЗАМОК (06.08): защита выше держится на том, что кто-то ВРУЧНУЮ поставил 'keep'.
       -- Дарью спасли на честном слове. Поэтому акк, который УЖЕ РАБОТАЛ (есть наши публикации),
       -- автозамена не сносит никогда: чекпоинт после входа с телефона выглядит как 'challenge',
       -- а вместе с акком удаляется и профиль GoLogin, то есть история и прогрев. Такой случай
       -- разбирает человек. Приказ «всё равно снеси» — REPLACE_KILL_PUBLISHED=1.
       AND (${/^(1|true|yes)$/i.test(String(process.env.REPLACE_KILL_PUBLISHED || '')) ? 'true' : `NOT EXISTS (
             SELECT 1 FROM posts p WHERE p.account_id=a.id AND p.status='published')`})
       AND ( a.ig_status IN ('challenge','suspended','captcha')
             -- КУКИ-акк с неверным паролём = потерян СРАЗУ (кука была единств. входом, пароль из папки мусорный;
             -- bad_creds в radar.ts ставится только на реальный «incorrect», не на soft-block → ждать 3ч незачем).
             OR (a.ig_status='bad_login' AND a.ig_cookies IS NOT NULL)
             OR (a.ig_status='bad_login' AND a.session_checked_at < now() - interval '${SOFT_H} hours') )
     ORDER BY a.session_checked_at ASC NULLS FIRST LIMIT ${CAP}`).catch(() => ({ rows: [] as Record<string, any>[] }));
  if (!dead.length) return;
  const killed: string[] = [];
  for (const acc of dead) {
    const tok = acc.group_token || process.env.GOLOGIN_API_TOKEN;
    try {
      if (acc.gologin_profile_id && tok) await deleteCloudProfile(acc.gologin_profile_id, tok).catch(() => 0);
      await query(`UPDATE accounts SET deleted_at=now(), status='paused', session_status='dead', gologin_profile_id=NULL WHERE id=$1`, [acc.id]).catch(() => {});
      void logAccountEvent(acc.id, acc.slug, acc.platform, 'deleted', await accountSnapshot(acc.id));
      killed.push(`${acc.slug} (${acc.ig_status || '—'})`);
    } catch (e) { console.warn(`[replace] снос ${acc.slug} не удался:`, e instanceof Error ? e.message.slice(0, 80) : e); }
  }
  if (!killed.length) return;
  // Завод замены из очереди (creds есть, профиля нет) — на освободившиеся слоты, по числу снесённых.
  const { rows: queued } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.ig_proxy, a.acc_no, g.gologin_token AS group_token
     FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE a.gologin_profile_id IS NULL AND a.deleted_at IS NULL AND coalesce(a.ig_password,'')<>'' AND g.gologin_token IS NOT NULL
       AND coalesce(a.ig_status,'')<>'profile_lost' -- профиль-lost заводит maybeRebuildLostProfiles; иначе тут заведём ВТОРОЙ профиль = утечка слота
     ORDER BY a.acc_no ASC NULLS LAST LIMIT ${killed.length}`).catch(() => ({ rows: [] as Record<string, any>[] }));
  const made: string[] = [];
  for (const q of queued) {
    try {
      const proxy = q.ig_proxy ? parseProxy(q.ig_proxy) : null;
      if (q.ig_proxy && !proxy) { console.warn(`[replace] ${q.slug}: прокси не распознан — пропуск`); continue; }
      const os = q.platform === 'tiktok' ? 'mac' : 'win';
      const pid = await createCloudProfile(q.acc_no != null ? `${q.acc_no} ${q.slug}` : q.slug, os, q.group_token);
      if (proxy) await setProfileProxy(pid, proxy, q.group_token).catch(() => {});
      // session_checked_at=NULL → maybeRelogin подхватит СРАЗУ и войдёт паролем+2FA.
      await query(`UPDATE accounts SET gologin_profile_id=$1, warmup_started_at=now(), session_checked_at=NULL WHERE id=$2`, [pid, q.id]).catch(() => {});
      made.push(q.slug);
    } catch (e) { console.warn(`[replace] завод ${q.slug} не удался:`, e instanceof Error ? e.message.slice(0, 80) : e); }
  }
  alertOwner(`♻️ Авто-замена: снесены ${killed.length} блокнутых [${killed.join(', ')}]${made.length ? ` → из очереди заведены: ${made.join(', ')} (войдут паролем+2FA на след. тике релогина)` : ' — очередь пуста / нет свободных слотов'}`);
  console.log(`[replace] снесено ${killed.length}, заведено ${made.length}`);
}

// === #3 ЗАВОД ИСЧЕЗНУВШИХ ПРОФИЛЕЙ (ig_status='profile_lost') ===
// profile_lost ставят: reconcile (выше) ИЛИ ПОСТИНГ/smartrun (write-side, при no_connect потерянного профиля).
// Тут: createCloudProfile (свежий) + setProfileProxy (прежний ig_proxy) + ensureEgress + вход паролём+2FA.
// ГАРДРЕЙЛ: gologinHealth().down (в начале И в цикле) — не заводим пачку при облачном шторме; кап PROFILE_REBUILD_MAX.
// pid и увод из profile_lost персистим ДО connect — иначе следующий тик заведёт ЕЩЁ профиль (утечка слота).
async function maybeRebuildLostProfiles() {
  if (/^(1|true|yes)$/i.test(String(process.env.PROFILE_REBUILD_OFF || ''))) return;
  if (gologinHealth().down) { console.log('[rebuild] GoLogin штормит — пропуск'); return; }
  const CAP = Math.max(1, Number(process.env.PROFILE_REBUILD_MAX) || 3);
  const { rows } = await query<Record<string, any>>(
    `SELECT a.id, a.slug, a.platform, a.acc_no, a.ig_proxy, a.proxy, a.ig_login, a.ig_password, a.totp_secret, a.ig_email, a.ig_email_password, g.gologin_token AS group_token
     FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE a.deleted_at IS NULL AND a.ig_status='profile_lost' AND coalesce(a.ig_password,'')<>'' AND g.gologin_token IS NOT NULL
     ORDER BY a.session_checked_at ASC NULLS FIRST LIMIT ${CAP}`).catch(() => ({ rows: [] as Record<string, any>[] }));
  let made = 0;
  for (const a of rows) {
    if (gologinHealth().down) break; // шторм посреди прогона — createCloudProfile предохранителем connect НЕ защищён
    try {
      await withLoginSlot(async () => {
        const os = a.platform === 'tiktok' ? 'mac' : 'win';
        let pid: string;
        try { pid = await createCloudProfile(a.acc_no != null ? `${a.acc_no} ${a.slug}` : a.slug, os, a.group_token); }
        catch (e) { alertOwner(`Завод профиля ${a.slug}: не создан (${(e instanceof Error ? e.message : String(e)).slice(0, 50)}) — вероятно лимит слотов`); throw new Error('stop-rebuild'); }
        const proxy = a.ig_proxy ? parseProxy(a.ig_proxy) : null;
        if (proxy) await setProfileProxy(pid, proxy, a.group_token).catch(() => {});
        // ПЕРСИСТ pid + увод из profile_lost ДО connect (анти-утечка слота). status=warming (инвариант), login_ok — временно.
        await query(`UPDATE accounts SET gologin_profile_id=$1, ig_status='login_ok', status='warming', session_checked_at=NULL WHERE id=$2`, [pid, a.id]).catch(() => {});
        made++;
        let session = null as Awaited<ReturnType<typeof connect>> | null;
        try {
          session = await connect(pid, a.group_token, { pool: 'logger', poolCap: loggerCap(), holder: a.slug });
          if (!(await ensureEgress(a, session.page))) return; // прокси мёртв → maybeFixProxy переставит, вход не жжём
          const creds = { login: a.ig_login, password: a.ig_password, totpSecret: a.totp_secret, email: a.ig_email, emailPassword: a.ig_email_password };
          const res = a.platform === 'tiktok' ? await tiktokLogin(session.page, creds) : await passwordLogin(session.page, creds);
          if (res === 'ok') {
            await query(`UPDATE accounts SET session_status='live', ig_status='login_ok', login_fails=0, session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {});
            noteReloginOk();
            console.log(`[rebuild] ${a.slug}: профиль заведён заново + вход ✓`);
          } else if (res === 'challenge' || res === 'captcha' || res === 'bad_creds') {
            const st = res === 'bad_creds' ? 'bad_login' : res;
            await query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead', session_checked_at=now() WHERE id=$1`, [a.id, st]).catch(() => {});
            void logAccountEvent(a.id, a.slug, a.platform, 'login_fail', { reason: res, stage: 'rebuild' }).catch(() => {});
          } else if (res === 'rate_limited' || res === 'error') {
            // Попытка не состоялась (частота заходов / инфра) — статус не трогаем (правило 07.08).
            console.warn(`[rebuild] ${a.slug}: вход не состоялся (${res}) — статус НЕ меняю`);
          } else {
            await query(`UPDATE accounts SET session_status='dead', login_fails=coalesce(login_fails,0)+1, session_checked_at=now() WHERE id=$1`, [a.id]).catch(() => {});
            void logAccountEvent(a.id, a.slug, a.platform, 'login_fail', { reason: loginFailReason(res), stage: 'rebuild' }).catch(() => {});
          }
        } finally { if (session) await disconnect(session); }
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'stop-rebuild') break; // лимит слотов — дальше не долбим
      console.warn(`[rebuild] ${a.slug}: инфра — ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    }
  }
  if (made) console.log(`[rebuild] заведено профилей: ${made}`);
}

// ВОТЧДОГ ЭФФЕКТИВНОСТИ РЕЛОГИНА: система сама понимает, что «цикл жив, но НЕ работает» (0 успехов входа
// при наличии ПОДЪЁМНЫХ акков) — а не молчит. Отличие от heartbeat (тот про «цикл жив»). Один алерт на
// эпизод, снимается при первом успехе (noteReloginOk). С разбивкой последних причин провала из account_events.
async function maybeReloginWatchdog() {
  if (/^(1|true|yes)$/i.test(String(process.env.RELOGIN_WATCHDOG_OFF || ''))) return;
  if (Date.now() - lastReloginOk <= RELOGIN_WATCH_WINDOW) return; // успех был в окне — всё работает
  if (reloginWatchAlerted) return;                                // уже алертили этот эпизод
  const r = await query<{ n: string }>(
    `SELECT count(*) n FROM accounts
     WHERE deleted_at IS NULL AND session_status='dead' AND status NOT IN ('paused','trash')
       AND coalesce(ig_password,'')<>'' AND gologin_profile_id IS NOT NULL AND coalesce(login_fails,0)<3`).catch(() => null);
  const recoverable = r ? Number(r.rows[0].n) : 0;
  if (recoverable <= 0) return; // нечего поднимать — не ложная тревога
  const hrs = Math.round(RELOGIN_WATCH_WINDOW / 3600000);
  const br = await query<{ reason: string; n: string }>(
    `SELECT coalesce(detail->>'reason','?') reason, count(*) n FROM account_events
     WHERE kind='login_fail' AND created_at > now() - ($1 || ' hours')::interval GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    [String(hrs)]).catch(() => null);
  const breakdown = (br?.rows || []).map((x) => `${x.reason}:${x.n}`).join(', ') || 'причин в account_events нет';
  reloginWatchAlerted = true;
  alertOwner(`🔴 РЕЛОГИН НЕ ПОДНИМАЕТ АККИ ~${hrs}ч: 0 успехов при ${recoverable} подъёмных. Причины провалов: ${breakdown}. Похоже сломан или облачный шторм GoLogin${gologinHealth().down ? ' (предохранитель СРАБОТАЛ — шторм)' : ''}.`);
}

// ПОДАЧА ПРОМО-РОЛИКОВ НА МАК (масс-постинг, 01.08).
// Облако промо НЕ публикует (leaseDuePost их не берёт) — оно только КЛАДЁТ задачу локальному раннеру,
// когда подошёл слот и аккаунт проходит гейты. Публикует igpost2.cjs на маке, окно за окном.
// Дубли физически невозможны: уникальный индекс uq_local_jobs_igpost_live на живые задачи по посту.
async function maybePushPromo(now: Date) {
  if (process.env.PROMO_AUTOPUSH_OFF === '1') return;
  const due = await query<Record<string, any>>(
    `SELECT p.id, a.slug, a.persona
       FROM posts p JOIN accounts a ON a.id = p.account_id
       LEFT JOIN post_batches b ON b.id = p.batch_id
      WHERE p.kind='promo' AND p.status='approved' AND p.post_submitted=false
        AND p.scheduled_at <= $1
        AND coalesce(b.status,'running') = 'running'
        AND a.deleted_at IS NULL AND a.status <> 'paused'
        -- АКК ДОЛЖЕН БЫТЬ ПОДГОТОВЛЕН. 02.08: ролики ушли на свежие акки с ЧУЖОЙ аватаркой и
        -- чужими постами прежнего владельца — профиль выглядел как угнанный. Гейт проверял
        -- живость сессии и куки, то есть «сможем ли опубликовать», и ни разу — «а стоит ли».
        -- dressed_at ставится только когда ава модели реально встала (prepacc.cjs).
        AND a.dressed_at IS NOT NULL
        -- ВЫДЕРЖКА ПОСЛЕ ОФОРМЛЕНИЯ. Пять акков сгорели, потому что чистка, ава, смена ника и
        -- первый пост случались в одну минуту: для IG это выглядит как перехваченный аккаунт,
        -- который сразу погнали в работу. Владелец 03.08 выбрал компромисс — 6 часов: не «сразу»,
        -- но и не сутки простоя. Это осознанный риск, а не безопасный режим.
        AND a.dressed_at < now() - interval '6 hours'
        -- И не постим сразу следом за сменой ника: это второе резкое изменение профиля подряд.
        AND (a.nick_changed_at IS NULL OR a.nick_changed_at < now() - interval '4 hours')
        AND a.session_status='live' AND coalesce(a.ig_cookies::text,'')<>''
        AND coalesce(a.ig_status,'') NOT IN ('restricted','suspended','captcha','challenge')
        AND coalesce(a.health_state,'') <> 'restricted'
        AND NOT EXISTS (SELECT 1 FROM local_jobs lj
                         WHERE lj.mode='igpost' AND lj.urls = p.id::text AND lj.status IN ('queued','running'))
      ORDER BY p.scheduled_at ASC LIMIT 1`, [now]);
  const post = due.rows[0];
  if (!post) return;
  // Пауза сети: между любыми двумя подачами держим интервал, чтобы окна Orbita не наложились.
  const busy = await query<Record<string, any>>(
    `SELECT 1 FROM local_jobs WHERE mode='igpost' AND status IN ('queued','running') LIMIT 1`);
  if (busy.rows.length) return;
  // ЕДИНЫЙ ПРЕДОХРАНИТЕЛЬ (06.08). Гейты в SQL выше проверяют «сможем ли опубликовать», но НЕ
  // знают про провалы: 06.08 задачи сыпались в акк, где Instagram уже выписал ограничение, по
  // одному заходу в минуту. Один и тот же код решает и в облаке, и на маке.
  const guard = await canPost(post.slug);
  if (!guard.ok) {
    console.log(`[promo] предохранитель не пустил @${post.slug}: ${guard.reason}`);
    return;
  }
  await query(`INSERT INTO local_jobs (slug, mode, n, urls, status) VALUES ($1,'igpost',1,$2,'queued')`,
    [post.slug, String(post.id)]);
  console.log(`[promo] подан на мак: ${post.persona} @${post.slug} (пост ${String(post.id).slice(0, 8)})`);
}

async function tickBody(now: Date) {
  await maybePublish(now);
  await maybePushPromo(now).catch((e) => console.warn('[promo] подача упала:', e instanceof Error ? e.message.slice(0, 80) : e));
  if (now.getTime() - lastSessions > SESSIONS_EVERY) { lastSessions = now.getTime(); await maybeSessions(); }
  if (now.getTime() - lastWarmup > WARMUP_EVERY) { lastWarmup = now.getTime(); await maybeWarmup(now); }
  if (now.getTime() - lastRelogin > RELOGIN_EVERY) { lastRelogin = now.getTime(); await maybeRelogin(); }
  if (now.getTime() - lastReplace > REPLACE_EVERY) { lastReplace = now.getTime(); await maybeReplaceBlocked().catch((e) => console.warn('[replace] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  if (now.getTime() - lastSeed > SEED_EVERY) { lastSeed = now.getTime(); await maybeSeed(now); }
  // Сторож тишины: реальный браузерный чек самого «давно не подтверждённого» акка. Без него
  // простаивающий акк числится живым вечно (быстрый REST-чек по куке для него врёт).
  if (now.getTime() - lastSilence > SILENCE_EVERY) { lastSilence = now.getTime(); await maybeSilenceWatch().catch((e) => console.warn('[тишина] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  // Восстановление login-софт-блока: свежий sticky из пула + вход, через 2ч после блока.
  if (now.getTime() - lastSoftblock > SOFTBLOCK_EVERY) { lastSoftblock = now.getTime(); await maybeSoftblockRecover().catch((e) => console.warn('[softblock] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  // Раз в 6ч: чистка мёртвых (сироты-профили + валидированный снос терминальных).
  if (now.getTime() - lastCleanup > CLEANUP_EVERY) { lastCleanup = now.getTime(); await maybeCleanupDead().catch((e) => console.warn('[cleanup] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  // #2 авто-реассайн прокси из пула + ресинк IP в профиль (раз в 10 мин).
  if (now.getTime() - lastFixProxy > FIXPROXY_EVERY) { lastFixProxy = now.getTime(); await maybeFixProxy().catch((e) => console.warn('[fixproxy] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  // #3 завод исчезнувших профилей profile_lost (15 мин) + сверка БД↔GoLogin (1 ч).
  if (now.getTime() - lastRebuild > REBUILD_EVERY) { lastRebuild = now.getTime(); await maybeRebuildLostProfiles().catch((e) => console.warn('[rebuild] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  if (now.getTime() - lastReconcile > RECONCILE_EVERY) { lastReconcile = now.getTime(); await maybeReconcileProfiles().catch((e) => console.warn('[reconcile] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
  // Вотчдог эффективности релогина: «цикл жив, но не поднимает акки» (0 успехов при подъёмных) → 🔴.
  if (now.getTime() - lastReloginWatch > RELOGIN_WATCH_EVERY) { lastReloginWatch = now.getTime(); await maybeReloginWatchdog().catch((e) => console.warn('[relogin-wd] тик упал:', e instanceof Error ? e.message.slice(0, 80) : e)); }
}
async function tick() {
  // Не наслаиваем тики: транскод видео + публикация могут идти дольше минуты.
  if (ticking) return;
  ticking = true;
  const now = new Date();
  try {
    // Сторож: если какой-то браузер/фетч завис — через 9 мин отпускаем тик,
    // чтобы `ticking` не залип навсегда (иначе весь воркер встаёт, как сейчас было).
    await Promise.race([
      tickBody(now),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tick watchdog: >9 мин, отпускаю')), 9 * 60 * 1000)),
    ]);
    beat('tick');
  } catch (err) {
    console.error('[worker] tick error:', err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

// Ответы из радара — ОТДЕЛЬНЫЙ цикл, чтобы не стоять в очереди за publish/sessions/warmup
// в основном тике (из-за этого «акк в очереди — ничего не происходит»). Со слотом акк2
// синхронизируется через browser-lock (два профиля одного тарифа разом всё равно нельзя).
// АВТО-РАЗДАЧА: если включена (radar_config.auto_reply), сам отдаёт посты со спросом отдохнувшим аккам
// под лимитом. Раздаёт РОВНО столько постов, сколько сейчас доступно акков (живой + под лимитом + отдохнул
// min_gap_min), по одному посту на акк — так один акк не горит. Дальше пул сам их обработает.
// Цель по кол-ву НАШИХ ответов на пост в зависимости от объёма комментов (спека юзера):
//  ≤100 → ~10% от общего (мин 3);  100-500 → ~12;  500+ → ~25. Бренд-коммент — 1 (первым заданием).
function tierTarget(cc: number): number {
  if (cc <= 100) return Math.max(3, Math.floor(cc * 0.1));
  if (cc <= 500) return 12;
  return 25;
}

// === ПУЛ ОТРАБОТКИ === queued-посты (кнопка 🚀/🎯) РЕАЛЬНО превращаем в задания комментинга. БЕЗОПАСНО:
//  • один акк за заход отвечает ≤3 людям (анти-ШБ);  • на пост даём НОВОЕ задание не чаще gap-минут
//  (растягиваем во времени, не наваливаем толпой);  • акки под дневным лимитом, отдохнувшие, с ротацией;
//  • дежурные (watchdog) сюда не берём. Прогресс = сколько уже ответили (бронь); дошли до цели → из пула.
async function maybeWorkQueue() {
  // Анти-контенция: если очередь «В РАБОТЕ» отрабатывает движок commenter (queue_supervisor в ig-worker),
  // на web-сервисе ставим WORK_QUEUE_OFF=1 — иначе два процесса дублируют комменты и дерутся за GoLogin-профили.
  if (/^(1|true|yes)$/i.test(String(process.env.WORK_QUEUE_OFF || ''))) return;
  const { rows: cfg } = await query<Record<string, any>>(`SELECT daily_limit, min_gap_min FROM radar_config WHERE id=1`);
  const limit = Number(cfg[0]?.daily_limit) || 14;
  const gap = Number(cfg[0]?.min_gap_min) || 25;
  const PER_TASK = Math.max(1, Number(process.env.WORK_PER_TASK) || 3); // ≤N ответов с акка за один заход
  // Посты в работе, которым ещё НУЖНА отработка: нет активного задания И последнее задание по посту старше gap.
  const { rows: posts } = await query<Record<string, any>>(
    `SELECT p.code, p.url, p.seq, coalesce(p.comment_count,0) cc,
            (SELECT count(*) FROM radar_reply_targets t WHERE t.post_code=p.code) AS answered,
            (SELECT count(*) FROM radar_replies r WHERE r.post_code=p.code AND r.roles IN ('both','brand') AND r.status='posted') AS brand_done
     FROM radar_posts p
     WHERE p.queued_at IS NOT NULL AND p.status='new'
       AND NOT EXISTS (SELECT 1 FROM radar_replies r WHERE r.post_code=p.code AND r.status IN ('pending','posting'))
       AND NOT EXISTS (SELECT 1 FROM radar_replies r WHERE r.post_code=p.code AND r.created_at > now() - interval '${gap} minutes')
     ORDER BY p.queued_at ASC`);
  if (!posts.length) return;
  const availSql = `FROM accounts a WHERE a.platform IN ('comments','instagram') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_role,'')<>'reader' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')<>'dead'
       AND coalesce(a.ig_status,'')<>'restricted' -- share-restricted («нельзя делиться ссылками») бренд не постит — из пула вон
       AND NOT EXISTS (SELECT 1 FROM account_groups gw WHERE gw.id=a.group_id AND gw.watchdog=true)
       AND (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) < ${limit}
       AND (a.last_commented_at IS NULL OR a.last_commented_at < now() - interval '${gap} minutes')`;
  const usedAccs: string[] = []; // один акк — не больше ОДНОГО задания за проход (анти-ШБ: не наваливаем на него)
  for (const p of posts) {
    const target = tierTarget(Number(p.cc));
    if (Number(p.answered) >= target) { // цель достигнута — НЕ снимаем из «В РАБОТЕ» (там приходят новые комменты, их отвечает
      // supervisor). Ставим status='reviewed' (воркер больше не берёт, но queued_at ОСТАЁТСЯ → пост виден и обрабатывается).
      await query(`UPDATE radar_posts SET status='reviewed', worked_count=comment_count WHERE code=$1`, [p.code]).catch(() => {});
      console.log(`[work] пост #${p.seq}: цель ${target} достигнута (${p.answered}) — передан supervisor (остаётся в В РАБОТЕ)`);
      continue;
    }
    // Акк: живой, под лимитом, отдохнул, НЕ работал по этому посту за 2ч (ротация) И не занят другим постом в этом проходе.
    const { rows: acc } = await query<Record<string, any>>(
      `SELECT a.id, a.slug ${availSql}
         AND NOT (a.id = ANY($2::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM radar_replies r WHERE r.post_code=$1 AND r.account_id=a.id AND r.created_at > now() - interval '2 hours')
       ORDER BY (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) ASC, a.last_commented_at ASC NULLS FIRST LIMIT 1`, [p.code, usedAccs]);
    if (!acc.length) continue; // сейчас некому — попробуем следующим тиком
    usedAccs.push(acc[0].id);
    const remaining = target - Number(p.answered);
    const perTask = Math.min(PER_TASK, remaining);
    const needBrand = Number(p.brand_done) === 0;
    const roles = needBrand ? 'both' : 'askers'; // первое задание — бренд+промпт+ответы; дальше только ответы
    await query(
      `INSERT INTO radar_replies (post_code, post_url, account_id, text, asker_count, roles, no_prompt, status)
       VALUES ($1,$2,$3,'',$4,$5,false,'pending')`, [p.code, p.url, acc[0].id, perTask, roles],
    ).then(() => console.log(`[work] пост #${p.seq} → ${acc[0].slug} (${roles}, до ${perTask} чел, прогресс ${p.answered}/${target})`)).catch(() => {});
  }
}

async function maybeAutoReply() {
  const { rows: cfg } = await query<Record<string, any>>(`SELECT auto_reply, daily_limit, min_gap_min, auto_askers FROM radar_config WHERE id=1`);
  if (!cfg[0]?.auto_reply) return;
  const limit = Number(cfg[0].daily_limit) || 14;
  const gap = Number(cfg[0].min_gap_min) || 25;
  const askers = Math.max(0, Math.min(10, Number(cfg[0].auto_askers ?? 3)));
  // Доступные акки: живые, под дневным лимитом, отдохнули (последний коммент > gap минут назад). Ротация.
  const availSql = `FROM accounts a WHERE a.platform IN ('comments','instagram') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_role,'')<>'reader' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')<>'dead'
       AND coalesce(a.ig_status,'')<>'restricted' -- share-restricted («нельзя делиться ссылками») бренд не постит — из пула вон
       AND NOT EXISTS (SELECT 1 FROM account_groups gw WHERE gw.id=a.group_id AND gw.watchdog=true) -- дежурные не в авто-раздаче
       AND (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) < ${limit}
       AND (a.last_commented_at IS NULL OR a.last_commented_at < now() - interval '${gap} minutes')`;
  const { rows: accs } = await query<Record<string, any>>(
    `SELECT a.id, a.slug ${availSql} ORDER BY (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) ASC, a.last_commented_at ASC NULLS FIRST LIMIT 5`);
  if (!accs.length) return; // некому раздавать сейчас — все заняты лимитом/отдыхом
  // Посты со спросом, ещё БЕЗ ответа. Приоритет — высокий спрос, затем скор/свежесть.
  const { rows: posts } = await query<Record<string, any>>(
    `SELECT code, url, seq FROM radar_posts WHERE status='new' AND coalesce(demand_hits,0) >= 1
       AND NOT EXISTS (SELECT 1 FROM radar_replies r WHERE r.post_code = radar_posts.code)
     ORDER BY demand_hits DESC, score DESC, created_at DESC LIMIT ${accs.length}`);
  for (let i = 0; i < posts.length && i < accs.length; i++) {
    await query(
      `INSERT INTO radar_replies (post_code, post_url, account_id, text, asker_count, no_prompt, status)
       VALUES ($1,$2,$3,'',$4,false,'pending')`, [posts[i].code, posts[i].url, accs[i].id, askers],
    ).then(() => console.log(`[auto] раздал пост #${posts[i].seq} → ${accs[i].slug} (спрос, отдохнул)`)).catch(() => {});
  }
}

// === 🛡 ДЕЖУРСТВО НА ГЛАВНОМ ПОСТУ === (напр. рил Алины) Отвечает НОВЫМ спрашивающим с дежурного
// акка (ig_role='duty'; первый живой по списку = на смене). Кому ответили — бронь в radar_reply_targets.
// Дежурный упал (сессия/капча/блок автора) — на смену следующий, владельцу алерт в ТГ.
// РИТМ: раз в DUTY_CHECK анонимный HTTP-чек числа комментов (БЕЗ логина и браузера — акк не жжём).
// Число выросло → дежурный выходит СРАЗУ. Чек не отдался (IG зарезал дата-центровый IP) —
// фолбэк-расписание визитов: 10 мин днём / 20 мин ночью (по Варшаве).
const DUTY_CHECK_EVERY = Number(process.env.DUTY_CHECK_MS) || 5 * 60 * 1000;
const DUTY_DAY_EVERY = Number(process.env.DUTY_DAY_MS) || 10 * 60 * 1000;
const DUTY_NIGHT_EVERY = Number(process.env.DUTY_NIGHT_MS) || 20 * 60 * 1000;
const DUTY_MAX_AGE_MIN = Number(process.env.DUTY_MAX_AGE_MIN) || 120; // отвечаем спросившим не старше ~2ч
const DUTY_TARGET = Math.max(1, Number(process.env.DUTY_TARGET) || 3); // сколько живых дежурных держим на посту
let lastDuty = 0;
let lastDutyCheck = 0;
let lastDutySlug = '';
let lastStandinKey = ''; // дедуп алерта «подхватили X» (транзиентный добор смены)
let lastShortfallKey = ''; // дедуп алерта «штат урезан, добрать некем»

// «14K»/«1,234» → число (для og:description «X comments»).
function dutyMetric(raw: string): number {
  const m = String(raw).match(/([\d.,]+)\s*([KMkm])?/);
  if (!m) return 0;
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K') return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1e3);
  if (suf === 'M') return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1e6);
  return parseInt(m[1].replace(/[.,\s]/g, ''), 10) || 0;
}
// Анонимный чек: тянем HTML поста обычным fetch (без логина/браузера) и читаем «N comments»
// из og:description. null = IG не отдал (логин-волл/блок IP) — тогда работает фолбэк-расписание.
async function fetchDutyCommentCount(code: string): Promise<number | null> {
  try {
    const r = await fetch(`https://www.instagram.com/p/${code}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow', signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/([\d.,]+[KMkm]?)\s+comments/i) || html.match(/([\d.,]+[KMkm]?)\s+комментар/i);
    return m ? dutyMetric(m[1]) : null;
  } catch { return null; }
}

async function maybeDuty(anonCount: number | null = null) {
  const { rows: cfgRows } = await query<Record<string, any>>(
    `SELECT duty_url, duty_enabled, duty_per_visit FROM radar_config WHERE id=1`).catch(() => ({ rows: [] as any[] }));
  const cfg = cfgRows[0];
  if (!cfg?.duty_enabled) return;
  const url = String(cfg.duty_url || '').trim();
  const code = (url.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
  if (!url || !code) return;
  // Дежурные по списку: живые, не на паузе, не в блоке у автора ЭТОГО поста И с запасом ЧАСОВОГО
  // лимита (не больше N ответов с акка в час — считаем по брони radar_reply_targets). Отвечаем ВСЕМ:
  // первый акк с запасом = на смене; выжег час — на пост выходит следующий, и так по кругу.
  const perHour = Math.max(1, Math.min(10, Number(cfg.duty_per_visit) || 5));
  // Колонки дежурного: id/слаг/платформа/профиль/токен группы + часовой расход (сколько ответов с акка за час).
  // Часовой расход СЧИТАЕМ ТОЛЬКО по дежурному посту ($1=code): обычные radar-ответы акка на ДРУГИХ постах
  // не должны съедать его дежурный бюджет (иначе дежурство молча простаивало бы «всё выбрали лимит»).
  const DUTY_COLS = `a.id, a.slug, a.platform, a.gologin_profile_id, a.proxy, a.proxy_status, a.egress_checked_at, g.gologin_token AS group_token,
            (SELECT count(*) FROM radar_reply_targets t
              WHERE t.assigned_account_id=a.id AND t.post_code=$1 AND t.created_at > now() - interval '1 hour') AS hour_used`;
  // КУРАТОРСКИЙ СОСТАВ = акки ДЕЖУРНОЙ ГРУППЫ (g.watchdog) или с явной ролью ig_role='duty' (владелец назначил).
  // Живые, не на паузе, не в блоке у автора ЭТОГО поста. Первый по списку = на смене, выжег час — следующий.
  const selectDuty = async () => (await query<Record<string, any>>(
    `SELECT ${DUTY_COLS}
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE (coalesce(g.watchdog,false)=true OR a.ig_role='duty')
       AND coalesce(a.ig_role,'')<>'reader' AND a.platform IN ('comments','instagram') -- искатель и чужие площадки НЕ дежурят
       AND a.deleted_at IS NULL AND a.status<>'paused'
       AND coalesce(a.session_status,'')<>'dead' AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.proxy_status,'')<>'dead' -- з.1: не выпускаем на замеренно-мёртвом прокси
       AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
     ORDER BY substring(a.slug from '\\d+')::int NULLS LAST, a.slug`, [code])).rows;
  let duty = await selectDuty();
  // ТРАНЗИЕНТНЫЙ ПОДХВАТ: если кураторский состав просел ниже DUTY_TARGET, ДОБИРАЕМ на ЭТОТ тик лучших живых
  // комментеров, НЕ входящих в состав. РОЛЬ В БД НЕ ПИШЕМ — нет храповика/дрейфа фермы/поломки пула ридера;
  // восстановился штат — добор исчезает сам, демоушен не нужен. Добор идёт ПОСЛЕ кураторских (в конце массива),
  // поэтому назначенные владельцем акки всегда выходят на пост первыми. Исключаем watchdog-группу (её живые
  // акки уже в составе) и уже отобранных (по id), чтобы не считать одного дважды.
  if (duty.length >= DUTY_TARGET) {
    lastStandinKey = '';
  } else {
    const have = duty.map((d) => d.id);
    const { rows: standins } = await query<Record<string, any>>(
      `SELECT ${DUTY_COLS}
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
       WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.ig_role IS NULL
         AND coalesce(g.watchdog,false)=false
         AND a.status NOT IN ('paused','trash') AND coalesce(a.session_status,'')='live'
         AND a.gologin_profile_id IS NOT NULL
         AND NOT (a.id = ANY($3::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
       ORDER BY a.last_commented_at DESC NULLS LAST LIMIT $2`,
      [code, DUTY_TARGET - duty.length, have],
    ).catch((e) => { console.warn('[duty] подхват не выбрался:', e instanceof Error ? e.message.slice(0, 100) : e); return { rows: [] as any[] }; });
    if (standins.length) {
      duty = duty.concat(standins); // в конец — кураторские идут первыми
      const key = standins.map((s) => s.slug).sort().join(',');
      if (key !== lastStandinKey) {
        lastStandinKey = key;
        await notifyOwner(`🛡 Штат просел (${duty.length - standins.length}/${DUTY_TARGET}) — на этот заход подхватили: ${standins.map((s) => s.slug).join(', ')}. Роль не назначается, вернутся к обычному комментингу сами`, { force: true }).catch(() => {});
      }
    }
  }
  // Всё равно недобор и подхватить некем — предупредить ОДИН раз (дедуп), чтобы «1-2 из 3» не тянулось молча.
  if (duty.length < DUTY_TARGET) {
    const short = `${duty.length}/${DUTY_TARGET}`;
    if (short !== lastShortfallKey) {
      lastShortfallKey = short;
      console.warn(`[duty] штат ниже цели: ${short}, свободных на подхват нет`);
      if (duty.length > 0) await notifyOwner(`🛡 Дежурство урезано: на посту ${short}, свободных живых акков на подхват нет`, { force: true }).catch(() => {});
    }
  } else {
    lastShortfallKey = '';
  }
  const acc = duty.find((a) => Number(a.hour_used || 0) < perHour);
  if (!acc) {
    if (!duty.length) {
      if (lastDutySlug !== '-') { lastDutySlug = '-'; await notifyOwner('🛡 Дежурство: живых дежурных акков не осталось — назначь новые в панели радара', { force: true }).catch(() => {}); }
    } else {
      console.log(`[duty] все дежурные выбрали часовой лимит (${perHour}/час) — ждём`);
    }
    return;
  }
  const hourLeft = perHour - Number(acc.hour_used || 0); // сколько ещё можно с этого акка в этот час
  if (acc.slug !== lastDutySlug) {
    if (lastDutySlug && lastDutySlug !== '-') await notifyOwner(`🛡 Дежурный на главном посту сменился: ${lastDutySlug} → ${acc.slug}`, { force: true }).catch(() => {});
    lastDutySlug = acc.slug;
  }
  if (!tryReserveProfile(acc.gologin_profile_id)) return; // профиль занят — проверим следующим тиком
  try {
    await withBrowserLock(async () => {
      let session = null as Awaited<ReturnType<typeof connect>> | null;
      try {
        startActivity('duty', acc.slug);
        session = await connect(acc.gologin_profile_id, acc.group_token, { pool: 'patrol', holder: acc.slug });
        // ГЕЙТ EGRESS (з.1): прокси мёртв → дежурного не выпускаем, следующий тик выведет сменщика.
        if (!(await ensureEgress(acc, session.page))) { console.log(`[duty] ${acc.slug}: прокси мёртв (egress) — пропуск`); return; }
        if (!(await ensureLoggedIn(session.page))) {
          // НЕ «разлогинен» вслепую: классифицируем экран (вериф номера / чек-поинт / капча / суспенд /
          // разлогин) — терминальные метятся + пауза, алерт говорит правду.
          const scr = await markLoginFailed(acc, session.page);
          const terminal = scr.kind === 'suspended' || scr.kind === 'challenge_phone' || scr.kind === 'challenge';
          const deadShot = await session.page.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 }).catch(() => null);
          const cap = `🛡 Дежурный ${acc.slug}: ${scr.label}${terminal ? ' — акк на ПАУЗЕ, нужны руки/замена' : ''} — на смену выйдет следующий\n«${scr.note}»`;
          if (deadShot) await notifyPhoto(cap, deadShot).catch(() => {});
          else await notifyOwner(cap, { force: true }).catch(() => {});
          return;
        }
        const driver = driverFor(acc.platform);
        const r = await runRadarEngagement(session.page, driver, {
          url, askerTexts: [], brandBase: '', maxAskers: hourLeft, doAskers: true, doBrand: false,
          claim: { postCode: code, accountId: acc.id }, onStep: updateActivity,
          maxAgeMin: DUTY_MAX_AGE_MIN, // отвечаем только спросившим за последние ~2ч (+ катч-ап после сбоя)
        });
        if (r.askerReplies > 0) {
          await query(
            `UPDATE accounts SET comments_today = (CASE WHEN comments_day = (now() at time zone 'Europe/Warsaw')::date THEN comments_today ELSE 0 END) + $2,
                    comments_day = (now() at time zone 'Europe/Warsaw')::date, last_commented_at = now(), session_status='live', session_checked_at=now() WHERE id = $1`,
            [acc.id, r.askerReplies]).catch(() => {});
          // Отчёт с ПАРАМИ «вопрос → наш ответ» — владелец видит, кому и что написали.
          const qaLines = (r.qa || []).map((x) => `\n\n❓ ${x.u ? '@' + x.u + ': ' : ''}«${x.q}»\n💬 «${x.a}»`).join('');
          await notifyOwner(`🛡 Дежурный ${acc.slug}: ответил ${r.askerReplies} новым на главном посту (час: ${Number(acc.hour_used || 0) + r.askerReplies}/${perHour})${qaLines}\n\n${url}`, { force: true }).catch(() => {});
          // + СКРИН поста после ответов (подпись Telegram ≤1024 — детали ушли текстом выше, тут короткая).
          await session.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          await session.page.waitForTimeout(700);
          const okShot = await session.page.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 }).catch(() => null);
          if (okShot) await notifyPhoto(`🛡 ${acc.slug}: пост после ${r.askerReplies} ответов`, okShot).catch(() => {});
          console.log(`[duty] ${acc.slug}: ответил ${r.askerReplies} новым (час ${Number(acc.hour_used || 0) + r.askerReplies}/${perHour})`);
          // Базовая линия числа комментов: анонимный чек + наши свежие ответы (они тоже растят счётчик).
          if (anonCount !== null) await query(`UPDATE radar_config SET duty_last_count=$1 WHERE id=1`, [anonCount + r.askerReplies]).catch(() => {});
        } else if (r.reason && /не нашёл поле|недоступ|приватн/.test(r.reason)) {
          // Автор ограничил доступ этому акку (или чек-поинт) — фиксируем блок, следующий тик выйдет сменщик.
          await query(`INSERT INTO post_account_blocks (code, account_id, blocked) VALUES ($1,$2,true)
                       ON CONFLICT (code, account_id) DO UPDATE SET blocked=true, checked_at=now()`, [code, acc.id]).catch(() => {});
          // Скрин ТОГО, что видит акк (капча/чек-поинт/грид профиля) — владелец отличит бан акка от блока автора.
          const cap = `🛡 Дежурный ${acc.slug} не видит главный пост (${r.reason}) — пост-блок, на смену выйдет следующий. Акк живой: продолжает комментить другие посты`;
          const shot = await session.page.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 }).catch(() => null);
          if (shot) await notifyPhoto(cap, shot).catch(() => {});
          else await notifyOwner(cap, { force: true }).catch(() => {});
        } else {
          console.log(`[duty] ${acc.slug}: новых вопросов нет (или все уже отвечены)`);
          if (anonCount !== null) await query(`UPDATE radar_config SET duty_last_count=$1 WHERE id=1`, [anonCount]).catch(() => {});
        }
      } catch (err) {
        if (err instanceof SessionError) {
          await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [acc.id]).catch(() => {});
          await notifyOwner(`🛡 Дежурный ${acc.slug}: сессия умерла — на смену выйдет следующий`, { force: true }).catch(() => {});
        } else if (err instanceof CaptchaError) {
          await query(`UPDATE accounts SET status='paused' WHERE id=$1`, [acc.id]).catch(() => {});
          await notifyOwner(`🛡 Дежурный ${acc.slug}: капча — акк на паузе, на смену выйдет следующий`, { force: true }).catch(() => {});
        } else {
          console.warn('[duty] сбой:', err instanceof Error ? err.message.slice(0, 120) : err);
        }
      } finally {
        finishActivity(true, null, {});
        if (session) await disconnect(session);
      }
    }, lockKey(acc.group_token));
  } finally { releaseProfile(acc.gologin_profile_id); }
}
let dutyTicking = false;
async function dutyTick() {
  if (dutyTicking) return;
  dutyTicking = true;
  let threw = false;
  try {
    const now = Date.now();
    if (now - lastDutyCheck < DUTY_CHECK_EVERY) return;
    lastDutyCheck = now;
    const { rows: cfgRows } = await query<Record<string, any>>(
      `SELECT duty_url, duty_enabled, duty_last_count FROM radar_config WHERE id=1`).catch(() => ({ rows: [] as any[] }));
    const cfg = cfgRows[0];
    if (!cfg?.duty_enabled) return;
    const code = (String(cfg.duty_url || '').match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
    if (!code) return;
    // 1) АНОНИМНЫЙ ЧЕК (без логина): выросло число комментов → есть новые → выходим сразу.
    const cnt = await fetchDutyCommentCount(code);
    let go = false;
    if (cnt !== null) {
      const stored = Number(cfg.duty_last_count || 0);
      if (stored === 0) { // первый чек — базовая линия без визита
        await query(`UPDATE radar_config SET duty_last_count=$1 WHERE id=1`, [cnt]).catch(() => {});
        console.log(`[duty] анонимный чек: базовая линия ${cnt} комментов`);
      } else if (cnt > stored) {
        go = true;
        console.log(`[duty] анонимный чек: комментов ${cnt} (+${cnt - stored}) — дежурный выходит СРАЗУ`);
      } else {
        if (cnt < stored) await query(`UPDATE radar_config SET duty_last_count=$1 WHERE id=1`, [cnt]).catch(() => {}); // удаления — не копим ложный зазор
        console.log(`[duty] анонимный чек: новых комментов нет (${cnt})`);
      }
    } else {
      // 2) ФОЛБЭК: IG не отдал страницу анониму — обычное расписание: 10 мин днём / 20 мин ночью (Варшава).
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false }).format(new Date()));
      const every = hour >= 8 ? DUTY_DAY_EVERY : DUTY_NIGHT_EVERY;
      if (now - lastDuty >= every) { go = true; console.log(`[duty] анонимный чек недоступен — плановый визит (${hour >= 8 ? 'день/10мин' : 'ночь/20мин'})`); }
    }
    if (!go) return;
    lastDuty = now;
    await Promise.race([
      maybeDuty(cnt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('duty watchdog >8 мин — отпускаю')), 8 * 60 * 1000)),
    ]);
  } catch (err) {
    threw = true;
    console.error('[worker] duty tick error:', err instanceof Error ? err.message : err);
  } finally {
    if (!threw) beat('duty'); // холостой проход (нет новых комментов) = цикл жив
    dutyTicking = false;
  }
}

let replyTicking = false;
async function replyTick() {
  if (replyTicking) return;
  replyTicking = true;
  try {
    // Зависшие 'posting' (>15 мин ОТ НАЧАЛА постинга, не от создания) — в ошибку, чтобы статус не висел.
    await query(`UPDATE radar_replies SET status='failed', error='прервано (таймаут сессии)' WHERE status='posting' AND coalesce(posting_at, created_at) < now() - interval '15 minutes'`).catch(() => {});
    await maybeWorkQueue().catch((e) => console.warn('[work] пул:', e instanceof Error ? e.message.slice(0, 80) : e)); // queued-посты → задания
    await maybeAutoReply().catch((e) => console.warn('[auto] раздача:', e instanceof Error ? e.message.slice(0, 80) : e));
    await Promise.race([
      maybeRadarReply(new Date()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('reply watchdog: >20 мин')), 20 * 60 * 1000)),
    ]);
    beat('reply');
  } catch (err) {
    console.error('[worker] reply tick error:', err instanceof Error ? err.message : err);
  } finally {
    replyTicking = false;
  }
}

// Радар (искатель = GoLogin акк1) крутится в ОТДЕЛЬНОМ цикле — свой слот, не ждёт прогрев/
// комменты акк2. Так он реально идёт нон-стоп параллельно аккаунтам (замки разнесены по токену).
let radarTicking = false;
async function radarTick() {
  if (radarTicking) return;
  radarTicking = true;
  try {
    // Сторож: если скан завис (чек-поинт искателя/зависший goto) — через 6 мин отпускаем,
    // чтобы радар не залип навсегда (иначе новые посты не ищутся).
    await Promise.race([
      maybeRadar(new Date()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('radar watchdog >10 мин — отпускаю')), 10 * 60 * 1000)), // 10 ссылок + recheck 5 постов не влезали в 6
    ]);
    beat('radar');
  } catch (err) {
    console.error('[worker] radar tick error:', err instanceof Error ? err.message : err);
  } finally {
    radarTicking = false;
  }
}

// === HEARTBEAT ВОРКЕРА (закрывает дыру ARCHITECTURE.md §7: «смерть тиков видна только по тишине в ТГ») ===
// По каждому циклу считаем прогоны (runs) + время последнего УСПЕШНОГО завершения (lastOk). Раз в час
// (ночью раз в 3ч) шлём сводную строку. Если цикл не завершался дольше своего порога — немедленный 🔴.
type Beat = { runs: number; lastOk: number; alerted: boolean };
const beats: Record<string, Beat> = {
  tick: { runs: 0, lastOk: Date.now(), alerted: false },
  radar: { runs: 0, lastOk: Date.now(), alerted: false },
  reply: { runs: 0, lastOk: Date.now(), alerted: false },
  duty: { runs: 0, lastOk: Date.now(), alerted: false },
};
function beat(name: keyof typeof beats): void { const b = beats[name]; if (b) { b.runs++; b.lastOk = Date.now(); b.alerted = false; } }
// === НАБЛЮДАТЕЛЬ: ходит по постам, читает просмотры, чекит акки ===
const OBSERVER_EVERY = 15 * 60 * 1000; // тик наблюдателя — раз в ~15 мин
async function observerTick() {
  try {
    const cfg = (await query<Record<string, any>>(
      `SELECT observer_account_id, observer_started_at FROM radar_config WHERE id=1`)).rows[0];
    const observerId = cfg?.observer_account_id;
    if (!observerId) return;
    // Берём опубликованные посты (последние 7 дней, Instagram).
    const { rows: posts } = await query<Record<string, any>>(
      `SELECT p.id, p.external_url, p.media_url, a.slug AS account_slug, a.gologin_profile_id, a.ig_login
       FROM posts p
       JOIN accounts a ON a.id=p.account_id
       WHERE p.platform='instagram' AND p.status='published'
         AND p.published_at > now() - interval '7 days'
       ORDER BY p.published_at DESC LIMIT 10`,
    );
    if (!posts.length) return;
    // Подключаем наблюдателя.
    await withBrowserLock(async () => {
      const obsAcc = (await query<Record<string, any>>(
        `SELECT gologin_profile_id, ig_login FROM accounts WHERE id=$1`, [observerId])).rows[0];
      if (!obsAcc?.gologin_profile_id) return;
      let session: Awaited<ReturnType<typeof connect>> | null = null;
      try {
        session = await connect(obsAcc.gologin_profile_id);
        const logged = await ensureLoggedIn(session.page);
        if (!logged) { console.log('[observer] не залогинен'); return; }
        // Ходим по постам.
        let checked = 0;
        for (const post of posts) {
          if (!post.external_url) continue;
          try {
            updateActivity(`наблюдатель: ${post.account_slug}`);
            await session.page.goto(post.external_url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            await session.page.waitForTimeout(2_000);
            // Instagram показывает просмотры в разных местах — читаем из мета-данных поста.
            const viewCount = await session.page.evaluate(() => {
              // Вариант 1: data-testid="views"
              const el = document.querySelector('[data-testid="views"]');
              if (el) { const txt = el.textContent || ''; const m = txt.match(/([\d.,]+)/); return m ? parseFloat(m[1].replace(',', '.')) : 0; }
              // Вариант 2: мета-теги OG
              const og = document.querySelector('meta[property="og:description"]');
              if (og) { const txt = og.getAttribute('content') || ''; const m = txt.match(/([\d.,]+)\s*views?/i); return m ? parseFloat(m[1].replace(',', '.')) : 0; }
              return 0;
            }).catch(() => 0);
            // Сохраняем результат.
            await query(
              `INSERT INTO observer_results (observer_account_id, post_id, view_count) VALUES ($1,$2,$3)`,
              [observerId, post.id, viewCount],
            );
            checked++;
          } catch (e) {
            console.warn(`[observer] пост ${post.id}: ${(e as Error).message.slice(0, 80)}`);
          }
        }
        // Записываем запуск.
        await query(
          `INSERT INTO observer_runs (observer_account_id, duration_s, posts_checked) VALUES ($1, $2, $3)`,
          [observerId, OBSERVER_EVERY / 1000, checked],
        );
        if (checked) console.log(`[observer] проверено постов: ${checked}`);
      } finally {
        if (session) await disconnect(session);
      }
    });
  } catch (e) {
    console.warn('[observer]', e instanceof Error ? e.message : e);
  }
}
// watchdog: tick 9м / radar 10м / reply 20м / duty 8м). Берём с запасом, чтобы не было ложных 🔴.
const SILENT_MS: Record<string, number> = { tick: 15 * 60_000, radar: 20 * 60_000, reply: 40 * 60_000, duty: 20 * 60_000 };
let lastHeartbeat = 0;
function warsawHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false }).format(new Date()));
}
async function heartbeatTick(): Promise<void> {
  if (/^(1|true|yes)$/i.test(String(process.env.HEARTBEAT_OFF || ''))) return;
  const now = Date.now();
  // 1) НЕМЕДЛЕННЫЙ 🔴 при тишине цикла — в любое время суток, один раз на эпизод (alerted сбросится при оживлении).
  for (const name of Object.keys(beats)) {
    const b = beats[name]; const silent = now - b.lastOk;
    if (silent > (SILENT_MS[name] || 15 * 60_000) && !b.alerted) {
      b.alerted = true;
      alertOwner(`🔴 Цикл ${name} молчит ${Math.round(silent / 60_000)} мин — web-воркер завис/цикл умер. Проверь Railway web.`);
    }
  }
  // 2) СВОДКА — раз в час днём, раз в 3 часа ночью (00–08 Варшава), чтобы не спамить.
  const base = Math.max(5 * 60_000, Number(process.env.HEARTBEAT_EVERY_MS) || 60 * 60_000);
  const h = warsawHour();
  const every = (h >= 0 && h < 8) ? base * 3 : base;
  if (now - lastHeartbeat >= every) {
    lastHeartbeat = now;
    const r = await query<{ live: string; n: string }>(
      `SELECT count(*) FILTER (WHERE session_status='live' AND status<>'paused') live, count(*) n FROM accounts WHERE platform='comments' AND deleted_at IS NULL`).catch(() => null);
    const live = r?.rows[0];
    const d = dutyStatus();
    const line = `💓 web жив | tick ${beats.tick.runs} | radar ${beats.radar.runs} | reply ${beats.reply.runs} | duty ${beats.duty.runs} | акки live ${live ? live.live : '?'}/${live ? live.n : '?'}${d.alarm ? ' | ТРЕВОГА' : ''}`;
    void notifyOwner(line, { force: true }).catch(() => {}); // force: строки различаются счётчиками, но подстрахуемся от троттла
    for (const name of Object.keys(beats)) beats[name].runs = 0; // счётчики — за период между сводками
  }
}

export function startWorker() {
  console.log('[worker] запущен: публикация 1/мин, сессии 30 мин, прогрев ~12 мин, радар — свой цикл');
  // Ответы, зависшие в 'posting' (воркер перезапустился деплоем на середине) — вернуть в очередь.
  void query(`UPDATE radar_replies SET status='pending' WHERE status='posting'`).catch(() => {});
  ffmpegAvailable().then((ok) => {
    if (ok) console.log('[worker] ffmpeg на месте — уникализация видео доступна');
    else { console.warn('[worker] ffmpeg НЕ найден — уникализация недоступна'); alertOwner('ffmpeg не установлен на сервере — уникализация видео не будет работать'); }
  });
  setInterval(tick, PUBLISH_EVERY);
  setInterval(radarTick, PUBLISH_EVERY); // отдельный цикл радара (акк1) — параллельно основному
  setInterval(replyTick, PUBLISH_EVERY); // отдельный цикл ответов из радара (акк2) — не ждёт основной тик
  setInterval(dutyTick, PUBLISH_EVERY);  // 🛡 дежурство на главном посту — свой цикл, интервал внутри (DUTY_EVERY)
  setInterval(observerTick, OBSERVER_EVERY); // 👁 наблюдатель: чекит просмотры постов
  setInterval(() => { void heartbeatTick().catch(() => {}); }, 60 * 1000); // 💓 heartbeat: сводка 1/ч (ночью 1/3ч) + 🔴 при тишине цикла
  // ТГ-КНОПКИ: ловим нажатия «🚀 В работу» / «✕ Пропустить» из вирал-уведа (q:<code> / s:<code>).
  startTelegramPoll(async (data) => {
    const [act, code] = String(data).split(':');
    if (!code) return 'не понял';
    if (act === 'q') {
      const r = await query(`UPDATE radar_posts SET queued_at=now() WHERE code=$1 AND status='new'`, [code]).catch(() => ({ rowCount: 0 }));
      return r.rowCount ? '🚀 взято в работу' : 'пост не найден/уже не в панели';
    }
    if (act === 's') {
      const r = await query(`UPDATE radar_posts SET status='dismissed' WHERE code=$1`, [code]).catch(() => ({ rowCount: 0 }));
      return r.rowCount ? '✕ пропущено' : 'пост не найден';
    }
    return 'неизвестная кнопка';
  });
}
