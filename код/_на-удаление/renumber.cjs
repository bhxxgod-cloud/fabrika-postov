// ПЕРЕНУМЕРАЦИЯ acc_no: сквозная глобальная 1…N по всему живому флоту (порядок — по created_at, старейший=№1).
// Убирает дубли (два №11) и дыры. У удалённых зануляет acc_no (чтоб не переиспользовались/не мешали max+1).
// DRY-RUN по умолчанию (только показывает). Применяет с --go. После --go прогони: node renameprofiles.cjs --go
// usage: DB_PUBLIC_URL=<pub> node renumber.cjs [--go]
const { Client } = require('pg');
async function db(q, p) { const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 }); await c.connect(); try { return await c.query(q, p); } finally { await c.end(); } }

(async () => {
  const go = process.argv.includes('--go');
  // Все ЖИВЫЕ акки, порядок стабильный: created_at (старейший первый), затем id.
  const rows = (await db(
    `SELECT id, slug, platform, acc_no AS old_no, to_char(created_at,'MM-DD HH24:MI') created
     FROM accounts WHERE deleted_at IS NULL ORDER BY created_at ASC NULLS LAST, id ASC`)).rows;
  const changes = rows.map((r, i) => ({ ...r, new_no: i + 1 })).filter((r) => r.old_no !== r.new_no);
  console.log(`${go ? '🔴 ПРИМЕНЯЮ' : '🟡 DRY-RUN (--go чтобы применить)'} · живых акков: ${rows.length} · меняется номеров: ${changes.length}`);
  // дубли в текущих номерах (для контекста)
  const cur = {}; for (const r of rows) if (r.old_no != null) cur[r.old_no] = (cur[r.old_no] || 0) + 1;
  const dups = Object.entries(cur).filter(([, n]) => n > 1).map(([k]) => k);
  console.log(`  текущих дублей acc_no: ${dups.length}${dups.length ? ' → ' + dups.join(',') : ''}`);
  console.log(`  новый диапазон: 1…${rows.length}`);
  console.log('  --- примеры (первые 8 изменений) ---');
  for (const r of changes.slice(0, 8)) console.log(`   №${r.old_no ?? '—'} → №${r.new_no}   ${r.slug}  [${r.platform}, ${r.created}]`);
  if (changes.length > 8) console.log(`   … и ещё ${changes.length - 8}`);

  if (!go) { console.log('\nЭто предпросмотр. Применить: node renumber.cjs --go'); return; }

  // Применяем одной транзакцией. Уникального индекса на acc_no нет (дубли были) → прямой UPDATE безопасен.
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const r of rows) await c.query('UPDATE accounts SET acc_no=$2 WHERE id=$1', [r.id, rows.indexOf(r) + 1]);
    // у удалённых номера убираем — чтобы max(acc_no) считался только по живым, и новые шли N+1 без дыр
    await c.query('UPDATE accounts SET acc_no=NULL WHERE deleted_at IS NOT NULL AND acc_no IS NOT NULL');
    await c.query('COMMIT');
    console.log(`\n✓ ПРИМЕНЕНО: живые → 1…${rows.length}, у удалённых acc_no занулён.`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('✗ откат:', e.message); process.exit(1); }
  finally { await c.end(); }
  // контроль
  const chk = (await db(`SELECT count(*) n, count(DISTINCT acc_no) uniq, min(acc_no) mn, max(acc_no) mx FROM accounts WHERE deleted_at IS NULL AND acc_no IS NOT NULL`)).rows[0];
  console.log(`  контроль: акков ${chk.n}, уникальных ${chk.uniq}, диапазон ${chk.mn}…${chk.mx} ${chk.n === chk.uniq ? '✓ без дублей' : '⚠ есть дубли!'}`);
  console.log('\nТеперь имена профилей: node renameprofiles.cjs --go');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
