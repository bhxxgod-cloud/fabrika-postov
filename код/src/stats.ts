// stats.ts — ВКЛАДКА «СТАТИСТИКА»: ВСЕ АККАУНТЫ ОДНОЙ ТАБЛИЦЕЙ.
//
// ЗАЧЕМ. Приказ владельца 25.08.2026: «нужно взять все акки и свести их в
// постере в стату по просмотрам и тд». До сих пор цифры лежали в трёх
// несвязанных местах и ни один экран не показывал их вместе:
//
//   • YouTube и ВК — таблицы yt_channels + yt_queue + yt_stats;
//   • Instagram — accounts + post_stats;
//   • TikTok — вообще вне базы панели, в файле фермы на маке владельца.
//
// ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: НОЛЬ И «НЕТ ЗАМЕРА» — РАЗНЫЕ ВЕЩИ.
//
// Соблазн подставить 0 там, где цифры нет, велик: таблица выглядит опрятнее.
// Но у нас есть площадки, по которым замера нет вовсе (ВК: 15 постов
// опубликовано, просмотры не собирает никто), и нарисованный ноль читается как
// «посмотрели ноль раз», то есть как провал вместо пробела в приборах. Поэтому
// наружу едет null, а витрина обязана показать прочерк и подпись «нет замера».
//
// ОТКУДА TIKTOK. Из веба, а не с телефонов (см. src/ttweb.ts, там же цена
// вопроса). Это важно и для работы в облаке: обход идёт с самой панели, не
// требует ни фермы, ни включённого мака.

import type { Express, Request, Response, RequestHandler } from 'express';
import { query } from './db/index.js';
import { обход, снимокАккаунта } from './ttweb.js';

/** Одна строка витрины. Любая цифра может быть null — это «не мерили». */
type Строка = {
  platform: string;
  key: string;
  name: string;
  status: string | null;
  postsTotal: number | null;
  posts7d: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  followers: number | null;
  medianViews: number | null;
  bestViews: number | null;
  bestUrl: string | null;
  lastPostAt: string | null;
  measuredAt: string | null;
  /** Прирост просмотров за сутки и за неделю. null — ряда ещё не хватает. */
  growth1d: number | null;
  growth7d: number | null;
  note?: string;
};

