// ПЕРЕИМЕНОВАНИЕ ПРОФИЛЕЙ GOLOGIN ПОД ТЕКУЩИЙ НИК (06.08, правило начальника: «переименовывай
// гологин, если ник меняем»). Профили назывались старыми слагами («36 kasey37750» у акка с ником
// darya.smirnova13), и в панели GoLogin невозможно было понять, где какой акк.
// Формат имени: «<acc_no> <ig_login>». Слаг в базе НЕ трогаем: по нему живёт очередь задач.
// Запуск: node glrename.cjs           — привести в порядок все живые
//         node glrename.cjs <slug>    — один акк
//         node glrename.cjs --dry     — показать, что будет сделано
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const API = 'https://api.gologin.com';
const arg = process.argv[2];
const DRY = process.argv.includes('--dry');

async function glGet(pid, token) {
  const r = await fetch(`${API}/browser/${pid}`, { headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`GET профиля HTTP ${r.status}`);
  return r.json();
}
// GoLogin принимает переименование только полным телом профиля, поэтому читаем и возвращаем целиком.
async function glRename(pid, token, name) {
  const body = await glGet(pid, token);
  body.name = name;
  const r = await fetch(`${API}/browser/${pid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`PUT HTTP ${r.status}`);
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`
    SELECT a.slug, a.acc_no, coalesce(a.ig_login, a.slug) nick, a.gologin_profile_id pid, g.gologin_token tok
      FROM accounts a JOIN account_groups g ON g.id = a.group_id
     WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
       ${arg && !arg.startsWith('--') ? 'AND a.slug = $1' : ''}
     ORDER BY a.acc_no NULLS LAST`, arg && !arg.startsWith('--') ? [arg] : [])).rows;
  await c.end();

  let fixed = 0, ok = 0, fail = 0;
  for (const a of rows) {
    const want = `${a.acc_no ? a.acc_no + ' ' : ''}${a.nick}`;
    let have = '';
    try { have = (await glGet(a.pid, a.tok)).name || ''; }
    catch (e) { console.log(`✗ ${a.nick}: ${e.message}`); fail++; continue; }
    if (have === want) { ok++; continue; }
    if (DRY) { console.log(`  ~ ${have}  →  ${want}`); fixed++; continue; }
    try { await glRename(a.pid, a.tok, want); console.log(`✓ ${have}  →  ${want}`); fixed++; }
    catch (e) { console.log(`✗ ${a.nick}: ${e.message}`); fail++; }
  }
  console.log(`ИТОГ: ${DRY ? 'к переименованию' : 'переименовано'} ${fixed}, уже верных ${ok}, ошибок ${fail}`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
