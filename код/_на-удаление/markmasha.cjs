// Аккаунты Маши отдали /accounts/suspended/ при проверке — помечаем терминально.
// Отдельным скриптом, потому что старая версия ighealth писала им только «нет сессии».
const { Pool } = require('pg');
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await p.query(
    `UPDATE accounts SET ig_status='suspended', status='paused', session_status='dead',
            health_state='restricted', health_note='/accounts/suspended/ при проверке 02.08'
      WHERE slug IN ('greyson669812','josiah69339') RETURNING coalesce(ig_login,slug) h`);
  console.log('помечены забаненными:', r.rows.map(x => '@' + x.h).join(', '));
  const st = await p.query(
    `SELECT a.persona, coalesce(a.ig_login,a.slug) h, a.is_spare, coalesce(a.ig_status,'') ig
       FROM accounts a WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
      ORDER BY a.persona, a.is_spare`);
  const bad = st.rows.filter(x => x.ig === 'suspended');
  console.log(`\nЖИВЫХ АККОВ: ${st.rowCount - bad.length} из ${st.rowCount}`);
  st.rows.forEach(x => console.log(`  ${x.persona.padEnd(8)} @${String(x.h).padEnd(20)} ${x.is_spare ? 'запас' : 'основной'} ${x.ig === 'suspended' ? '⛔ БАН' : '✓ жив'}`));
  await p.end();
})().catch(e => { console.log('ОШИБКА:', e.message); process.exit(1); });
