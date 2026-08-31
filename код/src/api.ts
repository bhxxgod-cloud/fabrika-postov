import express from 'express';
import multer from 'multer';
import os from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tiktokCaption } from './captions.js';
import { dirname, join } from 'node:path';
import { query, pool, logError, logAccountEvent, accountSnapshot } from './db/index.js';
import { checkPassword, signSession, requireAuth, COOKIE_NAME, cookieOptions } from './auth.js';
import { generateCaption, generateMedia, generatePersona, generateAvatar, generateTikTokProfile, generateRadarReply } from './ai.js';
import { nextSlot } from './scheduler.js';
import { checkSessionDeep, connect, disconnect, getProfileProxy, lockKey, gologinHealth,
  createCloudProfile, setProfileProxy, importCookies, deleteCloudProfile, parseProxy } from './gologin.js';
import { totpCode, totpRemaining } from './totp.js';
import { driverFor, SessionError, CaptchaError } from './drivers/index.js';
import { runWarmupSession } from './warmup.js';
import { ensureLoggedIn, passwordLogin, tiktokLogin, TRENDS } from './radar.js';
import { withBrowserLock, withLoginSlot, browserQueue, tryReserveProfile, releaseProfile, slotUsage } from './lock.js';
import { startActivity, finishActivity, getStatus } from './status.js';
import { notifyOwner, telegramConfigured } from './notify.js';
import { registerGenRoutes } from './gencontent.js';
import { registerStatsRoutes } from './stats.js';
import { registerFarmRelay } from './farmrelay.js';
import { diagnoseProxy } from './proxycheck.js';
import { canPost } from './postguard.js';
import { mountYoutube } from './youtube.js';
import { mountThreads } from './threads.js';

// Классификатор ошибки браузерной операции — человекочитаемая причина для панели.
function classifyErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof SessionError) return 'сессия мертва — перелогинься в GoLogin и Stop профиля';
  if (e instanceof CaptchaError) return 'капча — почисти вручную в GoLogin';
  if (/timeout|net::|ECONN|ENOTFOUND|ERR_|navigation|Timeout/i.test(m)) return 'прокси не отвечает / сеть — проверь прокси';
  return m.slice(0, 160);
}

// Одна сессия прогрева аккаунта через замок, с записью живого статуса.
async function runWarmupOnce(acc: Record<string, any>): Promise<void> {
  const label = acc.slug || acc.gologin_profile_id;
  console.log(`[warmup] старт ${acc.platform}/${label} (профиль ${acc.gologin_profile_id})`);
  await withBrowserLock(async () => {
    startActivity('warmup', label);
    let session: Awaited<ReturnType<typeof connect>> | null = null;
    try {
      session = await connect(acc.gologin_profile_id, acc.group_token);
      // IG/комменты стартуют на «продолжить как …» — дожимаем вход (пароль в профиле GoLogin).
      if (acc.platform === 'instagram' || acc.platform === 'comments') {
        const logged = await ensureLoggedIn(session.page);
        if (!logged) throw new SessionError('не залогинен (дожми вход в GoLogin)');
      }
      const summary = await Promise.race([
        runWarmupSession(session.page, driverFor(acc.platform), { id: acc.id, warmup_comments: acc.group_comments ?? acc.warmup_comments }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('таймаут прогрева (>5 мин) — медленный прокси или зависла лента')), 5 * 60 * 1000)),
      ]);
      finishActivity(true, null, summary);
      // Успешный прогрев залогиненного аккаунта = сессия точно жива (авторитетнее кук).
      await query(`UPDATE accounts SET session_status='live', session_checked_at=now() WHERE id=$1`, [acc.id]).catch(() => {});
      console.log(`[warmup] готово ${label}:`, summary);
    } catch (e) {
      const reason = classifyErr(e);
      finishActivity(false, reason);
      console.warn(`[warmup] ошибка ${label}: ${reason}`);
      if (e instanceof SessionError) await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [acc.id]).catch(() => {});
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey(acc.group_token));
}

