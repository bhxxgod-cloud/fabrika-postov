// СВОДКА ПО ПАРКУ АККАУНТОВ: сколько в работе под моделями, сколько в резерве, что с резервом.
// Резерв делим честно: «готов сейчас» (есть куки — заходим без пароля) и «нужен вход» (только
// пароль+2FA, заход 7-10 минут и не факт, что акк жив). Одно число «свободно 37» вводит в
// заблуждение: половина из них может оказаться мёртвой при первом же заходе.
// FOL считаем отдельной строкой и в резерв НЕ включаем — правило владельца: не трогать вообще.
const { Pool } = require('pg');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const BAD = `coalesce(ig_status,'') IN ('restricted','suspended','captcha','challenge')`;

  const models = await p.query(
    `SELECT persona, coalesce(ig_login,slug) h, is_spare, coalesce(ig_status,'') ig
       FROM accounts WHERE persona IS NOT NULL AND persona<>'' AND deleted_at IS NULL
      ORDER BY persona, is_spare`);
  console.log('=== В РАБОТЕ (модели) ===');
  const byP = new Map();
  for (const r of models.rows) {
    if (!byP.has(r.persona)) byP.set(r.persona, []);
    byP.get(r.persona).push(r);
  }
  let live = 0;
  for (const [persona, list] of byP) {
    const ok = list.filter((x) => x.ig !== 'suspended' && x.ig !== 'restricted');
    live += ok.length;
    console.log(`  ${persona.padEnd(8)} ${ok.length}/${list.length}: ` +
      list.map((x) => `@${x.h}${x.ig === 'suspended' ? ' ⛔' : ''}${x.is_spare ? ' (зап)' : ''}`).join(', '));
  }
  console.log(`  ИТОГО живых под моделями: ${live}`);

  const q = async (where) => Number((await p.query(
    `SELECT count(*)::int n FROM accounts WHERE deleted_at IS NULL AND (persona IS NULL OR persona='')
        AND coalesce(ig_role,'')<>'reader' AND ${where}`)).rows[0].n);

  const notFol = `slug NOT LIKE 'FOL%'`;
  const total = await q(notFol);
  const bad = await q(`${notFol} AND ${BAD}`);
  const ready = await q(`${notFol} AND NOT ${BAD} AND coalesce(ig_cookies::text,'')<>'' AND gologin_profile_id IS NOT NULL AND coalesce(status,'')<>'paused'`);
  const needLogin = await q(`${notFol} AND NOT ${BAD} AND coalesce(ig_cookies::text,'')='' AND coalesce(ig_password,'')<>'' AND gologin_profile_id IS NOT NULL`);
  const noProfile = await q(`${notFol} AND gologin_profile_id IS NULL`);
  const fol = await q(`slug LIKE 'FOL%'`);

  console.log('\n=== РЕЗЕРВ (не-FOL, без модели) ===');
  console.log(`  всего: ${total}`);
  console.log(`  готовы сейчас (куки есть, заход без пароля): ${ready}`);
  console.log(`  нужен вход паролём+2FA: ${needLogin}   ← из них рабочими выходят примерно половина`);
  console.log(`  помечены битыми (бан/капча/ограничение): ${bad}`);
  console.log(`  без профиля GoLogin (зайти нечем): ${noProfile}`);
  console.log(`\n=== FOL (не используем по правилу владельца): ${fol} ===`);
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
