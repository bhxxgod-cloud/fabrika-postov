// Повесить ЛЮБОЙ прокси на GoLogin-профиль акка (для безлим-траф прокси под радар/воркеры).
// Форматы прокси: "user:pass@host:port" | "http://user:pass@host:port" | "host:port:user:pass" | "user pass host port".
// Проверяет живость curl'ом, PATCH'ит профиль в GoLogin, пишет ig_proxy в БД.
// usage: DB_PUBLIC_URL=<pub> node setproxy.cjs <slug> "<proxy>"
const { Client } = require('pg');
const { execFile } = require('node:child_process');
const API = 'https://api.gologin.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseProxy(raw) {
  let s = String(raw || '').trim();
  let mode = 'http';
  const sch = s.match(/^(https?|socks[45]?):\/\//i);
  if (sch) { mode = /socks/i.test(sch[1]) ? 'socks5' : 'http'; s = s.slice(sch[0].length); }
  // "user pass host port" (пробелы)
  if (/^\S+\s+\S+\s+\S+\s+\d+$/.test(s)) { const p = s.split(/\s+/); return { mode, username: p[0], password: p[1], host: p[2], port: Number(p[3]) }; }
  const at = s.lastIndexOf('@');
  if (at >= 0) { const cred = s.slice(0, at), hp = s.slice(at + 1); const ci = cred.indexOf(':'); const [h, pt] = hp.split(':'); return { mode, username: cred.slice(0, ci), password: cred.slice(ci + 1), host: h, port: Number(pt) }; }
  // "host:port:user:pass"
  const p = s.split(':'); return { mode, host: p[0], port: Number(p[1]), username: p[2] || '', password: p.slice(3).join(':') || '' };
}
async function db(q, p) { const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); const r = await c.query(q, p); await c.end(); return r.rows; }
const curlIp = (px) => new Promise((res) => execFile('curl', ['-s', '--max-time', '12', '-x', px, 'https://api.ipify.org'], { timeout: 14000 }, (_e, o) => { const ip = String(o || '').trim(); res(/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null); }));

(async () => {
  const slug = process.argv[2], raw = process.argv[3];
  if (!slug || !raw) { console.error('usage: node setproxy.cjs <slug> "<proxy>"'); process.exit(1); }
  const px = parseProxy(raw);
  if (!px.host || !px.port) { console.error('не распарсил прокси:', raw); process.exit(1); }
  const proxyStr = `http://${px.username}:${px.password}@${px.host}:${px.port}`;
  const rows = await db(`SELECT a.id, a.gologin_profile_id, g.gologin_token FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL`, [slug]);
  const acc = rows[0];
  if (!acc) { console.error('акк не найден:', slug); process.exit(1); }
  if (!acc.gologin_profile_id) { console.error('нет GoLogin-профиля у', slug); process.exit(1); }
  const tok = acc.gologin_token || process.env.GOLOGIN_API_TOKEN;
  console.log(`проверяю прокси ${px.host}:${px.port} …`);
  const ip = await curlIp(proxyStr);
  console.log(ip ? `  жив, egress-IP ${ip}` : '  ⚠ curl не подтвердил (вешаю всё равно — может, curl режется)');
  const res = await fetch(`${API}/browser/${encodeURIComponent(acc.gologin_profile_id)}/proxy`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: px.mode, host: px.host, port: px.port, username: px.username, password: px.password }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) { console.error('GoLogin PATCH proxy HTTP', res.status, (await res.text().catch(() => '')).slice(0, 120)); process.exit(1); }
  await db(`UPDATE accounts SET ig_proxy=$2, egress_ip=$3, egress_checked_at=now() WHERE id=$1`, [acc.id, `${px.username}:${px.password}@${px.host}:${px.port}`, ip]);
  console.log(`✓ ${slug}: прокси повешен на профиль + записан в БД${ip ? ` (IP ${ip})` : ''}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
