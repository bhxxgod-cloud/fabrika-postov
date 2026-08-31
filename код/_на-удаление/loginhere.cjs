// ВХОД В УЖЕ ОТКРЫТОЕ ОКНО (профиль поднят openacct.cjs). Логику логина НЕ дублируем — берём
// проверенный loginInline из iglogin.cjs. Нужен, когда IG после верификации показал обычную форму:
// подключаемся к тому же Orbita по порту отладки и входим, не открывая второй сессии на профиле.
// usage: node loginhere.cjs <slug> <debug-port>
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const { loginInline } = require('./iglogin.cjs');
const L = require('./iglib.cjs');
const SLUG = process.argv[2];
const PORT = process.argv[3];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

(async () => {
  if (!SLUG || !PORT) { console.log('usage: node loginhere.cjs <slug> <debug-port>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const a = (await c.query(
    `SELECT id, coalesce(ig_login,slug) ig_login, ig_password, ig_email, ig_email_password, totp_secret
       FROM accounts WHERE slug=$1 AND deleted_at IS NULL LIMIT 1`, [SLUG])).rows[0];
  if (!a) { console.log('акк не найден'); await c.end(); process.exit(1); }
  if (!a.ig_password) { console.log('нет пароля в БД'); await c.end(); process.exit(1); }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 20000 });
  const ctx = b.contexts()[0]; const page = ctx.pages()[0];
  console.log(`ВХОЖУ в открытом окне: @${a.ig_login} (порт ${PORT})`);
  const r = await loginInline(page, ctx, a, { log: (m) => console.log(m), shot: async () => {} });
  console.log(`loginInline: ${r.ok ? 'ok' : 'нет — ' + (r.reason || '')}`);

  // Проверяем ПОЛОЖИТЕЛЬНО (кука сессии), а не по «кнопка нажалась».
  await L.sleep(4000);
  const cls = await L.classifyScreen(ctx, page);
  if (cls.state === 'logged_in') {
    const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
    await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', ig_status='login_ok',
        health_state='ok', session_checked_at=now() WHERE id=$1`, [a.id, JSON.stringify(fresh)]);
    console.log(`✅ ВОШЁЛ: куки сохранены (${fresh.length}), ds_user_id=${cls.dsUserId}`);
  } else {
    console.log(`⚠ не вошли: экран=${cls.state} (${cls.evidence})`);
    await L.snap(page, '/tmp', `loginhere_${SLUG}`);
  }
  await b.close().catch(() => {}); // окно НЕ закрываем — им владеет openacct
  await c.end();
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
