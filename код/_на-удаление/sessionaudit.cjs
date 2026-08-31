// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
//
// SESSION AUDIT — узнать РЕАЛЬНУЮ ёмкость фермы. База врёт: session_status='live' стоит у акков, которые на
// деле заходят ГОСТЯМИ (troy48629/rafael41852 — «live» в базе, «Зарегистрируйтесь в Instagram» на экране).
// Из-за этого движки тратили по 5 минут облачной сессии на пустышку и мы не знали, сколько акков рабочих.
//
// Проверка дешёвая: открыть instagram.com, посмотреть есть ли поле «Добавьте комментарий»/аватар (залогинен)
// или кнопки «Войти/Зарегистрироваться» (гость). ~25-30с на акк. Профиль закрываем ШТАТНО (DELETE /web).
//
// Запуск: DB_PUBLIC_URL=… node sessionaudit.cjs [сколько] [only_live|all]
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');

const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 70);
const MODE = process.argv[3] || 'only_live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

async function check(a, gt) {
  let b = null;
  try {
    const u = new global.URL('wss://cloudbrowser.gologin.com/connect');
    u.searchParams.set('token', gt); u.searchParams.set('profile', a.pid);
    for (let k = 0; k < 3 && !b; k++) {
      try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); }
      catch { await sleep(k === 0 ? 15000 : 10000); }
    }
    if (!b) return 'no_connect';
    const ctx = b.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000);
    const st = await page.evaluate(() => {
      const t = String(document.body.innerText || '');
      const guest = /Зарегистрируйтесь в Instagram|Sign up for Instagram|Log in to Instagram|Войдите в Instagram|Не пропускайте публикации|Забыли пароль|Forgot password/i.test(t);
      // Признаки залогиненного: навигация «Создать/Профиль/Сообщения» либо поле ввода коммента на постах.
      const navd = /Создать|Create|Сообщения|Messages|Профиль|Profile|Уведомления|Notifications/i.test(t);
      const box = !!document.querySelector('textarea, div[contenteditable="true"][role="textbox"]');
      const chall = /подтвердите|confirm your identity|challenge|Помогите нам|верифи|verification/i.test(t);
      return { guest, navd, box, chall, url: location.href };
    }).catch(() => null);
    if (!st) return 'unknown';
    // СУДИМ ТОЛЬКО ЭКРАН INSTAGRAM (07.08). Ниже по st.guest пишется session_status='dead', а
    // «гостевые» фразы («войдите», «забыли пароль») водятся и на чужих страницах: заглушка прокси,
    // страница провайдера, редирект. Не наш домен = вердикта нет, посмотрим в следующий прогон.
    if (st.url && !/^https?:\/\/([a-z0-9-]+\.)*instagram\.com/i.test(String(st.url))) return 'unknown';
    if (/challenge|checkpoint/i.test(st.url) || st.chall) return 'challenge';
    if (st.navd || st.box) return 'live';
    if (st.guest) return 'logged_out';
    return 'unknown';
  } catch { return 'error'; }
  finally {
    // ШТАТНОЕ закрытие облачной сессии — pkill здесь недопустим (вылогинит акк).
    try { await fetch('https://api.gologin.com/browser/' + a.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + gt } }); } catch { /* noop */ }
    try { if (b) await b.close(); } catch { /* noop */ }
  }
}

(async () => {
  const c = await db();
  // SLUGS=slug1,slug2,… — проверить именно этот список (для аудита конкретной пачки, напр. FOL-акков).
  const SLUGS = (process.env.SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let rows;
  if (SLUGS.length) {
    rows = (await c.query(
      `SELECT a.id, a.slug, a.gologin_profile_id AS pid, coalesce(a.session_status,'-') st,
              coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
       WHERE a.slug = ANY($1) AND a.gologin_profile_id IS NOT NULL`, [SLUGS])).rows;
  } else {
    const where = MODE === 'all' ? '' : `AND coalesce(a.session_status,'')='live'`;
    rows = (await c.query(
      `SELECT a.id, a.slug, a.gologin_profile_id AS pid, coalesce(a.session_status,'-') st,
              coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
       WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL
         AND a.status NOT IN ('paused','trash') ${where}
       ORDER BY a.last_commented_at ASC NULLS FIRST LIMIT $1`, [LIMIT])).rows;
  }
  await c.end();
  console.log(`[audit] проверяю ${rows.length} акков (режим: ${MODE}). Идём ПО ОДНОМУ — параллель ловит cloud-штормы.\n`);

  const tally = {};
  let i = 0;
  for (const a of rows) {
    i++;
    const t0 = Date.now();
    const res = await check(a, a.tok);
    tally[res] = (tally[res] || 0) + 1;
    const mark = res === 'live' ? '✅' : res === 'logged_out' ? '☠ ГОСТЬ' : res === 'challenge' ? '⚠ ЧЕКПОИНТ' : '· ' + res;
    console.log(`[${String(i).padStart(2)}/${rows.length}] ${a.slug.padEnd(20)} ${mark}  (${Math.round((Date.now() - t0) / 1000)}с)`);
    // Пишем правду в базу: движки перестанут брать пустышки в работу.
    if (res === 'live' || res === 'logged_out' || res === 'challenge') {
      const c2 = await db();
      const set = res === 'live' ? `session_status='live'`
        : res === 'challenge' ? `session_status='dead', ig_status='challenge'`
          : `session_status='dead'`;
      await c2.query(`UPDATE accounts SET ${set} WHERE id=$1`, [a.id]).catch(() => {});
      await c2.end();
    }
    await sleep(3000);
  }

  console.log('\n[audit] ИТОГ:');
  Object.entries(tally).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v}`));
  console.log(`\n[audit] РЕАЛЬНАЯ ёмкость фермы: ${tally.live || 0} залогиненных акка.`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('FATAL', String(e.message).slice(0, 160)); setTimeout(() => process.exit(1), 60); });
