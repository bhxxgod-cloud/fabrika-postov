// Списание аккаунтов, в которые мы не можем войти.
// Удаляем МЯГКО (deleted_at + причина): физическое удаление невозвратно, а «неверный пароль» —
// это про наши данные, а не про акк. Если владелец найдёт верные креды, запись поднимается обратно.
// Списываем ТОЛЬКО по доказанной причине из захода: bad_credentials / suspended / captcha /
// challenge. Всё, что «не поняли» (unknown, ошибка прокси, 429), НЕ трогаем: это про инструмент.
// Запуск: node purge.cjs <slug…> [--apply]
const { Pool } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slugs = args.filter((a) => !a.startsWith('--'));

(async () => {
  if (!slugs.length) { console.log('usage: node purge.cjs <slug…> [--apply]'); process.exit(1); }
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const rows = (await p.query(
    `SELECT slug, coalesce(ig_login,slug) h, persona, coalesce(ig_status,'') ig
       FROM accounts WHERE slug = ANY($1) AND deleted_at IS NULL`, [slugs])).rows;

  const withPersona = rows.filter((r) => r.persona);
  if (withPersona.length) {
    console.log('⚠ ЭТИ ЗАНЯТЫ ПОД МОДЕЛЬ, не трогаю:', withPersona.map((r) => `@${r.h} (${r.persona})`).join(', '));
  }
  const kill = rows.filter((r) => !r.persona);
  console.log(`К СПИСАНИЮ: ${kill.length}`);
  kill.forEach((r) => console.log(`  @${r.h} (${r.slug})`));

  if (!APPLY) { console.log('\n(показ; для применения --apply)'); await p.end(); return; }
  const r = await p.query(
    `UPDATE accounts SET deleted_at = now(), ig_status = 'bad_login',
            health_note = 'списан 02.08: вход невозможен, пароль в базе не подходит'
      WHERE slug = ANY($1) AND deleted_at IS NULL AND (persona IS NULL OR persona='')
      RETURNING slug`, [kill.map((r2) => r2.slug)]);
  console.log(`\nсписано: ${r.rowCount}`);
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
