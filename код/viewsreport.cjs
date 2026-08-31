// ОТЧЁТ ПО ОПУБЛИКОВАННЫМ РОЛИКАМ: сколько просмотров, лайков, комментов набрал каждый.
// Читаем АНОНИМНО (без логина и без открытия профилей в браузере): заход в акк стоит времени и
// риска, а цифры видны снаружи. Пробуем два пути: страницу рилса и embed; берём первый, что ответил.
// Если цифру достать не удалось, так и пишем — «нет данных» честнее выдуманного нуля.
const { Pool } = require('pg');
const { spawn } = require('node:child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function curl(url, proxy) {
  return new Promise((resolve) => {
    const args = ['-s', '--max-time', '25', '-A', UA, '-H', 'Accept-Language: en-US,en;q=0.9'];
    if (proxy) args.push('--proxy', proxy);
    args.push(url);
    const p = spawn('curl', args);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out));
  });
}

// Числа лежат в og:description вида "12K likes, 34 comments - nick on ..." либо в JSON полях.
function parseCounts(html) {
  const res = {};
  const og = (html.match(/property="og:description"\s+content="([^"]+)"/) || [])[1] || '';
  const likes = og.match(/([\d.,KMkm]+)\s+likes?/);
  const comments = og.match(/([\d.,KMkm]+)\s+comments?/);
  if (likes) res.likes = likes[1];
  if (comments) res.comments = comments[1];
  const vp = html.match(/"video_play_count"\s*:\s*(\d+)/) || html.match(/"play_count"\s*:\s*(\d+)/);
  if (vp) res.views = vp[1];
  const vv = html.match(/"video_view_count"\s*:\s*(\d+)/);
  if (vv && !res.views) res.views = vv[1];
  return res;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `SELECT p.external_url, p.published_at, left(coalesce(p.caption,''),42) cap,
            a.persona, a.is_spare, coalesce(a.ig_login,a.slug) h
       FROM posts p JOIN accounts a ON a.id=p.account_id
      WHERE p.kind='promo' AND p.status='published' AND p.external_url IS NOT NULL
      ORDER BY p.published_at`);
  const px = (await pool.query(
    `SELECT ig_proxy FROM accounts WHERE ig_proxy LIKE '%@%' AND proxy_status='ok' AND deleted_at IS NULL LIMIT 3`))
    .rows.map((r) => (r.ig_proxy.startsWith('http') ? r.ig_proxy : `http://${r.ig_proxy}`));

  console.log(`ОПУБЛИКОВАННЫХ РОЛИКОВ: ${rows.length}\n`);
  for (const r of rows) {
    const code = (String(r.external_url).match(/\/(?:reel|p)\/([^/?]+)/) || [])[1];
    let counts = {};
    for (const proxy of [null, ...px]) {
      const html = await curl(`https://www.instagram.com/reel/${code}/`, proxy);
      if (html && html.length > 2000) { counts = parseCounts(html); if (counts.likes || counts.views) break; }
      const emb = await curl(`https://www.instagram.com/reel/${code}/embed/captioned/`, proxy);
      if (emb && emb.length > 2000) { counts = { ...counts, ...parseCounts(emb) }; if (counts.likes || counts.views) break; }
    }
    const when = r.published_at ? new Date(r.published_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    console.log(`${String(r.persona).padEnd(8)} @${String(r.h).padEnd(20)} ${when}`);
    console.log(`   ${r.external_url}`);
    console.log(`   просмотры: ${counts.views || 'нет данных'} | лайки: ${counts.likes || 'нет данных'} | комменты: ${counts.comments || 'нет данных'}`);
    console.log(`   «${r.cap}»`);
  }
  await pool.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
