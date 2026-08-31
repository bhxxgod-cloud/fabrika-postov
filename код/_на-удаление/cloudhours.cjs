// РЕКЛЕЙМ ОБЛАЧНЫХ ЧАСОВ. GoLogin не даёт «список запущенных» (пути /running режет CF, в профиле живого флага нет).
// Рычаг: DELETE /browser/{pid}/web — закрывает облачную сессию. Ответ = детектор: 200 → сессия ВИСЕЛА (освободили часы),
// 404/иное → не крутилась. Метём ТОЛЬКО заведомо неактивные (dead/бан/пауза/капча/не-live) — рабочих и дежурных не трогаем.
// Запуск:  node cloudhours.cjs            (сухой: покажет цель и сколько кандидатов)
//          node cloudhours.cjs --kill     (метёт: закрывает висящие облачные сессии безопасного подмножества)
const { Client } = require('pg');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const KILL = process.argv.includes('--kill');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  // БЕЗОПАСНОЕ подмножество: акки, которые СЕЙЧАС работать не должны → любая живая облачная сессия у них = утечка часов.
  // Исключаем всё, что коммитило за последние 25 мин (воркер мог держать) и явные рабочие роли.
  const rows = (await c.query(`SELECT a.slug, a.platform, a.gologin_profile_id pid, g.gologin_token tok,
      coalesce(a.session_status,'') ss, coalesce(a.ig_status,'') igs, coalesce(a.status,'') st, g.name grp, coalesce(g.role,'') role,
      extract(epoch from (now()-a.last_commented_at))/60 mins
    FROM accounts a JOIN account_groups g ON g.id=a.group_id
    WHERE a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
      -- ТОЛЬКО заведомо неактивные. Иначе DELETE /web прилетит в ЖИВУЮ сессию (логин/оформление/дежурство),
      -- куки не синкнутся и акк «разлогинится». Ревью 28.07: раньше фильтров тут не было вообще.
      AND coalesce(a.session_status,'') <> 'live'
      AND coalesce(g.role,'') NOT IN ('worker','duty','reader')
      AND (a.last_commented_at IS NULL OR a.last_commented_at < now() - interval '25 min')
      AND (a.commenting_at IS NULL OR a.commenting_at < now() - interval '25 min')
`)).rows;
  await c.end();
  console.log(`Кандидатов на метлу (заведомо неактивные, не рабочие/дежурные): ${rows.length}`);
  const by = {}; rows.forEach((r) => { const k = `${r.ss || '∅'}/${r.igs || '∅'}`; by[k] = (by[k] || 0) + 1; });
  console.log('Разбивка session/ig:', Object.entries(by).map(([k, v]) => `${k}:${v}`).join('  '));
  if (!KILL) { console.log(`\nСухой прогон. Закрыть висящие сессии этого подмножества:  node cloudhours.cjs --kill`); return; }
  console.log(`\n--kill: шлю DELETE /web по ${rows.length} профилям (200 = ВИСЕЛА, освободил)…\n`);
  let freed = 0, notrun = 0, err = 0;
  const res = await pool(rows, 5, async (r) => {
    try {
      const x = await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok }, signal: AbortSignal.timeout(12000) });
      await sleep(150);
      if (x.status === 200) { freed++; return `✅ВИСЕЛА→освобождена  ${r.slug} [${r.grp}] ${r.ss}/${r.igs}`; }
      notrun++; return null;
    } catch (e) { err++; return `!ошибка ${r.slug}: ${(e.message || '').slice(0, 30)}`; }
  });
  res.filter(Boolean).forEach((l) => console.log('  ' + l));
  console.log(`\nИТОГ: освобождено (висели) ${freed} | не крутились ${notrun} | ошибок ${err}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
