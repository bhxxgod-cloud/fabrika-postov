// ПЕРЕВОД ПРОФИЛЯ НА ВСТРОЕННЫЙ ПРОКСИ GOLOGIN.
// Зачем: у купленных FOL-акков прокси в профиле мёртв (curl не проходит), браузер падает на
// «Proxy Error» ещё до Instagram, и это легко принять за вердикт по аккаунту. Так же лечили
// Дарью и Карину: профиль переводится на прокси самого GoLogin.
// Регионы раздаём вразнобой: одна страна на всю пачку связанных акков читается как сетка.
// Запуск: node proxytogologin.cjs <slug|--file /tmp/proxy_dead.txt> [--apply]
const { Pool } = require('pg');
const fs = require('node:fs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REGIONS = ['uk', 'us', 'de'];

function targets() {
  const i = args.indexOf('--file');
  if (i >= 0) return fs.readFileSync(args[i + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  return args.filter((a) => !a.startsWith('--'));
}

(async () => {
  const slugs = targets();
  if (!slugs.length) { console.log('usage: node proxytogologin.cjs <slug…|--file список> [--apply]'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.proxy_status, g.gologin_token tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug = ANY($1) AND a.deleted_at IS NULL`, [slugs]);

  let n = 0;
  for (const [i, r] of rows.entries()) {
    const region = REGIONS[i % REGIONS.length];
    // Токен ГРУППЫ первым: профили заведены под разными аккаунтами GoLogin, и общий токен из
    // переменных сервиса на чужой профиль отвечает 403 «You cannot edit this profile».
    const token = r.tok || process.env.GOLOGIN_API_TOKEN;
    if (!r.pid) { console.log(`  ${r.slug}: нет профиля GoLogin — пропуск`); continue; }
    if (!token) { console.log(`  ${r.slug}: нет токена GoLogin — пропуск`); continue; }
    if (!APPLY) { console.log(`  ${r.slug} @${r.h}: ${r.proxy_status} → gologin_${region} (показ)`); continue; }

    const resp = await fetch(`https://api.gologin.com/browser/${r.pid}/proxy`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'gologin', autoProxyRegion: region }),
    }).catch((e) => ({ ok: false, status: 0, _err: e.message }));

    if (!resp.ok && resp.status !== 204) {
      const body = resp.text ? await resp.text().catch(() => '') : (resp._err || '');
      console.log(`  ${r.slug}: ⛔ GoLogin ответил ${resp.status} ${String(body).slice(0, 120)}`);
      continue;
    }
    // В БД чиним ОДНОВРЕМЕННО: иначе флаг снова начнёт врать про реальное состояние профиля.
    await pool.query(`UPDATE accounts SET ig_proxy=NULL, proxy_status=$2 WHERE slug=$1`, [r.slug, `gologin_${region}`]);
    console.log(`  ${r.slug} @${r.h}: ✓ встроенный прокси GoLogin (${region})`);
    n++;
  }
  console.log(APPLY ? `\nпереведено: ${n} из ${rows.length}` : '\n(показ; для применения добавь --apply)');
  await pool.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
