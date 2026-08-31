// ЗАВЕДЕНИЕ НОВОГО АККА: строка в БД + облачный профиль GoLogin + встроенный прокси GoLogin.
// Под брендовые модели (группа «БРЕНДБУК ЛИЦА»). Куки не трогаем — их снимет вход/igsnapcookies.
// Почему встроенный прокси GoLogin: купленные sticky у старой партии мертвы, а на gologin_uk
// стабильно живут Дарья и Карина (проверено 01.08).
//
// usage: node addacct.cjs <login> <password> <totp-secret> [group_id]
//        node addacct.cjs --file /path/creds.txt        (строки: login<TAB|пробел>pass<TAB|пробел>totp)
const { Client } = require('pg');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const API = 'https://api.gologin.com';
const GROUP = process.env.GROUP_ID || 'a5a3ba3f-708b-4e8d-9111-e1a31e525da7'; // БРЕНДБУК ЛИЦА
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function addOne(c, tok, { login, pass, totp }) {
  const secret = String(totp || '').replace(/\s+/g, '').toUpperCase();
  // 1) строка в БД (идемпотентно: повтор не плодит дубли)
  const ins = await c.query(
    `INSERT INTO accounts (platform, slug, ig_login, ig_password, totp_secret, gender, status, group_id, tracking_code)
     VALUES ('comments',$1,$1,$2,$3,'female','warming',$4, substr(md5(random()::text),1,6))
     ON CONFLICT (platform, slug) DO UPDATE SET ig_login=excluded.ig_login, ig_password=excluded.ig_password,
       totp_secret=excluded.totp_secret, group_id=excluded.group_id
     RETURNING id, gologin_profile_id`, [login, pass, secret || null, GROUP]);
  const row = ins.rows[0];
  if (row.gologin_profile_id) return { login, id: row.id, pid: row.gologin_profile_id, note: 'профиль уже был' };

  // 2) облачный профиль GoLogin (сервер сам генерит валидный фингерпринт)
  const r = await fetch(`${API}/browser/quick`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ os: 'win', name: login }), signal: AbortSignal.timeout(30000),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`создание профиля HTTP ${r.status}: ${body.slice(0, 120)}`);
  const pid = String((JSON.parse(body).id) || (JSON.parse(body)._id) || '');
  if (!pid) throw new Error('GoLogin не вернул id профиля');

  // 3) встроенный прокси GoLogin (UK) — тот же, на котором живут рабочие акки
  const pr = await fetch(`${API}/browser/${pid}/proxy`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'gologin', autoProxyRegion: 'uk' }), signal: AbortSignal.timeout(20000),
  });
  await c.query(`UPDATE accounts SET gologin_profile_id=$2, proxy_status='gologin_uk' WHERE id=$1`, [row.id, pid]);
  return { login, id: row.id, pid, note: `профиль создан, прокси HTTP ${pr.status}` };
}

(async () => {
  let creds = [];
  if (process.argv[2] === '--file') {
    creds = fs.readFileSync(process.argv[3], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const p = l.split(/\s+/);
      return { login: p[0], pass: p[1], totp: p.slice(2).join('') };
    });
  } else if (process.argv[2] && process.argv[3]) {
    creds = [{ login: process.argv[2], pass: process.argv[3], totp: process.argv.slice(4).join('') }];
  } else { console.log('usage: node addacct.cjs <login> <pass> <totp> | --file creds.txt'); process.exit(1); }

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, statement_timeout: 25000 });
  await c.connect();
  const tok = (await c.query(`SELECT gologin_token FROM account_groups WHERE id=$1`, [GROUP])).rows[0]?.gologin_token;
  if (!tok) { console.log('у группы нет gologin_token'); await c.end(); process.exit(1); }
  console.log(`ЗАВОЖУ ${creds.length} акк(ов) в группу БРЕНДБУК ЛИЦА\n`);
  let ok = 0;
  for (const cr of creds) {
    try { const r = await addOne(c, tok, cr); ok++; console.log(`  ✅ @${r.login} · профиль ${String(r.pid).slice(0, 10)}… · ${r.note}`); }
    catch (e) { console.log(`  ✗ @${cr.login}: ${String(e.message).slice(0, 120)}`); }
    await sleep(1200);
  }
  console.log(`\nГОТОВО: ${ok}/${creds.length}. Дальше: вход (dressup/chlogin) → куки снимутся сами.`);
  await c.end();
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
