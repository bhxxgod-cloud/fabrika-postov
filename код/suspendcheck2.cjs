// СУСПЕНД-ЧЕК ПО КУКЕ (без браузера, без churn): тянет куки профиля из GoLogin API, дёргает instagram.com
// с сессионной кукой ЧЕРЕЗ прокси акка (curl), смотрит финальный URL — редирект на /accounts/suspended/ = БАН.
// НЕ открывает GoLogin-профиль → не воюет с воркером за сессию (в отличие от suspendcheck.cjs).
// Найденных метит suspended+paused+dead → Фаза-2 снесёт+заменит. usage: DB_PUBLIC_URL=<pub> node suspendcheck2.cjs [slug...]
const { Client } = require('pg');
const { execFile } = require('node:child_process');
const API = 'https://api.gologin.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function db(q, p) { const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 }); await c.connect(); const r = await c.query(q, p); await c.end(); return r.rows; }
const run = (args) => new Promise((res) => execFile('curl', args, { timeout: 30000 }, (_e, out) => res(String(out || ''))));

function proxyUrl(ig_proxy) {
  const s = String(ig_proxy || ''); const at = s.lastIndexOf('@'); if (at < 0) return null;
  const cred = s.slice(0, at), hp = s.slice(at + 1); const ci = cred.indexOf(':');
  return `http://${cred.slice(0, ci)}:${cred.slice(ci + 1)}@${hp}`;
}

(async () => {
  const slugs = process.argv.slice(2);
  const rows = await db(
    `SELECT a.slug, a.gologin_profile_id pid, a.ig_proxy, g.gologin_token tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
       ${slugs.length ? 'AND a.slug = ANY($1)' : "AND coalesce(a.session_status,'')='live'"}
     ORDER BY a.slug`, slugs.length ? [slugs] : []);
  console.log(`Суспенд-чек по куке: ${rows.length} акк(ов) (без браузера)\n`);
  let banned = 0, ok = 0, err = 0;
  for (const a of rows) {
    try {
      // 1) куки профиля из GoLogin
      const cj = await run(['-s', '--max-time', '15', '-H', `Authorization: Bearer ${a.tok}`, `${API}/browser/${a.pid}/cookies`]);
      let cookies; try { cookies = JSON.parse(cj); } catch { console.log(`  … ${a.slug}: куки не отдались`); err++; continue; }
      const ig = (cookies || []).filter((c) => String(c.domain || '').includes('instagram'));
      const sess = ig.find((c) => c.name === 'sessionid');
      if (!sess) { console.log(`  … ${a.slug}: нет sessionid (не залогинен?)`); err++; continue; }
      const cookieHdr = ig.map((c) => `${c.name}=${c.value}`).join('; ');
      const px = proxyUrl(a.ig_proxy);
      // 2) дёргаем IG с кукой через прокси, берём финальный URL
      const args = ['-s', '-o', '/dev/null', '-w', '%{url_effective}', '-L', '--max-time', '22', '-A', UA, '-H', `Cookie: ${cookieHdr}`];
      if (px) args.push('-x', px);
      args.push('https://www.instagram.com/');
      const finalUrl = (await run(args)).trim();
      if (/\/accounts\/suspended|\/accounts\/disabled/i.test(finalUrl)) {
        await db(`UPDATE accounts SET ig_status='suspended', status='paused', session_status='dead', session_checked_at=now() WHERE slug=$1 AND platform='comments' AND deleted_at IS NULL`, [a.slug]);
        console.log(`  ⛔ ${a.slug}: СУСПЕНД  [${finalUrl.replace('https://www.instagram.com', '')}] → помечен (Фаза-2 снесёт+заменит)`);
        banned++;
      } else if (!finalUrl) { console.log(`  … ${a.slug}: пустой ответ (прокси/сеть)`); err++; }
      else { console.log(`  ✓ ${a.slug}: чист  [${finalUrl.replace('https://www.instagram.com', '').slice(0, 40)}]`); ok++; }
    } catch (e) { console.log(`  … ${a.slug}: ошибка ${String(e.message).slice(0, 60)}`); err++; }
    await sleep(400);
  }
  console.log(`\n=== ИТОГ === ⛔ суспенд ${banned} · ✓ чисто ${ok} · … ошибок/скип ${err}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
