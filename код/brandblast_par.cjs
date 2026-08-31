// brandblast_par.cjs — ПАРАЛЛЕЛЬНЫЙ бренд-бласт: N воркеров разом (N профилей одновременно, cap GoLogin ~7).
// Каждый воркер = свой АКК + свой ЧАНК кодов + свой РЕЗЕРВ (disjoint, чтобы не было двойных сессий на профиль).
// Оркестратор: node brandblast_par.cjs <gridJson> <perAcc> <conc> [skipCsv]
// Воркер (внутр.): node brandblast_par.cjs --worker <codesJson> <accsJson> <wid>
const { execFileSync, spawn } = require('child_process');
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

function brandOne(slug, code) {
  const url = `https://www.instagram.com/reel/${code}/`;
  try {
    const out = execFileSync('node', ['vcomment.cjs', slug, url, '0'],
      { cwd: '/Users/qq/Desktop/neironka-poster', encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BRANDTOP: '1' } });
    const m = out.match(/RESULT done=\d+ brand=(\d+) blocked=(\d+)[^\n]*restricted=(\d+)/);
    return m ? { brand: +m[1], blocked: +m[2], restricted: +m[3] } : { brand: 0, blocked: 0, restricted: 0 };
  } catch (e) { const o = (e.stdout || '') + (e.stderr || ''); const m = o.match(/blocked=(\d+)/); return { brand: 0, blocked: m ? +m[1] : 0, restricted: 0 }; }
}

// === РЕЖИМ ВОРКЕРА ===
if (process.argv[2] === '--worker') {
  const codes = JSON.parse(process.argv[3]);
  const accs = JSON.parse(process.argv[4]); // [primary, ...reserve]
  const wid = process.argv[5];
  let ai = 0, slug = accs[0];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const r = brandOne(slug, code);
    if (r.brand === 1) { console.log(`[w${wid}] ✅ ${code} (${slug})`); }
    else if (r.blocked) {
      console.log(`[w${wid}] ⛔ ${code} блок ${slug} → свап`);
      ai++; if (ai >= accs.length) { console.log(`[w${wid}] резерв исчерпан — стоп`); break; }
      slug = accs[ai]; i--; continue;
    } else console.log(`[w${wid}] ⚠ ${code} не встал (${slug})`);
    if (i + 1 < codes.length) execFileSync('sleep', ['25']);
  }
  console.log(`[w${wid}] готов`);
  return;
}

// === РЕЖИМ ОРКЕСТРАТОРА ===
(async () => {
  const GRID = process.argv[2]; const PER = Number(process.argv[3] || 4); const CONC = Number(process.argv[4] || 5);
  const SKIP = new Set(String(process.argv[5] || '').split(',').map((s) => s.trim()).filter(Boolean));
  let codes = JSON.parse(fs.readFileSync(GRID, 'utf8')).filter((c) => !SKIP.has(c));
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 25000 });
  await c.connect();
  const pool = (await c.query(`SELECT a.slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live'
       AND coalesce(a.ig_status,'') NOT IN ('action_block','soft_block','captcha','challenge','bad_login','suspended','profile_lost')
       AND a.last_commented_at IS NOT NULL AND (a.shadow_at IS NULL OR a.shadow_at < now()-interval '2 days')
       AND coalesce(a.comments_today,0) < 8 AND a.slug <> 'FOL_384'
     ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at DESC LIMIT 40`)).rows.map((r) => r.slug);
  await c.end();
  const N = Math.min(CONC, Math.ceil(codes.length / 1), pool.length);
  console.log(`ПАРАЛЛЕЛЬНЫЙ БРЕНД-БЛАСТ: постов ${codes.length} | воркеров ${N} | пул ${pool.length} | резерв/воркер 2`);
  // чанки кодов
  const chunks = Array.from({ length: N }, () => []);
  codes.forEach((code, i) => chunks[i % N].push(code));
  // аккам: каждому воркеру disjoint слайс из 3 (primary + 2 резерв)
  const workers = [];
  for (let w = 0; w < N; w++) {
    const accs = pool.slice(w * 3, w * 3 + 3);
    if (!accs.length) break;
    console.log(`  воркер ${w}: ${chunks[w].length} постов, акк ${accs[0]} (+резерв ${accs.slice(1).join(',') || '—'})`);
    workers.push(new Promise((res) => {
      const p = spawn('node', ['brandblast_par.cjs', '--worker', JSON.stringify(chunks[w]), JSON.stringify(accs), String(w)],
        { cwd: '/Users/qq/Desktop/neironka-poster', stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
      p.on('close', () => res());
    }));
  }
  await Promise.all(workers);
  console.log('\n==== ПАРАЛЛЕЛЬНЫЙ БЛАСТ ЗАВЕРШЁН ====');
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
