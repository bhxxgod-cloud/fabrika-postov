// Какие купленные адреса свободны и годятся к переиспользованию.
// Правило владельца 02.08: адрес можно отдать другому акку, ЕСЛИ на нём не было бана. Если акк на
// этом IP получил suspended — адрес считаем «обожжённым» и больше не даём: IG связывает адрес с
// заблокированным аккаунтом. Неподошедший пароль (bad_credentials) адрес не портит: акк там даже
// не залогинился.
const { Pool } = require('pg');
const fs = require('node:fs');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ours = fs.readFileSync('/tmp/newproxies.txt', 'utf8').split('\n').filter(Boolean)
    .map((l) => { const [name, url] = l.split('|'); return { name, url, ip: (String(url).match(/@([\d.]+):/) || [])[1] }; })
    .filter((x) => x.ip);

  const rows = (await p.query(
    `SELECT coalesce(ig_login,slug) h, slug, ig_proxy, coalesce(ig_status,'') ig, deleted_at
       FROM accounts WHERE ig_proxy LIKE '%@%'`)).rows;

  const byIp = new Map();
  for (const r of rows) {
    const ip = (String(r.ig_proxy).match(/@([\d.]+):/) || [])[1];
    if (!ip) continue;
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(r);
  }

  const free = [];
  console.log('АДРЕСА:');
  for (const px of ours) {
    const list = byIp.get(px.ip) || [];
    const activeLive = list.find((r) => !r.deleted_at && r.ig !== 'suspended');
    const wasBanned = list.some((r) => r.ig === 'suspended');
    let verdict;
    if (activeLive) verdict = `занят: @${activeLive.h}`;
    else if (wasBanned) verdict = '⛔ ОБОЖЖЁН (тут был бан) — не переиспользуем';
    else { verdict = '✓ СВОБОДЕН, годен'; free.push(px); }
    console.log(`  ${String(px.name).padEnd(9)} ${String(px.ip).padEnd(16)} ${verdict}`);
  }
  console.log(`\nГОДНЫХ К ЗАВЕДЕНИЮ: ${free.length}`);
  free.forEach((x) => console.log(`  ${x.name} ${x.url}`));
  fs.writeFileSync('/tmp/free_proxies.txt', free.map((x) => `${x.name}|${x.url}`).join('\n'));
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
