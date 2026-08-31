// Переименовать GoLogin-профили в «<acc_no> <slug>» (порядковый номер акка из панели перед логином).
// READ-ONLY по умолчанию (dry-run). Реально переименовывает только с флагом --go. Имя профиля —
// косметический лейбл (не влияет на фингерпринт/прокси/куки), правка обратима.
// usage: DB_PUBLIC_URL=<pub> node renameprofiles.cjs [--go] [slug...]
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.gologin.com';

async function db(q, p) {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); const r = await c.query(q, p); await c.end(); return r.rows; }
    catch (e) { await c.end().catch(() => {}); if (k === 4) throw e; await sleep(2000); }
  }
}
async function getName(pid, tok) {
  const r = await fetch(`${API}/browser/${pid}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j.name ?? null;
}
// Переименование GoLogin: GET полного профиля → меняем name → PUT назад (PATCH имя не поддерживает).
async function rename(pid, tok, name) {
  const H = { Authorization: `Bearer ${tok}` };
  const g = await fetch(`${API}/browser/${pid}`, { headers: H, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!g || !g.ok) { console.log(`    GET → HTTP ${g ? g.status : 'ERR'}`); return false; }
  const prof = await g.json().catch(() => null);
  if (!prof) return false;
  prof.name = name;
  const r = await fetch(`${API}/browser/${pid}`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(prof), signal: AbortSignal.timeout(25000),
  }).catch((e) => ({ ok: false, status: 'ERR ' + e.message }));
  return r.ok ? true : (console.log(`    PUT → HTTP ${r.status}`), false);
}

(async () => {
  const go = process.argv.includes('--go');
  const slugs = process.argv.slice(2).filter((a) => a !== '--go');
  const rows = await db(
    `SELECT a.acc_no, a.slug, a.gologin_profile_id pid, g.gologin_token tok, g.name grp
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.gologin_profile_id IS NOT NULL AND a.deleted_at IS NULL AND a.acc_no IS NOT NULL AND g.gologin_token IS NOT NULL
       ${slugs.length ? 'AND a.slug = ANY($1)' : ''}
     ORDER BY g.name, a.acc_no`, slugs.length ? [slugs] : []);
  console.log(`${go ? '🔴 ПЕРЕИМЕНОВАНИЕ' : '🟡 DRY-RUN (добавь --go чтобы применить)'} · профилей: ${rows.length}\n`);
  let done = 0, skip = 0, fail = 0;
  for (const a of rows) {
    const want = `${a.acc_no} ${a.slug}`;
    if (!go) { console.log(`  «${a.slug}» → «${want}»  [${a.grp}]`); continue; }
    const cur = await getName(a.pid, a.tok);
    if (cur === want) { skip++; console.log(`  = ${want} (уже так)`); continue; }
    const ok = await rename(a.pid, a.tok, want);
    if (ok) {
      const check = await getName(a.pid, a.tok);
      if (check === want) { done++; console.log(`  ✓ «${cur}» → «${want}»`); }
      else { fail++; console.log(`  ✗ «${cur}»: PATCH ок, но GET вернул «${check}» — не подтвердилось`); }
    } else { fail++; console.log(`  ✗ «${cur ?? a.slug}»: не переименован`); }
    await sleep(400);
  }
  if (go) console.log(`\n=== ИТОГ === переименовано ${done} · уже верно ${skip} · ошибок ${fail}`);
  else console.log(`\nЭто предпросмотр. Применить: node renameprofiles.cjs --go`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
