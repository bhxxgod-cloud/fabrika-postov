// АУДИТ ПРОКСИ МОДЕЛЬНЫХ АККОВ: что реально стоит в профиле GoLogin у каждого.
// Вопрос владельца: «может, прокси плохие?». Проверяем не на словах: тянем конфигурацию профиля
// из API GoLogin и смотрим режим, регион и хост. Опасная картина — несколько наших акков на ОДНОМ
// адресе: тогда Instagram видит их как одну сетку, и бан прилетает независимо от контента.
const { Pool } = require('pg');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query(
    `SELECT a.persona, coalesce(a.ig_login,a.slug) h, a.slug, a.is_spare, coalesce(a.ig_status,'') ig,
            a.gologin_profile_id pid, a.proxy_status, a.ig_proxy, g.gologin_token tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
      WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
      ORDER BY a.persona, a.is_spare`);

  const seen = new Map();
  for (const r of rows) {
    let info = 'нет профиля';
    if (r.pid && r.tok) {
      const resp = await fetch(`https://api.gologin.com/browser/${r.pid}`, {
        headers: { Authorization: `Bearer ${r.tok}` }, signal: AbortSignal.timeout(25000),
      }).catch((e) => ({ ok: false, status: 0, _e: e.message }));
      if (resp.ok) {
        const d = await resp.json();
        const px = d.proxy || {};
        const key = `${px.mode || '?'}:${px.host || px.autoProxyRegion || '?'}:${px.port || ''}`;
        info = `режим=${px.mode || '—'} регион=${px.autoProxyRegion || '—'} хост=${px.host || '—'}:${px.port || '—'}`;
        seen.set(key, [...(seen.get(key) || []), r.h]);
      } else {
        info = `GoLogin ответил ${resp.status}`;
      }
    }
    console.log(`${(r.ig === 'suspended' ? '⛔' : '✓ ')} ${String(r.persona).padEnd(8)} @${String(r.h).padEnd(20)} в БД=${String(r.proxy_status || '—').padEnd(13)} ${info}`);
  }

  console.log('\nСКОЛЬКО АККОВ НА ОДНОМ КАНАЛЕ:');
  for (const [key, list] of seen) {
    console.log(`  ${key}  → ${list.length} акк(ов): ${list.join(', ')}${list.length > 1 ? '   ⚠ общий канал' : ''}`);
  }
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
