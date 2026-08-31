// ИЗОЛЯЦИЯ МОДЕЛЬНЫХ АККОВ ОТ КОМMЕНТИНГА.
// Зачем: акк, который комментит с ссылкой, копит спам-историю и ловит ограничения (Маша сгорела 01.08),
// а параллельная сессия из фермы просто убивает акк. Модельные акки и ферма обязаны жить на РАЗНЫХ
// контурах. Раньше все 8 модельных акков лежали в platform='comments' и группе фермы, то есть любой
// движок комментинга имел полное право их взять.
//
// Изоляция делается ДАННЫМИ, а не правкой шести чужих файлов:
//   • platform='promo'  → выпадают из vcomment / smartrun / queue_supervisor / наборов duty_safe и
//                          backlog_safe / radar (все они фильтруют platform='comments'), а заодно
//                          из queue_supervisor DELETE, который сносит акки фермы;
//   • отдельная группа  → выпадают из storozhi (g.role='worker'), duty_safe (g.watchdog),
//     platform='promo'    backlog_safe (g.backlog). Группа своя, потому что миграция схемы обнуляет
//                          group_id при расхождении платформ акка и группы (schema.sql, ~171).
//   • ig_role='model'   → записанное намерение: не выводить «нельзя комментить» из платформы.
// Токен GoLogin переносим в новую группу, иначе оформление и постинг потеряют доступ к профилям.
//
// Запуск: node promoisolate.cjs           (только показать, ничего не менять)
//         node promoisolate.cjs --apply   (применить)
const { Pool } = require('pg');
const APPLY = process.argv.includes('--apply');
const GROUP_NAME = 'Модели (промо)';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const models = (await c.query(
      `SELECT a.id, a.slug, a.persona, a.is_spare, coalesce(a.ig_login,a.slug) h, a.platform, a.ig_role,
              a.group_id, g.name gname, g.role grole, coalesce(g.watchdog,false) wd, coalesce(g.backlog,false) bl,
              g.gologin_token tok
         FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
        WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
        ORDER BY a.persona, a.is_spare`)).rows;

    console.log(`МОДЕЛЬНЫЕ АККИ: ${models.length}`);
    for (const m of models) {
      const risk = [
        m.platform === 'comments' ? 'в вкладке комменты' : null,
        m.grole === 'worker' ? 'группа worker (сторожи)' : null,
        m.wd ? 'группа watchdog (дежурство)' : null,
        m.bl ? 'группа backlog' : null,
      ].filter(Boolean);
      console.log(`  ${m.persona}/${m.h} ${m.is_spare ? '(запас)' : '(основной)'} platform=${m.platform} группа=${m.gname || '—'}` +
        (risk.length ? `\n      ⚠ комментинг может взять: ${risk.join(', ')}` : '\n      ✓ изолирован'));
    }

    // Пул для новых моделей: живые акки фермы, не занятые под модель
    const free = (await c.query(
      `SELECT coalesce(ig_login,slug) h, slug, session_status, coalesce(ig_status,'') ig_status, status,
              (coalesce(ig_cookies::text,'')<>'') has_cookies, health_state, created_at
         FROM accounts
        WHERE deleted_at IS NULL AND (persona IS NULL OR persona='')
          AND coalesce(ig_role,'')<>'reader' AND platform='comments'
        ORDER BY session_status DESC, created_at DESC`)).rows;
    const live = free.filter((x) => x.session_status === 'live');
    const okIg = live.filter((x) => !['restricted', 'suspended', 'captcha', 'challenge'].includes(x.ig_status));
    const ready = okIg.filter((x) => x.has_cookies && x.status !== 'paused');
    console.log(`\nПУЛ ПОД НОВЫЕ МОДЕЛИ (акки фермы без модели): всего ${free.length}`);
    console.log(`  живая сессия: ${live.length}`);
    console.log(`  из них без ограничений IG: ${okIg.length}`);
    console.log(`  готовы прямо сейчас (куки есть, не на паузе): ${ready.length}`);
    console.log('  ' + ready.slice(0, 30).map((x) => '@' + x.h).join(', '));

    if (!APPLY) { console.log('\n(показ без изменений; для применения: node promoisolate.cjs --apply)'); return; }

    const tok = models.map((m) => m.tok).find(Boolean);
    if (!tok) throw new Error('не нашёл gologin_token у групп модельных акков — без него оформление и постинг потеряют профили');

    await c.query('BEGIN');
    const grp = (await c.query(
      `INSERT INTO account_groups (name, platform, role, watchdog, backlog, gologin_token)
       VALUES ($1,'promo','promo',false,false,$2)
       ON CONFLICT DO NOTHING RETURNING id`, [GROUP_NAME, tok])).rows[0]
      || (await c.query(`SELECT id FROM account_groups WHERE name=$1 AND platform='promo'`, [GROUP_NAME])).rows[0];
    if (!grp) throw new Error('не удалось создать/найти группу промо');
    await c.query(`UPDATE account_groups SET gologin_token=$2 WHERE id=$1 AND coalesce(gologin_token,'')=''`, [grp.id, tok]);

    const ids = models.map((m) => m.id);
    const r = await c.query(
      `UPDATE accounts SET platform='promo', group_id=$2, ig_role='model' WHERE id = ANY($1) RETURNING slug`, [ids, grp.id]);
    await c.query('COMMIT');
    console.log(`\nИЗОЛИРОВАНО: ${r.rowCount} акков → platform=promo, группа «${GROUP_NAME}», ig_role=model`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.log('ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();
