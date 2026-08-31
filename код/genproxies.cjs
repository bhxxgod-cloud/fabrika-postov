// genproxies.cjs — генератор БЕСПЛАТНЫХ прокси для анон-чтения (грид креаторов, шэдоучек).
// Фетчит из публичных источников → валидирует живость (GET через прокси, короткий таймаут, параллельно) →
// пишет живые в anon_proxies.txt (формат тулов) + upsert в proxy_pool (country='FREE', status='anon') для панели.
// usage: node genproxies.cjs [хочу_живых=40] [источник_лимит=400]
// ВАЖНО: бесплатные датацентр-прокси для IG живут недолго и часто режутся — гнать по кнопке РЕГУЛЯРНО (обновление).
const fs = require('fs');
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const WANT = Number(process.argv[2] || 40);
const CAP = Number(process.argv[3] || 400);
const ANON_FILE = '/Users/qq/Desktop/neironka-poster/anon_proxies.txt';
const TEST_URL = 'https://api.ipify.org?format=json'; // лёгкая проверка живости
const SRCS = [
  'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&timeout=8000',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchList(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    return t.split(/\s+/).map((s) => s.trim()).filter((s) => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s));
  } catch { return []; }
}
// проверка одного прокси через curl (в системе есть, пакеты не нужны): 200 = живой
const { execFile } = require('child_process');
function alive(hostport) {
  return new Promise((res) => {
    execFile('curl', ['-s', '-x', `http://${hostport}`, '--max-time', '8', '-o', '/dev/null', '-w', '%{http_code}', TEST_URL],
      { timeout: 10000 }, (err, stdout) => res(!err && String(stdout).trim() === '200'));
  });
}
(async () => {
  // 1) собрать кандидатов
  const seen = new Set();
  for (const s of SRCS) { for (const p of await fetchList(s)) { if (seen.size < CAP) seen.add(p); } }
  const cand = [...seen];
  console.log(`кандидатов собрано: ${cand.length} (из ${SRCS.length} источников)`);
  // 2) валидировать параллельно пачками, пока не наберём WANT живых
  const live = [];
  const CONC = 40;
  for (let i = 0; i < cand.length && live.length < WANT; i += CONC) {
    const batch = cand.slice(i, i + CONC);
    const res = await Promise.all(batch.map((p) => alive(p).then((ok) => (ok ? p : null))));
    for (const p of res) if (p) live.push(p);
    process.stdout.write(`\r  проверено ${Math.min(i + CONC, cand.length)}/${cand.length} · живых ${live.length}/${WANT}   `);
  }
  console.log(`\nживых прокси: ${live.length}`);
  if (!live.length) { console.log('⚠ ни одного живого — источники пусты/зарезаны, попробуй позже'); process.exit(3); }
  // 3) записать в anon_proxies.txt (формат тулов: "http host:port" без auth)
  fs.writeFileSync(ANON_FILE, live.map((p) => `http ${p}`).join('\n') + '\n');
  console.log(`✍ anon_proxies.txt обновлён: ${live.length} прокси`);
  // 4) upsert в proxy_pool для панели (country='FREE', status='anon')
  try {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000, query_timeout: 20000 });
    await c.connect();
    await c.query(`DELETE FROM proxy_pool WHERE country='FREE'`).catch(() => {});
    for (const p of live) await c.query(`INSERT INTO proxy_pool(proxy,country,status,created_at) VALUES($1,'FREE','anon',now()) ON CONFLICT DO NOTHING`, [`http ${p}`]).catch(() => {});
    await c.end();
    console.log('✍ proxy_pool обновлён (country=FREE)');
  } catch (e) { console.log('proxy_pool не обновлён:', e.message); }
  console.log(`ГОТОВО: ${live.length} живых бесплатных прокси`);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
