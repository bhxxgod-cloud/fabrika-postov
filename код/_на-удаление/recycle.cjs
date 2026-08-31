// recycle.cjs — пересоздать акк с НУЛЯ: новый GoLogin-профиль + новая sticky ClickIP-прокси (свободный порт) + обновить БД.
// Для recycle-цикла (bad_creds/soft-block на старых условиях): меняем ВСЕ переменные, чтобы рассудить битый пароль vs анти-бот.
// usage: node recycle.cjs <slug>
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const { execFileSync } = require('child_process');
const fs = require('fs');
const DBURL = fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const API = 'https://api.gologin.com';
const SLUG = process.argv[2];
if (!SLUG) { console.log('usage: node recycle.cjs <slug>'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseProxy(s) {
  let host = '', port = 0, user = '', pass = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) { const cred = s.slice(0, at), hp = s.slice(at + 1); const ci = cred.indexOf(':'); user = cred.slice(0, ci); pass = cred.slice(ci + 1); const p = hp.split(':'); host = p[0]; port = Number(p[1]) || 0; }
  else { const p = s.split(':'); host = p[0]; port = Number(p[1]) || 0; user = p[2] || ''; pass = p.slice(3).join(':'); }
  return { host, port, user, pass };
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 9000, statement_timeout: 15000 });
  await c.connect();
  const a = (await c.query(`SELECT a.id, a.acc_no, a.slug, a.gologin_profile_id oldpid, a.ig_proxy, coalesce(g.gologin_token,'') tok FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE lower(a.slug)=lower($1) LIMIT 1`, [SLUG])).rows[0];
  if (!a) { console.log('акк не найден'); await c.end(); return; }
  let tok = a.tok || fs.readFileSync(process.env.HOME + '/.gltok_tmp', 'utf8').trim();
  console.log(`RECYCLE ${a.slug} (№${a.acc_no}) — старый профиль ${String(a.oldpid).slice(0, 10)}`);

  // 1) базовый ClickIP кред + занятые порты
  const rows = (await c.query(`SELECT ig_proxy FROM accounts WHERE ig_proxy ILIKE '%proxy.click-ip.com%' AND ig_proxy IS NOT NULL AND deleted_at IS NULL`)).rows;
  const base = parseProxy(a.ig_proxy && /click-ip/.test(a.ig_proxy) ? a.ig_proxy : rows[0].ig_proxy);
  const used = new Set();
  for (const r of rows) { const p = parseProxy(r.ig_proxy); if (p.host === base.host && p.user === base.user && p.port) used.add(p.port); }
  console.log(`база ClickIP: ${base.user}@${base.host}, занято портов ${used.size}`);

  // 2) новый свободный порт + alive-проверка (curl через прокси)
  const alive = (port) => { try { const out = execFileSync('curl', ['-s', '--max-time', '9', '-x', `http://${base.user}:${base.pass}@${base.host}:${port}`, 'https://api.ipify.org'], { timeout: 11000 }).toString().trim(); return /^\d+\.\d+\.\d+\.\d+/.test(out) ? out : null; } catch { return null; } };
  let newPort = 0, egress = '';
  for (let port = 10000; port < 10500; port++) { if (used.has(port)) continue; const ip = alive(port); if (ip) { newPort = port; egress = ip; break; } }
  if (!newPort) { console.log('❌ свободный живой порт не найден'); await c.end(); return; }
  const newProxy = `${base.user}:${base.pass}@${base.host}:${newPort}`;
  console.log(`✅ новая sticky-прокси: порт ${newPort}, egress ${egress}`);

  // 3) создать новый профиль (POST /browser/quick)
  const cr = await fetch(`${API}/browser/quick`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ os: 'win', name: `${a.acc_no != null ? a.acc_no + ' ' : ''}${a.slug}` }), signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch((e) => ({ err: e.message }));
  const newId = cr.id || cr._id;
  if (!newId) { console.log('❌ создать профиль не удалось: ' + JSON.stringify(cr).slice(0, 150)); await c.end(); return; }
  console.log(`✅ новый профиль создан: ${String(newId).slice(0, 10)}`);

  // 4) привязать новую прокси (PATCH /browser/{id}/proxy)
  const pr = await fetch(`${API}/browser/${newId}/proxy`, { method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'http', host: base.host, port: newPort, username: base.user, password: base.pass }), signal: AbortSignal.timeout(20000) });
  console.log(`прокси привязана: HTTP ${pr.status}`);

  // 5) обновить БД (новый профиль + прокси, сброс статусов)
  await c.query(`UPDATE accounts SET gologin_profile_id=$2, ig_proxy=$3, proxy_status='unknown', egress_ip=NULL, egress_country=NULL, egress_checked_at=NULL, session_status='dead', status='paused', login_fails=0, ig_status=NULL WHERE id=$1`, [a.id, newId, newProxy]);
  console.log(`✅ БД обновлена: ${a.slug} → профиль ${String(newId).slice(0, 10)}, прокси порт ${newPort}, status=paused`);

  // 6) удалить СТАРЫЙ профиль (освободить квоту)
  if (a.oldpid && a.oldpid !== newId) {
    const del = await fetch(`${API}/browser/${a.oldpid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) }).catch(() => ({ status: '?' }));
    console.log(`старый профиль ${String(a.oldpid).slice(0, 10)} удалён: HTTP ${del.status}`);
  }
  await c.end();
  console.log(`\nГОТОВО. Теперь: LOCAL=1 node chlogin.cjs "${a.slug}" (human-ввод, новый профиль+прокси)`);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
