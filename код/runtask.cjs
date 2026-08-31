// runtask.cjs — ОРКЕСТРАТОР авто-замены: держит цель N ответов на посту, тянет пул ПРОГРЕТЫХ акков (с историей,
// живые, не в блоке, не в тени, малая дневная нагрузка), при блоке/провале акка свапает следующего и ДОДЕЛЫВАЕТ таск.
// usage: node runtask.cjs <reelURL> <target> [perAcc=2] [brand=1]
// env: DB_PUBLIC_URL, OPENROUTER_API_KEY, SHOT_DIR + всё что нужно vcomment (CTA_POST, FRESH_MAX, GL_LOCAL...).
const { execFileSync } = require('child_process');
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const fs = require('fs');
const URL = process.argv[2];
const TARGET = Number(process.argv[3] || 6);
const PER = Number(process.argv[4] || 2);
const BRAND = String(process.argv[5] ?? '1') === '1';
const BRAND_ACC = process.env.BRAND_ACC || 'whitmore_evangeline';
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const CODE = (String(URL).match(/\/(?:p|reel|reels)\/([^/?]+)/) || [])[1] || URL;
const runVc = (slug, n, extraEnv = {}) => {
  try {
    return execFileSync('node', ['vcomment.cjs', slug, URL, String(n)],
      { cwd: '/Users/qq/Desktop/neironka-poster', encoding: 'utf8', timeout: 360000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  } catch (e) { return (e.stdout || '') + '\n' + (e.stderr || '') + '\nRESULT done=0 brand=0 blocked=0'; }
};
const parse = (out) => {
  const m = out.match(/RESULT done=(\d+) brand=(\d+) blocked=(\d+)[^\n]*restricted=(\d+)/);
  return m ? { done: +m[1], brand: +m[2], blocked: +m[3], restricted: +m[4] } : { done: 0, brand: 0, blocked: 0, restricted: 0 };
};
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 25000 });
  await c.connect();
  // ПУЛ прогретых работяг: история есть, живой, не в блоке/тени; малая нагрузка сегодня — вперёд.
  const pool = (await c.query(`SELECT a.slug FROM accounts a JOIN account_groups g ON g.id=a.group_id
     WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live'
       AND coalesce(a.ig_status,'') NOT IN ('action_block','soft_block','captcha','challenge','bad_login','suspended','profile_lost')
       AND a.last_commented_at IS NOT NULL
       AND (a.shadow_at IS NULL OR a.shadow_at < now()-interval '2 days')
       AND coalesce(a.comments_today,0) < 9
     ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at DESC LIMIT 40`)).rows.map((r) => r.slug);
  await c.end();
  console.log(`ЗАДАЧА: пост ${CODE} | цель ${TARGET} ответов | пул прогретых ${pool.length} | по ${PER}/акк`);
  if (!pool.length) { console.log('⛔ нет прогретых акков в пуле — задачу выполнить нечем'); process.exit(3); }
  let total = 0, zeroStreak = 0; const used = [], blockedAcc = [];
  for (let i = 0; i < pool.length && total < TARGET; i++) {
    const slug = pool[i];
    const need = Math.min(PER, TARGET - total);
    const r = parse(runVc(slug, need));
    total += r.done;
    used.push(`${slug}:${r.done}${r.blocked ? '⛔' : ''}`);
    if (r.blocked) blockedAcc.push(slug);
    console.log(`[${slug}] done=${r.done} blocked=${r.blocked} restricted=${r.restricted} → всего ${total}/${TARGET}`);
    if (r.restricted) { console.log('⛔ пост restricted — стоп'); break; }
    // пост исчерпан: 2 акка подряд дали 0 БЕЗ блока (не блок акка, а нет целей) → стоп
    if (!r.blocked && r.done === 0) { if (++zeroStreak >= 2) { console.log('пост исчерпан (2 акка подряд 0 без блока) — стоп'); break; } }
    else zeroStreak = 0;
    if (total < TARGET && i + 1 < pool.length) execFileSync('sleep', ['35']);
  }
  let brandRes = null;
  if (BRAND && total > 0) {
    console.log(`\n★ БРЕНД-ТОП: ${BRAND_ACC} (N=0)`);
    brandRes = parse(runVc(BRAND_ACC, 0, { BRANDTOP: '1' }));
    console.log(`  бренд: ${brandRes.brand === 1 ? '✅ встал' : '⚠ не встал'}`);
  }
  console.log(`\n==== ИТОГ: ${total}/${TARGET} ответов | бренд=${brandRes ? brandRes.brand : '-'} | акки: ${used.join(', ')} | блокнуто: ${blockedAcc.join(',') || 'нет'} ====`);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
