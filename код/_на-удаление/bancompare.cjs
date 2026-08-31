// Сравнение забаненных и живых модельных акков: ищем, что общего у погибших.
// Смысл: «банит объёмом» и «банит контентом» уже опровергнуто (умерли акки с НУЛЁМ постов,
// выжили те, что публиковали), значит причина в чём-то другом — возрасте, оформлении, прокси.
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await p.query(
    `SELECT a.persona, coalesce(a.ig_login,a.slug) h, a.is_spare, coalesce(a.ig_status,'') ig,
            to_char(a.created_at,'DD.MM HH24:MI') created,
            to_char(a.dressed_at,'DD.MM HH24:MI') dressed,
            to_char(a.nick_changed_at,'DD.MM HH24:MI') nick,
            coalesce(a.proxy_status,'—') px,
            (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published') posts
       FROM accounts a WHERE a.platform='promo' AND a.deleted_at IS NULL
      ORDER BY (coalesce(a.ig_status,'')='suspended') DESC, a.persona, a.is_spare`);
  console.log('аккаунт                бан  заведён       оформлен      ник сменён    прокси         постов');
  for (const x of r.rows) {
    console.log(
      String(x.h).padEnd(23) +
      (x.ig === 'suspended' ? 'ДА ' : 'нет').padEnd(5) +
      String(x.created || '—').padEnd(14) +
      String(x.dressed || '—').padEnd(14) +
      String(x.nick || '—').padEnd(14) +
      String(x.px).padEnd(15) +
      x.posts);
  }
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
