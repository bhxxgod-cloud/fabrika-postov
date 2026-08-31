// brandblast.cjs — бренд-бласт топ-левел по СПИСКУ постов профиля. Каждый акк ставит бренд-топ на perAcc постов,
// при action_block свапает на следующего прогретого и ДОДЕЛЫВАЕТ список. Фраза бренд-топа варьируется per-пост (slug+CODE).
// usage: node brandblast.cjs <gridJsonPath> <perAcc=4> [skipCodesCsv]
const { execFileSync } = require('child_process');
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const fs = require('fs');
const GRID = process.argv[2];
const PER = Number(process.argv[3] || 4);
const SKIP = new Set(String(process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean));
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
let codes = JSON.parse(fs.readFileSync(GRID, 'utf8')).filter((c) => !SKIP.has(c));
const brandOne = (slug, code) => {
  const url = `https://www.instagram.com/reel/${code}/`;
  try {
    const out = execFileSync('node', ['vcomment.cjs', slug, url, '0'],
      { cwd: '/Users/qq/Desktop/neironka-poster', encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BRANDTOP: '1' } });
    const m = out.match(/RESULT done=\d+ brand=(\d+) blocked=(\d+)[^\n]*restricted=(\d+)/);
    return m ? { brand: +m[1], blocked: +m[2], restricted: +m[3] } : { brand: 0, blocked: 0, restricted: 0 };
  } catch (e) { const o = (e.stdout || '') + (e.stderr || ''); const m = o.match(/blocked=(\d+)/); return { brand: 0, blocked: m ? +m[1] : 0, restricted: 0 }; }
};
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 25000 });
  await c.connect();
  const pool = (await c.query(`SELECT a.slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live'
       AND coalesce(a.ig_status,'') NOT IN ('action_block','soft_block','captcha','challenge','bad_login','suspended','profile_lost')
       AND a.last_commented_at IS NOT NULL AND (a.shadow_at IS NULL OR a.shadow_at < now()-interval '2 days')
       AND coalesce(a.comments_today,0) < 8
     ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at DESC LIMIT 40`)).rows.map((r) => r.slug);
  await c.end();
  console.log(`БРЕНД-БЛАСТ: постов ${codes.length} | пул прогретых ${pool.length} | по ${PER}/акк`);
  if (!pool.length) { console.log('⛔ нет прогретых акков'); process.exit(3); }
  let pi = 0, ok = 0; const done = []; let acctPosts = 0; let slug = pool[pi];
  console.log(`→ акк ${slug}`);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const r = brandOne(slug, code);
    if (r.brand === 1) { ok++; done.push(`${slug}:${code}`); console.log(`  ✅ ${code} бренд-топ встал (${slug}) [${ok}/${codes.length}]`); acctPosts++; }
    else if (r.blocked) {
      console.log(`  ⛔ ${code} блок акка ${slug} → свап, пост переназначаю`);
      pi++; if (pi >= pool.length) { console.log('пул исчерпан — стоп'); break; }
      slug = pool[pi]; acctPosts = 0; console.log(`→ акк ${slug}`); i--; continue; // тот же пост — новым аккам
    } else if (r.restricted) { console.log(`  ⚠ ${code} restricted/поле не нашлось — пропуск`); }
    else { console.log(`  ⚠ ${code} бренд не встал (не блок) — пропуск`); }
    // ротация акка по лимиту perAcc
    if (acctPosts >= PER && i + 1 < codes.length) {
      pi++; if (pi >= pool.length) { console.log('пул исчерпан на ротации — стоп'); break; }
      slug = pool[pi]; acctPosts = 0; console.log(`→ акк ${slug} (ротация после ${PER})`);
    }
    if (i + 1 < codes.length) execFileSync('sleep', ['30']);
  }
  console.log(`\n==== ИТОГ: бренд-топов встало ${ok}/${codes.length} ====`);
  done.forEach((d) => console.log('  ' + d));
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
