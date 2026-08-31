// Что за прокси у нас УЖЕ есть, кроме купленных сегодня ISP: собираем из proxy_pool и из карточек
// аккаунтов, приводим к одному виду и проверяем живьём curl'ом. Владелец вспомнил про пачку
// 51.194.246.x — она действительно лежит в базе, но статусы там могли протухнуть, поэтому доверяем
// только реальной проверке, а не полю status.
const { Pool } = require('pg');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Форматы в базе разные: "user:pass@host:port", "host:port:user:pass", иногда с лишним "//"
function norm(raw) {
  let s = String(raw || '').trim().replace(/^(socks5|https?):\/\//i, '').replace(/:\/\//g, ':');
  if (!s) return null;
  if (s.includes('@')) {
    const at = s.lastIndexOf('@');
    const cred = s.slice(0, at), hp = s.slice(at + 1);
    const [h, p] = hp.split(':');
    const i = cred.indexOf(':');
    if (!h || !p) return null;
    return { host: h, port: p, user: cred.slice(0, i), pass: cred.slice(i + 1) };
  }
  const parts = s.split(':');
  if (parts.length >= 4) return { host: parts[0], port: parts[1], user: parts[2], pass: parts.slice(3).join(':') };
  return null;
}
const url = (x) => `http://${x.user}:${x.pass}@${x.host}:${x.port}`;

function check(u) {
  return new Promise((resolve) => {
    const p = spawn('curl', ['-s', '--max-time', '18', '--proxy', u, 'https://ipv4.icanhazip.com']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.trim().match(/^\d+\.\d+\.\d+\.\d+$/) ? out.trim() : null));
  });
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const pp = (await pool.query(`SELECT proxy, country, status, assigned_slug FROM proxy_pool`)).rows;
  const acc = (await pool.query(
    `SELECT DISTINCT ig_proxy proxy FROM accounts WHERE ig_proxy IS NOT NULL AND ig_proxy<>''`)).rows;

  const seen = new Map();
  for (const r of [...pp, ...acc]) {
    const n = norm(r.proxy);
    if (!n) continue;
    const key = `${n.host}:${n.port}`;
    if (!seen.has(key)) seen.set(key, { ...n, country: r.country || '', status: r.status || '', slug: r.assigned_slug || '' });
  }
  const list = [...seen.values()];
  console.log(`НАЙДЕНО УНИКАЛЬНЫХ ПРОКСИ: ${list.length} (proxy_pool ${pp.length}, из карточек акков ${acc.length})\n`);

  const live = [];
  const lanes = 8;
  const q = list.slice();
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (q.length) {
      const x = q.shift();
      const ip = await check(url(x));
      if (ip) { live.push({ ...x, ip }); console.log(`  ✓ ${x.host}:${x.port} ${x.country} → выход ${ip}${x.slug ? ` (числился за ${x.slug})` : ''}`); }
    }
  }));

  console.log(`\nЖИВЫХ: ${live.length} из ${list.length}`);
  fs.writeFileSync('/tmp/old_live_proxies.txt', live.map((x) => `${x.country || 'XX'}|${url(x)}`).join('\n'));
  console.log('живые записаны в /tmp/old_live_proxies.txt');
  await pool.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
