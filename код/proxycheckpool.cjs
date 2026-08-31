// Проверка прокси свободного пула БЕЗ браузера и БЕЗ логинов: curl через прокси акка.
// Зачем отдельно: заход в профиль с мёртвым прокси даёт «Proxy Error», и это легко принять
// за вердикт по аккаунту (ошибка «инструмент врёт про акки», урок igaudit 01.08).
// Сначала выясняем, у кого канал вообще живой, и только этих ведём в браузер.
const { Pool } = require('pg');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

function curlVia(proxy, url, timeoutS = 20) {
  return new Promise((resolve) => {
    const args = ['-s', '-o', '/dev/null', '-w', '%{http_code} %{time_total}', '--max-time', String(timeoutS)];
    if (proxy) args.push('--proxy', proxy);
    args.push('-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', url);
    const p = spawn('curl', args);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const slugs = fs.readFileSync('/tmp/freepool.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const { rows } = await pool.query(
    `SELECT slug, coalesce(ig_login,slug) h, ig_proxy, proxy_status FROM accounts WHERE slug = ANY($1)`, [slugs]);

  const results = [];
  const lanes = 6;
  const q = rows.slice();
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (q.length) {
      const r = q.shift();
      if (!r.ig_proxy) { results.push({ ...r, verdict: 'встроенный GoLogin (в БД прокси нет)' }); continue; }
      const px = r.ig_proxy.startsWith('http') ? r.ig_proxy : `http://${r.ig_proxy}`;
      const a = await curlVia(px, 'https://www.instagram.com/favicon.ico');
      const verdict = a.code !== 0 ? `КАНАЛ МЁРТВ (curl ${a.code})` : `жив, IG отдал ${a.out}`;
      results.push({ ...r, verdict });
    }
  }));

  results.sort((x, y) => x.slug.localeCompare(y.slug));
  console.log('ПРОКСИ СВОБОДНОГО ПУЛА:');
  for (const r of results) console.log(`  ${r.slug.padEnd(12)} @${String(r.h).padEnd(30)} в БД=${r.proxy_status || '—'} → ${r.verdict}`);
  const dead = results.filter((r) => /МЁРТВ/.test(r.verdict));
  const live = results.filter((r) => !/МЁРТВ/.test(r.verdict));
  console.log(`\nживых каналов: ${live.length} | мёртвых: ${dead.length}`);
  fs.writeFileSync('/tmp/proxy_dead.txt', dead.map((r) => r.slug).join('\n'));
  fs.writeFileSync('/tmp/proxy_live.txt', live.map((r) => r.slug).join('\n'));
  console.log('мёртвые → /tmp/proxy_dead.txt, живые → /tmp/proxy_live.txt');
  await pool.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
