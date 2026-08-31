// Полное удаление забаненного/мёртвого акка: сносит GoLogin-профиль (стоп сессии → DELETE) и добивает
// флаги в БД (deleted_at, status=paused, ig_status=suspended, gologin_profile_id=NULL). БД-строку НЕ трёт
// (soft-delete: история/претензия продавцу сохраняется). ig_proxy оставляем как есть (порт освобождать не надо).
// usage: DB_PUBLIC_URL=<pub> node delacct.cjs <slug> [ig_status]     (ig_status по умолчанию 'suspended')
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

(async () => {
  const slug = process.argv[2]; const igStatus = process.argv[3] || 'suspended';
  if (!slug) { console.error('usage: node delacct.cjs <slug> [ig_status]'); process.exit(1); }

  const rows = await db(
    `SELECT a.id, a.slug, a.status, a.session_status, a.ig_status, a.deleted_at, a.gologin_profile_id, g.gologin_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.slug=$1 AND a.platform='comments'`, [slug]);
  if (!rows.length) { console.error(`акк ${slug} не найден`); process.exit(1); }
  if (rows.length > 1) { console.error(`⚠ найдено ${rows.length} строк с slug ${slug} — уточни, прерываю`); process.exit(1); }
  const acc = rows[0];
  console.log(`Цель: ${acc.slug} | status=${acc.status} session=${acc.session_status} ig_status=${acc.ig_status} deleted_at=${acc.deleted_at ? 'да' : 'нет'} profile=${acc.gologin_profile_id || '—'}`);

  // 1) GoLogin-профиль (если ещё есть).
  if (acc.gologin_profile_id) {
    const tok = acc.gologin_token || process.env.GOLOGIN_API_TOKEN;
    if (!tok) { console.error('нет GoLogin-токена — не могу снести профиль'); process.exit(1); }
    const h = { Authorization: `Bearer ${tok}` };
    // сперва гасим облачную сессию (running → DELETE даёт 403)
    await fetch(`${API}/browser/${acc.gologin_profile_id}/web`, { method: 'DELETE', headers: h }).then((r) => console.log(`  стоп сессии: HTTP ${r.status}`)).catch(() => {});
    await sleep(2500);
    const del = await fetch(`${API}/browser/${acc.gologin_profile_id}`, { method: 'DELETE', headers: h, signal: AbortSignal.timeout(20000) }).catch((e) => ({ ok: false, status: 'ERR ' + e.message }));
    if (del.ok || del.status === 204 || del.status === 200 || del.status === 404) {
      console.log(`  ✓ GoLogin-профиль удалён (HTTP ${del.status})`);
    } else {
      console.error(`  ✗ GoLogin DELETE вернул HTTP ${del.status} (403 = профиль защищён/расшарен — снеси руками в GoLogin). БД НЕ трогаю.`);
      process.exit(1);
    }
  } else {
    console.log('  профиля GoLogin уже нет — только флаги БД');
  }

  // 2) БД: soft-delete + флаги (строку не удаляем).
  await db(
    `UPDATE accounts SET deleted_at=coalesce(deleted_at, now()), status='paused', session_status='dead',
            ig_status=$2, gologin_profile_id=NULL, warmup_at=now() WHERE id=$1`, [acc.id, igStatus]);
  console.log(`  ✓ БД: deleted_at + status='paused' + ig_status='${igStatus}' + gologin_profile_id=NULL`);
  console.log(`\nГОТОВО: ${slug} удалён везде (GoLogin-профиль снесён, строка помечена deleted).`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
