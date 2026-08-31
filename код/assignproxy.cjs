// Выдать акку ПЕРСОНАЛЬНЫЙ click-ip порт (свой sticky-IP) вместо общего базового 10000.
// Делает ровно то, что задумано кнопкой mint + назначение: проверяет порт живым, PATCH'ит прокси на
// GoLogin-профиле, обновляет ig_proxy в БД. Egress НЕ мерит — после прогони: node vegress.cjs <slug>.
// usage: DB_PUBLIC_URL=<pub> node assignproxy.cjs <slug> <port>
const { Client } = require('pg');
const { execFile } = require('node:child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.gologin.com';

async function db(q, p) {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); const r = await c.query(q, p); await c.end(); return r.rows; }
    catch (e) { await c.end().catch(() => {}); if (k === 4) throw e; await sleep(2000); }
  }
}
const curlIp = (proxy) => new Promise((resolve) => {
  execFile('curl', ['-s', '--max-time', '10', '-x', proxy, 'https://api.ipify.org'], { timeout: 12000 }, (_e, out) => {
    const ip = String(out || '').trim(); resolve(/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
  });
});

(async () => {
  const slug = process.argv[2]; const port = Number(process.argv[3]);
  if (!slug || !port) { console.error('usage: node assignproxy.cjs <slug> <port>'); process.exit(1); }

  const rows = await db(
    `SELECT a.id, a.slug, a.gologin_profile_id, a.ig_proxy, a.session_status, g.gologin_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.slug=$1 AND a.platform='comments' AND a.deleted_at IS NULL`, [slug]);
  const acc = rows[0];
  if (!acc) { console.error(`акк ${slug} не найден`); process.exit(1); }
  if (!acc.gologin_profile_id) { console.error(`у ${slug} нет GoLogin-профиля`); process.exit(1); }
  const tok = acc.gologin_token || process.env.GOLOGIN_API_TOKEN;
  if (!tok) { console.error('нет GoLogin-токена'); process.exit(1); }

  // База creds берём из текущего ig_proxy акка (тот же пул click-ip, меняем ТОЛЬКО порт).
  const cur = String(acc.ig_proxy || '');
  const at = cur.lastIndexOf('@');
  const cred = at >= 0 ? cur.slice(0, at) : '';
  const host = at >= 0 ? cur.slice(at + 1).split(':')[0] : 'proxy.click-ip.com';
  const ci = cred.indexOf(':'); const user = cred.slice(0, ci); const pass = cred.slice(ci + 1);
  if (!user || !pass || !host) { console.error(`не разобрал текущий ig_proxy: ${cur}`); process.exit(1); }
  const newProxyStr = `${user}:${pass}@${host}:${port}`;
  console.log(`${slug}: сейчас ${cur.replace(pass, '***')} → станет ${newProxyStr.replace(pass, '***')}`);

  // 1) порт живой?
  const ip = await curlIp(`http://${user}:${pass}@${host}:${port}`);
  if (!ip) { console.error(`✗ порт ${port} не отвечает — не назначаю (возьми другой свободный)`); process.exit(1); }
  console.log(`✓ порт ${port} жив, отдаёт IP ${ip}`);

  // 2) PATCH прокси на GoLogin-профиле (при 403 «running» — гасим сессию и повторяем).
  const spec = { mode: 'http', host, port, username: user, password: pass };
  const patch = () => fetch(`${API}/browser/${encodeURIComponent(acc.gologin_profile_id)}/proxy`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(spec), signal: AbortSignal.timeout(20000),
  });
  let res = await patch();
  if (res.status === 403) {
    console.log('  профиль запущен (403) — гашу сессию и повторяю PATCH…');
    await fetch(`${API}/browser/${acc.gologin_profile_id}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }).catch(() => {});
    await sleep(3000); res = await patch();
  }
  if (!res.ok) { console.error(`✗ GoLogin PATCH proxy HTTP ${res.status} — прокси на профиле НЕ сменился, БД не трогаю`); process.exit(1); }
  console.log(`✓ GoLogin-профиль ${acc.gologin_profile_id}: прокси переключён на порт ${port}`);

  // 3) обновляем ig_proxy в БД (+ сбрасываем egress — он теперь старый, перемерить через vegress).
  await db(`UPDATE accounts SET ig_proxy=$2, proxy_status='unknown', egress_ip=NULL, egress_country=NULL, egress_checked_at=NULL WHERE id=$1`, [acc.id, newProxyStr]);
  console.log(`✓ БД: ig_proxy обновлён, egress сброшен в unknown`);
  console.log(`\nГОТОВО. Теперь подтверди egress:  DB_PUBLIC_URL=<pub> node vegress.cjs ${slug}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
