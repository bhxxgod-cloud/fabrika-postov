// СВЯЗКА «АККАУНТ → ПРОКСИ → ГЕО»: заполнение и проверка (10.08).
//
// ПРИКАЗ. «Прокси нужно начать тречить, где больше валида, какие меньше падают по статистике и с
// каких больше просмотров, например какое гео».
//
// ЧЕГО НЕ ХВАТАЛО. Чекер просмотров (viewsmon.cjs) уже пишет, ЧЕРЕЗ КАКОЙ прокси мы читали
// статистику, и по журналу попыток видно, какие IP падают. Но «с каких больше просмотров» так не
// считается: охват зависит от прокси, через который акк ПРОЛИТ и работает, а не от того, через что
// мы подглядываем снаружи. Связь «акк → его рабочий прокси» в базе не хранилась: ig_proxy пуст у
// всех 150 магос-акков (профиля GoLogin им не делали), egress_country ставится только замером
// через GoLogin, значит тоже пуст. Поля accounts.proxy_host/proxy_port/proxy_geo закрывают дыру
// (миграция migrations/2026-08-10-account-proxy-geo.sql).
//
// ГЕО ТОЛЬКО ПО ФАКТУ. Страну берём из строки прокси, потому что провайдер сам её туда пишет:
//   click-ip: …__cr.kz;sessttl.120 → KZ,  …__cr.ge → GE (грузинские),  …__cr.ru → RU
//   sous:     …-cc-KZ-s-u1940…     → KZ
// Название файла, из которого прокси взяли, доказательством НЕ считается. proxy_pool.country тоже:
// у живого кз-пула там '?'. Единственный фолбэк это РЕАЛЬНЫЙ замер egress_country. Не разобрали →
// пишем '?' («неизвестно») и не выдумываем.
//
// ПАРОЛИ НЕ ПИШЕМ И НЕ ПЕЧАТАЕМ. В базу идут хост, порт и гео. В вывод тоже.
//
// РЕЖИМЫ:
//   node proxygeo.cjs stat                          что уже связано: по гео и по источнику
//   node proxygeo.cjs backfill [--apply]            собрать связку из фактов в базе (без --apply только показывает)
//   node proxygeo.cjs set <ник> <прокси> [--apply]  точная связка одного акка
//   node proxygeo.cjs file <файл> [--apply]         пачкой: строки «ник<пробел|;|таб>прокси»
//   node proxygeo.cjs pack <файл-ников> <прокси-или-гео> [--apply]   известно только гео пачки
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const APPLY = process.argv.includes('--apply');
const args = process.argv.slice(3).filter((a) => a !== '--apply');

// ── РАЗБОР СТРОКИ ПРОКСИ ──────────────────────────────────────────────────────────────────────
// В хозяйстве живут два формата, поддерживаем оба (как в viewsmon.cjs):
//   host:port:user:pass      (формат магоса и кз-пула)
//   user:pass@host:port      (формат бота и ig_proxy)
// Гео ищем во ВСЕЙ строке, а не в хосте: провайдер кладёт метку страны в логин сессии.
function proxyMeta(raw, fallbackCountry) {
  const s = String(raw || '').trim();
  if (!s) return { host: null, port: null, geo: '?' };
  let host = null, port = null;
  if (s.includes('@')) {
    const tail = s.split('@').pop();
    host = tail.split(':')[0] || null; port = tail.split(':')[1] || null;
  } else {
    const p = s.split(':'); host = p[0] || null; port = p[1] || null;
  }
  const m = s.match(/__cr\.([a-z]{2})/i) || s.match(/-cc-([A-Za-z]{2})/) || s.match(/[-_.]country[-_=]([a-z]{2})/i);
  let geo = m ? m[1].toUpperCase() : null;
  let geoFrom = geo ? 'строка' : 'нет';
  // Фолбэк только на факт замера. proxy_pool.country сюда не подаём: он врёт ('?' у кз-пула).
  if (!geo && fallbackCountry && /^[A-Za-z]{2}$/.test(fallbackCountry)) { geo = fallbackCountry.toUpperCase(); geoFrom = 'egress'; }
  return { host, port, geo: geo || '?', geoFrom };
}
// Если вместо прокси дали просто код страны («KZ»), это гео пачки, хоста мы не знаем.
function geoOnly(s) {
  const t = String(s || '').trim();
  return /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : null;
}
// Хост в вывод печатаем как есть (в нём секрета нет), а строку прокси целиком, никогда.
const showMeta = (m) => `${m.host || '?'}${m.port ? ':' + m.port : ''} гео ${m.geo}`;