// Ручной вход по кредам (кнопка «войти»). Коннект -> ensureLoggedIn -> при полном разлогине passwordLogin
// (юзер+пароль+2FA из сида). На челлендж/капчу — пауза, руками (капчу не обходим). Приложение логинит.
const LOGIN_COOLDOWN_MS = 60 * 60 * 1000; // не логинить один акк чаще раза в час (анти-soft-block IG)
async function loginAccountOnce(acc: Record<string, any>, opts?: { force?: boolean }): Promise<{ result: string; msg: string }> {
  // ГАРД КУЛДАУНА: свежие данные акка из БД (acc из фонового цикла бывает неполным). Повторные входы одного
  // акка за короткое окно (завод + кнопка + прогрев подряд) = soft-block IG «login incorrect» → жжём акк.
  // Один вход в ~час; если недавно пробовали — молча ждём.
  const cur = (await query<{ session_status: string | null; relogin_try_at: string | null; login_fails: number | null }>(
    `SELECT session_status, relogin_try_at, login_fails FROM accounts WHERE id=$1`, [acc.id])).rows[0];
  if (cur?.session_status === 'live') return { result: 'ok', msg: 'уже live' };
  // Кулдаун можно обойти вручную (opts.force) — юзер сам решил войти сейчас из панели, приняв риск soft-block.
  // Отсчёт по relogin_try_at (последняя РЕАЛЬНАЯ попытка входа), НЕ по session_checked_at — тот бампают фоновые чеки → ложный кулдаун.
  if (!opts?.force && cur?.relogin_try_at && Date.now() - new Date(cur.relogin_try_at).getTime() < LOGIN_COOLDOWN_MS)
    return { result: 'cooldown', msg: 'кулдаун входа (недавно пробовали) — ждём ~час, чтобы не словить soft-block IG' };
  const priorFails = Number(cur?.login_fails) || 0;
  // Резерв профиля: повторные клики «войти» и параллельный тик прогрева НЕ откроют один профиль дважды
  // (иначе серия логинов = сжигание акка / «Target closed»). Занят — сразу выходим, без очереди.
  if (!tryReserveProfile(acc.gologin_profile_id)) return { result: 'busy', msg: 'профиль занят (вход/прогрев уже идёт) — подожди' };
  try {
  return await withLoginSlot(() => withBrowserLock(async () => {   // ≤3 входов разом (панель+воркер делят), 7 слотов комментингу
    let session: Awaited<ReturnType<typeof connect>> | null = null;
    try {
      session = await connect(acc.gologin_profile_id, acc.group_token);
      let result: string;
      let wasIn = false;
      if (acc.platform === 'tiktok') {
        // TikTok: свой вход (юзер+пароль+TOTP). Сам определяет «уже залогинен». Капча/SMS → пауза, руками.
        result = await tiktokLogin(session.page, { login: acc.ig_login, password: acc.ig_password, totpSecret: acc.totp_secret });
      } else {
        wasIn = await ensureLoggedIn(session.page);
        result = wasIn ? 'ok' : 'need_login';
        if (result !== 'ok' && acc.ig_login && acc.ig_password) {
          // Селекторный вход напрямую. visionLogin убран из горячего пути: он жёг ~80с на 14 «зрячих» шагов
          // и по факту всегда падал на этот же passwordLogin (см. память) — чистая потеря времени.
          const creds = { login: acc.ig_login, password: acc.ig_password, totpSecret: acc.totp_secret, email: acc.ig_email, emailPassword: acc.ig_email_password };
          result = await passwordLogin(session.page, creds);
        }
      }
      console.log(`[login] ${acc.platform}/${acc.slug || acc.gologin_profile_id}: ${wasIn ? 'уже был залогинен' : 'вход'} -> ${result}`);
      if (result === 'ok') { await query(`UPDATE accounts SET session_status='live', ig_status='login_ok', login_fails=0, session_checked_at=now(), relogin_try_at=now() WHERE id=$1`, [acc.id]); return { result, msg: 'вошли ✓' }; }
      if (result === 'challenge' || result === 'captcha') { await query(`UPDATE accounts SET ig_status='challenge', status='paused', session_status='dead', session_checked_at=now(), relogin_try_at=now() WHERE id=$1`, [acc.id]); void logAccountEvent(acc.id, acc.slug, acc.platform, result, await accountSnapshot(acc.id)); return { result, msg: result === 'captcha' ? 'капча — зайди вручную в GoLogin' : 'челлендж (почта/SMS) — зайди вручную' }; }
      if (result === 'bad_creds') {
        // «incorrect» у свежего купленного акка почти всегда soft-block на повторный вход, а не реально неверный
        // пароль (те же креды логинят другие акки этой пачки). Даём кулдаун-ретраи: ПАУЗА только после 3×, иначе ждём час.
        const f = priorFails + 1; const stop = f >= 3;
        await query(`UPDATE accounts SET ig_status='bad_login', session_status='dead', login_fails=$2, session_checked_at=now(), relogin_try_at=now()${stop ? `, status='paused'` : ''} WHERE id=$1`, [acc.id, f]);
        if (stop) void logAccountEvent(acc.id, acc.slug, acc.platform, 'bad_login', await accountSnapshot(acc.id));
        return { result: stop ? 'bad_creds' : 'cooldown', msg: stop ? 'неверный логин/пароль (пауза после 3×)' : `soft-block «incorrect» — кулдаун, ретрай позже (${f}/3)` };
      }
      await query(`UPDATE accounts SET session_status='dead', login_fails=$2, session_checked_at=now(), relogin_try_at=now() WHERE id=$1`, [acc.id, priorFails + 1]); return { result, msg: 'вход не удался — кулдаун, ретрай позже' };
    } catch (e) {
      return { result: 'error', msg: classifyErr(e) };
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey(acc.group_token)));
  } finally { releaseProfile(acc.gologin_profile_id); }
}

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

// Простой парсер кук в объект (для /login редиректа хватает express).
function setCookie(res: express.Response, name: string, value: string) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${cookieOptions.maxAge / 1000}; SameSite=Lax${cookieOptions.secure ? '; Secure' : ''}`);
}

// Реальное число профилей GoLogin у ОСНОВНОГО коммент-аккаунта (yotbonly / РАБОЧИЕ АККИ) — из API (allProfilesCount),
// а не из БД (в БД — по всему флоту/токенам). Кэш 3 мин: панель дёргает /radar/live часто, GoLogin API не спамим.
let _profCache = { count: 0, at: 0 };
async function gologinProfileCount(force = false): Promise<number> {
  if (!force && _profCache.count && Date.now() - _profCache.at < 15 * 60 * 1000) return _profCache.count; // кэш 15 мин; force=1 (кнопка ↻) — свежак
  try {
    const { rows } = await query<{ tok: string }>(
      `SELECT gologin_token AS tok FROM account_groups g WHERE gologin_token IS NOT NULL
       ORDER BY (SELECT count(*) FROM accounts a WHERE a.group_id=g.id AND a.deleted_at IS NULL AND a.platform='comments') DESC LIMIT 1`);
    const tok = rows[0]?.tok;
    if (!tok) return _profCache.count;
    const res = await fetch('https://api.gologin.com/browser/v2?limit=1', { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) { const j = (await res.json()) as { allProfilesCount?: number }; const n = Number(j.allProfilesCount) || 0; if (n > 0) _profCache = { count: n, at: Date.now() }; }
  } catch { /* держим прошлый кэш */ }
  return _profCache.count;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Вкладка «Генерация» (конвейер маркетолога кнопкой, а не из чата)
  registerGenRoutes(app, requireAuth);

  // Вкладка «Статистика» (все аккаунты всех площадок одной таблицей)
  registerStatsRoutes(app, requireAuth);

  // Мост к ферме телефонов: ферма сама держит канал, браузер ходит только сюда
  registerFarmRelay(app, requireAuth);

  // --- Вход ---
  app.post('/login', (req, res) => {
    if (checkPassword(String(req.body?.password || ''))) {
      setCookie(res, COOKIE_NAME, signSession());
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Неверный пароль' });
  });

  // --- Воронка: сайт neironka.pro шлёт события по tracking_code (server-to-server) ---
  // Защищено сервисным ключом, а не кукой оператора.
  app.post('/api/funnel', async (req, res) => {
    if (req.get('x-service-key') !== (process.env.NEIRONKA_MEDIA_API_KEY || '')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { tracking_code, event_type, revenue_cents } = req.body || {};
    if (!tracking_code || !['click', 'registration', 'payment'].includes(event_type)) {
      return res.status(400).json({ error: 'bad event' });
    }
    const { rows } = await query<{ id: string }>(`SELECT id FROM accounts WHERE tracking_code=$1 LIMIT 1`, [tracking_code]);
    await query(
      `INSERT INTO funnel_events (tracking_code, account_id, event_type, revenue_cents) VALUES ($1,$2,$3,$4)`,
      [tracking_code, rows[0]?.id ?? null, event_type, Math.round(Number(revenue_cents) || 0)],
    );
    res.json({ ok: true });
  });

  // Всё ниже — только для залогиненного оператора.
  const api = express.Router();
  api.use(requireAuth);
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }); // API никогда не кэшируем

  // Секреты акка (пароли/куки/сессия/прокси-креды/2FA-сид) в браузер НЕ отдаём — только флаги наличия.
  // 2FA-код и прокси-детали тянутся отдельными эндпоинтами по клику.
  function stripAccountSecrets(r: any) {
    const { totp_secret, ig_password, ig_email_password, ig_email, ig_proxy, ig_cookies, ig_session, ...rest } = r;
    return { ...rest, has_totp: !!totp_secret, has_password: !!ig_password, has_email: !!ig_email };
  }

  // Аккаунты с воронкой (посты -> клики -> реги -> платят -> выручка).
  api.get('/accounts', async (req, res) => {
    const platform = req.query.platform as string | undefined;
    // «Очередь» = акки БЕЗ GoLogin-профиля (ждут заведения профиля; креды уже сохранены), кросс-платформенно.
    // Вкладки платформ показывают только акки С профилем. Так «Очередь» и «Комменты» НЕ пересекаются —
    // раньше очередь ловила ЛЮБОЙ не-live акк, из-за чего мёртвые комменты-акки висели в обеих вкладках.
    const queue = platform === 'queue';
    const whereExtra = queue
      ? `AND a.gologin_profile_id IS NULL AND a.ig_password IS NOT NULL AND a.ig_password <> ''`
      : (platform ? 'AND a.platform=$1 AND a.gologin_profile_id IS NOT NULL' : '');
    const params = (platform && !queue) ? [platform] : [];
    const { rows } = await query(
      `SELECT a.*,
         (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published') AS posts_published,
         (SELECT count(*) FROM funnel_events f WHERE f.account_id=a.id AND f.event_type='click') AS clicks,
         (SELECT count(*) FROM funnel_events f WHERE f.account_id=a.id AND f.event_type='registration') AS regs,
         (SELECT count(DISTINCT f.id) FROM funnel_events f WHERE f.account_id=a.id AND f.event_type='payment') AS payers,
         (SELECT coalesce(sum(f.revenue_cents),0) FROM funnel_events f WHERE f.account_id=a.id) AS revenue_cents,
         (SELECT count(*) FROM warmup_log w WHERE w.account_id=a.id AND w.action='watch'  AND w.created_at > now()-interval '7 days') AS warm_watched,
         (SELECT count(*) FROM warmup_log w WHERE w.account_id=a.id AND w.action='like'   AND w.created_at > now()-interval '7 days') AS warm_liked,
         (SELECT count(*) FROM warmup_log w WHERE w.account_id=a.id AND w.action='follow' AND w.created_at > now()-interval '7 days') AS warm_followed,
         (SELECT count(*) FROM warmup_log w WHERE w.account_id=a.id AND w.action='comment' AND w.created_at > now()-interval '7 days') AS warm_commented,
         (SELECT max(w.created_at) FROM warmup_log w WHERE w.account_id=a.id) AS warm_last,
         (SELECT count(DISTINCT b.code) FROM post_account_blocks b WHERE b.account_id=a.id AND b.blocked) AS blocked_posts,
         (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) AS comments_today_n
       FROM accounts a
       WHERE coalesce(a.ig_role,'') <> 'reader' AND a.deleted_at IS NULL
       ${whereExtra}
       ORDER BY a.platform, a.acc_no NULLS LAST, substring(a.slug from '\\d+')::int NULLS LAST, a.slug`,
      params,
    );
    // Секреты в браузер не отдаём (2FA-код и т.п. тянутся отдельными эндпоинтами). Флаги — можно.
    res.json(rows.map(stripAccountSecrets));
  });

  // === Корзина аккаунтов (мягкое удаление + восстановление) ===
  api.get('/accounts/trash', async (req, res) => {
    try {
      const platform = req.query.platform as string | undefined;
      const { rows } = await query<Record<string, any>>(
        `SELECT id, platform, slug, display_name, ig_role, deleted_at FROM accounts
         WHERE deleted_at IS NOT NULL ${platform ? 'AND platform=$1' : ''} ORDER BY deleted_at DESC`,
        platform ? [platform] : [],
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  api.post('/accounts/:id/trash', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      const snap = await accountSnapshot(req.params.id); // снимок ДО пометки (для лога «почему умер»)
      await query(`UPDATE accounts SET deleted_at=now() WHERE id=$1`, [req.params.id]);
      void logAccountEvent(req.params.id, (snap.slug as string) || null, (snap.platform as string) || null, 'trashed', snap);
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });
  api.post('/accounts/:id/restore', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      await query(`UPDATE accounts SET deleted_at=NULL WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });
  api.delete('/accounts/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      const snap = await accountSnapshot(req.params.id); // снимок ДО удаления — событие переживёт акк
      void logAccountEvent(req.params.id, (snap.slug as string) || null, (snap.platform as string) || null, 'deleted', snap);
      await query(`DELETE FROM accounts WHERE id=$1`, [req.params.id]); // насовсем (из корзины)
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });

  // === Лог жизни акков: лента событий + отчёт «выводы о банах» ===
  api.get('/accounts/events', async (req, res) => {
    try {
      const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
      const rows = (await query(
        `SELECT id, account_id, slug, platform, kind, detail, created_at FROM account_events
         ${kind ? 'WHERE kind=$1' : ''} ORDER BY id DESC LIMIT 200`, kind ? [kind] : [])).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.get('/accounts/events-report', async (_req, res) => {
    try {
      // Агрегат по «плохим» событиям: сколько, средне комментов/день и возраст акка НА МОМЕНТ бана, топ-гео.
      const byKind = (await query(
        `SELECT kind, count(*)::int n,
                round(avg(nullif(detail->>'comments_today','')::numeric),1) avg_comments_day,
                round(avg(nullif(detail->>'age_days','')::numeric),1) avg_age_days
         FROM account_events WHERE kind IN ('challenge','bad_login','captcha','restriction','trashed','deleted')
         GROUP BY kind ORDER BY n DESC`)).rows;
      const byGeo = (await query(
        `SELECT coalesce(nullif(detail->>'proxy_country',''),'?') geo, count(*)::int bans
         FROM account_events WHERE kind IN ('challenge','bad_login','captcha','deleted')
         GROUP BY 1 ORDER BY bans DESC LIMIT 10`)).rows;
      const byType = (await query(
        `SELECT coalesce(nullif(detail->>'account_type',''),'?') acc_type, count(*)::int bans,
                round(avg(nullif(detail->>'age_days','')::numeric),1) avg_age_days
         FROM account_events WHERE kind IN ('challenge','bad_login','captcha','deleted')
         GROUP BY 1 ORDER BY bans DESC`)).rows;
      const recent = (await query(
        `SELECT slug, platform, kind, detail->>'comments_today' comments_today, detail->>'age_days' age_days, created_at
         FROM account_events WHERE kind IN ('challenge','bad_login','captcha','restriction','deleted')
         ORDER BY id DESC LIMIT 30`)).rows;
      res.json({ byKind, byGeo, byType, recent });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // Невалидный UUID в пути не должен долетать до Postgres (ошибка типа = unhandled rejection).
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

  // Прокси профиля из GoLogin (тип/адрес/порт/логин/пароль) — панель тянет по клику.
  api.get('/accounts/:id/gologin-proxy', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json(null); return; }
      const { rows } = await query<Record<string, any>>(
        `SELECT gologin_profile_id FROM accounts WHERE id=$1`, [req.params.id],
      );
      const pid = rows[0]?.gologin_profile_id;
      if (!pid) { res.json(null); return; }
      res.json(await getProfileProxy(pid));
    } catch {
      res.status(500).json(null);
    }
  });

  // 2FA-код акка (TOTP из сохранённого сида). Считаем сами — сид наружу не отдаём.
  // Панель дёргает при ручном входе в профиль (замена 2fa.cn / 2fa.fb.tools).
  api.get('/accounts/:id/totp', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const { rows } = await query<{ totp_secret: string | null }>(`SELECT totp_secret FROM accounts WHERE id=$1`, [req.params.id]);
      const secret = rows[0]?.totp_secret;
      if (!secret) { res.status(404).json({ error: 'у акка нет 2FA-ключа' }); return; }
      res.json({ code: totpCode(secret), expires_in: totpRemaining() });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // Ручной вход по кредам (кнопка «войти»): приложение логинит акк паролем + 2FA. Долго (коннект+вход).
  api.post('/accounts/:id/login', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const { rows } = await query<Record<string, any>>(
        `SELECT a.*, g.gologin_token AS group_token FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.id=$1`, [req.params.id]);
      const acc = rows[0];
      if (!acc?.gologin_profile_id) { res.status(400).json({ error: 'нет профиля GoLogin' }); return; }
      if (!acc.ig_login || !acc.ig_password) { res.status(400).json({ error: 'нет сохранённого логина/пароля у акка' }); return; }
      res.json(await loginAccountOnce(acc, { force: !!(req.body && req.body.force) }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // Ручная отметка «живой»: авто-проверка кук иногда даёт ЛОЖНЫЙ «перелогин» (акк на деле залогинен).
  // Владелец, убедившись в GoLogin, ставит live руками — акк снова в ротации (комменты/дежурство/прогрев).
  // === ОФОРМЛЕНИЕ АККА (ава + имя + био) ===
  // Панель в облаке, Orbita на маке → кладём задачу в local_jobs, localrunner.cjs на маке её выполняет
  // (dressup.cjs, 0 облачных часов GoLogin). Тут только очередь + статус.
  api.post('/accounts/:id/dress', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ ok: false, error: 'плохой id' }); return; }
      const r = await query<Record<string, any>>(`SELECT slug FROM accounts WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      const slug = r.rows[0]?.slug;
      if (!slug) { res.status(404).json({ ok: false, error: 'акк не найден' }); return; }
      await query(`INSERT INTO local_jobs (slug, mode, n, status) VALUES ($1,'dress',1,'queued')`, [slug]);
      res.json({ ok: true, slug, queued: true });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Батч: оформить всех НЕоформленных живых акков (опц. в одной группе). Одна задача на всех, раннер идёт подряд.
  api.post('/accounts/dress-batch', async (req, res) => {
    try {
      const b = req.body || {};
      const lim = Math.max(1, Math.min(40, Number(b.limit) || 10));
      const params: any[] = [lim];
      let grp = '';
      if (b.group_id && isUuid(String(b.group_id))) { grp = 'AND a.group_id=$2'; params.push(String(b.group_id)); }
      const r = await query<Record<string, any>>(
        `SELECT a.slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
         WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
           AND a.dressed_at IS NULL
           AND a.slug NOT LIKE 'FOL%'                                  -- FOL-акки владельца НЕ оформляем (28.07)
           AND a.slug NOT IN ('поисковик','may.tthewfields')           -- служебные
           AND coalesce(a.ig_status,'') NOT IN ('owner_posting','challenge','suspended') ${grp}
         ORDER BY (a.session_status='live') DESC, a.created_at DESC LIMIT $1`, params);
      const slugs = r.rows.map((x) => x.slug);
      if (!slugs.length) { res.json({ ok: true, queued: 0, note: 'все уже оформлены' }); return; }
      await query(`INSERT INTO local_jobs (slug, mode, n, status) VALUES ($1,'dress',$2,'queued')`, [slugs.join(','), slugs.length]);
      res.json({ ok: true, queued: slugs.length, slugs });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // ГЕНЕРАЦИЯ ФОТОПОСТОВ: панель заказывает N постов на девочку, фабрика их рисует, готовое
  // ложится на СКЛАД (posts.status='backlog') — запас, из которого потом планируем публикации.
  // Исполняет мак (genposts.cjs): админка фабрики закрыта httpOnly-кукой, из облака туда не зайти.
  api.post('/promo/generate', async (req, res) => {
    try {
      const b = req.body || {};
      const n = Math.max(1, Math.min(10, Number(b.n) || 1));
      const group = ['beauty', 'photo', 'looks', 'all'].includes(String(b.group)) ? String(b.group) : '';
      // Персон можно передать несколько (или «все»): владелец заказывает пачку на всю ферму разом,
      // а не кликает по каждой девочке отдельно.
      let personas: string[] = Array.isArray(b.personas) ? b.personas.map((x: any) => String(x).trim()).filter(Boolean)
        : (b.persona ? [String(b.persona).trim()] : []);
      if (!personas.length || b.all) {
        const all = await query<Record<string, any>>(
          `SELECT DISTINCT persona FROM accounts WHERE persona IS NOT NULL AND persona<>'' AND deleted_at IS NULL ORDER BY persona`);
        personas = all.rows.map((x) => x.persona);
      }
      if (!personas.length) { res.status(400).json({ ok: false, error: 'нет ни одной модели' }); return; }

      const queued: string[] = [];
      const skipped: string[] = [];
      for (const persona of personas) {
        const has = await query<Record<string, any>>(
          `SELECT 1 FROM accounts WHERE persona=$1 AND deleted_at IS NULL LIMIT 1`, [persona]);
        if (!has.rowCount) { skipped.push(`${persona}: нет аккаунтов`); continue; }
        // Один активный заказ на модель: фабрика платная, дубли жгут деньги впустую.
        const dup = await query<Record<string, any>>(
          `SELECT id FROM local_jobs WHERE mode='genposts' AND slug LIKE $1 AND status IN ('queued','running') LIMIT 1`,
          [`${persona}%`]);
        if (dup.rowCount) { skipped.push(`${persona}: уже в работе (#${dup.rows[0].id})`); continue; }
        // Группу шаблонов передаём в slug после «|» — отдельной колонки в local_jobs нет.
        await query(`INSERT INTO local_jobs (slug, mode, n, status) VALUES ($1,'genposts',$2,'queued')`,
          [group ? `${persona}|${group}` : persona, n]);
        queued.push(persona);
      }
      res.json({ ok: true, queued: queued.length * n, personas: queued, skipped, group: group || 'бьюти+фото' });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // СВОДКА ПО ПРОСМОТРАМ. Цифры собирает stats.cjs на маке (Instagram отдаёт их только по куке
  // самого аккаунта), сюда попадает готовый снимок — панель показывает его и время сбора.
  api.get('/promo/stats', async (_req, res) => {
    try {
      const byPersona = await query<Record<string, any>>(
        `SELECT persona, count(*) posts, coalesce(sum(views),0) views, coalesce(sum(likes),0) likes,
                coalesce(sum(comments),0) comments, max(updated_at) upd
           FROM post_stats WHERE persona IS NOT NULL GROUP BY persona ORDER BY 3 DESC`);
      const today = await query<Record<string, any>>(
        `SELECT count(*) posts, coalesce(sum(s.views),0) views FROM post_stats s
           JOIN posts p ON p.status='published' AND p.external_url LIKE '%'||s.shortcode||'%'
          WHERE p.published_at > now() - interval '24 hours'`);
      // ТОЛЬКО НАШИ посты (07.08): раньше LEFT JOIN пускал в топ снимки чужой ленты купленных
      // акков (наследство прежнего владельца, у promt.vibe.lab 39682 «наших» просмотров).
      // Наш пост = строка в posts со status='published' и external_url от самого Instagram.
      const top = await query<Record<string, any>>(
        `SELECT s.shortcode, s.persona, s.views, s.likes, coalesce(a.ig_login,a.slug) handle,
                to_char(p.published_at,'DD.MM HH24:MI') t
           FROM post_stats s
           JOIN posts p ON p.status='published' AND p.external_url LIKE '%'||s.shortcode||'%'
           JOIN accounts a ON a.id=p.account_id
          ORDER BY s.views DESC LIMIT 10`);
      const upd = await query<Record<string, any>>(`SELECT max(updated_at) u FROM post_stats`);
      res.json({
        by_persona: byPersona.rows, today: today.rows[0] || { posts: 0, views: 0 },
        top: top.rows, updated_at: upd.rows[0]?.u || null,
      });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Кнопка «обновить статистику»: ставит задачу маку — он сходит по аккам и обновит снимок.
  api.post('/promo/stats/refresh', async (_req, res) => {
    try {
      const dup = await query<Record<string, any>>(
        `SELECT id FROM local_jobs WHERE mode='stats' AND status IN ('queued','running') LIMIT 1`);
      if (dup.rowCount) { res.json({ ok: true, queued: false, note: `обновление уже идёт (#${dup.rows[0].id})` }); return; }
      await query(`INSERT INTO local_jobs (slug, mode, n, status) VALUES ('all','stats',1,'queued')`);
      res.json({ ok: true, queued: true });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Склад: что уже нарисовано и ждёт публикации, по девочкам.
  api.get('/promo/backlog', async (_req, res) => {
    try {
      const r = await query<Record<string, any>>(
        `SELECT p.id, coalesce(p.meta->>'persona','') persona, p.meta->>'template' template,
                p.caption, p.meta->'image_urls' image_urls, coalesce(a.ig_login,a.slug) handle,
                to_char(p.created_at,'DD.MM HH24:MI') t
           FROM posts p LEFT JOIN accounts a ON a.id=p.account_id
          WHERE p.status='backlog' ORDER BY p.created_at DESC LIMIT 60`);
      const byPersona = await query<Record<string, any>>(
        `SELECT coalesce(meta->>'persona','?') persona, count(*) n FROM posts WHERE status='backlog' GROUP BY 1`);
      res.json({ posts: r.rows, counts: byPersona.rows });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Статус локальных задач (панель показывает: раннер жив? что в очереди/выполняется).
  api.get('/local-jobs', async (_req, res) => {
    try {
      const r = await query<Record<string, any>>(`SELECT id, slug, mode, status, left(coalesce(result,''),120) result,
        to_char(created_at,'HH24:MI') t, to_char(updated_at,'HH24:MI') upd FROM local_jobs ORDER BY id DESC LIMIT 12`);
      const undressed = await query<Record<string, any>>(`SELECT count(*) n FROM accounts a JOIN account_groups g ON g.id=a.group_id
        WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
          AND a.dressed_at IS NULL AND a.slug NOT LIKE 'FOL%' AND a.slug NOT IN ('поисковик','may.tthewfields')
          AND coalesce(a.ig_status,'') NOT IN ('owner_posting','challenge','suspended')`);
      res.json({ jobs: r.rows, undressed: Number(undressed.rows[0]?.n || 0) });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // === ПРОМО-ФАБРИКА → ПОСТЕР (29.07) =========================================================
  // Личность = аккаунт: Маша/Карина/Дарья привязаны к живым IG-аккам полем accounts.persona.
  // Фабрика (neironka.pro/admin/promo) шлёт сюда готовый ролик → создаём пост в очереди нужного акка.
  // Тело: { persona:"Маша", video_url:"https://…", caption:"текст поста", link:"ссылка в первый коммент" }
  api.post('/promo/push', async (req, res) => {
    try {
      const { persona, video_url: videoUrl, caption, link, scheduled_at: schedAt } = (req.body || {}) as Record<string, string>;
      if (!persona || !videoUrl) { res.status(400).json({ error: 'нужны persona и video_url' }); return; }
      // ТОЛЬКО ОСНОВНОЙ акк модели. Урок 01.08: без is_spare=false фабрика могла положить ролик на
      // ЗАПАСНОЙ (LIMIT 1 брал что попало). Запасной ведёт свой контент, ролики ему ставят явно.
      // target='spare' в теле — осознанный выбор запасного, иначе всегда основной.
      const wantSpare = String((req.body || {}).target || '') === 'spare';
      const acc = await query<Record<string, any>>(
        `SELECT id, slug, coalesce(ig_login,slug) h, session_status FROM accounts
           WHERE persona=$1 AND deleted_at IS NULL AND gologin_profile_id IS NOT NULL
             AND is_spare = $2
           ORDER BY acc_no NULLS LAST LIMIT 1`, [persona, wantSpare]);
      const a = acc.rows[0];
      if (!a) { res.status(404).json({ error: `нет аккаунта для личности «${persona}»` }); return; }
      const ins = await query<Record<string, any>>(
        `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, scheduled_at)
         VALUES ($1,'instagram','promo','approved',$2,$3,'VIDEO',$4,coalesce($5::timestamptz, now()))
         RETURNING id`,
        [a.id, caption || null, videoUrl, link || 'https://neironka.pro', schedAt || null]);
      res.json({ ok: true, post_id: ins.rows[0].id, account: a.slug, handle: a.h, persona,
        note: a.session_status === 'live' ? 'акк живой, пост в очереди' : 'ВНИМАНИЕ: сессия акка не подтверждена' });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Очередь постера: что ждёт публикации по каждой личности
  api.get('/promo/queue', async (_req, res) => {
    try {
      const r = await query<Record<string, any>>(
        `SELECT p.id, p.status, left(coalesce(p.caption,''),80) caption, p.media_url, p.reply_text,
                to_char(p.scheduled_at,'MM-DD HH24:MI') sched, to_char(p.published_at,'MM-DD HH24:MI') pub,
                p.external_url, left(coalesce(p.error,''),80) error,
                a.persona, a.slug, coalesce(a.ig_login,a.slug) handle, a.session_status
           FROM posts p JOIN accounts a ON a.id=p.account_id
          WHERE p.platform='instagram' ORDER BY p.created_at DESC LIMIT 40`);
      const personas = await query<Record<string, any>>(
        `SELECT persona, slug, coalesce(ig_login,slug) handle, session_status, (coalesce(ig_cookies::text,'')<>'') has_cookies
           FROM accounts WHERE persona IS NOT NULL AND deleted_at IS NULL ORDER BY persona`);
      res.json({ posts: r.rows, personas: personas.rows });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // КАРТОЧКИ МОДЕЛЕЙ: всё, что нужно видеть глазами перед постингом — оформление, куки, здоровье.
  // Урок 01.08: постили на акк с restriction, потому что панель этого не показывала.
  api.get('/promo/models', async (_req, res) => {
    try {
      const r = await query<Record<string, any>>(
        `SELECT a.id, a.slug, a.persona, a.is_spare, a.acc_no, coalesce(a.ig_login,a.slug) handle,
                a.display_name, a.session_status, coalesce(a.ig_status,'') ig_status, a.status,
                (coalesce(a.ig_cookies::text,'')<>'') has_cookies,
                a.avatar_thumb IS NOT NULL has_avatar, a.avatar_cat, a.dressed_at IS NOT NULL dressed,
                to_char(a.dressed_at,'MM-DD') dressed_at, a.dress_status, left(coalesce(a.dress_error,''),90) dress_error,
                a.health_state, left(coalesce(a.health_note,''),140) health_note,
                to_char(a.health_checked_at,'MM-DD HH24:MI') health_at,
                to_char(a.session_checked_at,'MM-DD HH24:MI') session_at,
                coalesce(a.proxy_status,'') proxy_status, a.egress_country,
                st.published, st.queued, st.failed, st.last_post, st.last_url, st.today_n
           FROM accounts a
           LEFT JOIN LATERAL (
             SELECT count(*) FILTER (WHERE p.status='published') published,
                    count(*) FILTER (WHERE p.status IN ('approved','draft')) queued,
                    count(*) FILTER (WHERE p.status IN ('failed','ambiguous')) failed,
                    count(*) FILTER (WHERE p.status='published' AND p.published_at > now() - interval '24 hours') today_n,
                    to_char(max(p.published_at) FILTER (WHERE p.status='published'),'MM-DD HH24:MI') last_post,
                    (SELECT p2.external_url FROM posts p2 WHERE p2.account_id=a.id AND p2.status='published'
                      ORDER BY p2.published_at DESC NULLS LAST LIMIT 1) last_url
               FROM posts p WHERE p.account_id=a.id
           ) st ON true
          WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
          ORDER BY a.persona, a.is_spare, a.acc_no NULLS LAST`);
      // готовность постить = живая сессия + куки + здоровье не «ограничен»
      // + СОВПАДЕНИЕ ЛИЧНОСТИ: «Дарья» на @varya.smirnova13 читается как фейк (замечание владельца 01.08)
      const { checkIdentity } = await import('../iglib.cjs' as string).catch(() => ({ checkIdentity: null } as any));
      const accs: Record<string, any>[] = r.rows.map((m) => {
        const ident = checkIdentity ? checkIdentity({ persona: m.persona, handle: m.handle, displayName: m.display_name }) : { ok: true, issues: [] };
        const blocked = m.ig_status === 'restricted' || m.health_state === 'restricted'
          || m.ig_status === 'suspended' || m.health_state === 'suspended' || m.ig_status === 'captcha';
        return {
          ...m,
          published: Number(m.published || 0), queued: Number(m.queued || 0),
          failed: Number(m.failed || 0), today_n: Number(m.today_n || 0),
          identity_issues: ident.issues,
          blocked,
          ready: !blocked && m.session_status === 'live' && m.has_cookies && m.status !== 'paused',
          why: blocked ? 'акк ограничен IG — нужна замена'
            : !m.has_cookies ? 'нет кук — постер не откроет (снять куки)'
              : m.session_status !== 'live' ? 'сессия не подтверждена'
                : m.status === 'paused' ? 'акк на паузе (status=paused)'
                  : ident.issues.length ? ident.issues[0] : null,
        };
      });
      // Группируем в модели: один основной + запасные. Агрегат модели = состояние ОСНОВНОГО акка,
      // но если основной лёг, а запасной жив — это отдельный статус, чтобы владелец видел страховку.
      const byPersona = new Map<string, Record<string, any>[]>();
      for (const a of accs) { const k = String(a.persona); if (!byPersona.has(k)) byPersona.set(k, []); byPersona.get(k)!.push(a); }
      const models = [...byPersona.entries()].map(([persona, list]) => {
        const main = list.find((x) => !x.is_spare) || null;
        const spares = list.filter((x) => x.is_spare);
        const liveSpare = spares.find((x) => x.ready) || null;
        return {
          persona, main, spares, count: list.length,
          ready: !!(main && main.ready),
          fallback: !!(main && !main.ready && liveSpare),
          blocked: !!(main && main.blocked),
          why: main ? main.why : 'нет основного аккаунта',
          published_total: list.reduce((s, x) => s + x.published, 0),
          queued_total: list.reduce((s, x) => s + x.queued, 0),
          today_total: list.reduce((s, x) => s + x.today_n, 0),
          last_post: list.map((x) => x.last_post).filter(Boolean).sort().pop() || null,
        };
      }).sort((a, b) => a.persona.localeCompare(b.persona, 'ru'));
      res.json({ models, identity_check: !!checkIdentity });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // ── МАСС-ПОСТИНГ: пачка с предпросмотром плана (01.08) ──────────────────────────────────────
  // dry_run=true → только показать раскладку (кто, когда, почему такой слот), НИЧЕГО не пишем.
  // Без dry_run → создаём пачку и посты со scheduled_at; на мак их подаёт тик воркера.
  api.post('/promo/batch', async (req, res) => {
    try {
      const body = (req.body || {}) as { title?: string; items?: any[]; dry_run?: boolean };
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) { res.status(400).json({ error: 'пустой список роликов' }); return; }
      const { planBatch } = await import('./batchplan.js');
      const plan = await planBatch(items.map((x) => ({
        persona: String(x.persona || ''), video_url: String(x.video_url || ''),
        caption: x.caption ? String(x.caption) : undefined,
        target: x.target === 'spare' ? 'spare' : 'main',
      })));
      const okRows = plan.filter((p) => p.ok);
      if (body.dry_run) { res.json({ dry_run: true, plan, planned: okRows.length, skipped: plan.length - okRows.length }); return; }
      if (!okRows.length) { res.status(400).json({ error: 'ни один ролик не проходит по лимитам/гейтам', plan }); return; }
      const b = await query<Record<string, any>>(
        `INSERT INTO post_batches (title, status) VALUES ($1,'running') RETURNING id`,
        [body.title || `пачка ${okRows.length} роликов`]);
      const batchId = b.rows[0].id;
      for (const p of okRows) {
        await query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, scheduled_at, batch_id)
           VALUES ($1,'instagram','promo','approved',$2,$3,'VIDEO',$4,$5)`,
          [p.account_id, p.caption, p.video_url, p.at, batchId]);
      }
      res.json({ ok: true, batch_id: batchId, planned: okRows.length, skipped: plan.length - okRows.length, plan });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Состояние пачки: что уже вышло, что ждёт, что не вышло.
  api.get('/promo/batch/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const b = (await query<Record<string, any>>(`SELECT * FROM post_batches WHERE id=$1`, [req.params.id])).rows[0];
      if (!b) { res.status(404).json({ error: 'пачка не найдена' }); return; }
      const r = await query<Record<string, any>>(
        `SELECT p.id, p.status, p.post_submitted, left(coalesce(p.caption,''),70) caption, p.external_url,
                to_char(p.scheduled_at,'MM-DD HH24:MI') at, left(coalesce(p.error,''),80) error,
                a.persona, a.is_spare, coalesce(a.ig_login,a.slug) handle
           FROM posts p JOIN accounts a ON a.id=p.account_id
          WHERE p.batch_id=$1 ORDER BY p.scheduled_at`, [req.params.id]);
      res.json({ batch: b, posts: r.rows });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Список пачек для панели.
  api.get('/promo/batches', async (_req, res) => {
    try {
      const r = await query<Record<string, any>>(
        `SELECT b.id, b.title, b.status, to_char(b.created_at,'MM-DD HH24:MI') t,
                count(p.id) total,
                count(*) FILTER (WHERE p.status='published') published,
                count(*) FILTER (WHERE p.status='approved') waiting,
                count(*) FILTER (WHERE p.status IN ('failed','ambiguous')) problems
           FROM post_batches b LEFT JOIN posts p ON p.batch_id=b.id
          GROUP BY b.id ORDER BY b.created_at DESC LIMIT 10`);
      res.json({ batches: r.rows });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Пауза/возобновление/отмена. ОТМЕНА НИКОГДА не трогает посты с post_submitted=true:
  // после клика «Поделиться» ретраи и отмены запрещены (инвариант проекта, иначе дубли).
  api.post('/promo/batch/:id/:action', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const act = String(req.params.action);
      if (!['pause', 'resume', 'cancel'].includes(act)) { res.status(400).json({ error: 'плохое действие' }); return; }
      if (act === 'cancel') {
        await query(`UPDATE posts SET status='cancelled' WHERE batch_id=$1 AND status='approved' AND post_submitted=false`, [req.params.id]);
        await query(`DELETE FROM local_jobs WHERE status='queued' AND mode='igpost' AND urls IN
                       (SELECT id::text FROM posts WHERE batch_id=$1)`, [req.params.id]);
        await query(`UPDATE post_batches SET status='cancelled', updated_at=now() WHERE id=$1`, [req.params.id]);
      } else {
        await query(`UPDATE post_batches SET status=$2, updated_at=now() WHERE id=$1`, [req.params.id, act === 'pause' ? 'paused' : 'running']);
      }
      res.json({ ok: true, action: act });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // АВАТАРКИ ОТДЕЛЬНО: avatar_thumb это base64 (8-60 КБ на акк), тянуть их в /promo/models на каждом
  // обновлении панели накладно. Панель дёргает это один раз и кэширует в памяти вкладки.
  api.get('/promo/avatars', async (_req, res) => {
    try {
      // platform='promo' добавлен 07.08: единая таблица акков показывает ВСЕ постинг-акки,
      // включая те, что пока без персоны — авы нужны и им.
      const r = await query<Record<string, any>>(
        `SELECT slug, avatar_thumb FROM accounts
          WHERE ((persona IS NOT NULL AND persona<>'') OR platform='promo')
            AND deleted_at IS NULL AND avatar_thumb IS NOT NULL`);
      const avatars: Record<string, string> = {};
      for (const x of r.rows) avatars[x.slug] = x.avatar_thumb;
      res.json({ avatars });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // === ЕДИНАЯ ТАБЛИЦА АККАУНТОВ (07.08) =======================================================
  // Приказ: «1 таблица где все акки: фото, ник, описание, постов сделано, глаз, обновить,
  // разбивка по дням (сегодня/вчера/неделя/кастомная дата)» + «убирай моделей, аккаунты по
  // порядку». Один плоский список постинг-акков (platform='promo' или с персоной), персона —
  // техническое поле, не группировка. Числа считает СЕРВЕР по posts.published_at: период задаётся
  // именем (today|yesterday|7d|30d|all) или парой дат from/to (YYYY-MM-DD, custom). Границы дней —
  // по Europe/Warsaw (как comments_day). Просмотры — снимок post_stats (собирает stats.cjs по куке
  // акка), пост↔снимок связываем так же, как /promo/stats: external_url LIKE %shortcode%.
  api.get('/accounts/table', async (req, res) => {
    try {
      const period = String(req.query.period || 'all');
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      let fromD: string | null = null;
      let toD: string | null = null;
      if (period === 'custom') {
        fromD = dateRe.test(String(req.query.from || '')) ? String(req.query.from) : null;
        toD = dateRe.test(String(req.query.to || '')) ? String(req.query.to) : null;
        if (!fromD && !toD) { res.status(400).json({ error: 'custom: нужны даты from/to (YYYY-MM-DD)' }); return; }
      } else if (period !== 'all') {
        const back: Record<string, number> = { today: 0, yesterday: 1, '7d': 6, '30d': 29 };
        if (!(period in back)) { res.status(400).json({ error: 'период: today|yesterday|7d|30d|all|custom' }); return; }
        // «Сегодня» считаем по Варшаве на сервере, а не по часам браузера — иначе числа зависят
        // от того, откуда открыли панель.
        const t = (await query<Record<string, any>>(
          `SELECT ((now() at time zone 'Europe/Warsaw')::date - $1::int)::text f,
                  ((now() at time zone 'Europe/Warsaw')::date - $2::int)::text t`,
          [back[period], period === 'yesterday' ? 1 : 0])).rows[0];
        fromD = t.f; toD = t.t;
      }
      const { rows } = await query<Record<string, any>>(
        `SELECT a.id, a.slug, a.acc_no, coalesce(a.ig_login, a.slug) handle, a.display_name,
                a.persona, a.is_spare, a.status, a.session_status, coalesce(a.ig_status,'') ig_status,
                a.health_state, left(coalesce(a.health_note,''),140) health_note,
                to_char(a.health_checked_at,'MM-DD HH24:MI') health_at,
                coalesce(a.ig_bio,'') bio, a.ig_full_name, a.tracking_code, a.followers_count, a.posts_count,
                -- честность чека: bio/имя/ава показываем «не проверено», пока профиль ни разу
                -- не прочитан снаружи; отдельная попытка-сбой видна по try_at > checked_at
                to_char(a.profile_checked_at,'DD.MM HH24:MI') profile_checked_at,
                to_char(a.profile_try_at,'DD.MM HH24:MI') profile_try_at,
                (a.profile_try_at IS NOT NULL AND (a.profile_checked_at IS NULL OR a.profile_try_at > a.profile_checked_at + interval '2 minutes')) last_try_failed,
                (a.avatar_thumb IS NOT NULL) has_avatar, a.dressed_at IS NOT NULL dressed,
                to_char(a.session_checked_at,'MM-DD HH24:MI') session_at,
                per.posts_n, per.views_n, per.likes_n, per.last_post,
                tot.posts_total, tot.views_total, tot.queued_n, tot.last_url,
                (SELECT to_char(max(s.updated_at),'MM-DD HH24:MI') FROM post_stats s WHERE s.account_id=a.id) stats_at
           FROM accounts a
           -- за выбранный период (границы дней — Варшава)
           LEFT JOIN LATERAL (
             SELECT count(DISTINCT p.id)::int posts_n,
                    coalesce(sum(s.views),0)::int views_n,
                    coalesce(sum(s.likes),0)::int likes_n,
                    to_char(max(p.published_at),'MM-DD HH24:MI') last_post
               FROM posts p
               LEFT JOIN post_stats s ON p.external_url LIKE '%'||s.shortcode||'%'
              WHERE p.account_id=a.id AND p.status='published'
                AND ($1::date IS NULL OR p.published_at >= (($1::date)::timestamp AT TIME ZONE 'Europe/Warsaw'))
                AND ($2::date IS NULL OR p.published_at < ((($2::date)+1)::timestamp AT TIME ZONE 'Europe/Warsaw'))
           ) per ON true
           -- за всё время (для колонки «всего» и очереди)
           LEFT JOIN LATERAL (
             SELECT count(DISTINCT p.id) FILTER (WHERE p.status='published')::int posts_total,
                    coalesce(sum(s.views) FILTER (WHERE p.status='published'),0)::int views_total,
                    coalesce(sum(s.likes) FILTER (WHERE p.status='published'),0)::int likes_total,
                    count(DISTINCT p.id) FILTER (WHERE p.status IN ('approved','draft'))::int queued_n,
                    (SELECT p2.external_url FROM posts p2 WHERE p2.account_id=a.id AND p2.status='published'
                      ORDER BY p2.published_at DESC NULLS LAST LIMIT 1) last_url
               FROM posts p
               LEFT JOIN post_stats s ON p.external_url LIKE '%'||s.shortcode||'%'
              WHERE p.account_id=a.id
           ) tot ON true
          WHERE a.deleted_at IS NULL AND (a.platform='promo' OR (a.persona IS NOT NULL AND a.persona<>''))
          ORDER BY a.acc_no NULLS LAST, a.slug`,
        [fromD, toD]);
      // ВАЖНО ПРО ЧЕСТНОСТЬ ЦИФР (урок promt.vibe.lab, 07.08): у купленного акка в post_stats
      // лежит НАСЛЕДСТВО прежнего владельца (stats.cjs снимает всю ленту). Поэтому посты,
      // просмотры и лайки здесь идут ТОЛЬКО через нашу таблицу posts (status='published'), к
      // которой снимок пришивается по shortcode в external_url, выданном самим Instagram, — чужой
      // пост такой связи не имеет и в цифры не попадает никогда. Акк без наших публикаций
      // показывает ноль, а не чужие 39682. Чужая история отдаётся ОТДЕЛЬНО: foreign_posts_n =
      // сколько постов в ленте снаружи (accheck) сверх наших, без просмотров.
      const accounts = rows.map((r) => ({
        ...r,
        posts_n: Number(r.posts_n || 0), views_n: Number(r.views_n || 0), likes_n: Number(r.likes_n || 0),
        posts_total: Number(r.posts_total || 0), views_total: Number(r.views_total || 0),
        likes_total: Number(r.likes_total || 0), queued_n: Number(r.queued_n || 0),
        foreign_posts_n: r.posts_count == null ? null : Math.max(0, Number(r.posts_count) - Number(r.posts_total || 0)),
      }));
      res.json({
        period, from: fromD, to: toD, accounts,
        totals: {
          posts: accounts.reduce((s, a) => s + a.posts_n, 0),
          views: accounts.reduce((s, a) => s + a.views_n, 0),
          likes: accounts.reduce((s, a) => s + a.likes_n, 0),
        },
      });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Кнопка ⟳ на строке акка: свежие цифры + внешний чек профиля. Ничего своего не выдумываем —
  // ставим те же local_jobs, что и остальные кнопки: stats (просмотры по куке, stats.cjs) и
  // accheck (анонимный чек профиля снаружи: ава/био/подписчики/health, accheck.cjs --no-vision).
  // Выполняет localrunner.cjs на маке; не запущен → задачи ждут в очереди.
  api.post('/accounts/:id/refresh', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const a = (await query<Record<string, any>>(
        `SELECT slug, coalesce(ig_login,slug) h FROM accounts WHERE id=$1 AND deleted_at IS NULL`,
        [req.params.id])).rows[0];
      if (!a) { res.status(404).json({ error: 'акк не найден' }); return; }
      const queued: string[] = [];
      for (const mode of ['stats', 'accheck']) {
        const dup = await query<Record<string, any>>(
          `SELECT id FROM local_jobs WHERE mode=$1 AND slug IN ($2,'all') AND status IN ('queued','running') LIMIT 1`,
          [mode, a.slug]);
        if (dup.rowCount) continue; // уже в очереди (или идёт полный обход) — второй раз не ставим
        await query(`INSERT INTO local_jobs (slug, mode, n, status) VALUES ($1,$2,1,'queued')`, [a.slug, mode]);
        queued.push(mode);
      }
      res.json({ ok: true, slug: a.slug, handle: a.h, queued,
        note: queued.length ? 'задачи поставлены маку (нужен запущенный localrunner)' : 'обновление уже в очереди' });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // СДЕЛАТЬ ЗАПАСНОЙ ОСНОВНЫМ (когда основной лёг). Строго в транзакции: частичный уникальный индекс
  // uq_accounts_persona_main запрещает двух основных на одну модель, иначе 23505.
  api.post('/promo/promote/:id', async (req, res) => {
    if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cur = await c.query(`SELECT persona, coalesce(ig_login,slug) h FROM accounts WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      const persona = cur.rows[0]?.persona;
      if (!persona) { await c.query('ROLLBACK'); res.status(404).json({ error: 'акк не найден или без модели' }); return; }
      await c.query(`UPDATE accounts SET is_spare=true WHERE persona=$1 AND deleted_at IS NULL`, [persona]);
      await c.query(`UPDATE accounts SET is_spare=false WHERE id=$1`, [req.params.id]);
      await c.query('COMMIT');
      res.json({ ok: true, persona, handle: cur.rows[0].h });
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    } finally { c.release(); }
  });
  // Снять паузу с аккаунта. Только по кнопке: в схеме не записано, кто поставил паузу —
  // владелец руками или автоматика после сбоя входа, — поэтому снимать её фоном нельзя.
  // Если IG всё ещё держит акк ограниченным, паузу не снимаем: это не наше решение.
  api.post('/promo/unpause/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const cur = await query<Record<string, any>>(
        `SELECT coalesce(ig_login,slug) h, coalesce(ig_status,'') ig_status, health_state
           FROM accounts WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
      const a = cur.rows[0];
      if (!a) { res.status(404).json({ error: 'акк не найден' }); return; }
      if (['restricted', 'suspended', 'captcha', 'challenge'].includes(a.ig_status) || a.health_state === 'restricted') {
        res.status(409).json({ error: `IG держит акк как «${a.ig_status || a.health_state}» — сначала разберись в GoLogin` });
        return;
      }
      await query(`UPDATE accounts SET status='warming' WHERE id=$1`, [req.params.id]);
      res.json({ ok: true, handle: a.h });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Привязать акк к модели (или снять привязку) — иначе новый акк не попадёт в раздел «Модели».
  api.post('/promo/persona/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const persona = String((req.body || {}).persona || '').trim() || null;
      const isSpare = !!(req.body || {}).is_spare;
      await query(`UPDATE accounts SET persona=$2, is_spare=$3 WHERE id=$1 AND deleted_at IS NULL`,
        [req.params.id, persona, persona ? isSpare : false]);
      res.json({ ok: true, persona, is_spare: isSpare });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Кнопки карточки: проверить здоровье / снять куки / оформить — всё через локальный раннер на маке.
  api.post('/promo/task/:mode/:slug', async (req, res) => {
    try {
      const mode = String(req.params.mode || '');
      if (!['health', 'cookies', 'dress'].includes(mode)) { res.status(400).json({ error: 'плохой режим' }); return; }
      const slug = String(req.params.slug || '').trim();
      if (!slug) { res.status(400).json({ error: 'нет slug' }); return; }
      await query(`INSERT INTO local_jobs (slug, mode, n, status) VALUES ($1,$2,1,'queued')`, [slug, mode]);
      res.json({ ok: true, queued: slug, mode });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Кнопка «опубликовать сейчас»: кладём задачу локальному раннеру (публикация идёт на маке, 0 облачных часов)
  api.post('/promo/publish/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const p = await query<Record<string, any>>(
        `SELECT p.id, a.slug FROM posts p JOIN accounts a ON a.id=p.account_id WHERE p.id=$1`, [req.params.id]);
      if (!p.rows[0]) { res.status(404).json({ error: 'пост не найден' }); return; }
      // ЕДИНЫЙ ПРЕДОХРАНИТЕЛЬ (06.08): кнопка «опубликовать сейчас» проверок не имела вообще, то
      // есть больной акк добивался одним кликом. Отказ показываем человеку текстом, а не молча.
      const guard = await canPost(p.rows[0].slug);
      if (!guard.ok) { res.status(409).json({ error: `предохранитель: ${guard.reason}` }); return; }
      await query(`INSERT INTO local_jobs (slug, mode, n, urls, status) VALUES ($1,'igpost',1,$2,'queued')`,
        [p.rows[0].slug, String(p.rows[0].id)]);
      res.json({ ok: true, queued: p.rows[0].slug });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  api.post('/accounts/:id/mark-live', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const { rows } = await query<Record<string, any>>(
        `UPDATE accounts SET session_status='live', ig_status='login_ok', login_fails=0, session_checked_at=now()
         WHERE id=$1 AND deleted_at IS NULL RETURNING slug`, [req.params.id]);
      if (!rows[0]) { res.status(404).json({ error: 'акк не найден' }); return; }
      res.json({ ok: true, slug: rows[0].slug });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // Генерация профиля акка: аватар (RenderGrid) + ник + описание (LLM). Сохраняем на акк.
  api.post('/accounts/:id/gen-profile', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'bad id' }); return; }
      const [avatar, prof] = await Promise.all([generateAvatar(), generateTikTokProfile()]);
      await query(
        `UPDATE accounts SET tt_nick=$2, tt_name=$3, tt_avatar_url=coalesce($4,tt_avatar_url), tt_bio=$5 WHERE id=$1`,
        [req.params.id, prof.handle || null, prof.name || null, avatar || null, prof.bio || null],
      );
      res.json({ handle: prof.handle, name: prof.name, bio: prof.bio, avatar });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // Массовый импорт комментинг-акков через КУКИ (для фермы на приватном API).
  // items: [{ name, proxy, cookies:[...], user_agent }]. Создаёт акки platform='comments'.
  api.post('/accounts/bulk-comments', async (req, res) => {
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items : [];
      const gid = b.group_id && isUuid(String(b.group_id)) ? b.group_id : null;
      let created = 0, skipped = 0;
      for (const it of items) {
        const slug = String(it.name || it.slug || '').trim() || `ig-${Math.random().toString(36).slice(2, 8)}`;
        if (!it.cookies) { skipped++; continue; }
        const track = slug.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || Math.random().toString(36).slice(2, 8);
        await query(
          `INSERT INTO accounts (platform, slug, status, account_type, ig_cookies, ig_proxy, ig_user_agent, group_id, tracking_code)
           VALUES ('comments',$1,'active','bought',$2,$3,$4,(SELECT id FROM account_groups WHERE id=$5 AND platform='comments'),$6)
           ON CONFLICT (platform, slug) DO UPDATE SET
             ig_cookies=excluded.ig_cookies, ig_proxy=excluded.ig_proxy, ig_user_agent=excluded.ig_user_agent, group_id=excluded.group_id`,
          [slug, JSON.stringify(it.cookies), it.proxy ?? null, it.user_agent ?? null, gid, track],
        ).then(() => created++).catch(() => skipped++);
      }
      res.json({ created, skipped });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // Массовый ЗАВОД облачных профилей GoLogin: файл → на каждый акк создаём профиль (сервер генерит
  // фингерпринт) + вешаем прокси + (если есть) заливаем куки → акк поднимется залогиненным, и сразу
  // заводим его в панель со ссылкой на профиль. Токен берём у группы (свой GoLogin-акк) или общий env.
  // items: [{ name, proxy:"host:port:user:pass", cookies?:[…], user_agent? }]
  api.post('/accounts/bulk-gologin', async (req, res) => {
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) { res.status(400).json({ error: 'пустой список' }); return; }
      if (items.length > 50) { res.status(400).json({ error: 'за раз не больше 50 — разбей на части' }); return; }
      const gid = b.group_id && isUuid(String(b.group_id)) ? b.group_id : null;
      const platform = ['tiktok', 'instagram', 'comments'].includes(b.platform) ? b.platform : 'comments';
      const os = ['win', 'mac', 'lin'].includes(b.os) ? b.os : (platform === 'tiktok' ? 'mac' : 'win');
      // Токен GoLogin-аккаунта берём У ВЫБРАННОЙ ГРУППЫ. Молчаливый фолбэк на общий env недопустим:
      // env — это аккаунт искателя/ТТ (полный), профили ушли бы туда и смешались. Нет токена → ошибка.
      if (!gid) { res.status(400).json({ error: 'выбери группу — её GoLogin-токен нужен для создания профилей' }); return; }
      const g = await query<{ gologin_token: string | null; name: string }>(`SELECT gologin_token, name FROM account_groups WHERE id=$1`, [gid]);
      const tok = g.rows[0]?.gologin_token || null;
      if (!tok) { res.status(400).json({ error: `у группы «${g.rows[0]?.name || '—'}» нет своего GoLogin-токена — задай его в настройках группы` }); return; }
      const results: Array<{ name: string; profile_id?: string; warn?: string; error?: string }> = [];
      const seen = new Set<string>(); // дубли имён в файле не дают перезатирать профиль друг друга
      // Номер акка — СКВОЗНОЙ инкремент по ВСЕМУ флоту: новый = глобальный max(acc_no)+1 (с учётом удалённых,
      // чтобы номера НЕ переиспользовались и не дублировались). Удалил №50 → новый всё равно следующий (напр. 91),
      // а не «наименьший свободный 50». Так новые идут 85,86,87…, а не скачут 5,10,15.
      const mxRes = await query<{ mx: number }>(`SELECT coalesce(max(acc_no),0) mx FROM accounts`);
      let seqNo = Number(mxRes.rows[0]?.mx) || 0;
      const nextNo = () => ++seqNo;
      const toLogin: Array<Record<string, any>> = []; // акки с кредами — залогиним сразу после ответа (фоном)
      let created = 0, failed = 0, queued = 0;
      for (const it of items) {
        let name = String(it.name || it.slug || '').trim() || `ig-${Math.random().toString(36).slice(2, 8)}`;
        if (seen.has(name.toLowerCase())) name = `${name}-${Math.random().toString(36).slice(2, 5)}`;
        seen.add(name.toLowerCase());
        const proxyRaw = it.proxy ? String(it.proxy).trim() : '';
        const proxy = proxyRaw ? parseProxy(proxyRaw) : null;
        // Живой акк с таким именем и профилем — не трогаем (иначе отвяжем прогретый). Пропуск (он и так в БД — не потеря).
        // Удалённый (в корзине) — воскрешаем через ON CONFLICT; прежний профиль подчистим при успехе создания нового.
        const dup = await query<{ gologin_profile_id: string | null; deleted_at: string | null; acc_no: number | null }>(
          `SELECT gologin_profile_id, deleted_at, acc_no FROM accounts WHERE platform=$1 AND lower(slug)=lower($2)`, [platform, name]);
        const existed = dup.rows[0];
        if (existed && !existed.deleted_at && existed.gologin_profile_id) {
          failed++; results.push({ name, error: `уже есть акк «${name}» с профилем — пропускаю (переименуй)` }); continue;
        }
        const oldPid = existed?.gologin_profile_id || null; // профиль воскрешаемого из корзины акка
        const accNo = existed?.acc_no ?? nextNo(); // воскрешаемый — свой номер; новый — глобальный max+1
        // Креды. 2FA-сид чистим от пробелов (base32 группами «IYGR UVMZ …»); код считаем в панели (TOTP).
        const login = it.login ? String(it.login).trim() : null;
        const password = it.password != null ? String(it.password) : null;
        let totp = it.totp ? String(it.totp).replace(/\s+/g, '').toUpperCase() : null;
        let totpWarn: string | undefined;
        // Невалидный base32 НЕ сохраняем — иначе /totp отдаст уверенно-неверный код.
        if (totp && !/^[A-Z2-7]{8,}=*$/.test(totp)) { totpWarn = '2FA-ключ не base32 — не сохранён'; totp = null; }
        const email = it.email ? String(it.email).trim() : null;
        const emailPass = it.email_password != null ? String(it.email_password) : null;
        const track = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || Math.random().toString(36).slice(2, 8);
        // === ШАГ 0: СНАЧАЛА пишем креды в БД с профилем NULL (= «⏳ Очередь») — чтобы НИЧЕГО не потерять
        //    при лимите профилей GoLogin / битом прокси / сбое сети. Профиль прицепим ниже, если создастся. ===
        let accId: string | undefined;
        try {
          const ins = await query<{ id: string }>(
            `INSERT INTO accounts (platform, slug, status, account_type, gologin_profile_id, ig_cookies, ig_proxy, ig_user_agent, group_id, tracking_code,
               ig_login, ig_password, totp_secret, ig_email, ig_email_password, acc_no)
             VALUES ($1,$2,'warming','bought',NULL,$3,$4,$5,(SELECT id FROM account_groups WHERE id=$6),$7, $8,$9,$10,$11,$12,$13)
             ON CONFLICT (platform, slug) DO UPDATE SET
               ig_cookies=coalesce(excluded.ig_cookies, accounts.ig_cookies),
               ig_proxy=coalesce(excluded.ig_proxy, accounts.ig_proxy), ig_user_agent=coalesce(excluded.ig_user_agent, accounts.ig_user_agent),
               group_id=excluded.group_id, deleted_at=NULL,
               ig_login=coalesce(excluded.ig_login, accounts.ig_login), ig_password=coalesce(excluded.ig_password, accounts.ig_password),
               totp_secret=coalesce(excluded.totp_secret, accounts.totp_secret), ig_email=coalesce(excluded.ig_email, accounts.ig_email),
               ig_email_password=coalesce(excluded.ig_email_password, accounts.ig_email_password), acc_no=coalesce(accounts.acc_no, excluded.acc_no)
             RETURNING id`,
            [platform, name, it.cookies ? JSON.stringify(it.cookies) : null, proxyRaw || null, it.user_agent ?? null, gid, track,
             login, password, totp, email, emailPass, accNo],
          );
          accId = ins.rows[0]?.id;
        } catch (e) {
          failed++; results.push({ name, error: 'БД: ' + (e instanceof Error ? e.message.slice(0, 60) : 'insert') }); continue;
        }
        // Прокси задан, но не распознан — профиль без прокси не создаём (датацентр-IP). Акк УЖЕ в очереди — не потерян.
        if (proxyRaw && !proxy) {
          queued++; results.push({ name, warn: `прокси не распознан (${proxyRaw.slice(0, 30)}) — акк в «⏳ Очередь», поправь прокси и заведи профиль` + (totpWarn ? '; ' + totpWarn : '') });
          continue;
        }
        let pid: string | null = null;
        try {
          pid = await createCloudProfile(accNo != null ? `${accNo} ${name}` : name, os, tok);
          if (proxy) await setProfileProxy(pid, proxy, tok);
          let warn: string | undefined = proxy ? undefined : 'без прокси — датацентр-IP GoLogin (добавь прокси)';
          if (totpWarn) warn = (warn ? warn + '; ' : '') + totpWarn;
          if (Array.isArray(it.cookies) && it.cookies.length) {
            // куки некритичны: профиль+прокси уже валидны, при сбое просто поднимется не залогиненным
            try { await importCookies(pid, it.cookies, tok); }
            catch { warn = (warn ? warn + '; ' : '') + 'куки не залились — залогинься вручную'; }
          }
          // Профиль готов — прицепляем к уже сохранённому (ШАГ0) акку и запускаем прогрев.
          await query(`UPDATE accounts SET gologin_profile_id=$1, warmup_started_at=now() WHERE id=$2`, [pid, accId]);
          // Воскресили акк из корзины — его прежний GoLogin-профиль больше не нужен, гасим (не сирота).
          if (oldPid && oldPid !== pid) { try { await deleteCloudProfile(oldPid, tok); } catch { /* мог быть уже удалён */ } }
          created++;
          results.push({ name, profile_id: pid, warn });
          // Есть креды (не куки-акк) — сразу залогиним фоном, чтобы не ждать 8ч тика прогрева.
          if (accId && login && password) toLogin.push({ id: accId, slug: name, platform, gologin_profile_id: pid, group_token: tok, ig_login: login, ig_password: password, totp_secret: totp });
        } catch (e) {
          // Профиль не создан (частая причина — лимит профилей GoLogin). КРЕДЫ УЖЕ В БД (ШАГ0, «⏳ Очередь») — не потеряны.
          if (pid) { try { await deleteCloudProfile(pid, tok); } catch { /* снести вручную */ } }
          queued++;
          results.push({ name, warn: `профиль не создан (${e instanceof Error ? e.message.slice(0, 50) : 'ошибка'}) — акк сохранён в «⏳ Очередь», заведи профиль позже` + (totpWarn ? '; ' + totpWarn : '') });
        }
      }
      res.json({ created, queued, failed, results, will_login: toLogin.length });
      // ФОН: логиним заведённые кред-акки сразу (последовательно, замок/резерв внутри loginAccountOnce),
      // чтобы не ждать 8ч тик прогрева. Ошибки не критичны — воркер потом добьёт/поставит на паузу.
      if (toLogin.length) {
        (async () => {
          for (const acc of toLogin) {
            try { const r = await loginAccountOnce(acc); console.log(`[bulk-login] ${acc.slug}: ${r.result} — ${r.msg}`); }
            catch (e) { console.warn(`[bulk-login] ${acc.slug}: ${e instanceof Error ? e.message : e}`); }
          }
          console.log(`[bulk-login] готово, акков: ${toLogin.length}`);
        })();
      }
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // === СИГНАЛ ИЗВНЕ: «акки упали — подними» ===
  // Дёргает ЛЮБОЙ процесс/чат (машинный доступ по Bearer, кука не нужна):
  //   curl -X POST .../api/accounts/revive -H 'Authorization: Bearer <API_TOKEN>' -H 'Content-Type: application/json' -d '{}'
  // body: { slug?: только этот акк, force?: логинить сразу, а не ждать тик }
  // Синхронно: классифицирует упавших и снимает пауза/счётчики у тех, кого МОЖНО поднять авто (воркер войдёт ≤20 мин).
  // Фоном (ответ не ждёт): диагностит прокси у падавших + при force логинит немедленно + сводка в ТГ.
  api.post('/accounts/revive', async (req, res) => {
    try {
      const b = req.body || {};
      const slug = b.slug ? String(b.slug).trim() : null;
      const force = !!b.force;
      const rows = (await query<Record<string, any>>(
        `SELECT a.id, a.slug, a.platform, a.status, a.session_status, a.ig_status, coalesce(a.login_fails,0) AS login_fails,
                a.ig_proxy, a.gologin_profile_id, a.ig_login, a.ig_password, a.totp_secret, a.ig_email, a.ig_email_password,
                a.session_checked_at, a.relogin_try_at, g.gologin_token AS group_token
         FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.deleted_at IS NULL
           AND (a.session_status IS DISTINCT FROM 'live' OR a.status='paused')
           ${slug ? 'AND lower(a.slug)=lower($1)' : ''}
         ORDER BY a.acc_no ASC NULLS LAST LIMIT 100`,
        slug ? [slug] : [],
      )).rows;

      const revive: Record<string, any>[] = [];
      const hands: Array<{ slug: string; why: string }> = [];
      const waiting: Array<{ slug: string; why: string }> = [];
      for (const a of rows) {
        const ig = String(a.ig_status || '');
        if (ig === 'suspended') { hands.push({ slug: a.slug, why: 'бан/suspended' }); continue; }
        if (ig === 'challenge' || ig === 'captcha') { hands.push({ slug: a.slug, why: ig === 'captcha' ? 'капча' : 'челлендж (почта/SMS)' }); continue; }
        if (!a.gologin_profile_id) { hands.push({ slug: a.slug, why: 'нет профиля GoLogin' }); continue; }
        // Сессия ЖИВА, акк просто на паузе — вход не нужен, пароль не требуется (куки/TikTok-акки).
        // Раньше их ошибочно кидало в «руками» из-за пустого ig_password.
        if (String(a.session_status || '') === 'live') { revive.push(a); continue; }
        if (!a.ig_login || !a.ig_password) { hands.push({ slug: a.slug, why: 'сессия мертва и нет пароля — вход только руками' }); continue; }
        // (механику '2FA-кулдаун <4ч' убрали 23.07 — 2FA штатное событие, входим сразу)
        revive.push(a);
      }

      if (revive.length) {
        await query(
          `UPDATE accounts SET status = CASE WHEN status='paused' THEN 'warming' ELSE status END,
                               login_fails = 0, session_checked_at = NULL, relogin_try_at = NULL,
                               ig_status = CASE WHEN ig_status IN ('2fa_cooldown','bad_login') THEN NULL ELSE ig_status END
           WHERE id = ANY($1::uuid[])`,
          [revive.map((a) => a.id)],
        );
      }

      res.json({
        revived_count: revive.length, revived: revive.map((a) => a.slug),
        waiting, needs_hands: hands,
        note: 'пауза и счётчики сняты — воркер войдёт ближайшим тиком (≤20 мин); force=true логинит сразу',
      });

      // ФОН: ответ уже отдан, дальше не блокируем вызывающего.
      void (async () => {
        try {
          const bad: string[] = [];
          for (const a of revive.filter((x) => Number(x.login_fails) > 0 || slug)) {
            const d = await diagnoseProxy(a.ig_proxy).catch(() => '');
            if (d.startsWith('🔴')) bad.push(`${a.slug}: ${d}`);
          }
          if (force) {
            for (const a of revive.slice(0, 5)) { // не больше 5 разом — иначе IG режет частые входы
              try { const r = await loginAccountOnce(a, { force: true }); console.log(`[revive] ${a.slug}: ${r.result} — ${r.msg}`); }
              catch (e) { console.warn(`[revive] ${a.slug}: ${e instanceof Error ? e.message : e}`); }
            }
          }
          const lines = [`♻️ Сигнал «подними акки»: снято с паузы ${revive.length}, руками ${hands.length}, ждут 2FA ${waiting.length}`];
          if (bad.length) lines.push('', 'ПРОКСИ ПРОБЛЕМНЫЕ:', ...bad.slice(0, 10));
          if (hands.length) lines.push('', 'РУКАМИ:', ...hands.slice(0, 10).map((h) => `${h.slug} — ${h.why}`));
          await notifyOwner(lines.join('\n')).catch(() => {});
        } catch (e) { console.warn('[revive] фон:', e instanceof Error ? e.message : e); }
      })();
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // Завести GoLogin-профили для акков, уже лежащих в БД в «⏳ Очередь» (креды/прокси сохранены, профиля нет).
  // Юзкейс: упёрлись в лимит при массовом заводе → часть осела в очереди; освободили слоты → добираем ОТСЮДА,
  // повторно вставлять креды НЕ нужно (читаем прокси/логин/2FA из БД, создаём профиль, цепляем, логиним фоном).
  api.post('/accounts/create-queued', async (req, res) => {
    try {
      const b = req.body || {};
      const gid = b.group_id && isUuid(String(b.group_id)) ? b.group_id : null;
      const q = await query<{ id: string; slug: string; platform: string; acc_no: number | null; ig_proxy: string | null; ig_login: string | null; ig_password: string | null; totp_secret: string | null; group_token: string | null }>(
        `SELECT a.id, a.slug, a.platform, a.acc_no, a.ig_proxy, a.ig_login, a.ig_password, a.totp_secret, g.gologin_token AS group_token
         FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.gologin_profile_id IS NULL AND a.deleted_at IS NULL AND coalesce(a.ig_password,'') <> ''
           ${gid ? 'AND a.group_id=$1' : ''}
         ORDER BY a.acc_no ASC NULLS LAST LIMIT 50`,
        gid ? [gid] : [],
      );
      let created = 0, stillQueued = 0, consecFail = 0;
      const results: Array<{ slug: string; profile_id?: string; warn?: string; error?: string }> = [];
      const toLogin: Array<Record<string, any>> = [];
      for (const a of q.rows) {
        const tok = a.group_token;
        if (!tok) { stillQueued++; results.push({ slug: a.slug, error: 'у группы акка нет GoLogin-токена' }); continue; }
        const proxy = a.ig_proxy ? parseProxy(a.ig_proxy) : null;
        if (a.ig_proxy && !proxy) { stillQueued++; results.push({ slug: a.slug, warn: 'прокси не распознан — поправь у акка' }); continue; }
        const os = a.platform === 'tiktok' ? 'mac' : 'win';
        let pid: string | null = null;
        try {
          pid = await createCloudProfile(a.acc_no != null ? `${a.acc_no} ${a.slug}` : a.slug, os, tok);
          if (proxy) await setProfileProxy(pid, proxy, tok);
          await query(`UPDATE accounts SET gologin_profile_id=$1, warmup_started_at=now() WHERE id=$2`, [pid, a.id]);
          created++; consecFail = 0;
          results.push({ slug: a.slug, profile_id: pid });
          if (a.ig_login && a.ig_password) toLogin.push({ id: a.id, slug: a.slug, platform: a.platform, gologin_profile_id: pid, group_token: tok, ig_login: a.ig_login, ig_password: a.ig_password, totp_secret: a.totp_secret });
        } catch (e) {
          if (pid) { try { await deleteCloudProfile(pid, tok); } catch { /* вручную */ } }
          stillQueued++; consecFail++;
          const m = e instanceof Error ? e.message.slice(0, 50) : 'ошибка';
          results.push({ slug: a.slug, warn: `профиль не создан (${m}) — остался в очереди` });
          // 3 отказа подряд — почти наверняка лимит профилей GoLogin. Дальше не долбим, остальное оставляем в очереди.
          if (consecFail >= 3) { results.push({ slug: '—', warn: `стоп: ${consecFail} отказа подряд (похоже, лимит профилей). Освободи слоты и повтори.` }); break; }
        }
      }
      res.json({ created, stillQueued, results });
      // Фон: логиним заведённые кред-акки сразу (замок/резерв внутри loginAccountOnce).
      if (toLogin.length) {
        (async () => {
          for (const acc of toLogin) {
            try { const r = await loginAccountOnce(acc); console.log(`[queue-login] ${acc.slug}: ${r.result} — ${r.msg}`); }
            catch (e) { console.warn(`[queue-login] ${acc.slug}: ${e instanceof Error ? e.message : e}`); }
          }
        })();
      }
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // === РАДАР: конфиг хэштегов + найденные посты (комментит человек сам, открыто) ===
  api.get('/radar/config', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(`SELECT tags, enabled, brand_comment, default_prompt, auto_reply, daily_limit FROM radar_config WHERE id=1`);
      res.json(rows[0] ?? { tags: '', enabled: true });
    } catch { res.status(500).json({ tags: '', enabled: true }); }
  });

  // === 🛡 Дежурство на главном посту === конфиг + РОСТЕР дежурных = акки ДЕЖУРНОЙ ГРУППЫ (g.is_duty).
  // Состав дежурных настраивается карточкой группы (галка «дежурная»), НЕ здесь — один источник, без «двух окон».
  api.get('/radar/duty', async (_req, res) => {
    try {
      const [cfg, roster, groups] = await Promise.all([
        query<Record<string, any>>(`SELECT duty_url, duty_enabled, duty_per_visit FROM radar_config WHERE id=1`),
        // Тот же отбор, что у воркера (LEFT JOIN, исключаем reader/чужие площадки/паузу), чтобы ростер и «на смене»
        // в панели совпадали с тем, кого реально выберет дежурство. Блок у автора поста тут не проверяем (нужен code).
        query<Record<string, any>>(
          `SELECT coalesce(nullif(a.display_name,''), a.slug) AS label, a.slug, a.session_status, a.status
           FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
           WHERE (coalesce(g.watchdog,false)=true OR a.ig_role='duty')
             AND coalesce(a.ig_role,'')<>'reader' AND a.platform IN ('comments','instagram')
             AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL
           ORDER BY substring(a.slug from '\\d+')::int NULLS LAST, a.slug`),
        query<Record<string, any>>(`SELECT name FROM account_groups WHERE watchdog=true ORDER BY created_at`),
      ]);
      const onShift = roster.rows.find((a) => a.session_status !== 'dead' && a.status !== 'paused') || null; // первый живой не на паузе = на смене
      res.json({ ...(cfg.rows[0] || {}), roster: roster.rows, duty_groups: groups.rows.map((g) => g.name), on_shift: onShift ? onShift.label : null });
    } catch { res.status(500).json({ duty_enabled: false, roster: [] }); }
  });
  api.post('/radar/duty', async (req, res) => {
    try {
      const b = req.body || {};
      const url = String(b.url || '').trim().slice(0, 300);
      const enabled = b.enabled === true || b.enabled === 'true';
      const perVisit = Math.max(1, Math.min(10, Number(b.per_visit) || 5)); // часовой лимит ответов с одного дежурного акка
      if (enabled && !/instagram\.com\/(p|reel)\//.test(url)) return res.status(400).json({ ok: false, error: 'нужна ссылка на пост/рил IG' });
      await query(`UPDATE radar_config SET duty_url=$1, duty_enabled=$2, duty_per_visit=$3, updated_at=now() WHERE id=1`, [url || null, enabled, perVisit]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // Статус радара для панели: включён ли, жив ли искатель, сколько постов, последний скан/ошибка.
  // Живая строка статуса комментинга для панели: сколько акков комментят ПРЯМО СЕЙЧАС (commenting_at свежий) + ответов сегодня.
  api.get('/radar/live', async (_req, res) => {
    try {
      const day = `(now() at time zone 'Europe/Warsaw')::date`;
      const { rows } = await query<Record<string, any>>(`
        SELECT
          (SELECT count(*) FROM accounts WHERE platform='comments' AND commenting_at > now() - interval '3 min') AS active,
          (SELECT count(DISTINCT commenting_post) FROM accounts WHERE platform='comments' AND commenting_at > now() - interval '3 min' AND commenting_post IS NOT NULL) AS posts,
          (SELECT count(*) FROM post_answered WHERE ts::date = ${day}) AS valid,
          (SELECT count(*) FROM accounts WHERE gologin_profile_id IS NOT NULL AND deleted_at IS NULL) AS profiles,
          (SELECT coalesce(sum(brand),0) FROM account_run_stats WHERE ts::date = ${day}) AS brand`);
      const r = rows[0] || {};
      const valid = Number(r.valid) || 0, brand = Number(r.brand) || 0;
      // список кто комментит сейчас (для лайв-строки: акк → пост)
      const now = await query<Record<string, any>>(`SELECT slug, commenting_post FROM accounts WHERE platform='comments' AND commenting_at > now() - interval '3 min' ORDER BY commenting_at DESC LIMIT 12`).catch(() => ({ rows: [] }));
      const gpc = await gologinProfileCount().catch(() => 0); // реальное кол-во профилей yotbonly из API (кэш 3 мин)
      res.json({ active: Number(r.active) || 0, posts: Number(r.posts) || 0, valid, brand, today: valid + brand, profiles: gpc || Number(r.profiles) || 0, profiles_plan: Number(process.env.GOLOGIN_PROFILE_LIMIT) || 100, slots: slotUsage(), now: now.rows.map((x) => ({ slug: x.slug, post: x.commenting_post })) });
    } catch { res.json({ active: 0, posts: 0, today: 0 }); }
  });
  // Число профилей GoLogin (yotbonly) для плитки. ?fresh=1 (кнопка ↻ в панели) — форс-обновление мимо кэша.
  api.get('/radar/profiles', async (req, res) => {
    try {
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
      const count = await gologinProfileCount(fresh);
      res.json({ count, plan: Number(process.env.GOLOGIN_PROFILE_LIMIT) || 100 });
    } catch { res.json({ count: 0, plan: 100 }); }
  });
  api.get('/radar/status', async (_req, res) => {
    try {
      const [cfg, searcher, posts, err, accs] = await Promise.all([
        query<Record<string, any>>(`SELECT enabled, tags, auto_reply, daily_limit FROM radar_config WHERE id=1`),
        query<Record<string, any>>(`SELECT slug, session_status, session_checked_at, gologin_profile_id FROM accounts WHERE ig_role='reader' AND deleted_at IS NULL LIMIT 1`),
        query<Record<string, any>>(`SELECT count(*) FILTER (WHERE status='new') AS fresh, max(created_at) AS last_added FROM radar_posts`),
        query<Record<string, any>>(`SELECT message, detail, created_at FROM app_errors WHERE source='radar' ORDER BY created_at DESC LIMIT 1`),
        query<Record<string, any>>(`SELECT slug, session_status, (CASE WHEN comments_day=(now() at time zone 'Europe/Warsaw')::date THEN comments_today ELSE 0 END) AS today, last_commented_at
           FROM accounts WHERE platform IN ('comments','instagram') AND coalesce(ig_role,'')<>'reader' AND deleted_at IS NULL
           ORDER BY substring(slug from '\\d+')::int NULLS LAST, slug`),
      ]);
      const s = searcher.rows[0];
      const gl = gologinHealth();
      res.json({
        enabled: cfg.rows[0]?.enabled ?? false,
        auto_reply: cfg.rows[0]?.auto_reply ?? false,
        daily_limit: cfg.rows[0]?.daily_limit ?? 14,
        phrases: String(cfg.rows[0]?.tags || '').split(',').map((x) => x.trim()).filter(Boolean).length,
        searcher: s ? { slug: s.slug, session_status: s.session_status, checked_at: s.session_checked_at, has_profile: !!s.gologin_profile_id } : null,
        fresh: Number(posts.rows[0]?.fresh || 0),
        last_added: posts.rows[0]?.last_added || null,
        last_error: err.rows[0] ? { message: err.rows[0].message, detail: String(err.rows[0].detail || '').slice(0, 160), at: err.rows[0].created_at } : null,
        gologin: { down: gl.down, until: gl.downUntil, reason: gl.reason }, // предохранитель: GoLogin/прокси штормит?
        accounts: accs.rows.map((a) => ({ slug: a.slug, live: a.session_status === 'live', today: Number(a.today || 0), last: a.last_commented_at })),
        trends: TRENDS.map((t) => ({ name: t.name, phrases: t.phrases })), // рабочие тренды (зашиты в код, приоритет поиска)
      });
    } catch { res.status(500).json({ enabled: false, searcher: null, fresh: 0 }); }
  });
  api.post('/radar/config', async (req, res) => {
    try {
      const b = req.body || {};
      const tags = typeof b.tags === 'string' ? b.tags : '';
      const enabled = b.enabled !== false;
      // auto_reply/daily_limit УБРАНЫ отсюда 24.07: авто-раздача выпилена, daily_limit владеет /storozhi/config (sz_daily).
      // Иначе дефолт 14 из этого эндпоинта молча затирал бы значение сторожей (баг двух полей в одну колонку).
      await query(
        `INSERT INTO radar_config (id, tags, enabled, updated_at) VALUES (1,$1,$2,now())
         ON CONFLICT (id) DO UPDATE SET tags=$1, enabled=$2,
           brand_comment=coalesce(nullif($3,''), radar_config.brand_comment),
           default_prompt=coalesce(nullif($4,''), radar_config.default_prompt), updated_at=now()`,
        [tags, enabled, typeof b.brand_comment === 'string' ? b.brand_comment.trim() : null, typeof b.default_prompt === 'string' ? b.default_prompt.trim() : null],
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // === СТОРОЖИ: конфиг (тумблеры/крутилки) + здоровье + генератор прокси ===
  api.get('/storozhi/config', async (_req, res) => {
    try {
      const cfg = (await query<Record<string, any>>(`SELECT storozhi_enabled, brand_new_post, mobilize_spike, shadow_check, creator_poll_min, spike_mult, spike_workers, tier1_burn_fresh, daily_limit, commenter_enabled, comments_per_post, autoscan_enabled FROM radar_config WHERE id=1`)).rows[0] || {};
      const [prox, warm, unread, creators] = await Promise.all([
        query<Record<string, any>>(`SELECT count(*) n FROM proxy_pool WHERE country='FREE' AND coalesce(status,'')='anon'`),
        query<Record<string, any>>(`SELECT count(*) n FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live' AND coalesce(a.ig_status,'') NOT IN ('action_block','soft_block','captcha','challenge','bad_login','suspended','profile_lost') AND a.last_commented_at IS NOT NULL AND coalesce(a.comments_today,0) < coalesce((SELECT daily_limit FROM radar_config WHERE id=1),8)`),
        query<Record<string, any>>(`SELECT count(*) n, string_agg(username,', ') u FROM radar_creators WHERE cr_status='unreadable' AND enabled=true`),
        query<Record<string, any>>(`SELECT count(*) n FROM radar_creators WHERE enabled=true`),
      ]);
      res.json({ ...cfg, health: { proxies: Number(prox.rows[0]?.n || 0), warm_workers: Number(warm.rows[0]?.n || 0), unreadable: Number(unread.rows[0]?.n || 0), unreadable_who: unread.rows[0]?.u || '', creators: Number(creators.rows[0]?.n || 0) } });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.post('/storozhi/config', async (req, res) => {
    try {
      const b = req.body || {};
      const bo = (v: any, d: boolean) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
      await query(
        `UPDATE radar_config SET storozhi_enabled=$1, brand_new_post=$2, mobilize_spike=$3, shadow_check=$4,
           creator_poll_min=$5, spike_mult=$6, spike_workers=$7, tier1_burn_fresh=$8, daily_limit=$9,
           commenter_enabled=$10, comments_per_post=$11, autoscan_enabled=$12, updated_at=now() WHERE id=1`,
        [bo(b.storozhi_enabled, false), bo(b.brand_new_post, true), bo(b.mobilize_spike, true), bo(b.shadow_check, false),
         Math.max(15, Math.min(360, Number(b.creator_poll_min) || 60)), Math.max(1.5, Math.min(5, Number(b.spike_mult) || 2.5)),
         Math.max(2, Math.min(15, Number(b.spike_workers) || 6)), bo(b.tier1_burn_fresh, true), Math.max(1, Math.min(20, Number(b.daily_limit) || 8)),
         bo(b.commenter_enabled, false), Math.max(1, Math.min(10, Number(b.comments_per_post) || 2)), bo(b.autoscan_enabled, true)],
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Кнопка «🔄 Обновить прокси» — фоном фетчит+валидирует бесплатные, пишет в anon_proxies.txt + proxy_pool(FREE).
  api.post('/storozhi/proxies', async (_req, res) => {
    try {
      const { spawn } = await import('node:child_process');
      const p = spawn('node', ['genproxies.cjs', '40', '400'], { cwd: process.cwd(), env: { ...process.env, DB_PUBLIC_URL: process.env.DB_PUBLIC_URL || process.env.DATABASE_URL }, stdio: 'ignore', detached: true });
      p.unref();
      res.json({ ok: true, msg: 'генерация прокси запущена (фон, ~1-2 мин)' });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // === АНАЛИЗ поста (SCAN залогинен) → отчёт в панель: тир + сколько неотвеченного спроса. Владелец решает по цифрам. ===
  api.post('/radar/scan/:code', async (req, res) => {
    try {
      const code = String(req.params.code);
      // /p/ а НЕ /reel/: на /reel/ vcomment не открывает панель комментов («способом none» → ложный 0 спроса),
      // на /p/ открывается («already»). Один и тот же пост, разное поведение DOM. Диагностировано 24.07.
      const url = `https://www.instagram.com/p/${code}/`;
      // РОТАЦИЯ + ПЕРЕБОР читателей: берём НЕСКОЛЬКО случайных из наименее занятых здоровых. Флот наполовину битый
      // (акк «live/login_ok» в БД, а по факту на чек-поинте → панель не открывается → ложный 0). Поэтому пробуем по
      // очереди, пока у кого-то панель не откроется. Битого помечаем на релогин. Диагностировано 24.07.
      const readers = (await query<Record<string, any>>(`SELECT slug FROM (
          SELECT a.slug, coalesce(a.comments_today,0) ct FROM accounts a JOIN account_groups g ON g.id=a.group_id
          WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live' AND a.gologin_profile_id IS NOT NULL AND coalesce(a.ig_status,'')='login_ok'
          ORDER BY ct ASC LIMIT 10
        ) s ORDER BY random() LIMIT 3`)).rows.map((r) => r.slug);
      if (!readers.length) return res.json({ ok: false, error: 'нет живого читателя-акка' });
      const { spawn } = await import('node:child_process');
      // CTA_WORDS: слова-триггеры автора (бот/стиль/фон/…) — их комментаторы ТОЖЕ спрос. Иначе SCAN считал только «промпт».
      const prow = (await query<Record<string, any>>(`SELECT coalesce(nullif(work_cta,''),'бот,стиль,фон,взгляд,промпт,промт,гайд,скинь,хочу') w, manual_tier mt FROM radar_posts WHERE code=$1`, [code])).rows[0] || {};
      const cw = prow.w || 'бот,стиль,фон,взгляд,промпт,промт,гайд';
      const manualTier: string | null = /^tier[1-4]$/.test(String(prow.mt || '')) ? prow.mt : null;
      const scanOnce = (drv: string): Promise<string> => new Promise((resolve) => {
        const p = spawn('node', ['vcomment.cjs', drv, url, '5'], { cwd: process.cwd(), env: { ...process.env, SCAN: '1', MAXH: '168', CTA_WORDS: cw, SHOT_DIR: process.env.SHOT_DIR || '/tmp', DB_PUBLIC_URL: process.env.DB_PUBLIC_URL || process.env.DATABASE_URL } });
        let buf = ''; p.stdout.on('data', (d) => { buf += d; }); p.stderr.on('data', (d) => { buf += d; });
        const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(buf); }, 130000);
        p.on('close', () => { clearTimeout(t); resolve(buf); });
      });
      let out = '', usedDrv = readers[0], connected = false;
      for (const drv of readers) {
        usedDrv = drv;
        out = await scanOnce(drv);
        // connected = зашли и открыли панель (не «способом none», не шторм/краш). Только тогда результату можно верить.
        connected = /панель коммент(ов)? открыт/i.test(out) && !/способом:?\s*none|Failed to start|503|не подключил|ENOENT|undefined\//i.test(out);
        if (connected) break;
        // битый читатель (панель не открылась) → на релогин, пробуем следующего
        await query(`UPDATE accounts SET session_checked_at=NULL WHERE slug=$1 AND platform='comments' AND session_status='live'`, [drv]).catch(() => {});
      }
      const m = out.match(/SCAN_JSON (\{[^\n]*\})/);
      const j = m ? JSON.parse(m[1]) : { total: 0, unanswered: 0 };
      const restricted = /ОГРАНИЧЕНЫ|post_restricted/i.test(out);
      const found = Number(j.total) || 0, un = Number(j.unanswered) || 0;
      const volNums = (out.match(/(\d+)\s*комментов/g) || []).map((s) => parseInt(s, 10) || 0);
      const vol = Math.max(found, ...(volNums.length ? volNums : [0]));
      const autoTier = restricted ? 'restricted' : vol >= 100 ? 'tier1' : vol >= 30 ? 'tier2' : vol >= 5 ? 'tier3' : 'tier4';
      // НИ ОДИН читатель не смог открыть панель → это не «пустой пост», а битые акки/шторм. НЕ пишем ложный 0, честная ошибка.
      if (!connected) return res.json({ ok: false, error: `не удалось прочитать пост: перепробовал ${readers.length} читателей, все на чек-поинте/шторм. Пометил на релогин — попробуй через пару минут.` });
      await query(`UPDATE radar_posts SET scan_unanswered=$2, scan_total=$3, scan_tier=$4, scan_at=now() WHERE code=$1`, [code, un, vol, autoTier]);
      // РУЧНОЙ тир перебивает авто для выбора способа комментинга (модалка _rec берёт этот tier). Скан-объём/спрос — реальные.
      const tier = manualTier || autoTier;
      res.json({ ok: true, unanswered: un, total: vol, found, tier, autoTier, manual: !!manualTier, restricted, reader: usedDrv });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // === ЗАПУСК поста с выбранными параметрами (акки / комменты / бренд да-нет) ===
  api.post('/radar/launch/:code', async (req, res) => {
    try {
      const b = req.body || {};
      // ТРИГГЕР: владелец вставляет слово (напр. «бот»), LLM расширяет на похожие/варианты/синонимы спроса
      // (промт,скинь,хочу,дай,как…) — движок ловит regex'ом ВСЕ. 1 запрос ключом сайта, платит OpenRouter, не Claude.
      let cta = typeof b.cta === 'string' && b.cta.trim() ? b.cta.trim().slice(0, 120) : null;
      let expanded = cta;
      if (cta && process.env.OPENROUTER_API_KEY) {
        try {
          const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 90, temperature: 0.3, messages: [{ role: 'user', content: `В комментах под IG-постом люди пишут слово-триггер, чтобы автор скинул промпт/нейро-инструмент. Триггер владельца: "${cta}". Верни через запятую 6-12 ОДИНОЧНЫХ русских слов/коротких форм: сам триггер + его варианты и опечатки + слова-маркеры спроса (напр. промт, промпт, скинь, скиньте, хочу, дай, надо, как, туториал, гайд). Только слова через запятую, без фраз и пояснений.` }] }),
            signal: AbortSignal.timeout(15000),
          }).then((x) => x.json()).catch(() => null);
          const raw = r?.choices?.[0]?.message?.content || '';
          const words = raw.replace(/\n/g, ',').toLowerCase().replace(/[^а-яёa-z0-9,\s]/gi, ' ').split(',').map((s: string) => s.trim().split(/\s+/)[0]).filter((w: string) => w && w.length >= 2 && w.length <= 20);
          const set = Array.from(new Set([cta.toLowerCase(), ...words])).slice(0, 14);
          if (set.length > 1) expanded = set.join(',').slice(0, 240);
        } catch { /* LLM недоступен — оставляем исходное слово */ }
      }
      // work_target — ПЛАН по комментам (галочка+число в модалке): всего ответов людям на пост, движок стопнет по достижении.
      // 0/пусто = без лимита (крутим accounts×perpost как раньше). Кап 300 — предохранитель от опечатки.
      const plan = Math.max(0, Math.min(300, Number(b.plan) || 0));
      const dest = String(b.dest || 'site').toLowerCase() === 'bot' ? 'bot' : 'site'; // site=нейронка про, bot=@gener7_bot
      await query(`UPDATE radar_posts SET queued_at=now(), status='new', work_accounts=$2, work_perpost=$3, work_brand=$4, work_cta=$5, work_target=$6, work_dest=$7 WHERE code=$1`,
        [String(req.params.code), Math.max(1, Math.min(15, Number(b.accounts) || 3)), Math.max(1, Math.min(10, Number(b.perpost) || 2)), b.brand !== false && b.brand !== 'false', expanded, plan || null, dest]);
      res.json({ ok: true, cta: expanded, plan, dest });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // Самообучение: какие хэштеги чаще всего в найденных постах — подсказываем как новые фразы поиска.
  api.get('/radar/phrases/suggest', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(`SELECT caption FROM radar_posts WHERE caption IS NOT NULL ORDER BY created_at DESC LIMIT 250`);
      const { rows: cfg } = await query<Record<string, any>>(`SELECT tags FROM radar_config WHERE id=1`);
      const have = new Set(String(cfg[0]?.tags || '').toLowerCase().split(',').map((s: string) => s.trim().replace(/^#/, '')).filter(Boolean));
      const freq = new Map<string, number>();
      for (const r of rows) {
        const tags = String(r.caption || '').match(/#[\p{L}\p{N}_]{3,30}/gu) || [];
        for (const t of tags) { const k = t.slice(1).toLowerCase(); if (!have.has(k)) freq.set(k, (freq.get(k) || 0) + 1); }
      }
      const sug = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([phrase, count]) => ({ phrase, count }));
      res.json(sug);
    } catch { res.status(500).json([]); }
  });
  // Найденные посты: самые релевантные сверху, скрытые не показываем.
  api.get('/radar/posts', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT id, seq, code, tag, url, image_url, caption, like_count, comment_count, recent_comments, taken_at, last_comment_at, demand_hits, vision_summary, relevance, score, status, variants, source, rating, dm_bait, author_replies, queued_at, created_at,
           -- ИСТОРИЯ поста: скольким людям УЖЕ ответили (бронь) и сколько заданий было (успех/провал) —
           -- чтобы не комментить один пост дважды вслепую.
           (SELECT count(*) FROM radar_reply_targets t WHERE t.post_code=radar_posts.code) AS replied_count,
           (SELECT count(*) FROM radar_replies rr WHERE rr.post_code=radar_posts.code) AS tasks_total,
           (SELECT count(*) FROM radar_replies rr WHERE rr.post_code=radar_posts.code AND rr.status='posted') AS tasks_posted,
           (SELECT count(*) FROM radar_replies rr WHERE rr.post_code=radar_posts.code AND rr.status='failed') AS tasks_failed,
           (SELECT max(rr.posted_at) FROM radar_replies rr WHERE rr.post_code=radar_posts.code) AS last_reply_at,
           worked_count, work_instructions, rating_note,
           scan_tier, scan_unanswered, scan_total, scan_at, manual_tier,
           (SELECT left(rr.error,90) FROM radar_replies rr WHERE rr.post_code=radar_posts.code AND rr.error IS NOT NULL ORDER BY rr.posted_at DESC NULLS LAST, rr.id DESC LIMIT 1) AS last_error
         FROM radar_posts
         -- Ручные посты (добавленные вручную) НЕ прячем после ответа — остаются в списке (можно вернуться,
         -- откомментить ещё). Прячем их только если явно нажал «✕ Не то» (status='dismissed').
         WHERE status <> 'dismissed' AND (source='manual' OR status <> 'replied')
           -- прячем только ЯВНЫЙ бизнес-фаннел/спам (курсы/тг-ссылки), не «ссылка в шапке» (это все ИИ-посты)
           AND (source='manual' OR coalesce(caption,'') !~* 't\\.me/|https?://|мой курс|курс по|обучени|марафон|инфопрод|розыгрыш|giveaway')
         ORDER BY (coalesce(source,'')='manual') DESC, coalesce(queued_at, taken_at, created_at) DESC, score DESC LIMIT 80`,
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });

  // СТАТУС ДВИЖКА для панели: последние алерты (GoLogin 503/капчи/замены), когда последний коммент прошёл, сколько
  // в очереди. Владелец видит СТРОКОЙ на сайте, почему тихо (шторм/чек-поинт), и может действовать вручную.
  api.get('/radar/engine-status', async (_req, res) => {
    try {
      const [alerts, act, q] = await Promise.all([
        query<Record<string, any>>(`SELECT source, left(message,160) message, to_char(created_at,'HH24:MI') t FROM app_errors WHERE source LIKE 'alert%' ORDER BY created_at DESC LIMIT 6`),
        query<Record<string, any>>(`SELECT max(ts) last, count(*) FILTER (WHERE ts > now()-interval '60 min') h FROM account_post_done`),
        query<Record<string, any>>(`SELECT count(*) n FROM radar_posts WHERE queued_at IS NOT NULL`),
      ]);
      const last = act.rows[0]?.last || null;
      const mins = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
      // шторм GoLogin: если среди свежих алертов есть про 503/шторм за последние 15 мин
      const storm = alerts.rows.some((a) => /штормит|503|Failed to start/i.test(a.message || ''));
      res.json({ alerts: alerts.rows, lastCommentMin: mins, commentsLastHour: Number(act.rows[0]?.h || 0), queued: Number(q.rows[0]?.n || 0), storm });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Оценка поста 1-10 (обучение). Сохраняем на пост + опц. КОММЕНТ «почему» (сигнал для обучения бота).
  api.post('/radar/posts/:id/rate', async (req, res) => {
    try {
      const rating = Math.max(1, Math.min(10, Math.round(Number((req.body || {}).rating))));
      if (!isUuid(req.params.id) || !rating) { res.status(400).json({ error: 'плохой ввод' }); return; }
      const note = String((req.body || {}).note || '').trim().slice(0, 500) || null;
      await query(`UPDATE radar_posts SET rating=$2, rating_note=coalesce($3, rating_note) WHERE id=$1`, [req.params.id, rating, note]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // РУЧНОЙ ТИР: владелец ставит тир поста рукой (tier1-4) → он перебивает авто-скан (manual_tier). Способ комментинга
  // (сколько акков/ответов/весь ли спрос) движок и модалка выбирают по нему. tier=null → снять ручной, вернуться к авто.
  api.post('/radar/posts/:id/tier', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой ввод' }); return; }
      const raw = String((req.body || {}).tier || '').trim();
      const tier = /^tier[1-4]$/.test(raw) ? raw : null; // null = снять ручной тир
      await query(`UPDATE radar_posts SET manual_tier=$2 WHERE id=$1`, [req.params.id, tier]);
      res.json({ ok: true, tier });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // 🎯 «В работу с условием»: юзер пишет ЧТО сделать с постом и ПОЧЕМУ (директива движку) + ставим в пул.
  // Возвращаем code — фронт дублирует инструкцию в ТГ (чтобы была и там). Обучение: движок читает эти условия.
  api.post('/radar/posts/:id/work', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      const instr = String((req.body || {}).instructions || '').trim().slice(0, 800);
      if (!instr) { res.status(400).json({ ok: false, error: 'пустая инструкция' }); return; }
      const { rows } = await query<{ code: string; url: string }>(
        `UPDATE radar_posts SET work_instructions=$2, queued_at=now(), status='new' WHERE id=$1 RETURNING code, url`, [req.params.id, instr]);
      if (!rows[0]) { res.status(404).json({ ok: false }); return; }
      // Дублируем условие в ТГ (юзер просил — чтобы директива была и там).
      await notifyOwner(`🎯 В работу с условием:\n${instr}\n${rows[0].url}`, { force: true }).catch(() => {});
      res.json({ ok: true, code: rows[0].code, url: rows[0].url });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });

  // Качество фраз по оценкам: средний рейтинг постов на каждую фразу (обучение — что приносит толк).
  api.get('/radar/phrase-quality', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT tag, round(avg(rating)::numeric, 1)::float AS avg, count(*)::int AS n
         FROM radar_posts WHERE rating IS NOT NULL AND coalesce(tag,'') <> ''
         GROUP BY tag ORDER BY avg DESC, n DESC LIMIT 40`,
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  // === Креаторы: следим за их профилями, ловим НОВЫЙ пост, чтобы прокомментировать первым ===
  api.get('/radar/creators', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT id, username, url, enabled, checked_at, created_at, (last_codes IS NOT NULL) AS tracking
         FROM radar_creators ORDER BY created_at DESC`);
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  api.post('/radar/creators', async (req, res) => {
    try {
      const raw = String(req.body?.url || '').trim();
      const m = raw.match(/instagram\.com\/([A-Za-z0-9_.]+)/) || raw.match(/^@?([A-Za-z0-9_.]+)\/?$/);
      const username = m ? m[1].replace(/\/$/, '') : '';
      if (!username || ['p', 'reel', 'reels', 'explore', 'stories', 'accounts'].includes(username.toLowerCase())) {
        return res.status(400).json({ ok: false, error: 'нужен профиль (instagram.com/username или @username)' });
      }
      await query(
        `INSERT INTO radar_creators (username, url) VALUES ($1,$2)
         ON CONFLICT (username) DO UPDATE SET enabled=true, url=$2`,
        [username, `https://www.instagram.com/${username}/`]);
      res.json({ ok: true, username });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.delete('/radar/creators/:id', async (req, res) => {
    try { if (!isUuid(req.params.id)) return res.json({ ok: false }); await query(`DELETE FROM radar_creators WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
    catch { res.status(500).json({ ok: false }); }
  });

  // Добавить пост в радар руками (вставил ссылку на пост IG). Пытаемся подтянуть превью (og-теги).
  api.post('/radar/add', async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      const code = (url.match(/\/(?:p|reel)\/([^/?#]+)/) || [])[1];
      if (!code) return res.status(400).json({ ok: false, error: 'не похоже на ссылку поста IG (нужен /p/ или /reel/)' });
      const clean = `https://www.instagram.com/p/${code}/`;
      const metric = (raw: string): number => {
        const m = raw.match(/([\d.,]+)\s*([KMkmкмКМ])?/); if (!m) return 0;
        const s = (m[2] || '').toUpperCase(); const n = parseFloat(m[1].replace(/,/g, '.'));
        if (s === 'K' || s === 'К') return Math.round(n * 1e3); if (s === 'M' || s === 'М') return Math.round(n * 1e6);
        return parseInt(m[1].replace(/[.,\s]/g, ''), 10) || 0;
      };
      let caption = '', image = '', lc = 0, cc = 0;
      try {
        const r = await fetch(clean, { headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }, signal: AbortSignal.timeout(10_000) });
        if (r.ok) {
          const html = await r.text();
          const decode = (s: string) => s
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
            .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
            .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          const og = (p: string) => { const m = html.match(new RegExp(`<meta property="og:${p}" content="([^"]*)"`, 'i')); return m ? decode(m[1]) : ''; };
          const desc = og('description'); image = og('image');
          const lm = desc.match(/([\d.,]+\s*[KMkmкмКМ]?)\s*likes/i); lc = lm ? metric(lm[1]) : 0;
          const cm = desc.match(/([\d.,]+\s*[KMkmкмКМ]?)\s*comments/i); cc = cm ? metric(cm[1]) : 0;
          const pre = desc.match(/^[\d.,KMkmкмКМ\s]+likes[^:]*:\s*/i);
          caption = (pre ? desc.slice(pre[0].length) : desc).slice(0, 600);
        }
      } catch { /* превью не вышло — добавим голым */ }
      await query(
        `INSERT INTO radar_posts (code, url, tag, status, source, relevance, score, caption, image_url, like_count, comment_count)
         VALUES ($1,$2,'ручной','new','manual',80,80,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET status='new', source='manual',
           relevance=greatest(radar_posts.relevance,80), score=greatest(radar_posts.score,80),
           caption=coalesce(nullif(excluded.caption,''), radar_posts.caption),
           image_url=coalesce(nullif(excluded.image_url,''), radar_posts.image_url),
           like_count=greatest(radar_posts.like_count, excluded.like_count), comment_count=greatest(radar_posts.comment_count, excluded.comment_count)`,
        [code, clean, caption, image, lc, cc],
      );
      res.json({ ok: true, caption: caption.slice(0, 140) });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.post('/radar/posts/:id/dismiss', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      const reason = String((req.body || {}).reason || '').trim().slice(0, 400) || null; // почему «не то» (обучение)
      await query(`UPDATE radar_posts SET status='dismissed', dismiss_reason=$2 WHERE id=$1`, [req.params.id, reason]);
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });
  // 📜 История поста: кому/когда/каким акком отвечали + задания (успех/провал). Чтобы не дублировать.
  api.get('/radar/posts/:code/history', async (req, res) => {
    try {
      const code = String(req.params.code || '').trim();
      if (!code) { res.json({ targets: [], tasks: [] }); return; }
      const [targets, tasks] = await Promise.all([
        query<Record<string, any>>(
          `SELECT t.username, t.created_at, coalesce(nullif(a.display_name,''), a.slug) AS acc
           FROM radar_reply_targets t LEFT JOIN accounts a ON a.id=t.assigned_account_id
           WHERE t.post_code=$1 ORDER BY t.created_at DESC LIMIT 60`, [code]),
        query<Record<string, any>>(
          `SELECT r.roles, r.status, r.asker_count, r.posted_at, r.created_at, r.error,
                  coalesce(nullif(a.display_name,''), a.slug) AS acc
           FROM radar_replies r LEFT JOIN accounts a ON a.id=r.account_id
           WHERE r.post_code=$1 ORDER BY r.created_at DESC LIMIT 40`, [code]),
      ]);
      res.json({ targets: targets.rows, tasks: tasks.rows });
    } catch { res.status(500).json({ targets: [], tasks: [] }); }
  });

  // 🚀 В РАБОТУ / снять: toggle queued_at (пул постов на отработку комментингом). Ручное добавление вирала.
  api.post('/radar/posts/:id/queue', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      const on = (req.body || {}).on !== false; // по умолчанию ставим в работу; {on:false} — снять
      const { rows } = await query<{ queued_at: Date | null }>(
        `UPDATE radar_posts SET queued_at=${on ? 'now()' : 'NULL'} WHERE id=$1 RETURNING queued_at`, [req.params.id]);
      res.json({ ok: true, queued: !!rows[0]?.queued_at });
    } catch { res.status(500).json({ ok: false }); }
  });
  api.post('/radar/posts/:id/reviewed', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      await query(`UPDATE radar_posts SET status='reviewed' WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });

  // === Ответы из радара: с личного акка нейронки пишем коммент под найденным постом ===
  // Список акков, с которых можно отвечать (реальные акки с профилем GoLogin, НЕ искатель).
  api.get('/radar/reply/accounts', async (req, res) => {
    try {
      // code (опц.) — вернём флаг blocked: акк в блоке у автора ИМЕННО этого поста (не выбирать для ответа).
      const code = String(req.query.code || '').trim();
      const { rows } = await query<Record<string, any>>(
        `SELECT a.id, coalesce(nullif(a.ig_login,''), a.slug) AS label, a.slug, a.session_status,
           ${code ? `EXISTS(SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)` : `false`} AS blocked
         FROM accounts a
         WHERE a.platform IN ('comments','instagram') AND a.gologin_profile_id IS NOT NULL
           AND coalesce(a.ig_role,'') <> 'reader' AND a.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM account_groups gw WHERE gw.id=a.group_id AND gw.watchdog=true) -- дежурных в ручном пикере не показываем
         ORDER BY substring(a.slug from '\\d+')::int NULLS LAST, a.slug ASC`,
        code ? [code] : [],
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  // Живой дашборд комментинга: по каждому акку — статус, что комментит сейчас, счётчики.
  api.get('/radar/accounts/dashboard', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT a.id, coalesce(nullif(a.ig_login,''), a.slug) AS label, a.slug, a.session_status, a.ig_status,
           (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) AS today,
           a.last_commented_at, a.commenting_post,
           (a.commenting_at IS NOT NULL AND a.commenting_at > now()-interval '3 minutes') AS commenting_now,
           g.name AS grp
         FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.platform IN ('comments','instagram') AND a.gologin_profile_id IS NOT NULL
           AND coalesce(a.ig_role,'') <> 'reader' AND a.deleted_at IS NULL
         ORDER BY (a.commenting_at IS NOT NULL AND a.commenting_at > now()-interval '3 minutes') DESC,
                  a.last_commented_at DESC NULLS LAST, a.slug`);
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  // Черновики ответа (3-4 варианта) по подписи поста — юзер выбирает и правит.
  api.post('/radar/reply/draft', async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim();
      const force = Boolean(req.body?.force); // «↻ другие варианты» — генерим заново
      const { rows } = await query<Record<string, any>>(`SELECT caption, variants FROM radar_posts WHERE code=$1`, [code]);
      const stored = rows[0]?.variants;
      if (!force && Array.isArray(stored) && stored.length) return res.json({ variants: stored });
      const variants = await generateRadarReply(rows[0]?.caption || '', 4);
      await query(`UPDATE radar_posts SET variants=$2 WHERE code=$1`, [code, JSON.stringify(variants)]).catch(() => {});
      res.json({ variants });
    } catch (e) { res.status(500).json({ variants: [], error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Поставить ответ в очередь: воркер запостит его с выбранного акка (по одному за раз).
  api.post('/radar/reply', async (req, res) => {
    try {
      const b = req.body || {};
      const code = String(b.code || '').trim();
      const accountId = String(b.account_id || '').trim();
      const uuidOr = (v: unknown, notEq?: string) => { const s = String(v || '').trim(); return isUuid(s) && s !== notEq ? s : null; };
      const fallbackId = uuidOr(b.fallback_account_id, accountId); // запасной для роли «ответы людям»
      const brandAccountId = uuidOr(b.brand_account_id);           // 2-й акк: бренд+промпт (опц.)
      const brandFallbackId = uuidOr(b.brand_fallback_id, brandAccountId || undefined);
      // Тексты НЕ обязательны: бот генерит ответ под каждый коммент при отправке. Если юзер прислал —
      // используем как фолбэк/оверрайд.
      const texts = (Array.isArray(b.texts) ? b.texts : b.text ? [b.text] : [])
        .map((t: unknown) => String(t || '').trim()).filter((t: string) => t.length >= 3).slice(0, 12);
      const text = texts[0] || '';
      const askerCount = Math.max(0, Math.min(10, Number(b.asker_count ?? 3) || 0)); // 0-10 ответов людям
      const noPrompt = b.no_prompt === true || b.no_prompt === 'true'; // юзер выбрал «без промпта»
      // === ФАН-АУТ (мульти-выбор в композере): массивы акков для ролей ===
      // asker_account_ids: общее число ответов раскидывается между ними (round-robin, по строке-заданию на акк);
      // brand_account_ids: КАЖДЫЙ выбранный акк ставит 1 бренд-коммент (+промпт веткой, если не no_prompt).
      const idArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(isUuid) : []);
      const askerIds = [...new Set(idArr(b.asker_account_ids))].slice(0, 10);
      const brandIds = [...new Set(idArr(b.brand_account_ids))].slice(0, 10);
      const fanOut = askerIds.length > 0 || brandIds.length > 0;
      if (!code || (!fanOut && !isUuid(accountId))) return res.status(400).json({ ok: false, error: 'нужен пост и аккаунт' });
      const { rows: pr } = await query<Record<string, any>>(`SELECT url FROM radar_posts WHERE code=$1`, [code]);
      const url = pr[0]?.url;
      if (!url) return res.status(400).json({ ok: false, error: 'пост не найден' });
      if (fanOut) {
        if (askerIds.length && askerCount < 1) return res.status(400).json({ ok: false, error: 'выбери, скольким людям ответить' });
        const ids: string[] = [];
        // Доли ответов по акками: 5 ответов на [A,B,C] → A:2, B:2, C:1. Акку с долей 0 задание не создаём.
        for (let i = 0; i < askerIds.length; i++) {
          const share = Math.floor(askerCount / askerIds.length) + (i < askerCount % askerIds.length ? 1 : 0);
          if (share < 1) continue;
          const { rows: rr } = await query<{ id: string }>(
            `INSERT INTO radar_replies (post_code, post_url, account_id, text, asker_count, roles, no_prompt)
             VALUES ($1,$2,$3,'',$4,'askers',$5) RETURNING id`, [code, url, askerIds[i], share, noPrompt]);
          if (rr[0]) ids.push(rr[0].id);
        }
        for (const bid of brandIds) {
          const { rows: rr } = await query<{ id: string }>(
            `INSERT INTO radar_replies (post_code, post_url, account_id, text, asker_count, roles, no_prompt)
             VALUES ($1,$2,$3,'',0,'brand',$4) RETURNING id`, [code, url, bid, noPrompt]);
          if (rr[0]) ids.push(rr[0].id);
        }
        if (!ids.length) return res.status(400).json({ ok: false, error: 'ни одного задания не создано (проверь выбор акков/кол-во)' });
        return res.json({ ok: true, id: ids[0], ids, count: ids.length });
      }
      const { rows } = await query<Record<string, any>>(
        `INSERT INTO radar_replies (post_code, post_url, account_id, text, asker_count, fallback_account_id, texts, brand_account_id, brand_fallback_id, no_prompt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [code, url, accountId, text.slice(0, 500), askerCount, fallbackId, JSON.stringify(texts.map((t: string) => t.slice(0, 500))), brandAccountId, brandFallbackId, noPrompt],
      );
      // Пост НЕ трогаем (остаётся в списке) — юзер просил, чтобы не пропадал после ответа.
      res.json({ ok: true, id: rows[0]?.id });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // История ответов из радара: с какого акка, под каким постом, что вышло, когда.
  // ЖИВОЙ ЛОГ ДВИЖКА (переписано 24.07): старая история читала radar_replies (мёртвый хэштег-путь, стухло 21.07).
  // Новый комментинг пишет в account_run_stats (акк отработал: N ответов + бренд + причина остановки/ошибка) —
  // ЭТО и есть логи, что владелец просил рядом с историей. Плюс алерты движка (шторм GoLogin/замены/капчи).
  api.get('/radar/history', async (_req, res) => {
    try {
      const [runs, alerts] = await Promise.all([
        query<Record<string, any>>(`SELECT slug, coalesce(comments,0) comments, coalesce(brand,0) brand, coalesce(posts_tried,0) posts_tried, retire_reason, coalesce(elapsed,0) elapsed, ts FROM account_run_stats ORDER BY ts DESC LIMIT 50`),
        query<Record<string, any>>(`SELECT left(message,150) message, created_at FROM app_errors WHERE source LIKE 'alert%' AND message ~* 'штормит|503|замен|бан|капч|перелогин|Failed to start' ORDER BY created_at DESC LIMIT 15`),
      ]);
      const rows = [
        ...runs.rows.map((r) => {
          const posted = Number(r.comments) + Number(r.brand) > 0;
          return {
            account: r.slug, seq: null, text: '', created_at: r.ts, posted_at: r.ts,
            status: posted ? 'posted' : 'failed',
            result: `${r.comments} ответ${r.brand ? ' + ' + r.brand + ' бренд' : ''} · постов ${r.posts_tried} · ${r.elapsed}с`,
            error: r.retire_reason ? `${r.retire_reason} (постов ${r.posts_tried}, ${r.elapsed}с)` : `0 комментов · ${r.retire_reason || 'причина не записана'}`,
          };
        }),
        ...alerts.rows.map((a) => ({ account: '⚙️ движок', seq: null, text: '', created_at: a.created_at, posted_at: a.created_at, status: 'failed', result: '', error: a.message })),
      ].sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime()).slice(0, 60);
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  // Статус ответов по посту (для показа «в очереди / отправлено / ошибка» в карточке).
  api.get('/radar/reply/status', async (req, res) => {
    try {
      const code = String(req.query?.code || '').trim();
      const { rows } = await query<Record<string, any>>(
        `SELECT r.id, r.status, r.text, r.error, r.created_at, r.posted_at, coalesce(nullif(a.ig_login,''), a.slug) AS account
         FROM radar_replies r JOIN accounts a ON a.id=r.account_id
         WHERE r.post_code=$1 AND a.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 10`,
        [code],
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });

  // === Аккаунт-искатель для радара (ig_role='reader') — читает хэштеги, НЕ комментит ===
  // Пароль наружу НЕ отдаём (только флаг has_password).
  api.get('/radar/account', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT id, slug, ig_login, gologin_profile_id, session_status, ig_status
         FROM accounts WHERE ig_role='reader' ORDER BY created_at ASC LIMIT 1`,
      );
      res.json(rows[0] ?? null);
    } catch { res.status(500).json(null); }
  });
  // Искатель через GoLogin: вход руками в GoLogin, сюда только ID профиля.
  api.post('/radar/account', async (req, res) => {
    try {
      const b = req.body || {};
      const login = String(b.login || '').trim();
      const profile = String(b.gologin_profile_id || '').trim();
      const slug = login || 'поисковик';
      // Ровно один искатель: снимаем роль со всех прочих.
      await query(`UPDATE accounts SET ig_role=NULL WHERE ig_role='reader' AND slug<>$1`, [slug]);
      await query(
        `INSERT INTO accounts (platform, slug, status, account_type, ig_role, ig_login, gologin_profile_id, tracking_code)
         VALUES ('comments',$1,'active','bought','reader',$2,$3,$4)
         ON CONFLICT (platform, slug) DO UPDATE SET
           ig_role='reader', ig_login=$2, gologin_profile_id=$3, deleted_at=NULL, status='active'`,
        [slug, login || null, profile || null, 'radar' + Math.floor(Math.random() * 900 + 100)],
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.delete('/radar/account', async (_req, res) => {
    try { await query(`DELETE FROM accounts WHERE ig_role='reader'`); res.json({ ok: true }); }
    catch { res.status(500).json({ ok: false }); }
  });
  // Код с почты/смс для входа искателя — воркер его ждёт и до-логинивается.
  api.post('/radar/account/code', async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim();
      if (!code) { res.json({ ok: false }); return; }
      await query(`UPDATE accounts SET ig_challenge_code=$1 WHERE ig_role='reader'`, [code]);
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });
  // Назначить существующий (рабочий) акк искателем радара — переиспользуем его куки+прокси.
  api.post('/accounts/:id/make-reader', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      await query(`UPDATE accounts SET ig_role=NULL WHERE ig_role='reader'`); // один искатель
      await query(`UPDATE accounts SET ig_role='reader', ig_session=NULL, ig_status=NULL WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });

  // Лог ошибок (что и где упало) — для показа на сайте.
  api.get('/errors', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT id, source, message, detail, created_at FROM app_errors ORDER BY created_at DESC LIMIT 50`,
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });
  api.post('/errors/clear', async (_req, res) => {
    try { await query(`DELETE FROM app_errors`); res.json({ ok: true }); }
    catch { res.status(500).json({ ok: false }); }
  });

  // Пульс Python-воркера комментинг-фермы (жив ли, что делает).
  api.get('/worker/status', async (_req, res) => {
    try {
      const { rows } = await query<Record<string, any>>(
        `SELECT worker, status, note, extract(epoch from (now()-last_seen))::int AS ago_sec FROM worker_heartbeat WHERE worker='ig_comment'`,
      );
      res.json(rows[0] ?? null);
    } catch { res.status(500).json(null); }
  });

  // Лог промо-комментов аккаунта (ферма комментов): что, где, виден ли.
  api.get('/accounts/:id/seed-log', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json([]); return; }
      const { rows } = await query<Record<string, any>>(
        `SELECT text, target_url, visible, created_at FROM seed_comments WHERE account_id=$1 ORDER BY created_at DESC LIMIT 40`,
        [req.params.id],
      );
      res.json(rows);
    } catch { res.status(500).json([]); }
  });

  // История прогрева одного аккаунта: последние действия бота + сводка за 7 дней.
  api.get('/accounts/:id/warmup-log', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isUuid(id)) { res.json({ log: [], summary: {} }); return; }
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
      const { rows } = await query<Record<string, any>>(
        `SELECT action, meta, created_at FROM warmup_log
         WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [id, limit],
      );
      const { rows: agg } = await query<Record<string, any>>(
        `SELECT action, count(*)::int AS n FROM warmup_log
         WHERE account_id=$1 AND created_at > now()-interval '7 days'
         GROUP BY action`,
        [id],
      );
      const summary: Record<string, number> = {};
      for (const r of agg) summary[r.action] = r.n;
      res.json({ log: rows, summary });
    } catch {
      res.status(500).json({ log: [], summary: {} });
    }
  });

  // Создать/обновить аккаунт (включая cohort и warmup_comments для A/B).
  api.post('/accounts', async (req, res) => {
    const b = req.body || {};
    // Авто /go-тег: короткий код (3 буквы + 3 цифры, напр. "xkq472"). Задан вручную — берём его.
    const shortCode = () => {
      const L = 'abcdefghijkmnpqrstuvwxyz'; // без похожих l/o
      let s = ''; for (let i = 0; i < 3; i++) s += L[Math.floor(Math.random() * L.length)];
      return s + Math.floor(Math.random() * 900 + 100);
    };
    const track = (b.tracking_code && String(b.tracking_code).trim()) || shortCode();
    const { rows } = await query(
      `INSERT INTO accounts (platform, slug, display_name, handle, persona, system_prompt, gender, tone,
         gologin_profile_id, proxy, status, posts_per_day, cohort, warmup_comments, tracking_code, warmup_started_at, account_type, group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,'warming'),coalesce($12,1),$13,coalesce($14,false),$15,coalesce($16, now()),coalesce($17,'new'),
         (SELECT id FROM account_groups WHERE id=$18 AND platform=$1))
       ON CONFLICT (platform, slug) DO UPDATE SET
         display_name=excluded.display_name, handle=excluded.handle, persona=excluded.persona,
         system_prompt=excluded.system_prompt, gender=excluded.gender, tone=excluded.tone,
         gologin_profile_id=excluded.gologin_profile_id, proxy=excluded.proxy, status=excluded.status,
         posts_per_day=excluded.posts_per_day, cohort=excluded.cohort, warmup_comments=excluded.warmup_comments,
         tracking_code=excluded.tracking_code, account_type=excluded.account_type, group_id=excluded.group_id
       RETURNING *`,
      [b.platform, b.slug, b.display_name, b.handle, b.persona, b.system_prompt, b.gender, b.tone,
       b.gologin_profile_id, b.proxy ? JSON.stringify(b.proxy) : null, b.status, b.posts_per_day,
       b.cohort ?? null, b.warmup_comments, track, b.warmup_started_at ?? null, b.account_type ?? null,
       (b.group_id && isUuid(String(b.group_id))) ? b.group_id : null],
    );
    const acc = rows[0] as Record<string, any>;
    res.json(stripAccountSecrets(acc));
    // Автогенерация профиля для нового TikTok-акка (аватар+ник+описание), в фоне, один раз.
    if (acc && acc.platform === 'tiktok' && !acc.tt_avatar_url && !acc.tt_nick) {
      (async () => {
        try {
          const [avatar, prof] = await Promise.all([generateAvatar(), generateTikTokProfile()]);
          await query(
            `UPDATE accounts SET tt_nick=$2, tt_name=$3, tt_avatar_url=coalesce($4,tt_avatar_url), tt_bio=$5 WHERE id=$1`,
            [acc.id, prof.handle || null, prof.name || null, avatar || null, prof.bio || null],
          );
        } catch { /* фон — не критично */ }
      })();
    }
  });

  // Создание группы "Постеры" для Instagram-бренда: создает группу + переносит указанные акки.
  api.post('/groups/create-posters', async (req, res) => {
    try {
      const b = req.body || {};
      const accountIds = (Array.isArray(b.accountIds) ? b.accountIds : []).filter((x: any) => typeof x === 'string' && isUuid(String(x)));
      if (!accountIds.length) { res.status(400).json({ error: 'не указаны аккаунты' }); return; }
      // Создаем группу platform='instagram', role='brand'
      const { rows: gr } = await query(
        `INSERT INTO account_groups (name, platform, role) VALUES ('Постеры','instagram','brand') RETURNING *`,
      );
      const gid = gr[0]?.id;
      if (!gid) { res.status(500).json({ error: 'не создалась группа' }); return; }
      const ids = accountIds.map((x: string) => x);
      await query(`UPDATE accounts SET group_id=$1 WHERE id = ANY($2)`, [gid, ids]);
      res.json({ ok: true, group: { id: gid, name: 'Постеры', platform: 'instagram', role: 'brand' }, moved: ids.length });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' });
    }
  });

  // === Группы аккаунтов (рабочий стол) ===
  api.get('/groups', async (req, res) => {
    try {
      const platform = req.query.platform as string | undefined;
      const { rows } = await query<Record<string, any>>(
        `SELECT g.*, (g.gologin_token IS NOT NULL) AS has_token,
           (SELECT count(*) FROM accounts a WHERE a.group_id=g.id ${platform ? 'AND a.platform=$1' : ''}) AS accounts,
           (SELECT count(*) FROM accounts a WHERE a.group_id=g.id AND a.session_status='live' ${platform ? 'AND a.platform=$1' : ''}) AS alive,
           (SELECT count(*) FROM accounts a WHERE a.group_id=g.id AND a.status='warming' ${platform ? 'AND a.platform=$1' : ''}) AS warming
         FROM account_groups g
         ${platform ? 'WHERE g.platform=$1' : ''}
         ORDER BY g.created_at`,
        platform ? [platform] : [],
      );
      // gologin_token наружу не отдаём — только флаг has_token (посчитан выше).
      res.json(rows.map(({ gologin_token, ...g }: any) => g));
    } catch { res.status(500).json([]); }
  });
  api.post('/groups', async (req, res) => {
    const stripTok = (g: any) => g ? (({ gologin_token, ...rest }) => ({ ...rest, has_token: !!gologin_token }))(g) : g;
    try {
      const b = req.body || {};
      if (b.id && isUuid(String(b.id))) {
        const { rows } = await query(
          `UPDATE account_groups SET name=coalesce($2,name), geo=$3, note=$4, launched_at=$5, warmup_started_at=$6, warmup_comments=coalesce($7,warmup_comments), seed_enabled=coalesce($8,false), seed_hashtags=$9, seed_per_day=coalesce($10,3), platform=coalesce($11,platform), gologin_token=coalesce(nullif($12,''), gologin_token), watchdog=coalesce($13,watchdog), role=coalesce($14,role) WHERE id=$1 RETURNING *`,
          [b.id, b.name, b.geo ?? null, b.note ?? null, b.launched_at ?? null, b.warmup_started_at ?? null, b.warmup_comments ?? null, b.seed_enabled ?? false, b.seed_hashtags ?? null, Math.max(1, Number(b.seed_per_day) || 3), b.platform ?? null, b.gologin_token ?? null, typeof b.watchdog === 'boolean' ? b.watchdog : null, b.role ?? null],
        );
        res.json(stripTok(rows[0]) ?? null);
      } else {
        const { rows } = await query(
          `INSERT INTO account_groups (name, geo, note, launched_at, warmup_started_at, warmup_comments, seed_enabled, seed_hashtags, seed_per_day, platform, gologin_token, watchdog, role) VALUES ($1,$2,$3,$4,$5,coalesce($6,false),coalesce($7,false),$8,coalesce($9,3),coalesce($10,'tiktok'),nullif($11,''),coalesce($12,false),coalesce($13,'worker')) RETURNING *`,
          [String(b.name || 'Новая группа'), b.geo ?? null, b.note ?? null, b.launched_at ?? null, b.warmup_started_at ?? null, b.warmup_comments ?? false, b.seed_enabled ?? false, b.seed_hashtags ?? null, Math.max(1, Number(b.seed_per_day) || 3), b.platform ?? null, b.gologin_token ?? null, b.watchdog ?? false, b.role ?? 'worker'],
        );
        res.json(stripTok(rows[0]));
      }
    } catch { res.status(500).json(null); }
  });
  api.delete('/groups/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.json({ ok: false }); return; }
      await query(`DELETE FROM account_groups WHERE id=$1`, [req.params.id]); // акки не удаляются (group_id -> NULL)
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });

  // Очередь постов.
  api.get('/posts', async (req, res) => {
    const { rows } = await query(
      `SELECT * FROM posts ${req.query.platform ? 'WHERE platform=$1' : ''} ORDER BY coalesce(scheduled_at, created_at) DESC LIMIT 200`,
      req.query.platform ? [req.query.platform as string] : [],
    );
    res.json(rows);
  });

  // Поставить пост в очередь (сразу approved или draft на модерацию).
  api.post('/posts', async (req, res) => {
    const b = req.body || {};
    const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : nextSlot(new Date());
    const { rows } = await query(
      `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, scheduled_at)
       VALUES ($1,$2,$3,coalesce($4,'draft'),$5,$6,$7,$8,$9) RETURNING *`,
      [b.account_id, b.platform, b.kind, b.status, b.caption, b.media_url, b.media_type, b.reply_text, scheduledAt],
    );
    res.json(rows[0]);
  });

  // Апрув поста (draft -> approved).
  api.post('/posts/:id/approve', async (req, res) => {
    const { rows } = await query(`UPDATE posts SET status='approved' WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]);
    res.json(rows[0] ?? null);
  });

  // Отклонить черновик (draft -> skipped): в публикацию не пойдёт, но останется в истории.
  api.post('/posts/:id/reject', async (req, res) => {
    const { rows } = await query(`UPDATE posts SET status='skipped' WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]);
    res.json(rows[0] ?? null);
  });

  // Правка черновика перед одобрением (текст/медиа/время). Только пока draft.
  api.patch('/posts/:id', async (req, res) => {
    const b = req.body || {};
    const sched = b.scheduled_at ? new Date(b.scheduled_at) : null;
    const { rows } = await query(
      `UPDATE posts SET
         caption      = coalesce($2, caption),
         media_url    = coalesce($3, media_url),
         media_type   = coalesce($4, media_type),
         scheduled_at = coalesce($5, scheduled_at)
       WHERE id=$1 AND status='draft' RETURNING *`,
      [req.params.id, b.caption ?? null, b.media_url ?? null, b.media_type ?? null, sched],
    );
    res.json(rows[0] ?? null);
  });

  // Одобрить пачкой все черновики площадки (draft -> approved).
  api.post('/posts/approve-all', async (req, res) => {
    const platform = String(req.body?.platform || '');
    const { rowCount } = await query(
      `UPDATE posts SET status='approved' WHERE status='draft'${platform ? ' AND platform=$1' : ''}`,
      platform ? [platform] : [],
    );
    res.json({ approved: rowCount ?? 0 });
  });

  // Настроен ли Телеграм-алерт (заданы ли TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
  api.get('/alerts/status', (_req, res) => {
    res.json({ configured: telegramConfigured() });
  });

  // Тестовое оповещение — проверить, что бот пишет тебе в Телеграм.
  api.post('/alerts/test', async (_req, res) => {
    if (!telegramConfigured()) {
      res.json({ ok: false, configured: false });
      return;
    }
    await notifyOwner('Проверка связи ✓ Алерты настроены — сюда придут капчи, мёртвые сессии и сбои прокси.', { force: true });
    res.json({ ok: true, configured: true });
  });

  // Загрузка видео с компа + постановка в очередь на выбранные аккаунты.
  // Оригинал сохраняем один раз, на каждый акк создаём черновик со своим сидом —
  // уникализация применяется при публикации (1 видео → N разных файлов).
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
  // Оборачиваем multer, чтобы его ошибки (слишком большой файл и т.п.) уходили JSON'ом,
  // а не дефолтным HTML-500 (фронт ждёт JSON).
  const uploadVideo = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    upload.single('video')(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string })?.code;
        res.status(413).json({ error: code === 'LIMIT_FILE_SIZE' ? 'видео больше 100 МБ — сожми или обрежь' : 'ошибка загрузки файла' });
        return;
      }
      next();
    });
  };
  // ── УНИКАЛИЗАТОР ДЛЯ ВЛАДЕЛЬЦА (01.08) ──────────────────────────────────────────────────────
  // Самостоятельный инструмент: залил ролик → получил N РАЗНЫХ файлов → скачал себе (для сторонних
  // аккаунтов, которых нет в постере). Считаем ЗДЕСЬ (ffmpeg в nixpacks), строго ПО ОДНОМУ за раз:
  // это тот же контейнер, что публикует, и параллельные транскоды отняли бы у него CPU.
  let uniqBusy = false;
  async function runUniqJob(jobId: string) {
    if (uniqBusy) return;                       // очередь строго последовательная
    uniqBusy = true;
    try {
      const j = (await query<Record<string, any>>(`SELECT * FROM uniq_jobs WHERE id=$1`, [jobId])).rows[0];
      if (!j || j.status !== 'queued') return;
      await query(`UPDATE uniq_jobs SET status='running', updated_at=now() WHERE id=$1`, [jobId]);
      const src: Buffer = j.src_bytes;
      const { uniquifyVideo } = await import('./uniquify.js');
      for (let i = 1; i <= j.variants; i++) {
        // Сид солим id задачи: иначе повторный прогон того же файла отдал бы побайтово те же копии.
        const seed = Math.abs([...`${jobId}#${i}`].reduce((a, ch) => Math.imul(a ^ ch.charCodeAt(0), 16777619), 2166136261)) >>> 0;
        const r = await uniquifyVideo(src, seed, j.level === 'max' ? 'max' : 'medium');
        const name = String(j.filename || 'video').replace(/\.[^.]+$/, '') + `_v${i}.mp4`;
        await query(
          `INSERT INTO uniq_files (job_id, idx, filename, bytes, size_bytes, params) VALUES ($1,$2,$3,$4,$5,$6)`,
          [jobId, i, name, r.buffer, r.buffer.length, JSON.stringify(r.params)]);
        await query(`UPDATE uniq_jobs SET done_n=$2, updated_at=now() WHERE id=$1`, [jobId, i]);
      }
      // оригинал больше не нужен — освобождаем место в БД
      await query(`UPDATE uniq_jobs SET status='done', src_bytes=NULL, updated_at=now() WHERE id=$1`, [jobId]);
    } catch (e) {
      await query(`UPDATE uniq_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
        [jobId, e instanceof Error ? e.message.slice(0, 300) : 'ошибка']).catch(() => {});
    } finally {
      uniqBusy = false;
      // следующая задача в очереди, если есть
      const nxt = await query<Record<string, any>>(`SELECT id FROM uniq_jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      if (nxt.rows[0]) void runUniqJob(nxt.rows[0].id);
    }
  }
  api.post('/uniq/jobs', uploadVideo, async (req, res) => {
    try {
      const f = (req as express.Request & { file?: Express.Multer.File }).file;
      if (!f) { res.status(400).json({ error: 'нет файла' }); return; }
      const variants = Math.max(1, Math.min(10, Number((req.body || {}).variants) || 5));
      const level = String((req.body || {}).level || 'medium') === 'max' ? 'max' : 'medium';
      const { ffmpegAvailable } = await import('./uniquify.js');
      if (!(await ffmpegAvailable())) { res.status(503).json({ error: 'ffmpeg недоступен на сервере' }); return; }
      const ins = await query<Record<string, any>>(
        `INSERT INTO uniq_jobs (filename, level, variants, src_bytes, src_size) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [f.originalname || 'video.mp4', level, variants, f.buffer, f.buffer.length]);
      const id = ins.rows[0].id;
      void runUniqJob(id);                        // не ждём: панель опрашивает статус
      res.json({ ok: true, id, variants, level });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.get('/uniq/jobs', async (_req, res) => {
    try {
      const r = await query<Record<string, any>>(
        `SELECT j.id, j.filename, j.level, j.variants, j.status, j.done_n, j.src_size, left(coalesce(j.error,''),160) error,
                to_char(j.created_at,'MM-DD HH24:MI') t
           FROM uniq_jobs j ORDER BY j.created_at DESC LIMIT 10`);
      res.json({ jobs: r.rows });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  api.get('/uniq/jobs/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ error: 'плохой id' }); return; }
      const j = (await query<Record<string, any>>(
        `SELECT id, filename, level, variants, status, done_n, src_size, left(coalesce(error,''),200) error
           FROM uniq_jobs WHERE id=$1`, [req.params.id])).rows[0];
      if (!j) { res.status(404).json({ error: 'задача не найдена' }); return; }
      const f = await query<Record<string, any>>(
        `SELECT idx, filename, size_bytes, params FROM uniq_files WHERE job_id=$1 ORDER BY idx`, [req.params.id]);
      res.json({ ...j, files: f.rows });
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка' }); }
  });
  // Скачивание одного варианта. Кука сессии уходит сама (same-origin), поэтому обычная <a download>.
  api.get('/uniq/jobs/:id/files/:idx', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).end(); return; }
      const r = await query<Record<string, any>>(
        `SELECT filename, bytes FROM uniq_files WHERE job_id=$1 AND idx=$2`, [req.params.id, Number(req.params.idx)]);
      const row = r.rows[0];
      if (!row) { res.status(404).end(); return; }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${String(row.filename || 'video.mp4').replace(/[^\w.\-]/g, '_')}"`);
      res.end(row.bytes);
    } catch { res.status(500).end(); }
  });
  api.delete('/uniq/jobs/:id', async (req, res) => {
    try {
      if (!isUuid(req.params.id)) { res.status(400).json({ ok: false }); return; }
      await query(`DELETE FROM uniq_jobs WHERE id=$1`, [req.params.id]);   // файлы уйдут каскадом
      res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
  });

  api.post('/uniquify', uploadVideo, async (req, res) => {
    try {
      const f = req.file;
      if (!f || !f.buffer?.length) { res.status(400).json({ error: 'нет файла видео' }); return; }
      let accountIds: string[] = [];
      try { accountIds = JSON.parse(String(req.body.accountIds || '[]')); } catch { /* ignore */ }
      accountIds = (Array.isArray(accountIds) ? accountIds : []).filter((x) => typeof x === 'string' && isUuid(x));
      if (!accountIds.length) { res.status(400).json({ error: 'не выбраны аккаунты' }); return; }
      const level = ['none', 'medium', 'max'].includes(req.body.level) ? req.body.level : 'medium';
      const caption = String(req.body.caption || '');

      const { rows: up } = await query<{ id: string }>(
        `INSERT INTO media_uploads (filename, mime, bytes, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
        [f.originalname || 'video.mp4', f.mimetype || 'video/mp4', f.buffer, f.size],
      );
      const uploadId = up[0].id;

      let created = 0;
      for (const accId of accountIds) {
        const { rows: acc } = await query<{ platform: string }>(`SELECT platform FROM accounts WHERE id=$1`, [accId]);
        if (!acc[0]) continue;
        const seed = Math.floor(Math.random() * 2_000_000_000);
        await query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_type, media_upload_id, uniquify_level, uniquify_seed, scheduled_at)
           VALUES ($1,$2,'video','draft',$3,'VIDEO',$4,$5,$6,$7)`,
          [accId, acc[0].platform, caption, uploadId, level, seed, nextSlot(new Date())],
        );
        created++;
      }
      res.json({ ok: true, created, level });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка загрузки' });
    }
  });

  // Пакетный постинг с РОТАЦИЕЙ: грузим V видео на A аккаунтов. В каждом раунде
  // у всех акков РАЗНОЕ видео (сдвиг на 1), поэтому одинаковые ролики не уходят
  // одним заходом. Раунд r, акк i → видео ((V-1-i-r) mod V). Файлы на диск (не в RAM)
  // — читаем по одному, кладём в БД, удаляем temp.
  const batchUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024, files: 12 } });
  const uploadVideos = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    batchUpload.array('videos', 12)(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string })?.code;
        res.status(413).json({ error: code === 'LIMIT_FILE_SIZE' ? 'одно из видео больше 100 МБ' : 'ошибка загрузки файлов' });
        return;
      }
      next();
    });
  };
  api.post('/uniquify-batch', uploadVideos, async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    try {
      if (!files.length) { res.status(400).json({ error: 'нет видео' }); return; }
      let accountIds: string[] = [];
      try { accountIds = JSON.parse(String(req.body.accountIds || '[]')); } catch { /* ignore */ }
      accountIds = (Array.isArray(accountIds) ? accountIds : []).filter((x) => typeof x === 'string' && isUuid(x));
      if (!accountIds.length) { res.status(400).json({ error: 'не выбраны аккаунты' }); return; }
      const level = ['none', 'medium', 'max'].includes(req.body.level) ? req.body.level : 'medium';
      const autoApprove = req.body.autoApprove === 'true' || req.body.autoApprove === true;
      const captionMode = req.body.captionMode === 'none' ? 'none' : 'phrase';

      // Сохраняем каждое видео один раз (по одному в память, не всю пачку).
      const uploadIds: string[] = [];
      for (const f of files) {
        const buf = await readFile(f.path);
        const { rows } = await query<{ id: string }>(
          `INSERT INTO media_uploads (filename, mime, bytes, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
          [f.originalname || 'video.mp4', f.mimetype || 'video/mp4', buf, f.size],
        );
        uploadIds.push(rows[0].id);
      }

      const V = uploadIds.length;
      const A = accountIds.length;
      const rounds = Math.max(1, Math.min(V, Math.trunc(Number(req.body.rounds)) || 1));
      const MAX = 500; // предохранитель от лавины
      const truncated = A * rounds > MAX;
      let created = 0;
      let cursor = new Date();
      outer: for (let r = 0; r < rounds; r++) {
        for (let i = 0; i < A; i++) {
          if (created >= MAX) break outer;
          const vIdx = ((V - 1 - i - r) % V + V) % V; // ротация: в раунде у всех разное видео
          const accId = accountIds[i];
          const { rows: acc } = await query<{ platform: string }>(`SELECT platform FROM accounts WHERE id=$1`, [accId]);
          if (!acc[0]) continue;
          const seed = Math.floor(Math.random() * 2_000_000_000);
          const caption = captionMode === 'none' ? '' : tiktokCaption(seed);
          cursor = nextSlot(cursor); // разносим по прайм-слотам, чтобы не всё разом
          await query(
            `INSERT INTO posts (account_id, platform, kind, status, caption, media_type, media_upload_id, uniquify_level, uniquify_seed, scheduled_at)
             VALUES ($1,$2,'video',$3,$4,'VIDEO',$5,$6,$7,$8)`,
            [accId, acc[0].platform, autoApprove ? 'approved' : 'draft', caption, uploadIds[vIdx], level, seed, cursor],
          );
          created++;
        }
      }
      res.json({ ok: true, videos: V, accounts: A, rounds, created, autoApprove, truncated });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка пакетной загрузки' });
    } finally {
      for (const f of files) await unlink(f.path).catch(() => {});
    }
  });

  // Загрузка видео для Instagram (простой флоу: одно видео → капшн → черновики на выбранных IG-акках).
  const uploadIg = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
  const uploadIgVideo = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    uploadIg.single('video')(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string })?.code;
        res.status(413).json({ error: code === 'LIMIT_FILE_SIZE' ? 'видео больше 200 МБ — сожми или обрежь' : 'ошибка загрузки файла' });
        return;
      }
      next();
    });
  };
  api.post('/upload-ig', uploadIgVideo, async (req, res) => {
    try {
      const f = req.file;
      if (!f || !f.buffer?.length) { res.status(400).json({ error: 'нет файла видео' }); return; }
      const caption = String(req.body?.caption || '').trim().slice(0, 2200);
      let accountIds: string[] = [];
      try { accountIds = JSON.parse(String(req.body?.accountIds || '[]')); } catch { /* ignore */ }
      accountIds = (Array.isArray(accountIds) ? accountIds : []).filter((x) => typeof x === 'string' && isUuid(x));
      if (!accountIds.length) { res.status(400).json({ error: 'не выбраны аккаунты' }); return; }
      // Фильтруем только Instagram-акки
      const { rows: accs } = await query<{ id: string; platform: string }>(
        `SELECT id, platform FROM accounts WHERE id = ANY($1) AND platform = 'instagram'`,
        [accountIds],
      );
      if (!accs.length) { res.status(400).json({ error: 'нет Instagram-аккаунтов среди выбранных' }); return; }
      const igIds = accs.map((a) => a.id);
      const { rows: up } = await query<{ id: string }>(
        `INSERT INTO media_uploads (filename, mime, bytes, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
        [f.originalname || 'video.mp4', f.mimetype || 'video/mp4', f.buffer, f.size],
      );
      const uploadId = up[0].id;
      const sched = nextSlot(new Date());
      for (const aid of igIds) {
        await query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_type, media_upload_id, scheduled_at)
           VALUES ($1,$2,'video','draft',$3,'VIDEO',$4,$5)`,
          [aid, 'instagram', caption, uploadId, sched],
        );
      }
      res.json({ ok: true, created: igIds.length, caption });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'ошибка загрузки' });
    }
  });

  // === НАБЛЮДАТЕЛЬ: один акк чекит просмотры постов и статус акков ===
  // POST /observer/start — запускает наблюдателя (выбирает акк-наблюдателя).
  // GET /observer/results — текущий статус + список наблюдаемых постов с просмотрами.
  api.post('/observer/start', async (req, res) => {
    try {
      const b = req.body || {};
      const observerId = String(b.observer_account_id || '').trim();
      if (!isUuid(observerId)) { res.status(400).json({ ok: false, error: 'плохой аккаунт' }); return; }
      // Проверяем что акк существует и активен
      const { rows: acc } = await query(`SELECT id, slug, session_status FROM accounts WHERE id=$1`, [observerId]);
      if (!acc[0]) { res.status(404).json({ ok: false, error: 'аккаунт не найден' }); return; }
      // Сохраняем ID наблюдателя в radar_config (одно поле — один наблюдатель)
      await query(`UPDATE radar_config SET observer_account_id=$1, observer_started_at=now() WHERE id=1`, [observerId]);
      res.json({ ok: true, observer_slug: acc[0].slug });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'ошибка' });
    }
  });
  api.get('/observer/results', async (_req, res) => {
    try {
      const cfg = (await query<Record<string, any>>(
        `SELECT observer_account_id, observer_started_at FROM radar_config WHERE id=1`)).rows[0] || {};
      const observerId = cfg.observer_account_id;
      if (!observerId) { res.json({ watching: false }); return; }
      const startedAt = cfg.observer_started_at;
      const { rows: obsAcc } = await query<Record<string, any>>(
        `SELECT slug, platform FROM accounts WHERE id=$1`, [observerId]);
      const observerSlug = obsAcc[0]?.slug || '—';
      // Считаем количество запусков наблюдателя (по количеству записей в observer_runs)
      const { rows: runs } = await query<{ n: string }>(
        `SELECT count(*)::int n FROM observer_runs WHERE observer_account_id=$1`, [observerId]);
      const runCount = runs[0]?.n || 0;
      // Последний результат по каждому посту — берём свежий view_count + предыдущий из той же записи
      const { rows: lastResult } = await query<Record<string, any>>(
        `SELECT o.post_id, o.view_count, o.updated_at,
                p.external_url, p.media_url, a.slug AS account_slug
         FROM observer_results o
         JOIN posts p ON p.id=o.post_id
         JOIN accounts a ON a.id=p.account_id
         WHERE o.observer_account_id=$1
         ORDER BY o.updated_at DESC`, [observerId]);
      // Уникализируем по post_id (берём последние данные)
      const uniqueMap = new Map<string, Record<string, any>>();
      for (const p of lastResult) uniqueMap.set(String(p.post_id), p);
      const uniquePosts = [...uniqueMap.values()].map(p => ({
        post_id: p.post_id,
        view_count: Number(p.view_count) || 0,
        account_slug: p.account_slug || '—',
        external_url: p.external_url || null,
        media_url: p.media_url || null,
        updated_at: p.updated_at,
      }));
      // Для каждого поста ищем предыдущий view_count (из более раннего результата того же поста)
      const resultByPost = new Map<string, any[]>();
      for (const r of lastResult) {
        const key = String(r.post_id);
        if (!resultByPost.has(key)) resultByPost.set(key, []);
        resultByPost.get(key)!.push(r);
      }
      const postsWithPrev = uniquePosts.map(up => {
        const all = resultByPost.get(String(up.post_id)) || [];
        const prev = all.length > 1 ? all.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[1] : null;
        return {
          ...up,
          prev_view_count: prev ? Number(prev.view_count) || 0 : 0,
        };
      });
      res.json({
        watching: true,
        observer_slug: observerSlug,
        observer_started_at: startedAt,
        posts_checked: uniquePosts.length,
        runs: runCount,
        posts: postsWithPrev,
      });
    } catch (e) {
      res.status(500).json({ watching: false, error: e instanceof Error ? e.message : 'ошибка' });
    }
  });
  // === /НАБЛЮДАТЕЛЬ ===

  // Генерация текста от лица персоны.
  api.post('/generate/caption', async (req, res) => {
    const b = req.body || {};
    const text = await generateCaption({ persona: b.persona, system_prompt: b.system_prompt, gender: b.gender, tone: b.tone }, String(b.brief || ''));
    res.json({ text });
  });

  // Генерация картинки/видео через внутренний API neironka.pro.
  api.post('/generate/media', async (req, res) => {
    const b = req.body || {};
    const url = await generateMedia(b.kind === 'video' ? 'video' : 'image', String(b.prompt || ''));
    res.json({ url });
  });

  // Аватар для акка (RenderGrid): случайная категория — кот/эмблема/пейзаж/аниме…
  api.post('/generate/avatar', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    const url = prompt ? await generateMedia('image', prompt, '1:1') : await generateAvatar();
    res.json({ url });
  });

  // «План на N дней» — пачкой генерим черновики постов по всем не-паузным аккаунтам
  // площадки, ставим в расписание. Человек апрувит их потом (draft -> approved).
  api.post('/generate/plan', async (req, res) => {
    const platform = String(req.body?.platform || '');
    const days = Math.min(14, Math.max(1, Number(req.body?.days) || 3));
    const { rows: accounts } = await query<Record<string, any>>(
      `SELECT * FROM accounts WHERE platform=$1 AND status <> 'paused'`,
      [platform],
    );
    let created = 0;
    let slot = new Date();
    outer: for (const acc of accounts) {
      const total = days * (acc.posts_per_day || 1);
      for (let i = 0; i < total; i++) {
        if (created >= 80) break outer; // предохранитель от лавины LLM-вызовов
        const caption = await generateCaption(
          { slug: acc.slug, persona: acc.persona, system_prompt: acc.system_prompt, gender: acc.gender, tone: acc.tone },
          'пост про нейросети',
        );
        slot = nextSlot(slot);
        await query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, scheduled_at)
           VALUES ($1,$2,'auto','draft',$3,$4)`,
          [acc.id, platform, caption, slot],
        );
        created++;
      }
    }
    res.json({ created });
  });

  // «Проверить сессии» — глубокая проверка (открывает облачный браузер) по аккаунтам
  // площадки. Долго → отвечаем сразу, проверяем в фоне и обновляем session_status.
  api.post('/sessions/check', async (req, res) => {
    const platform = String(req.body?.platform || '');
    const { rows } = await query<Record<string, any>>(
      `SELECT id, gologin_profile_id, platform FROM accounts WHERE platform=$1 AND gologin_profile_id IS NOT NULL`,
      [platform],
    );
    void (async () => {
      for (const a of rows) {
        try {
          const live = await checkSessionDeep(a.gologin_profile_id, driverFor(a.platform));
          // null = проверить НЕ УДАЛОСЬ (шторм GoLogin, занятые слоты, упавший прокси, таймаут).
          // Статус не трогаем вообще: раньше `live ? 'live' : 'dead'` красил такой сбой в dead, и
          // один шторм по кнопке «Проверить сессии» отправлял в dead ВСЮ площадку сразу, после чего
          // храповик не пускал акки обратно быстрым чеком. Тот же класс ошибки, что 07.08 с 402:
          // «не смог проверить» не равно «плохо».
          if (live === null) { console.warn(`[sessions/check] ${a.id}: проверка не состоялась — статус оставляю как был`); continue; }
          await query(`UPDATE accounts SET session_status=$2, session_checked_at=now() WHERE id=$1`, [a.id, live ? 'live' : 'dead']);
        } catch {
          /* пропускаем аккаунт */
        }
      }
    })();
    res.json({ queued: rows.length });
  });

  // «Прогреть сейчас» — запускает одну сессию прогрева для аккаунта немедленно
  // (не ждём 12-мин тик воркера). Долго → отвечаем сразу, греем в фоне.
  api.post('/accounts/warmup', async (req, res) => {
    const { rows } = await query<Record<string, any>>(
      `SELECT a.*, g.gologin_token AS group_token, g.warmup_comments AS group_comments
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.id=$1`,
      [String(req.body?.id || '')]);
    const acc = rows[0];
    if (!acc || !acc.gologin_profile_id) return res.status(400).json({ error: 'нет профиля GoLogin' });
    void runWarmupOnce(acc);
    res.json({ ok: true });
  });

  // Создать свежие sticky-прокси click-ip. Пул click-ip = много портов на одних кредах, каждый порт = свой
  // резид. IP. Базовые креды берём из существующего click-ip акка, выдаём СЛЕДУЮЩИЕ свободные порты (не занятые
  // другими акками), живость проверяем curl'ом параллельно. Так «создать прокси» = без дашборда.
  api.post('/proxies/mint', async (req, res) => {
    try {
      const count = Math.max(1, Math.min(30, Number(req.body?.count) || 5));
      const verify = req.body?.verify !== false;
      const rows = (await query<{ ig_proxy: string }>(
        `SELECT ig_proxy FROM accounts WHERE ig_proxy ILIKE '%proxy.click-ip.com%' AND ig_proxy IS NOT NULL AND deleted_at IS NULL`)).rows;
      if (!rows.length) return res.status(400).json({ error: 'нет базового click-ip прокси в аккаунтах — заведи хотя бы один' });
      const parse = (s: string) => {
        let host = '', port = 0, user = '', pass = '';
        const at = s.lastIndexOf('@');
        if (at >= 0) { const cred = s.slice(0, at), hp = s.slice(at + 1); const ci = cred.indexOf(':'); user = cred.slice(0, ci); pass = cred.slice(ci + 1); const p = hp.split(':'); host = p[0]; port = Number(p[1]) || 0; }
        else { const p = s.split(':'); host = p[0]; port = Number(p[1]) || 0; user = p[2] || ''; pass = p.slice(3).join(':'); }
        return { host, port, user, pass };
      };
      const base = parse(rows[0].ig_proxy);
      const used = new Set<number>();
      for (const r of rows) { const p = parse(r.ig_proxy); if (p.host === base.host && p.user === base.user && p.port) used.add(p.port); }
      // кандидаты: свободные порты пула (берём с запасом ×3 на отсев мёртвых)
      const cands: number[] = [];
      for (let port = 10000; port < 10500 && cands.length < count * 3 + 3; port++) if (!used.has(port)) cands.push(port);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const alive = async (port: number) => {
        if (!verify) return true;
        try { const { stdout } = await run('curl', ['-s', '--max-time', '9', '-x', `http://${base.user}:${base.pass}@${base.host}:${port}`, 'https://api.ipify.org'], { timeout: 11000 }); return /^\d+\.\d+\.\d+\.\d+/.test(String(stdout).trim()); }
        catch { return false; }
      };
      const checked = await Promise.all(cands.map(async (port) => ({ port, ok: await alive(port) })));
      let alivePorts = checked.filter((r) => r.ok).slice(0, count);
      let verified = verify;
      // Фолбэк: если проверка была включена, но живых 0 (обычно = curl недоступен на хосте) —
      // отдаём порты без проверки, чтобы кнопка не возвращала пусто. Помечаем verified=false.
      if (verify && alivePorts.length === 0 && cands.length) { alivePorts = cands.slice(0, count).map((port) => ({ port, ok: true })); verified = false; }
      const out = alivePorts.map((r) => `${base.user}:${base.pass}@${base.host}:${r.port}`);
      res.json({ proxies: out, skipped: verified ? checked.filter((r) => !r.ok).length : 0, verified });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'mint failed' });
    }
  });

  // «Прогреть все» — ставит все аккаунты площадки в очередь; идут по одному (замок).
  api.post('/accounts/warmup-all', async (req, res) => {
    const platform = String(req.body?.platform || '');
    const groupId = req.body?.group_id && isUuid(String(req.body.group_id)) ? String(req.body.group_id) : null;
    // Пропускаем акки, что грелись меньше 6 часов назад (не дёргаем зря). Фильтр по группе.
    let where = `a.platform=$1 AND a.status <> 'paused' AND a.gologin_profile_id IS NOT NULL
      AND (a.warmup_at IS NULL OR a.warmup_at < now() - interval '6 hours')`;
    const params: any[] = [platform];
    if (groupId) { where += ` AND a.group_id=$2`; params.push(groupId); }
    else if (req.body?.group_id === 'none') { where += ` AND a.group_id IS NULL`; }
    const { rows } = await query<Record<string, any>>(
      `SELECT a.*, g.gologin_token AS group_token, g.warmup_comments AS group_comments
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
       WHERE ${where}`,
      params);
    for (const acc of rows) void runWarmupOnce(acc);
    res.json({ queued: rows.length });
  });

  // Живой статус браузерных операций + сколько ждут в очереди (1 профиль за раз).
  api.get('/status', (_req, res) => res.json({ ...getStatus(), queued: browserQueue() }));

  // Генерация персоны (рандомная или по брифу) — для кнопок в форме аккаунта.
  api.post('/generate/persona', async (req, res) => {
    const persona = await generatePersona(String(req.body?.brief || ''));
    res.json(persona);
  });

  // A/B по когортам: сравнение группы с комментами (A) и без (B).
  api.get('/cohorts', async (_req, res) => {
    const { rows } = await query(
      `SELECT a.cohort,
         count(*) AS accounts,
         count(*) FILTER (WHERE a.status <> 'paused' AND a.session_status='live') AS alive,
         count(*) FILTER (WHERE a.status='paused') AS paused,
         coalesce(sum((SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published')),0) AS posts,
         coalesce(sum((SELECT count(*) FROM funnel_events f WHERE f.account_id=a.id AND f.event_type='click')),0) AS clicks,
         coalesce(sum((SELECT count(*) FROM funnel_events f WHERE f.account_id=a.id AND f.event_type='registration')),0) AS regs,
         coalesce(sum((SELECT coalesce(sum(f.revenue_cents),0) FROM funnel_events f WHERE f.account_id=a.id)),0) AS revenue_cents,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (SELECT coalesce(sum(f.revenue_cents),0) FROM funnel_events f WHERE f.account_id=a.id)
         ) AS median_revenue_cents
       FROM accounts a
       WHERE a.cohort IS NOT NULL
       GROUP BY a.cohort ORDER BY a.cohort`,
    );
    res.json(rows);
  });

  mountYoutube(api); // ЮТУБ-КАНАЛЫ: OAuth, настройки текста, очередь Shorts (src/youtube.ts)
  mountThreads(api); // ТРЕДС: OAuth-контур (src/threads.ts)
  // OAuth-колбэк Google ДО requireAuth: редирект приходит в браузере без куки панели.
  app.get('/api/youtube/oauth/cb', (api as any).ytOauthCb);
  // Фото для Threads-каруселей: graph.threads.net должен скачать их БЕЗ куки панели.
  app.use('/t', express.static(join(PUBLIC_DIR, 't')));
  // OAuth Threads: колбэк тоже публичный (redirect приходит без куки)
  app.get('/api/threads/oauth/cb', (api as any).thOauthCb);
  app.use('/api', api);

  // Статика панели. index:false — чтобы «/» шёл в no-store хендлер ниже, а не кэшировался
  // express.static'ом (из-за этого браузер держал старый JS -> капс/мусор в вариантах).
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
  }));
  app.get('/login', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'login.html')));
  // no-store — чтобы Safari/браузер НИКОГДА не показывал старый кэш панели после деплоя.
  app.get('*', requireAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

  // Глобальный обработчик ошибок — чтобы сбой в любом роуте отдавал JSON, а не ронял ответ.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api error]', msg);
    logError('api', msg, `${req.method} ${req.path}`);
    if (!res.headersSent) res.status(500).json({ error: 'внутренняя ошибка' });
  });

  return app;
}
