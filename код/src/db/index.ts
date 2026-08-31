import pg from 'pg';

// Единый пул подключений. DATABASE_URL даёт Railway при добавлении плагина Postgres.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db] DATABASE_URL не задан — подключение к базе не выйдет.');
}

export const pool = new pg.Pool({
  connectionString,
  // Railway Postgres требует SSL, но с самоподписанным сертификатом.
  ssl: connectionString?.includes('localhost') ? undefined : { rejectUnauthorized: false },
  max: 10,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

// Лог ошибки в БД (для показа на сайте). Best-effort — сам никогда не роняет.
export async function logError(source: string, message: string, detail?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO app_errors (source, message, detail) VALUES ($1,$2,$3)`,
      [source, String(message).slice(0, 500), detail ? String(detail).slice(0, 2000) : null],
    );
  } catch { /* лог не должен ронять поток */ }
}

// === Лог жизни аккаунта (единая история для выводов о банах) ===
// Best-effort: сам никогда не роняет основной поток. detail — свободный снимок (jsonb).
export async function logAccountEvent(
  accountId: string | null, slug: string | null, platform: string | null,
  kind: string, detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,$3,$4,$5)`,
      [accountId, slug, platform, kind, detail ? JSON.stringify(detail) : null],
    );
  } catch { /* лог не должен ронять поток */ }
}

// Снимок ключевых метрик акка на момент события (для «почему умер»). Возвращает {} при любой ошибке.
export async function accountSnapshot(accountId: string): Promise<Record<string, unknown>> {
  try {
    const { rows } = await query<Record<string, any>>(
      `SELECT slug, platform, account_type, status, ig_status, session_status,
              coalesce(comments_today,0) AS comments_today,
              egress_country AS proxy_country,
              extract(day from now() - coalesce(created_at, now()))::int AS age_days,
              login_fails
       FROM accounts WHERE id=$1`, [accountId]);
    return rows[0] || {};
  } catch { return {}; }
}

// Аренда одного поста воркером без гонок между репликами:
// FOR UPDATE SKIP LOCKED + отметка locked_at (протухшая аренда переарендуется).
export async function leaseDuePost(now: Date): Promise<Record<string, unknown> | null> {
  const staleLease = new Date(now.getTime() - 10 * 60 * 1000); // 10 минут
  const { rows } = await query(
    `UPDATE posts SET locked_at = $1, status = 'publishing'
     WHERE id = (
       SELECT id FROM posts
       WHERE status = 'approved'
         AND scheduled_at <= $1
         -- ПРОМО-РОЛИКИ ПУБЛИКУЕТ ТОЛЬКО МАК (igpost2 через local_jobs). Урок 01.08: облачный воркер
         -- лизовал их наравне с обычными и открывал ОБЛАЧНЫЙ профиль того же акка, пока мак держал
         -- локальный → два окна на один профиль, ложные failed и порча вердиктов. Не снимать фильтр.
         AND kind IS DISTINCT FROM 'promo'
         AND (locked_at IS NULL OR locked_at < $2)
       ORDER BY scheduled_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [now, staleLease],
  );
  return rows[0] ?? null;
}
