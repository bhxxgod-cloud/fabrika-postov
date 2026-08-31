// СТАТИСТИКА ПОСТОВ: просмотры, лайки, комменты по каждому аккаунту.
//
// Почему так, а не анонимно: Instagram убрал счётчики из публичной выдачи — и страница рилса,
// и embed теперь приходят без чисел (проверено 03.08, старый viewsreport.cjs отдаёт «нет данных»).
// Зато лента СВОЕГО аккаунта отдаёт всё, если запрос идёт с его куками.
//
// Почему это безопасно: браузер НЕ открывается, профиль GoLogin не стартует, вход не выполняется.
// Обычный HTTPS-запрос с сохранёнными куками через прокси самого аккаунта — то есть с его же
// адреса. Нагрузка меньше, чем от одного открытия ленты человеком.
//
// Запуск: node stats.cjs            — все живые акки
//         node stats.cjs Карина     — только одна модель
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const APP_ID = '936619743392459';   // публичный web app-id инстаграма, без него отдают логин-стену

function feed(cookies, proxy, uid) {
  const jar = (cookies || []).map((k) => `${k.name}=${k.value}`).join('; ');
  const args = ['-s', '--max-time', '30', '-H', `Cookie: ${jar}`, '-H', `x-ig-app-id: ${APP_ID}`, '-A', UA];
  if (proxy) args.push('-x', proxy.includes('://') ? proxy : `http://${proxy}`);
  args.push(`https://www.instagram.com/api/v1/feed/user/${uid}/?count=20`);
  try { return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 })); }
  catch { return null; }
}

(async () => {
  const only = process.argv[2] || null;
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const accs = (await c.query(
    `SELECT id, persona, coalesce(ig_login,slug) h, ig_cookies, ig_proxy FROM accounts
      WHERE persona IS NOT NULL AND persona<>'' AND deleted_at IS NULL AND session_status='live'
        ${only ? 'AND (persona=$1 OR slug=$1 OR ig_login=$1)' : ''} ORDER BY persona`, only ? [only] : [])).rows;

  let totalViews = 0, totalLikes = 0, todayViews = 0, todayPosts = 0;
  const rows = [];

  for (const a of accs) {
    let cks = [];
    try { cks = typeof a.ig_cookies === 'string' ? JSON.parse(a.ig_cookies) : a.ig_cookies; } catch {}
    const uid = (cks || []).find((k) => k.name === 'ds_user_id')?.value;
    if (!uid) { console.log(`  ⚠ @${a.h}: нет ds_user_id в куках`); continue; }

    const j = feed(cks, a.ig_proxy, uid);
    const items = j?.items || [];
    if (!items.length) { console.log(`  ⚠ @${a.h}: лента не отдалась`); continue; }

    // Сопоставляем с нашими постами: время публикации берём из БД, чтобы считать «сегодня» честно.
    const mine = new Map((await c.query(
      `SELECT external_url, published_at FROM posts WHERE account_id=$1 AND external_url IS NOT NULL`, [a.id]))
      .rows.map((r) => [(String(r.external_url).match(/\/(reel|p)\/([^/]+)/) || [])[2], r.published_at]));

    for (const it of items) {
      const views = Number(it.content_views_count ?? it.play_count ?? it.ig_play_count ?? it.view_count ?? 0);
      const likes = Number(it.like_count ?? 0);
      const when = mine.get(it.code);
      const isToday = when && (Date.now() - new Date(when).getTime()) < 24 * 3600 * 1000;
      totalViews += views; totalLikes += likes;
      if (isToday) { todayViews += views; todayPosts++; }
      rows.push({ persona: a.persona, h: a.h, code: it.code, views, likes,
        comments: Number(it.comment_count ?? 0), today: !!isToday, ours: mine.has(it.code) });
      // Кладём снимок в базу, чтобы панель показывала цифры без нового захода в аккаунт.
      await c.query(
        `INSERT INTO post_stats (shortcode, account_id, persona, views, likes, comments, taken_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (shortcode) DO UPDATE SET views=EXCLUDED.views, likes=EXCLUDED.likes,
           comments=EXCLUDED.comments, updated_at=now()`,
        [it.code, a.id, a.persona, views, likes, Number(it.comment_count ?? 0),
         it.taken_at ? new Date(it.taken_at * 1000) : null]).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2500));   // не частим запросами с одного IP
  }

  rows.sort((x, y) => y.views - x.views);
  console.log('\nПОСТЫ ПО ПРОСМОТРАМ:');
  for (const r of rows) {
    console.log(`  ${String(r.views).padStart(5)} просм · ${String(r.likes).padStart(3)} лайк · `
      + `${r.persona} @${r.h}${r.today ? ' · СЕГОДНЯ' : ''}  https://www.instagram.com/reel/${r.code}/`);
  }
  console.log(`\nВСЕГО: ${rows.length} постов, ${totalViews} просмотров, ${totalLikes} лайков`);
  console.log(`СЕГОДНЯ: ${todayPosts} постов, ${todayViews} просмотров`
    + (todayPosts ? ` (в среднем ${Math.round(todayViews / todayPosts)} на пост)` : ''));
  await c.end();
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
