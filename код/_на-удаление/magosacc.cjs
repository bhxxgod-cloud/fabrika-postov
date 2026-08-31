// ЗАВЕДЕНИЕ КУПЛЕННЫХ АККОВ ДЛЯ МАГОСА В НАШУ БАЗУ (09.08).
//
// ЗАЧЕМ. Приказ начальника: «эти все акки надо в наш постер заводить как акки для маго, можно пока
// сессии гологин не делать, а то может не хватить». То есть строка в базе нужна (чтобы акк был у нас
// на учёте, с паролем, 2FA и куками), а облачный профиль GoLogin НЕ создаём: квота по профилям уже
// упиралась в потолок, и жечь её под акки, которые постит магос, бессмысленно.
//
// ФОРМАТ ФАЙЛА: одна строка на акк, login:password:2fa:cookie_base64 (ровно четыре поля).
// Куки СОХРАНЯЕМ у себя: если магос когда-то отвалится, сессия останется в нашей базе.
//
// Секреты в лог не печатаем: только логин и признаки «пароль есть», «2FA есть», «куки есть».
// Запуск: node magosacc.cjs <файл> [имя-группы]
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const FILE = process.argv[2];
const GROUP = process.argv[3] || 'МАГО (постинг)';

(async () => {
  if (!FILE || !fs.existsSync(FILE)) { console.log('usage: node magosacc.cjs <файл> [группа]'); process.exit(1); }
  const rows = fs.readFileSync(FILE, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = l.split(':');
    return { login: p[0], pass: p[1], totp: p[2], cookie: p.slice(3).join(':') };
  }).filter((x) => x.login && x.pass);
  console.log(`в файле акков: ${rows.length}`);

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();

  // Группа под магос: своя, чтобы наши воркеры комментинга и постинга её НЕ трогали.
  let g = (await c.query('SELECT id FROM account_groups WHERE name = $1', [GROUP])).rows[0];
  if (!g) {
    g = (await c.query('INSERT INTO account_groups (name) VALUES ($1) RETURNING id', [GROUP])).rows[0];
    console.log(`создал группу «${GROUP}»`);
  }

  let added = 0, skipped = 0;
  for (const r of rows) {
    const has = (await c.query('SELECT 1 FROM accounts WHERE slug = $1 OR ig_login = $1', [r.login])).rowCount;
    if (has) { console.log(`  · ${r.login}: уже в базе, пропускаю`); skipped++; continue; }
    await c.query(
      `INSERT INTO accounts (slug, ig_login, ig_password, totp_secret, ig_cookies, platform, status,
                             group_id, account_type, health_state, health_note)
       VALUES ($1, $1, $2, $3, $4::jsonb, 'promo', 'warming', $5, 'bought', 'ok', 'куплен у маго, постит маго, профиля GoLogin нет')`,
      [r.login, r.pass, r.totp || null, r.cookie ? JSON.stringify({ raw: r.cookie }) : null, g.id]);
    console.log(`  ✅ ${r.login}: пароль есть, 2FA ${r.totp ? 'есть' : 'нет'}, куки ${r.cookie ? 'есть' : 'нет'}`);
    added++;
  }
  await c.end().catch(() => {});
  console.log(`\nИТОГ: добавлено ${added}, пропущено ${skipped}, группа «${GROUP}», профили GoLogin НЕ создавались`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