const ч = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function медиана(значения: number[]): number | null {
  if (!значения.length) return null;
  const s = [...значения].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * КАНАЛЫ КОРОТКИХ ВИДЕО: YouTube, ВК, Threads — одна таблица, площадка полем.
 *
 * Просмотры считаем join-ом yt_queue → yt_stats по video_id. Тонкость, из-за
 * которой цифра легко уезжает вдвое: у канала бывают строки очереди в статусах
 * кроме posted, и join без фильтра по posted их тоже притянет. Фильтр стоит В
 * УСЛОВИИ СОЕДИНЕНИЯ, а не в WHERE: иначе канал без единой публикации выпал бы
 * из выдачи целиком, вместо того чтобы честно показать нули.
 */
async function строкиКаналов(): Promise<Строка[]> {
  const r = await query<Record<string, unknown>>(`
    SELECT c.slug, c.name, c.platform, c.enabled, c.subs,
           COUNT(DISTINCT q.id)                                          AS posts_total,
           COUNT(DISTINCT q.id) FILTER (WHERE q.posted_at > now() - interval '7 days') AS posts_7d,
           SUM(s.views)                                                  AS views,
           SUM(s.likes)                                                  AS likes,
           SUM(s.comments)                                               AS comments,
           MAX(s.updated_at)                                             AS measured_at,
           MAX(q.posted_at)                                              AS last_post_at,
           MAX(s.views)                                                  AS best_views,
           (ARRAY_AGG(q.url ORDER BY s.views DESC NULLS LAST))[1]        AS best_url,
           ARRAY_REMOVE(ARRAY_AGG(s.views), NULL)                        AS all_views
    FROM yt_channels c
    LEFT JOIN yt_queue q ON q.channel_id = c.id AND q.status = 'posted'
    LEFT JOIN yt_stats  s ON s.video_id  = q.video_id
    GROUP BY c.id
    ORDER BY SUM(s.views) DESC NULLS LAST`);

  return r.rows.map((x) => {
    const все = ((x.all_views as unknown[]) || []).map(Number).filter((n) => Number.isFinite(n));
    // Замера НЕТ вовсе (ВК, Threads) — просмотры остаются null, а не нулём.
    const мерили = все.length > 0;
    return {
      platform: String(x.platform || 'youtube'),
      key: String(x.slug || ''),
      name: String(x.name || x.slug || ''),
      status: x.enabled === false ? 'выключен' : 'включён',
      postsTotal: ч(x.posts_total),
      posts7d: ч(x.posts_7d),
      views: мерили ? ч(x.views) : null,
      likes: мерили ? ч(x.likes) : null,
      comments: мерили ? ч(x.comments) : null,
      followers: ч(x.subs),
      medianViews: медиана(все),
      bestViews: мерили ? ч(x.best_views) : null,
      bestUrl: (x.best_url as string) || null,
      lastPostAt: x.last_post_at ? new Date(x.last_post_at as string).toISOString() : null,
      measuredAt: x.measured_at ? new Date(x.measured_at as string).toISOString() : null,
      growth1d: null, growth7d: null,
      note: мерили ? undefined : 'просмотры этой площадки не собирает никто',
    };
  });
}

/**
 * INSTAGRAM: персоны, у которых есть хотя бы один замер.
 *
 * Соединение через post_stats, а не через все 490 строк accounts. Иначе
 * витрину утопили бы четыре с лишним сотни аккаунтов фермы комментинга,
 * которые ничего не публикуют и метрик иметь не могут по определению.
 */
async function строкиИнстаграма(): Promise<Строка[]> {
  const r = await query<Record<string, unknown>>(`
    SELECT a.slug, a.handle, a.ig_full_name, a.status, a.followers_count, a.last_posted_at,
           COUNT(DISTINCT ps.shortcode)                                        AS posts_total,
           COUNT(DISTINCT ps.shortcode) FILTER (WHERE ps.taken_at > now() - interval '7 days') AS posts_7d,
           SUM(ps.views)                                                       AS views,
           SUM(ps.likes)                                                       AS likes,
           SUM(ps.comments)                                                    AS comments,
           MAX(ps.updated_at)                                                  AS measured_at,
           MAX(ps.views)                                                       AS best_views,
           (ARRAY_AGG(ps.shortcode ORDER BY ps.views DESC NULLS LAST))[1]      AS best_code,
           ARRAY_REMOVE(ARRAY_AGG(ps.views), NULL)                             AS all_views
    FROM accounts a
    JOIN post_stats ps ON ps.account_id = a.id
    GROUP BY a.id
    ORDER BY SUM(ps.views) DESC NULLS LAST`);

  return r.rows.map((x) => {
    const все = ((x.all_views as unknown[]) || []).map(Number).filter((n) => Number.isFinite(n));
    const код = (x.best_code as string) || null;
    return {
      platform: 'instagram',
      key: String(x.slug || x.handle || ''),
      name: String(x.ig_full_name || x.handle || x.slug || ''),
      status: (x.status as string) || null,
      postsTotal: ч(x.posts_total),
      posts7d: ч(x.posts_7d),
      views: ч(x.views),
      likes: ч(x.likes),
      comments: ч(x.comments),
      followers: ч(x.followers_count),
      medianViews: медиана(все),
      bestViews: ч(x.best_views),
      bestUrl: код ? `https://www.instagram.com/reel/${код}/` : null,
      lastPostAt: x.last_posted_at ? new Date(x.last_posted_at as string).toISOString() : null,
      measuredAt: x.measured_at ? new Date(x.measured_at as string).toISOString() : null,
      growth1d: null, growth7d: null,
    };
  });
}

/**
 * TIKTOK: из собственных таблиц, которые наполняет веб-обход.
 *
 * Оговорка, которую обязана повторить и витрина: просмотры здесь это сумма по
 * ДЕСЯТИ ПОСЛЕДНИМ постам, а не за всю жизнь аккаунта. Страница эмбеда отдаёт
 * ровно десять и не даёт курсора, чтобы уйти глубже. Выдавать это за
 * пожизненный итог значит занижать старые аккаунты в разы и делать сравнение
 * площадок между собой ложью.
 */
async function строкиТиктока(): Promise<Строка[]> {
  const r = await query<Record<string, unknown>>(`
    SELECT a.nick, a.title, a.active, a.exists_on_tiktok, a.followers, a.likes_total,
           a.video_count, a.checked_at,
           COUNT(p.post_id)                                        AS posts_measured,
           COUNT(p.post_id) FILTER (WHERE p.posted_at > now() - interval '7 days') AS posts_7d,
           SUM(p.views)                                            AS views,
           MAX(p.views)                                            AS best_views,
           MAX(p.posted_at)                                        AS last_post_at,
           (ARRAY_AGG(p.post_id ORDER BY p.views DESC NULLS LAST))[1] AS best_id,
           ARRAY_REMOVE(ARRAY_AGG(p.views), NULL)                  AS all_views
    FROM tt_accounts a
    LEFT JOIN tt_post_stats p ON p.nick = a.nick
    GROUP BY a.nick
    ORDER BY SUM(p.views) DESC NULLS LAST`);

  return r.rows.map((x) => {
    const все = ((x.all_views as unknown[]) || []).map(Number).filter((n) => Number.isFinite(n));
    const ник = String(x.nick);
    const лучший = (x.best_id as string) || null;
    return {
      platform: 'tiktok',
      key: ник,
      name: String(x.title || ник),
      status: x.exists_on_tiktok === false ? 'нет аккаунта' : x.active === false ? 'отложен' : 'следим',
      postsTotal: ч(x.video_count),
      posts7d: ч(x.posts_7d),
      views: все.length ? ч(x.views) : null,
      likes: ч(x.likes_total),
      comments: null,
      followers: ч(x.followers),
      medianViews: медиана(все),
      bestViews: все.length ? ч(x.best_views) : null,
      bestUrl: лучший ? `https://www.tiktok.com/@${ник}/video/${лучший}` : null,
      lastPostAt: x.last_post_at ? new Date(x.last_post_at as string).toISOString() : null,
      measuredAt: x.checked_at ? new Date(x.checked_at as string).toISOString() : null,
      growth1d: null, growth7d: null,
      note: все.length
        ? `просмотры по ${все.length} последним постам, глубже TikTok не отдаёт`
        : 'замера ещё не было',
    };
  });
}

/** Сумма по колонке, где хотя бы что-то измерено. null, если не мерили нигде. */
function сумма(строки: Строка[], поле: keyof Строка): number | null {
  const цифры = строки.map((с) => с[поле]).filter((v): v is number => typeof v === 'number');
  return цифры.length ? цифры.reduce((a, b) => a + b, 0) : null;
}

/**
 * ОБХОД TIKTOK: обновить снимок и дописать строку в журнал.
 *
 * Вынесено из ручки, потому что зовётся из ДВУХ мест: кнопкой в панели и
 * расписанием. Ряд по дням, ради которого журнал и заведён, кнопкой не
 * набирается: владелец не будет жать её каждые шесть часов, а без регулярности
 * «прирост за неделю» так и останется неотвечаемым.
 */
export async function обойтиТикток(): Promise<{ обошли: number; постов: number; нетАккаунта: string[] }> {
  const список = await query<{ nick: string }>(
    `SELECT nick FROM tt_accounts WHERE active AND (exists_on_tiktok IS DISTINCT FROM false) ORDER BY nick`,
  );
  const ники = список.rows.map((r) => r.nick);
  if (!ники.length) return { обошли: 0, постов: 0, нетАккаунта: [] };

  const снимки = await обход(ники);
  let постов = 0;
  for (const с of снимки) {
    await query(
      `UPDATE tt_accounts SET followers=$2, likes_total=$3, video_count=$4, exists_on_tiktok=$5, checked_at=now() WHERE nick=$1`,
      [с.nick, с.followers, с.likesTotal, с.videoCount, с.exists],
    );
    // Пишем в журнал ВСЕГДА, даже когда цифра не изменилась. Ряд с пропусками
    // нельзя отличить от ряда, где показатель стоял на месте, а разница между
    // «не мерили» и «не выросло» это и есть весь смысл динамики.
    await query(
      `INSERT INTO stats_log (platform, account_key, level, views, likes, followers, posts_count, source)
       VALUES ('tiktok', $1, 'account', $2, $3, $4, $5, 'tt_web')`,
      [с.nick, с.viewsVisible, с.likesTotal, с.followers, с.videoCount],
    );
    for (const p of с.posts) {
      постов += 1;
      await query(
        `INSERT INTO tt_post_stats (post_id, nick, views, posted_at, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (post_id) DO UPDATE SET views=EXCLUDED.views, updated_at=now()`,
        [p.id, с.nick, p.views, p.postedAt],
      );
      await query(
        `INSERT INTO stats_log (platform, account_key, post_key, level, views, source)
         VALUES ('tiktok', $1, $2, 'post', $3, 'tt_web')`,
        [с.nick, p.id, p.views],
      );
    }
  }
  return { обошли: снимки.length, постов, нетАккаунта: снимки.filter((с) => !с.exists).map((с) => с.nick) };
}

/**
 * СНЯТЬ ПОКАЗАНИЯ ЮТУБА И ИНСТАГРАМА В ЖУРНАЛ.
 *
 * Эти две площадки собирают цифры сами (Data API и куки-сборщик), но кладут их
 * в таблицы с ПЕРЕЗАПИСЬЮ: yt_stats и post_stats держат одну строку на объект.
 * Поэтому прошлое значение там не сохраняется, и прирост посчитать нельзя.
 *
 * Мы не трогаем их сбор, а лишь снимаем с него слепок в журнал. Это дёшево (два
 * запроса), не зависит от чужого кода и не отнимает квоту: читаем то, что уже
 * лежит в базе.
 */
export async function снятьПоказания(): Promise<{ строк: number }> {
  const r1 = await query(`
    INSERT INTO stats_log (platform, account_key, post_key, level, views, likes, comments, source)
    SELECT COALESCE(c.platform,'youtube'), c.slug, s.video_id, 'post', s.views, s.likes, s.comments, 'yt_api'
    FROM yt_stats s
    JOIN yt_queue q  ON q.video_id = s.video_id
    JOIN yt_channels c ON c.id = q.channel_id`);
  const r2 = await query(`
    INSERT INTO stats_log (platform, account_key, post_key, level, views, likes, comments, source)
    SELECT 'instagram', COALESCE(a.slug, a.handle, ps.persona), ps.shortcode, 'post', ps.views, ps.likes, ps.comments, 'ig_cookies'
    FROM post_stats ps
    LEFT JOIN accounts a ON a.id = ps.account_id`);
  return { строк: (r1.rowCount || 0) + (r2.rowCount || 0) };
}

/**
 * ПРИРОСТ ПО ЖУРНАЛУ: сколько набрали за окно.
 *
 * Считаем как разницу между последним замером и последним замером ДО начала
 * окна, по каждому аккаунту. Не сумму приростов между всеми точками: замеры
 * идут неравномерно, и сумма разностей раздувалась бы на каждом лишнем прогоне.
 *
 * Отрицательную дельту гасим в ноль: она значит не «просмотры убыли», а что
 * пост пропал из выдачи (у TikTok мы видим только десять последних, и старый
 * выпадает, когда выходит новый). Показывать минус в графе «прирост» значит
 * пугать владельца несуществующим падением.
 */
export async function приростПоАккаунтам(дней: number): Promise<Map<string, number>> {
  const r = await query<{ platform: string; account_key: string; delta: string }>(`
    WITH последние AS (
      SELECT DISTINCT ON (platform, account_key, COALESCE(post_key,''))
             platform, account_key, COALESCE(post_key,'') pk, views
        FROM stats_log
       WHERE level = 'post'
       ORDER BY platform, account_key, COALESCE(post_key,''), checked_at DESC
    ), было AS (
      SELECT DISTINCT ON (platform, account_key, COALESCE(post_key,''))
             platform, account_key, COALESCE(post_key,'') pk, views
        FROM stats_log
       WHERE level = 'post' AND checked_at < now() - ($1 || ' days')::interval
       ORDER BY platform, account_key, COALESCE(post_key,''), checked_at DESC
    )
    SELECT п.platform, п.account_key,
           SUM(GREATEST(COALESCE(п.views,0) - COALESCE(б.views,0), 0))::text AS delta
      FROM последние п
      LEFT JOIN было б ON б.platform=п.platform AND б.account_key=п.account_key AND б.pk=п.pk
     WHERE б.views IS NOT NULL
     GROUP BY п.platform, п.account_key`, [String(дней)]);
  return new Map(r.rows.map((x) => [`${x.platform}:${x.account_key}`, Number(x.delta)]));
}

export function registerStatsRoutes(app: Express, requireAuth: RequestHandler): void {
  /**
   * Витрина целиком. Один запрос вместо четырёх с фронта: так таблица не
   * приезжает кусками и итоги сверху не пляшут, пока догружается последняя
   * площадка.
   */
  app.get('/api/stats/overview', requireAuth, async (_req: Request, res: Response) => {
    try {
      // Тикток может ещё не иметь своих таблиц (миграция не прогнана) — это не
      // повод отдать пустую витрину по всем остальным площадкам.
      const [каналы, инста, тикток] = await Promise.all([
        строкиКаналов().catch(() => [] as Строка[]),
        строкиИнстаграма().catch(() => [] as Строка[]),
        строкиТиктока().catch(() => [] as Строка[]),
      ]);
      const строки = [...каналы, ...инста, ...тикток];

      // ПРИРОСТ ПРИШИВАЕМ ОТДЕЛЬНО, А НЕ СЧИТАЕМ В КАЖДОМ СБОРЩИКЕ.
      //
      // Он живёт в журнале, общем для всех площадок, и считается одним запросом
      // на всех. Считать его внутри трёх разных SQL значило бы три разные
      // арифметики прироста, которые однажды разойдутся между собой.
      const [за1, за7] = await Promise.all([
        приростПоАккаунтам(1).catch(() => new Map<string, number>()),
        приростПоАккаунтам(7).catch(() => new Map<string, number>()),
      ]);
      for (const с of строки) {
        const ключ = `${с.platform}:${с.key}`;
        с.growth1d = за1.has(ключ) ? (за1.get(ключ) as number) : null;
        с.growth7d = за7.has(ключ) ? (за7.get(ключ) as number) : null;
      }

      const поПлощадкам: Record<string, { views: number | null; posts: number | null; accounts: number }> = {};
      for (const с of строки) {
        const p = (поПлощадкам[с.platform] ||= { views: null, posts: null, accounts: 0 });
        p.accounts += 1;
        if (typeof с.views === 'number') p.views = (p.views ?? 0) + с.views;
        if (typeof с.postsTotal === 'number') p.posts = (p.posts ?? 0) + с.postsTotal;
      }

      // Глубина истории: пока журнал пуст, витрина обязана сказать «накапливаем
      // с сегодня», а не рисовать прирост нулём.
      const ист = await query<{ n: string; c: string }>(
        `SELECT count(*)::text n, COALESCE(min(checked_at)::text,'') c FROM stats_log`,
      ).catch(() => ({ rows: [{ n: '0', c: '' }] }));

      res.json({
        at: new Date().toISOString(),
        строки,
        итоги: {
          просмотры: сумма(строки, 'views'),
          лайки: сумма(строки, 'likes'),
          постов: сумма(строки, 'postsTotal'),
          прирост1д: сумма(строки, 'growth1d'),
          прирост7д: сумма(строки, 'growth7d'),
          постов7д: сумма(строки, 'posts7d'),
          аккаунтов: строки.length,
          поПлощадкам,
        },
        история: {
          замеров: Number(ист.rows[0]?.n || 0),
          сНачала: ист.rows[0]?.c || null,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'не собрал витрину' });
    }
  });

  /**
   * Обход TikTok по вебу: обновить снимок и дописать строку в журнал.
   *
   * Журнал пишем ВСЕГДА, даже когда цифра не изменилась. Ряд с пропусками
   * нельзя отличить от ряда, где показатель стоял на месте, а разница между
   * «не мерили» и «не выросло» это и есть весь смысл динамики.
   */
  app.post('/api/stats/tiktok/refresh', requireAuth, async (_req: Request, res: Response) => {
    try {
      const r = await обойтиТикток();
      res.json({ сделано: 'обход завершён', ...r });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'обход не удался' });
    }
  });

  /** Завести ник под наблюдение. Сразу проверяем, что аккаунт вообще есть. */
  app.post('/api/stats/tiktok/accounts', requireAuth, async (req: Request, res: Response) => {
    try {
      const ник = String(req.body?.nick || '').replace(/^@/, '').trim();
      if (!/^[\w.]{2,30}$/.test(ник)) return res.status(400).json({ error: 'ник не похож на ник' });
      const с = await снимокАккаунта(ник);
      await query(
        `INSERT INTO tt_accounts (nick, title, exists_on_tiktok, followers, likes_total, video_count, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (nick) DO UPDATE
           SET active=true, exists_on_tiktok=EXCLUDED.exists_on_tiktok, checked_at=now()`,
        [ник, req.body?.title || null, с.exists, с.followers, с.likesTotal, с.videoCount],
      );
      res.json({ сделано: с.exists ? 'ник заведён' : 'ник заведён, но аккаунта нет', снимок: с });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'не завёл' });
    }
  });

  /** Снять ник с наблюдения. Не удаляем: цифры прошлого остаются в журнале. */
  app.delete('/api/stats/tiktok/accounts/:nick', requireAuth, async (req: Request, res: Response) => {
    try {
      await query(`UPDATE tt_accounts SET active=false WHERE nick=$1`, [String(req.params.nick)]);
      res.json({ сделано: 'снят с наблюдения' });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'не снял' });
    }
  });
}
