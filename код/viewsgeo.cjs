// ПРОСМОТРЫ В РАЗРЕЗЕ ГЕО ПРОКСИ (10.08).
//
// ПРИКАЗ. «Прокси нужно начать тречить, где больше валида, какие меньше падают по статистике и с
// каких больше просмотров, например какое гео».
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ. Берём связку «акк → прокси → гео» из accounts.proxy_geo (её пишет
// proxygeo.cjs) и сводим с замерами просмотров, которые круглосуточно снимает viewsmon.cjs
// (post_views_log, acct_views_log). Получается три ответа начальнику в одной таблице:
//   сколько просмотров даёт гео (сумма и МЕДИАНА),
//   сколько акков в этом гео живо снаружи (доля валида по анонимному чеку),
//   и отдельным блоком, какие прокси падают при чтении (proxy_probe_log).
//
// ПОЧЕМУ МЕДИАНА, А НЕ СРЕДНЕЕ. Один рилс с 3000 просмотров на сорок нулей даёт «среднее 75» и
// картину «вроде идёт охват», хотя идёт он у одного акка. Медиана это середина ряда: если она 0,
// значит у половины акков ноль, и никакое одно везение это не спрячет. Считаем честно: сортируем
// ряд, при чётном числе берём полусумму двух средних, средним арифметическим НЕ подменяем.
//
// ПРОСМОТРЫ БЕРЁМ ПО ПОСЛЕДНЕМУ ЗАМЕРУ КАЖДОГО ПОСТА. Журнал только дописывается, у поста много
// строк за разные дни; суммировать их все значило бы посчитать один пост несколько раз.
//
// ЧЕГО ЭТОТ ОТЧЁТ НЕ ДЕЛАЕТ. Он не выдумывает гео. Акк без записанной связки попадает в строку
// «неизвестно», а не растворяется по гео «примерно похоже». Пароли прокси не читаются и не
// печатаются: в базе их в этих полях нет, только хост, порт и гео.
//
// Запуск: node viewsgeo.cjs            (можно DAYS=7, тогда учтём замеры за последние 7 дней)
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const DAYS = Number(process.env.DAYS || 0); // 0 = вся история замеров

// Честная медиана целого ряда.
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const num = (s, n) => String(s == null ? '' : s).padStart(n);

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();

  const since = DAYS > 0 ? `AND checked_at > now() - interval '${DAYS} days'` : '';

  // 1) Последний замер каждого поста + гео акка, через который пост залит.
  const posts = (await c.query(`
    WITH cur AS (
      SELECT DISTINCT ON (shortcode) shortcode, username, media_type, views, likes, comments, taken_at, checked_at
        FROM post_views_log
       WHERE true ${since}
       ORDER BY shortcode, checked_at DESC)
    SELECT COALESCE(NULLIF(a.proxy_geo,''), 'неизвестно') AS geo,
           cur.username, cur.shortcode, cur.media_type, cur.views
      FROM cur
      LEFT JOIN accounts a
        ON COALESCE(NULLIF(a.ig_login,''), a.slug) = cur.username AND a.deleted_at IS NULL`)).rows;

  // 2) Последний внешний вердикт по каждому акку: живой снаружи или нет.
  const verds = (await c.query(`
    WITH cur AS (
      SELECT DISTINCT ON (username) username, verdict, checked_at
        FROM acct_views_log
       WHERE true ${since}
       ORDER BY username, checked_at DESC)
    SELECT COALESCE(NULLIF(a.proxy_geo,''), 'неизвестно') AS geo, cur.username, cur.verdict
      FROM cur
      LEFT JOIN accounts a
        ON COALESCE(NULLIF(a.ig_login,''), a.slug) = cur.username AND a.deleted_at IS NULL`)).rows;

  // 3) Сколько акков вообще числится за каждым гео (в том числе тех, кого ещё не замеряли).
  const inBase = (await c.query(`
    SELECT COALESCE(NULLIF(proxy_geo,''), 'неизвестно') AS geo, count(*) n
      FROM accounts WHERE deleted_at IS NULL GROUP BY 1`)).rows;

  const G = {};
  const g = (k) => (G[k] = G[k] || { geo: k, accs_base: 0, accs_seen: new Set(), posts: 0, views: [], nulls: 0, zeros: 0, ok: 0, checked: 0 });
  for (const r of inBase) g(r.geo).accs_base = Number(r.n);
  for (const r of posts) {
    const x = g(r.geo);
    x.posts++; x.accs_seen.add(r.username);
    if (r.views == null) x.nulls++;
    else { x.views.push(Number(r.views)); if (Number(r.views) === 0) x.zeros++; }
  }
  for (const r of verds) {
    const x = g(r.geo);
    x.checked++; if (r.verdict === 'ok') x.ok++;
    x.accs_seen.add(r.username);
  }

  const rows = Object.values(G).sort((a, b) => b.views.reduce((s, v) => s + v, 0) - a.views.reduce((s, v) => s + v, 0) || b.posts - a.posts);

  console.log(`ПРОСМОТРЫ ПО ГЕО ПРОКСИ${DAYS > 0 ? ` (замеры за ${DAYS} дн.)` : ' (вся история замеров)'}`);
  console.log('');
  console.log('  ' + pad('гео', 12) + num('акков', 6) + num('замерено', 9) + num('постов', 7) +
    num('со счёт.', 9) + num('сумма', 8) + num('медиана', 8) + num('нулей', 7) + num('живых', 7) + '  доля живых');
  console.log('  ' + '-'.repeat(92));
  for (const r of rows) {
    const sum = r.views.reduce((s, v) => s + v, 0);
    const med = median(r.views);
    const share = r.checked ? Math.round((r.ok / r.checked) * 100) + '%' : 'нет';
    console.log('  ' + pad(r.geo, 12) + num(r.accs_base || r.accs_seen.size, 6) + num(r.accs_seen.size, 9) +
      num(r.posts, 7) + num(r.views.length, 9) + num(sum, 8) +
      num(med == null ? 'нет' : med, 8) + num(r.zeros, 7) + num(r.ok, 7) + '  ' + share);
  }
  console.log('');
  console.log('  акков     : числится за этим гео в базе (связка записана), «неизвестно» = связки нет');
  console.log('  замерено  : по скольким из них чекер уже снимал цифры');
  console.log('  со счёт.  : постов, где инстаграм отдаёт счётчик просмотров (у фото его нет)');
  console.log('  медиана   : середина ряда просмотров, не среднее: устойчива к одному везучему рилсу');
  console.log('  живых     : вердикт «ok» в последнем анонимном чеке; доля живых считается от замеренных');

  // ── КОНКРЕТНЫЕ IP: там, где порт связки известен, видно уже не гео, а сессию ────────────────
  const byIp = (await c.query(`
    WITH cur AS (
      SELECT DISTINCT ON (shortcode) shortcode, username, views
        FROM post_views_log WHERE true ${since} ORDER BY shortcode, checked_at DESC)
    SELECT a.proxy_host, a.proxy_port, a.proxy_geo, count(*) posts, sum(cur.views) sum_views
      FROM cur JOIN accounts a
        ON COALESCE(NULLIF(a.ig_login,''), a.slug) = cur.username AND a.deleted_at IS NULL
     WHERE a.proxy_port IS NOT NULL
     GROUP BY 1,2,3 ORDER BY sum_views DESC NULLS LAST LIMIT 15`)).rows;
  console.log('');
  if (byIp.length) {
    console.log('ПО КОНКРЕТНОМУ IP (порт = отдельная sticky-сессия; только там, где порт записан):');
    for (const r of byIp) {
      console.log(`  ${pad(r.proxy_host + ':' + r.proxy_port, 30)} гео ${pad(r.proxy_geo, 4)} постов ${num(r.posts, 3)}, просмотров ${r.sum_views ?? 'нет'}`);
    }
  } else {
    console.log('ПО КОНКРЕТНОМУ IP: пока нечего показать. Порт (то есть свой IP) записан только у акков,');
    console.log('  которым прокси выдавали мы сами; у пролитых магосом известна пачка, а не порт.');
  }

  // ── ПАДЕНИЯ ПРОКСИ: это про наше ЧТЕНИЕ, а не про охват. Путать нельзя ─────────────────────
  const probe = (await c.query(`
    SELECT proxy_geo geo, proxy_host host, count(*) probes,
           count(*) FILTER (WHERE outcome='ok') ok,
           count(*) FILTER (WHERE outcome='лимит') lim,
           count(*) FILTER (WHERE outcome='отказ') fail,
           count(DISTINCT proxy_port) ips, round(avg(ms)) ms
      FROM proxy_probe_log WHERE true ${since}
     GROUP BY 1,2 ORDER BY probes DESC`)).rows;
  console.log('');
  console.log('ВАЛИД ПРОКСИ ПРИ ЧТЕНИИ СТАТИСТИКИ (журнал попыток; это НЕ про охват, а про то,');
  console.log('какие прокси реже падают, когда мы через них ходим к инстаграму):');
  if (!probe.length) console.log('  журнал пуст');
  for (const r of probe) {
    const share = Number(r.probes) ? Math.round((Number(r.ok) / Number(r.probes)) * 100) : 0;
    console.log(`  гео ${pad(r.geo, 4)} ${pad(r.host, 18)} IP ${num(r.ips, 4)}, запросов ${num(r.probes, 5)}, ` +
      `валид ${num(r.ok, 5)} (${share}%), лимитов ${num(r.lim, 4)}, отказов ${num(r.fail, 4)}, среднее ${r.ms} мс`);
  }

  // ── ЧЕСТНЫЙ ХВОСТ: чего в картине не хватает ───────────────────────────────────────────────
  const gap = (await c.query(`
    SELECT count(*) n FROM accounts a
     WHERE a.deleted_at IS NULL AND (a.proxy_geo IS NULL OR a.proxy_geo='')
       AND EXISTS (SELECT 1 FROM acct_views_log v WHERE v.username = COALESCE(NULLIF(a.ig_login,''), a.slug))`)).rows[0];
  const noport = (await c.query(
    `SELECT count(*) n FROM accounts WHERE deleted_at IS NULL AND proxy_geo IS NOT NULL AND proxy_port IS NULL`)).rows[0];
  console.log('');
  console.log('ПОЛНОТА СВЯЗКИ:');
  console.log(`  акков под чекером без записанного гео: ${gap.n}, их просмотры лежат в строке «неизвестно»`);
  console.log(`  акков с гео, но без порта: ${noport.n}, гео пачки известно, конкретный IP нет`);
  console.log('  заполнить: node proxygeo.cjs file <файл «ник прокси»> --apply  (или pack, если известно только гео)');

  await c.end().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