async function bind(c, plan) {
  // plan: [{ id, nick, host, port, geo, src }]
  if (!APPLY) return 0;
  let n = 0;
  for (const p of plan) {
    await c.query(
      `UPDATE accounts SET proxy_host=$2, proxy_port=$3, proxy_geo=$4, proxy_geo_src=$5, proxy_bound_at=now()
        WHERE id=$1`, [p.id, p.host, p.port, p.geo, p.src]);
    n++;
  }
  return n;
}

async function findAcc(c, nick) {
  const r = await c.query(
    `SELECT id, slug, ig_login FROM accounts
      WHERE deleted_at IS NULL AND (slug=$1 OR ig_login=$1) ORDER BY id LIMIT 1`, [nick]);
  return r.rows[0] || null;
}

// ── СВОДКА ЗАПОЛНЕННОСТИ ──────────────────────────────────────────────────────────────────────
async function stat(c) {
  const t = await c.query(
    `SELECT count(*) n, count(proxy_geo) bound, count(proxy_port) with_port FROM accounts WHERE deleted_at IS NULL`);
  const s = t.rows[0];
  console.log(`акков живых в базе: ${s.n}, связка «акк → прокси → гео» записана у ${s.bound}, из них с точным портом (свой IP) ${s.with_port}`);
  const byGeo = await c.query(
    `SELECT COALESCE(proxy_geo,'нет записи') geo, count(*) n FROM accounts WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  console.log('\nпо гео:');
  for (const r of byGeo.rows) console.log(`  ${String(r.geo).padEnd(12)} ${String(r.n).padStart(4)}`);
  const bySrc = await c.query(
    `SELECT COALESCE(proxy_geo_src,'нет записи') src, count(*) n FROM accounts WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  console.log('\nпо источнику связки:');
  for (const r of bySrc.rows) console.log(`  ${String(r.src).padEnd(28)} ${String(r.n).padStart(4)}`);
}

// ── СБОР СВЯЗКИ ИЗ ФАКТОВ, КОТОРЫЕ УЖЕ ЛЕЖАТ В БАЗЕ ──────────────────────────────────────────
// Четыре источника, в порядке убывания точности:
//   1) accounts.ig_proxy     , строка выданного прокси, точнее не бывает (хост + порт + гео);
//   2) proxy_pool.assigned_slug: прокси закреплён за ником в пуле;
//   3) health_note «пролито магосом … на кз-магос-100», записанный факт пролива на конкретную
//      пачку. Хост пачки один, порт конкретного акка неизвестен → пишем гео пачки без порта;
//   4) egress_country: реально замеренная страна выхода, если ничего выше нет.
async function backfill(c) {
  const plan = [];
  const seen = new Set();
  // Источник пишем ровно тот, откуда взято ГЕО: если в строке прокси метки страны нет и гео
  // пришло из замера egress, так и помечаем, чтобы потом не спорить, откуда цифра.
  const add = (row, meta, src) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    plan.push({ id: row.id, nick: row.ig_login || row.slug, ...meta, src: meta.geoFrom === 'egress' ? src + ' + гео из egress' : src });
  };

  // 1) ig_proxy
  const igp = await c.query(
    `SELECT id, slug, ig_login, ig_proxy, egress_country FROM accounts
      WHERE deleted_at IS NULL AND ig_proxy IS NOT NULL AND ig_proxy <> '' ORDER BY id`);
  for (const r of igp.rows) add(r, proxyMeta(r.ig_proxy, r.egress_country), 'ig_proxy');

  // 2) пул: прокси закреплён за слагом
  const pool = await c.query(
    `SELECT a.id, a.slug, a.ig_login, p.proxy, a.egress_country
       FROM proxy_pool p JOIN accounts a
         ON (a.slug = p.assigned_slug OR a.ig_login = p.assigned_slug) AND a.deleted_at IS NULL
      WHERE p.assigned_slug IS NOT NULL ORDER BY a.id`);
  for (const r of pool.rows) add(r, proxyMeta(r.proxy, r.egress_country), 'proxy_pool');

  // 3) партия пролива из health_note. Единственный кз-пул с такой пометкой это click-ip 74.81.81.81
  // с логинами __cr.kz, гео KZ. Порт (значит и IP) не записан, ставим NULL, чтобы не соврать.
  const note = await c.query(
    `SELECT id, slug, ig_login FROM accounts
      WHERE deleted_at IS NULL AND health_note ILIKE '%кз-магос%' ORDER BY id`);
  const kzHost = (await c.query(
    `SELECT split_part(proxy,':',1) host, count(*) n FROM proxy_pool
      WHERE proxy ILIKE '%__cr.kz%' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
  for (const r of note.rows) {
    add(r, { host: kzHost ? kzHost.host : null, port: null, geo: 'KZ' }, 'health_note (партия кз-магос-100)');
  }

  // 4) замер egress
  const eg = await c.query(
    `SELECT id, slug, ig_login, egress_country FROM accounts
      WHERE deleted_at IS NULL AND egress_country IS NOT NULL AND egress_country <> '' ORDER BY id`);
  for (const r of eg.rows) add(r, { host: null, port: null, geo: r.egress_country.toUpperCase() }, 'egress (замер)');

  console.log(`нашёл связку по фактам базы для ${plan.length} акков:`);
  const bySrc = {};
  for (const p of plan) bySrc[p.src] = (bySrc[p.src] || 0) + 1;
  for (const [k, v] of Object.entries(bySrc)) console.log(`  ${k.padEnd(34)} ${String(v).padStart(4)}`);
  const byGeo = {};
  for (const p of plan) byGeo[p.geo] = (byGeo[p.geo] || 0) + 1;
  console.log('  гео: ' + Object.entries(byGeo).map(([g, n]) => `${g}:${n}`).join(', '));
  for (const p of plan.slice(0, 10)) console.log(`    ${String(p.nick).padEnd(22)} ${showMeta(p)}  ← ${p.src}`);
  if (plan.length > 10) console.log(`    … ещё ${plan.length - 10}`);

  const rest = await c.query(
    `SELECT count(*) n FROM accounts WHERE deleted_at IS NULL
       AND (ig_proxy IS NULL OR ig_proxy='') AND (egress_country IS NULL OR egress_country='')
       AND health_note NOT ILIKE '%кз-магос%'`);
  console.log(`\nбез единого факта о прокси остаётся ${rest.rows[0].n} акков: их связку базе взять негде,`);
  console.log('заполняется руками из кабинета магоса: node proxygeo.cjs file <файл «ник прокси»> --apply');

  const n = await bind(c, plan);
  console.log(APPLY ? `\nзаписал в базу: ${n}` : '\nэто прогон без записи. Записать: добавь --apply');
}

// ── ТОЧНАЯ СВЯЗКА: ОДИН АКК ──────────────────────────────────────────────────────────────────
async function setOne(c, nick, proxy) {
  const a = await findAcc(c, nick);
  if (!a) { console.log(`акк ${nick} в базе не найден`); return; }
  const g = geoOnly(proxy);
  const meta = g ? { host: null, port: null, geo: g } : proxyMeta(proxy, null);
  console.log(`${nick}: ${showMeta(meta)}` + (meta.geo === '?' ? '  (гео из строки не читается, пишу «неизвестно»)' : ''));
  const n = await bind(c, [{ id: a.id, nick, ...meta, src: g ? 'вручную (только гео)' : 'вручную' }]);
  console.log(APPLY ? `записал в базу: ${n}` : 'это прогон без записи. Записать: добавь --apply');
}

// ── ПАЧКОЙ ИЗ ФАЙЛА «НИК ПРОКСИ» ─────────────────────────────────────────────────────────────
async function fromFile(c, file) {
  if (!fs.existsSync(file)) { console.log(`файла ${file} нет`); return; }
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const plan = []; const missed = []; let noGeo = 0;
  for (const l of lines) {
    const parts = l.split(/[\s;,]+/).filter(Boolean);
    const nick = parts[0].replace(/^@/, '');
    const proxy = parts.slice(1).join(':');
    const a = await findAcc(c, nick);
    if (!a) { missed.push(nick); continue; }
    const g = geoOnly(proxy);
    const meta = g ? { host: null, port: null, geo: g } : proxyMeta(proxy, null);
    if (meta.geo === '?') noGeo++;
    plan.push({ id: a.id, nick, ...meta, src: g ? 'файл (только гео)' : 'файл' });
  }
  console.log(`строк в файле ${lines.length}, сопоставлено с базой ${plan.length}, не найдено в базе ${missed.length}` +
    (missed.length ? ` (${missed.slice(0, 8).join(', ')}${missed.length > 8 ? '…' : ''})` : ''));
  const byGeo = {};
  for (const p of plan) byGeo[p.geo] = (byGeo[p.geo] || 0) + 1;
  console.log('гео: ' + Object.entries(byGeo).map(([g, n]) => `${g}:${n}`).join(', ') +
    (noGeo ? `  (у ${noGeo} строк гео из прокси не читается, пишу «?»)` : ''));
  const n = await bind(c, plan);
  console.log(APPLY ? `записал в базу: ${n}` : 'это прогон без записи. Записать: добавь --apply');
}

// ── ИЗВЕСТНО ТОЛЬКО ГЕО ПАЧКИ ────────────────────────────────────────────────────────────────
// Так бывает, когда в кабинете магоса пачка прокси залита на папку целиком: кто именно на каком
// порте сидит, снаружи не видно. Гео пачки это факт, порт, нет, поэтому порт остаётся пустым.
async function pack(c, file, proxyOrGeo) {
  if (!fs.existsSync(file)) { console.log(`файла ${file} нет`); return; }
  const g = geoOnly(proxyOrGeo);
  const meta = g ? { host: null, port: null, geo: g } : { ...proxyMeta(proxyOrGeo, null), port: null };
  if (meta.geo === '?') { console.log('гео пачки не разобрал, записывать «?» пачкой смысла нет, уточни строку прокси'); return; }
  const nicks = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim().replace(/^@/, '')).filter((s) => s && !s.startsWith('#'));
  const plan = []; const missed = [];
  for (const nick of nicks) {
    const a = await findAcc(c, nick);
    if (!a) { missed.push(nick); continue; }
    plan.push({ id: a.id, nick, ...meta, src: 'пачка (гео известно, порт нет)' });
  }
  console.log(`ников в файле ${nicks.length}, найдено в базе ${plan.length}, не найдено ${missed.length}`);
  console.log(`ставлю всем: ${showMeta(meta)} (порт не пишу: какой акк на каком IP, неизвестно)`);
  const n = await bind(c, plan);
  console.log(APPLY ? `записал в базу: ${n}` : 'это прогон без записи. Записать: добавь --apply');
}

// Файл работает и как команда, и как библиотека: viewsgeo.cjs берёт отсюда proxyMeta, чтобы
// определение гео жило в ОДНОМ месте. Поэтому CLI поднимается только при прямом запуске.
module.exports = { proxyMeta, geoOnly };
if (require.main !== module) return;

(async () => {
  const mode = (process.argv[2] || 'stat').toLowerCase();
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  try {
    if (mode === 'stat') await stat(c);
    else if (mode === 'backfill') await backfill(c);
    else if (mode === 'set') {
      if (args.length < 2) console.log('usage: node proxygeo.cjs set <ник> <прокси|ГЕО> [--apply]');
      else await setOne(c, args[0].replace(/^@/, ''), args[1]);
    } else if (mode === 'file') {
      if (!args[0]) console.log('usage: node proxygeo.cjs file <файл «ник прокси»> [--apply]');
      else await fromFile(c, args[0]);
    } else if (mode === 'pack') {
      if (args.length < 2) console.log('usage: node proxygeo.cjs pack <файл-ников> <прокси|ГЕО> [--apply]');
      else await pack(c, args[0], args[1]);
    } else console.log('режимы: stat | backfill | set | file | pack');
  } finally {
    await c.end().catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
