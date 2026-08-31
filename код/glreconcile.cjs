// Сверка GoLogin ↔ БД (READ-ONLY): тянет ВСЕ профили из каждого GoLogin-аккаунта (по токенам групп +
// env-токен) и сверяет с аккаунтами в БД. Показывает: (A) профили в GoLogin БЕЗ живого акка в БД —
// «потеряшки»/висяки (жгут слоты тарифа); (B) акки в БД, чей gologin_profile_id уже НЕ существует в GoLogin.
// usage: DB_PUBLIC_URL=<pub> [GOLOGIN_API_TOKEN=<env>] node glreconcile.cjs
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.gologin.com';

async function dbAll() {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  const groups = (await c.query(`SELECT id, name, gologin_token FROM account_groups WHERE gologin_token IS NOT NULL`)).rows;
  const accs = (await c.query(
    `SELECT a.slug, a.gologin_profile_id pid, a.status, a.deleted_at, a.platform, g.name gname
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.gologin_profile_id IS NOT NULL`)).rows;
  await c.end();
  return { groups, accs };
}

// Все профили одного GoLogin-аккаунта (v2 пагинируется — идём по страницам).
async function fetchProfiles(token, label) {
  const out = [];
  for (let page = 1; page < 40; page++) {
    const r = await fetch(`${API}/browser/v2?page=${page}&limit=30`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
    }).catch((e) => ({ ok: false, status: 'ERR ' + e.message }));
    if (!r.ok) { if (page === 1) console.log(`  ⚠ ${label}: GoLogin HTTP ${r.status}`); break; }
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j) ? j : (j.profiles || []);
    for (const p of arr) out.push({ id: String(p.id || p._id), name: p.name || '(без имени)' });
    const total = Number(j.allProfilesCount || 0);
    if (arr.length < 30 || (total && out.length >= total)) break;
    await sleep(300);
  }
  return out;
}

(async () => {
  const { groups, accs } = await dbAll();
  // токен → метка (группа). + env-токен как отдельный аккаунт (парсер/самореги).
  const tokens = new Map();
  for (const g of groups) if (!tokens.has(g.gologin_token)) tokens.set(g.gologin_token, g.name);
  if (process.env.GOLOGIN_API_TOKEN && !tokens.has(process.env.GOLOGIN_API_TOKEN)) tokens.set(process.env.GOLOGIN_API_TOKEN, 'env-токен (bhxxgod)');

  console.log(`GoLogin-аккаунтов (токенов) к опросу: ${tokens.size}\n`);
  const glProfiles = new Map(); // id -> {name, acct(label)}
  for (const [tok, label] of tokens) {
    const profs = await fetchProfiles(tok, label);
    console.log(`• ${label}: профилей в GoLogin = ${profs.length}`);
    for (const p of profs) if (!glProfiles.has(p.id)) glProfiles.set(p.id, { name: p.name, acct: label });
  }

  const liveByPid = new Map(); // pid -> acc (живой, не удалённый)
  const anyByPid = new Map();
  for (const a of accs) { anyByPid.set(a.pid, a); if (!a.deleted_at) liveByPid.set(a.pid, a); }

  // (A) профили в GoLogin без ЖИВОГО акка в БД
  const orphans = [];
  for (const [id, info] of glProfiles) {
    const a = anyByPid.get(id);
    if (!a) orphans.push({ profile: id, name: info.name, gologin: info.acct, вердикт: 'НЕТ строки в БД' });
    else if (a.deleted_at) orphans.push({ profile: id, name: info.name, gologin: info.acct, вердикт: `акк ${a.slug} помечен deleted, а профиль жив` });
  }
  // (B) акки в БД, чей профиль отсутствует в GoLogin
  const dangling = [];
  for (const a of accs) if (!a.deleted_at && !glProfiles.has(a.pid)) dangling.push({ slug: a.slug, profile: a.pid, group: a.gname, status: a.status, вердикт: 'профиля НЕТ в GoLogin' });

  console.log(`\n=== (A) 🟠 ПРОФИЛИ В GOLOGIN БЕЗ ЖИВОГО АККА (потеряшки/висяки, жгут слоты) ===`);
  console.table(orphans.length ? orphans : [{ info: 'нет — все GoLogin-профили привязаны к живым аккам 👍' }]);
  console.log(`=== (B) 🔴 АККИ В БД С НЕСУЩЕСТВУЮЩИМ ПРОФИЛЕМ (ссылка висит) ===`);
  console.table(dangling.length ? dangling : [{ info: 'нет — у всех живых акков профиль на месте 👍' }]);

  console.log(`\n=== ИТОГ === GoLogin-профилей: ${glProfiles.size} · живых акков с профилем: ${liveByPid.size} · потеряшек: ${orphans.length} · висячих ссылок: ${dangling.length}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
