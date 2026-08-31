// ЖУРНАЛ БЛОКЕРОВ АККАУНТА (07.08, приказ начальника: «нужно чтобы ты выписывал эти ошибки и
// передавал в базу»).
//
// ЗАЧЕМ. Знание о том, что мешает аккаунту, жило в переписке и в моей голове. Пример, который это
// и вскрыл: описание профиля не сохранялось, потому что Instagram не даёт править профиль без
// подтверждённой почты. Я это знал, база нет, поэтому каждый новый прогон и каждый другой чат
// натыкались на ту же стену заново и списывали её на «скрипт не работает». Теперь у каждого акка
// есть список КОНКРЕТНЫХ блокеров: код, человеческое пояснение, что именно он мешает делать, когда
// найден и чем снят. Это видно всем: скриптам, панели, другим чатам, и вопрос «почему нет ника»
// получает ответ из базы, а не из моей памяти.
//
// Использование из кода:
//   const B = require('./blockers.cjs');
//   await B.add({ slug, kind: 'no_email', detail: 'IG требует подтверждённую почту', blocks: ['bio','nick'] });
//   await B.resolve({ slug, kind: 'no_email', by: 'начальник добавил почту 07.08' });
//   const list = await B.live(slug);        // живые блокеры одного акка
//
// CLI:
//   node blockers.cjs                       все живые блокеры по ферме
//   node blockers.cjs <slug|ник>            блокеры одного акка, включая снятые
//   node blockers.cjs add <slug> <kind> "пояснение" [что_мешает,через,запятую]
//   node blockers.cjs resolve <slug> <kind> "чем снят"
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

// Известные коды. Список открытый, но эти встречаются постоянно, и пояснения к ним стоят опыта.
const KINDS = {
  no_email: 'нет подтверждённой почты: IG не даёт править профиль (ни ник, ни био)',
  junk_nick: 'ник остался мусорным от прежнего владельца',
  no_bio: 'описание профиля пустое',
  no_avatar: 'нет аватарки или стоит чужое лицо',
  foreign_feed: 'в ленте посты прежнего владельца, профиль читается как перепроданный',
  foreign_owner: 'аккаунтом пользуется настоящий владелец, трогать нельзя',
  need_login: 'куки мертвы, нужен вход руками',
  wrong_password: 'пароль в базе неверный, автовход невозможен',
  restricted: 'ограничение от Instagram',
  ui_no_create: 'не открывается мастер создания поста',
  profile_blank: 'профиль не отрисовывается, Instagram отдаёт пустую страницу',
};

async function withDb(fn) {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

async function accId(c, key) {
  const r = await c.query(
    `SELECT id, coalesce(ig_login, slug) h FROM accounts
      WHERE deleted_at IS NULL AND (slug = $1 OR ig_login = $1 OR coalesce(ig_login,slug) = $1) LIMIT 1`, [key]);
  if (!r.rowCount) throw new Error(`акк не найден: ${key}`);
  return r.rows[0];
}

// Повторный add не плодит дубли: живой блокер того же вида обновляется (уникальный индекс).
async function add({ slug, kind, detail, blocks = [], client }) {
  const run = async (c) => {
    const a = await accId(c, slug);
    await c.query(
      `INSERT INTO account_blockers (account_id, kind, detail, blocks) VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id, kind) WHERE resolved_at IS NULL
       DO UPDATE SET detail = excluded.detail, blocks = excluded.blocks`,
      [a.id, kind, detail || KINDS[kind] || null, blocks]);
    return a.h;
  };
  return client ? run(client) : withDb(run);
}

async function resolve({ slug, kind, by = 'снят', client }) {
  const run = async (c) => {
    const a = await accId(c, slug);
    const r = await c.query(
      `UPDATE account_blockers SET resolved_at = now(), resolved_by = $3
        WHERE account_id = $1 AND kind = $2 AND resolved_at IS NULL RETURNING id`, [a.id, kind, by]);
    return r.rowCount;
  };
  return client ? run(client) : withDb(run);
}

async function live(slug, client) {
  const run = async (c) => {
    const a = await accId(c, slug);
    return (await c.query(
      `SELECT kind, detail, blocks, found_at FROM account_blockers
        WHERE account_id = $1 AND resolved_at IS NULL ORDER BY found_at`, [a.id])).rows;
  };
  return client ? run(client) : withDb(run);
}

// Мешает ли что-то конкретному действию: blocked(slug, 'post') → список блокеров или пустой массив.
async function blocked(slug, action, client) {
  const rows = await live(slug, client);
  return rows.filter((r) => !r.blocks || !r.blocks.length || r.blocks.includes(action));
}

module.exports = { add, resolve, live, blocked, KINDS };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'add') {
      const [slug, kind, detail, blocks] = rest;
      const h = await add({ slug, kind, detail, blocks: (blocks || '').split(',').filter(Boolean) });
      console.log(`блокер «${kind}» записан на ${h}`);
    } else if (cmd === 'resolve') {
      const [slug, kind, by] = rest;
      const n = await resolve({ slug, kind, by });
      console.log(n ? `блокер «${kind}» снят` : 'живого блокера с таким кодом не было');
    } else if (cmd) {
      const rows = await withDb(async (c) => {
        const a = await accId(c, cmd);
        return (await c.query(
          `SELECT kind, detail, blocks, to_char(found_at,'DD.MM HH24:MI') found,
                  coalesce(to_char(resolved_at,'DD.MM HH24:MI'),'—') resolved, coalesce(resolved_by,'—') by
             FROM account_blockers WHERE account_id=$1 ORDER BY found_at DESC`, [a.id])).rows;
      });
      console.table(rows);
    } else {
      const rows = await withDb(async (c) => (await c.query(
        `SELECT coalesce(a.ig_login,a.slug) h, b.kind, left(coalesce(b.detail,''),58) detail,
                array_to_string(b.blocks,',') blocks, to_char(b.found_at,'DD.MM HH24:MI') found
           FROM account_blockers b JOIN accounts a ON a.id=b.account_id
          WHERE b.resolved_at IS NULL AND a.deleted_at IS NULL
          ORDER BY h, b.found_at`)).rows);
      console.log(`ЖИВЫХ БЛОКЕРОВ: ${rows.length}`);
      console.table(rows);
    }
    process.exit(0);
  })().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
}
