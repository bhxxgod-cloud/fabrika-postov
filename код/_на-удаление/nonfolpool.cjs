// Расклад по НЕ-FOL аккаунтам: кто вообще есть, в каком состоянии, с какой историей комментинга.
// Считаем ДО заходов: открывать акк дорого и рискованно, а половина вопросов решается данными.
// История важна отдельно: урок 01.08 — под модель горят рабочие лошади фермы (721 прогон = restriction),
// а не «свежие» акки, поэтому кандидат под персону выбирается по МИНИМУМУ прогонов и комментов.
const { Pool } = require('pg');
const fs = require('node:fs');

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query(
    `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.platform, a.persona, a.status, a.session_status,
            coalesce(a.ig_status,'') ig_status, a.health_state, a.proxy_status, a.ig_proxy,
            (coalesce(a.ig_cookies::text,'')<>'') has_cookies,
            (coalesce(a.ig_password,'')<>'') has_pass, (coalesce(a.totp_secret,'')<>'') has_2fa,
            a.gologin_profile_id pid, g.name gname,
            (SELECT count(*) FROM account_run_stats s WHERE s.slug=a.slug) runs,
            (SELECT count(*) FROM post_answered pa WHERE pa.username=lower(coalesce(a.ig_login,a.slug))) comments
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
      WHERE a.deleted_at IS NULL AND a.slug NOT LIKE 'FOL%' AND coalesce(a.ig_role,'')<>'reader'
      ORDER BY (a.persona IS NOT NULL) DESC, (SELECT count(*) FROM account_run_stats s WHERE s.slug=a.slug), a.slug`);

  const model = rows.filter((r) => r.persona);
  const rest = rows.filter((r) => !r.persona);
  console.log(`НЕ-FOL АККОВ ВСЕГО: ${rows.length} (под моделями ${model.length}, свободных ${rest.length})\n`);

  const line = (r) => `  ${r.slug.padEnd(20)} @${String(r.h).slice(0, 26).padEnd(27)} ${String(r.gname || '—').slice(0, 16).padEnd(17)}` +
    ` сессия=${String(r.session_status || '—').padEnd(5)} куки=${r.has_cookies ? 'да ' : 'НЕТ'}` +
    ` профиль=${r.pid ? 'да ' : 'НЕТ'} прокси=${String(r.proxy_status || '—').slice(0, 12).padEnd(13)}` +
    ` ig=${(r.ig_status || '—').padEnd(10)} прогонов=${String(r.runs).padEnd(4)} комментов=${r.comments}`;

  console.log('ПОД МОДЕЛЯМИ:');
  model.forEach((r) => console.log(`  [${r.persona}]` + line(r).slice(2)));

  console.log('\nСВОБОДНЫЕ (кандидаты под Полину, отсортированы по чистоте истории):');
  rest.forEach((r) => console.log(line(r)));

  // Кандидат = есть профиль GoLogin (иначе зайти нечем) и нет терминального статуса IG
  const bad = ['restricted', 'suspended', 'captcha', 'challenge'];
  const cand = rest.filter((r) => r.pid && !bad.includes(r.ig_status) && r.health_state !== 'restricted');
  const ready = cand.filter((r) => r.has_cookies);
  const needLogin = cand.filter((r) => !r.has_cookies && r.has_pass);
  console.log(`\nГОДНЫХ К ПРОВЕРКЕ: ${cand.length}`);
  console.log(`  с куками (заход без пароля): ${ready.length} → ${ready.map((r) => r.slug).join(', ') || '—'}`);
  console.log(`  без кук, но с паролем (вход = риск капчи): ${needLogin.length} → ${needLogin.map((r) => r.slug).join(', ') || '—'}`);
  fs.writeFileSync('/tmp/nonfol_ready.txt', ready.map((r) => r.slug).join('\n'));
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
