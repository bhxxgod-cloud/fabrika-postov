// Брифинг по флоту (READ-ONLY): весь парк IG-акков одним взглядом. Ничего не меняет — только SELECT'ы.
// usage: DB_PUBLIC_URL=<pub> node fleethealth.cjs
// Секции: сводка · ложные смерти (к восстановлению) · настоящие баны/суспенды (претензия продавцу) ·
//         общие egress-IP (footprint) · у дневного лимита · непроверенный egress · дежурные.
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db(q, p) {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); const r = await c.query(q, p); await c.end(); return r.rows; }
    catch (e) { await c.end().catch(() => {}); if (k === 4) throw e; await sleep(2000); }
  }
}
// Отдельная секция: сбой одной не роняет весь отчёт.
async function section(title, q, p, empty) {
  try {
    const rows = await db(q, p);
    console.log(`\n${title}`);
    if (!rows.length) { console.log(`  ${empty || '— пусто —'}`); return 0; }
    console.table(rows);
    return rows.length;
  } catch (e) { console.log(`\n${title}\n  ⚠ секция упала: ${e.message}`); return 0; }
}

(async () => {
  const limitRow = await db(`SELECT coalesce(daily_limit,14) dl FROM radar_config WHERE id=1`).catch(() => [{ dl: 14 }]);
  const DL = Number(limitRow[0]?.dl) || 14;
  console.log(`=== 🩺 БРИФИНГ ПО ФЛОТУ ===  (дневной лимит комментов: ${DL})`);

  await section('=== СВОДКА (comments, не удалённые) ===',
    `SELECT status, session_status, coalesce(proxy_status,'unknown') proxy, count(*)::int n
     FROM accounts WHERE platform='comments' AND deleted_at IS NULL
     GROUP BY 1,2,3 ORDER BY 1,2,3`);

  const falseDead = await section('=== 🔴 ЛОЖНЫЕ СМЕРТИ → к восстановлению (прокси ok, fails=0, не бан, не 2fa-кулдаун) ===',
    `SELECT slug, coalesce(ig_status,'—') ig_status, coalesce(proxy_status,'unknown') proxy, egress_country egress,
            session_checked_at::date checked, coalesce(ig_role,'—') role
     FROM accounts
     WHERE platform='comments' AND deleted_at IS NULL AND session_status='dead' AND status<>'paused'
       AND coalesce(login_fails,0)=0
       AND coalesce(ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended','2fa_cooldown')
     ORDER BY checked NULLS FIRST, slug`,
    null, 'нет — все dead-акки либо забанены, либо на паузе, либо в 2fa-кулдауне');

  await section('=== ⏳ 2FA-КУЛДАУН (сами оживут ~4ч, руками не трогать) ===',
    `SELECT slug, egress_country egress, session_checked_at::date since
     FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND ig_status='2fa_cooldown'
     ORDER BY slug`,
    null, 'нет акков в 2fa-кулдауне');

  await section('=== ⛔ НАСТОЯЩИЕ БАНЫ / СУСПЕНДЫ → список для претензии продавцу ===',
    `SELECT slug, coalesce(ig_status,'—') ig_status, coalesce(login_fails,0) fails,
            created_at::date bought, status
     FROM accounts
     WHERE platform='comments' AND deleted_at IS NULL
       AND (ig_status IN ('challenge','bad_login','captcha','suspended') OR coalesce(login_fails,0)>0)
     ORDER BY ig_status, slug`,
    null, 'нет явных банов 👍');

  await section('=== 🌐 FOOTPRINT: общий egress-IP у нескольких акков (риск корреляции банов) ===',
    `SELECT egress_ip, egress_country country, count(*)::int n,
            string_agg(slug || (CASE WHEN ig_role='duty' THEN ' 🛡' ELSE '' END), ', ' ORDER BY slug) slugs
     FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND egress_ip IS NOT NULL
     GROUP BY 1,2 HAVING count(*)>1 ORDER BY n DESC`,
    null, 'общих IP нет — каждый акк на своём выходе 👍');

  await section('=== ♨️ У ДНЕВНОГО ЛИМИТА (жгут много — риск бана) ===',
    `SELECT slug, (CASE WHEN comments_day=(now() at time zone 'Europe/Warsaw')::date THEN comments_today ELSE 0 END)::int used,
            ${DL} AS limit, coalesce(ig_role,'—') role
     FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND status<>'paused'
       AND (CASE WHEN comments_day=(now() at time zone 'Europe/Warsaw')::date THEN comments_today ELSE 0 END) >= ${DL} - 2
     ORDER BY used DESC`,
    null, 'никто не близко к лимиту');

  await section('=== ❓ НЕПРОВЕРЕННЫЙ / МЁРТВЫЙ EGRESS (в IG пускать рискованно) ===',
    `SELECT slug, coalesce(proxy_status,'unknown') proxy, session_status, coalesce(ig_role,'—') role,
            egress_checked_at::date checked
     FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND status<>'paused'
       AND coalesce(proxy_status,'unknown') IN ('unknown','dead')
     ORDER BY (ig_role='duty') DESC NULLS LAST, slug`,
    null, 'у всех живых egress подтверждён 👍');

  await section('=== 🛡 ДЕЖУРНЫЕ (состав смены) ===',
    `SELECT a.slug, a.session_status, coalesce(a.proxy_status,'unknown') proxy, a.egress_country egress,
            a.last_commented_at::date last_comment
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND a.deleted_at IS NULL
       AND (coalesce(g.watchdog,false)=true OR a.ig_role='duty')
     ORDER BY a.slug`,
    null, 'дежурных нет (ig_role=duty / группа watchdog)');

  // Итоговая строка-рекомендация.
  console.log('\n=== 📌 ИТОГ ===');
  if (falseDead) console.log(`• ${falseDead} акк(ов) похожи на ЛОЖНУЮ смерть — их можно вернуть в работу (авто-релогин / node-скрипт).`);
  console.log('• Баны/суспенды из списка выше — на удаление + претензию продавцу.');
  console.log('• Общие egress-IP — развести (особенно если там дежурный 🛡).');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
