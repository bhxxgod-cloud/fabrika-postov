// РЕЛОГИН НА GoLogin-FREE ПРОКСИ. ClickIP сдох → ставим встроенный бесплатный прокси GoLogin (mode:gologin) на
// профиль + чистим мёртвый ig_proxy в БД (иначе воркер вернёт дохлый ClickIP на профиль) + логиним chlogin'ом.
// ВНИМАНИЕ: GoLogin-free = датацентр/общие IP → для IG рискованно (баны). Тест на малом батче.
// Запуск: DB_PUBLIC_URL=… node reloginfree.cjs [сколько] [регион us/de/…]
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 8);
const REGION = process.argv[3] || 'us';
const GAP = Number(process.env.GAP_SEC || 25) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chlogin(slug) {
  return new Promise((res) => {
    const out = fs.openSync(`/tmp/free_${slug}.txt`, 'w');
    const p = spawn('node', [path.join(__dirname, 'chlogin.cjs'), slug], { cwd: __dirname, env: { ...process.env, DB_PUBLIC_URL: DBURL, SHOT_DIR: process.env.SHOT_DIR || '/tmp', LOCAL: '1', GL_LOCAL: '1' }, stdio: ['ignore', out, out] });
    const t = setTimeout(() => { try { p.kill(); } catch { /* */ } res('timeout'); }, 180000);
    p.on('exit', () => { clearTimeout(t); fs.closeSync(out); res('done'); });
  });
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const rows = (await c.query(`SELECT a.id, a.slug, a.gologin_profile_id pid, g.gologin_token tok
    FROM accounts a JOIN account_groups g ON g.id=a.group_id
    WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL
      AND coalesce(a.ig_password,'')<>'' AND g.gologin_token IS NOT NULL
      AND coalesce(a.session_status,'')<>'live'
    ORDER BY a.last_commented_at DESC NULLS LAST LIMIT $1`, [LIMIT])).rows;
  console.log(`[free] кандидатов: ${rows.length}, регион ${REGION}\n`);
  const tally = { ok: 0, fail: 0, err: 0 };
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    process.stdout.write(`[${i + 1}/${rows.length}] ${a.slug.padEnd(20)} `);
    try {
      // 1) GoLogin free proxy на профиль
      const r = await fetch(`https://api.gologin.com/browser/${a.pid}/proxy`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + a.tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'gologin', autoProxyRegion: REGION }), signal: AbortSignal.timeout(20000) });
      if (r.status >= 300) { console.log(`⛔ PATCH proxy HTTP ${r.status}`); tally.err++; continue; }
      // 2) чистим мёртвый ig_proxy в БД (чтоб воркер не вернул ClickIP на профиль) + метка
      await c.query(`UPDATE accounts SET ig_proxy=NULL, proxy_status='gologin_free' WHERE id=$1`, [a.id]).catch(() => {});
      // 3) логин
      await chlogin(a.slug);
      const st = (await c.query(`SELECT coalesce(session_status,'-') ss, coalesce(ig_status,'-') igs FROM accounts WHERE id=$1`, [a.id])).rows[0];
      const ok = st.ss === 'live' && st.igs === 'login_ok';
      console.log(ok ? `✅ ВОШЁЛ (${st.ss}/${st.igs})` : `✗ не вошёл (${st.ss}/${st.igs})`);
      ok ? tally.ok++ : tally.fail++;
    } catch (e) { console.log('ERR', (e.message || '').slice(0, 40)); tally.err++; }
    if (i < rows.length - 1) await sleep(GAP);
  }
  await c.end();
  console.log(`\n[free] ИТОГ: вошли ${tally.ok}, не вошли ${tally.fail}, ошибок ${tally.err}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
