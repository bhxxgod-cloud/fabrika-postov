// MASS100 — гоним ВСЕ живые акки (приоритет: кто раньше всего комментил) по пулу постов, по 5 постов на акк,
// бренд-бот @gener7_bot, локально (0 облачных часов). Цель ~100 комментов. Каждый акк: 1 сессия → 5 постов.
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PER = Number(process.env.PER || 5);
const CODES = [
  'Da3bcJLRT41', 'DYNS5uoMxyk', 'DZhnEVhiC0z', 'DZ7O-FNs_-u', 'DZQe5pIIP-C', 'DYKyuzojW7v', 'DXqesRAiO5s',
  'DYgz20GJUV0', 'DXgcSkqDQfL', 'DDl1xtYRRos', 'Da_NdNhxWGe', 'DbABrgcI7CZ', 'Da22NpYIesv', 'DYH5SkPM2fr',
  'DbGC7ElCKAP', 'DaQDgmgM_F-', 'DZ7t1a3oYPF', 'Da5nHB4IbKf', 'DXrmgoNjIjQ', 'DbC8nSIMiUC', 'DYGgEWyiQpf',
  'Da5hlmujNPm', 'Da_KK5FhP1r', 'Da5fTXHIkm4',
];
const URL = (code) => `https://www.instagram.com/p/${code}/`;
function brand(slug, urls) {
  return new Promise((res) => {
    const p = spawn('node', [path.join(__dirname, 'brandbatch.cjs'), slug, urls], { cwd: __dirname, env: { ...process.env, DB_PUBLIC_URL: DBURL, SHOT_DIR: process.env.SHOT_DIR || '/tmp' } });
    let buf = ''; p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); }); p.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* */ } res(buf); }, 12 * 60000);
    p.on('close', () => { clearTimeout(t); res(buf); });
  });
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const accs = (await c.query(`SELECT slug FROM accounts WHERE platform='comments' AND deleted_at IS NULL
    AND session_status='live' AND coalesce(ig_status,'')='login_ok' AND gologin_profile_id IS NOT NULL
    ORDER BY last_commented_at ASC NULLS FIRST, slug`)).rows.map((r) => r.slug);
  await c.end();
  console.log(`[mass100] акков: ${accs.length}, постов в пуле: ${CODES.length}, по ${PER}/акк → цель ~${accs.length * PER} комментов\n`);
  const CONC = Number(process.env.CONC || 3); // 3 окна Orbita параллельно
  let total = 0, next = 0, stop = false;
  async function worker(w) {
    while (!stop && next < accs.length) {
      const i = next++;
      const picks = [];
      for (let k = 0; k < PER; k++) picks.push(CODES[(i * PER + k) % CODES.length]);
      console.log(`\n=== [окно${w}] [${i + 1}/${accs.length}] ${accs[i]} → ${picks.join(', ')} ===`);
      const out = await brand(accs[i], picks.map(URL).join(','));
      total += (out.match(/✅/g) || []).length;
      console.log(`[mass100] накоплено ✅ комментов: ${total}`);
      if (total >= 100) { stop = true; console.log('[mass100] ЦЕЛЬ 100 достигнута 🎉'); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w + 1)));
  console.log(`\n[mass100] ИТОГ: ${total} бренд-комментов ушло`);
  process.exit(0);
})().catch((e) => { console.error('[mass100] FATAL', e.message); process.exit(1); });
