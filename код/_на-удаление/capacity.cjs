// Сколько аккаунтов реально можно завести ПРЯМО СЕЙЧАС.
// Упирается в два независимых ресурса, берём минимум из них:
//   1) свободные живые адреса (без «обожжённых», где был бан);
//   2) кандидаты, которых мы ЕЩЁ НЕ пробовали и у которых чистая история фермы.
// Отдельно считаем ожидаемый выход: сегодня из 15 попыток рабочими вышли 3, то есть примерно
// каждый пятый. Обещать «сколько кандидатов, столько акков» нечестно.
const { Pool } = require('pg');
const fs = require('node:fs');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // --- адреса ---
  const live = fs.existsSync('/tmp/old_live_proxies.txt')
    ? fs.readFileSync('/tmp/old_live_proxies.txt', 'utf8').split('\n').filter(Boolean)
      .map((l) => { const url = l.split('|')[1]; return { url, ip: (String(url).match(/@([\d.]+):/) || [])[1] }; })
    : [];
  const used = (await p.query(
    `SELECT ig_proxy, coalesce(ig_status,'') ig, deleted_at FROM accounts WHERE ig_proxy LIKE '%@%' OR ig_proxy ~ ':'`)).rows;
  const busy = new Set(), burned = new Set();
  for (const r of used) {
    const ip = (String(r.ig_proxy).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
    if (!ip) continue;
    if (r.ig === 'suspended') burned.add(ip);
    else if (!r.deleted_at) busy.add(ip);
  }
  const freeIps = live.filter((x) => x.ip && !busy.has(x.ip) && !burned.has(x.ip));

  // --- кандидаты ---
  const cand = (await p.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, coalesce(a.ig_status,'') ig,
            (SELECT count(*) FROM account_run_stats s WHERE s.slug=a.slug) runs
       FROM accounts a
      WHERE a.deleted_at IS NULL AND (a.persona IS NULL OR a.persona='')
        AND a.slug NOT LIKE 'FOL%' AND coalesce(a.ig_role,'')<>'reader'
        AND a.gologin_profile_id IS NOT NULL
        AND coalesce(a.ig_password,'')<>''
        AND coalesce(a.ig_status,'') NOT IN ('restricted','suspended','captcha','challenge','bad_login')
      ORDER BY (SELECT count(*) FROM account_run_stats s WHERE s.slug=a.slug)`)).rows;

  // кого уже пробовали сегодня — по отметке login_fails/last попытке не понять надёжно,
  // поэтому список неудачных ведём явно: он получен из логов заходов 02.08
  const tried = new Set(['deacon40877', 'elijah662548', 'gaige83560', 'isaiah51035', 'jayvion5880',
    'jeremy268776', 'kaleb57609', 'melvin15648', 'luis473586', 'george484323', 'remington79254',
    'ross412868', 'mateo890836']);
  const fresh = cand.filter((c) => !tried.has(c.slug));
  const clean = fresh.filter((c) => Number(c.runs) < 20);   // чистая история фермы

  console.log(`СВОБОДНЫХ ЖИВЫХ АДРЕСОВ: ${freeIps.length}`);
  freeIps.forEach((x) => console.log(`  ${x.ip}`));
  console.log(`\nКАНДИДАТЫ, которых ещё НЕ пробовали: ${fresh.length} (из них с чистой историей фермы: ${clean.length})`);
  clean.slice(0, 15).forEach((c) => console.log(`  ${c.slug.padEnd(20)} прогонов фермы: ${c.runs}`));

  const cap = Math.min(freeIps.length, clean.length);
  console.log(`\nПОТОЛОК ПО РЕСУРСАМ: ${cap} (минимум из адресов и кандидатов)`);
  console.log(`ОЖИДАЕМО ЗАВЕДЁТСЯ: ~${Math.max(0, Math.round(clean.length * 0.2))} — сегодня рабочим оказывался примерно каждый пятый`);
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
