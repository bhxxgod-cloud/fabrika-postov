// ЧЕКЕР ПРОСМОТРОВ ПО АККАМ МАГОСА, 24/7 (09.08).
// Приказ начальника: «нужно сделать чекер просмотров на акках, которые заведены в магос, плюс
// чтобы он работал 24/7».
//
// ЗАЧЕМ. Залито 50 акков через магос, у каждого один наш рилс, все живы и с авой. Есть ощущение,
// что просмотров нет. Одиночный замер на это не отвечает: ноль в моменте и ноль третьи сутки это
// два разных диагноза. Нужен РЯД по дням, тогда видно, растёт охват или стоит колом. Ноль
// просмотров при живом посте это признак шэдоубана либо акка без охвата, и это ловится цифрой.
//
// ПРИНЦИП. Ноль входов в аккаунты. Смотрим только то, что видит любой прохожий: анонимный запрос
// к публичной ручке web_profile_info. Никаких сессий, никаких действий над акками.
//
// ГЛАВНАЯ ГРАБЛЯ, ИЗ-ЗА КОТОРОЙ ЭТО НЕ РАБОТАЕТ «В ЛОБ». Инстаграм режет по IP: на частых
// запросах ручка вместо профиля отдаёт «Please wait a few minutes before you try again», и
// ломается замер даже по тем акках, что читались минуту назад. Отсюда три правила:
//   1) ходим ТОЛЬКО через прокси из пула, меняя прокси на каждый запрос (у kz-магос-100 порт =
//      отдельная sticky-сессия, значит каждый запрос с другого IP);
//   2) пауза между запросами, круг растянут на десятки минут, а не залпом;
//   3) ответ про лимит это НЕ мёртвый акк. Уходим в паузу с ростом задержки и берём другой прокси.
//      «лимит» и «профиль не отдаётся» пишем разными вердиктами: путать их нельзя, иначе будем
//      хоронить живые акки.
//
// ХРАНЕНИЕ. post_views_log и acct_views_log (см. src/db/schema.sql). Каждый обход это НОВЫЕ строки,
// перезаписи нет: иначе не будет динамики. Существующие post_stats и post_shadow не трогаем.
//
// РЕЖИМЫ:
//   node viewsmon.cjs once     один обход и выход
//   node viewsmon.cjs daemon   бесконечный цикл, обход раз в 2.5 часа (поднимается сторожем)
//   node viewsmon.cjs report   сводка для начальника (сам в телеграм ничего не отправляет)
//   node viewsmon.cjs list     кого проверяем (сверка с /tmp/mago24.txt и /tmp/fresh26.txt)
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

// ПУТИ НЕ В /tmp. Мак чистит /tmp, и 13.08 чекер молча умер именно из-за этого: пропал dburl.txt,
// а с ним и обходы. Постоянное место это ~/.neironka, /tmp оставлен последним запасным вариантом.
const ДОМ = require('node:path').join(require('node:os').homedir(), '.neironka');
const первыйСущ = (...пути) => пути.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const DBURL = process.env.DB_PUBLIC_URL
  || fs.readFileSync(первыйСущ(require('node:path').join(ДОМ, 'secrets', 'dburl.txt'), '/tmp/dburl.txt'), 'utf8').trim();
const UA = 'Instagram 219.0.0.12.117 Android';
const APPID = '936619743392459';
const GROUP_MAGOS = '786f34fe-c865-43d7-a3cb-99ea8cc5e55b'; // группа «МАГО (постинг)»

// РАСКЛАДКА ПО ВРЕМЕНИ. Пауза не константа, а следствие объёма: ферма растёт (было 50 акков,
// подъезжает ещё 100 европейских, будет полторы сотни), и жёсткие 14-30 с превратили бы круг по
// 150 аккам в два часа, то есть круги начали бы наезжать друг на друга. Поэтому задаём ЦЕЛЕВУЮ
// длительность круга и делим её на число акков, зажимая результат в разумные границы.
const TARGET_MIN = Number(process.env.TARGET_MIN || 60);    // сколько минут должен занимать круг
const PAUSE_FLOOR = Number(process.env.PAUSE_FLOOR || 8);   // ниже нельзя: словим лимит по IP
const PAUSE_CAP = Number(process.env.PAUSE_CAP || 30);      // выше незачем
const ROUND_HOURS = Number(process.env.ROUND_HOURS || 2.5);
const TRIES = Number(process.env.TRIES || 4);          // сколько прокси перебрать на один акк
const BEAT = process.env.VIEWS_BEAT || '/tmp/viewsmon.beat'; // сердцебиение для сторожа

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
// Даты из базы приходят объектами Date, а их toString даёт нечитаемую портянку. Режем до минут.
const fmt = (d, len = 16) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, len) : '?');
const log = (s) => console.log(`[${ts()}] ${s}`);

// ── ПРОКСИ ────────────────────────────────────────────────────────────────────────────────────
// В базе и в файлах два разных формата, поддерживаем оба:
//   host:port:user:pass          (kz-магос-100, живые)
//   user:pass@host:port          (sous, на 09.08 не отвечают)
function toCurlProxy(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes('@')) return 'http://' + s;
  const p = s.split(':');
  if (p.length >= 4) {
    const [h, port, user] = p;
    const pass = p.slice(3).join(':');
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${h}:${port}`;
  }
  return 'http://' + s;
}

// Хост, порт и ГЕО прокси. Гео нужно тречить, а поле proxy_pool.country врёт: у живого кз-пула
// там стоит «?». Поэтому гео читаем из самой строки прокси (провайдеры кладут его в логин:
// clickip «__cr.kz», sous «-cc-KZ-»), а country из базы это только фолбэк.
function proxyMeta(raw, country) {
  const s = String(raw || '').trim();
  let host = null, port = null;
  if (s.includes('@')) {
    const tail = s.split('@').pop();
    host = tail.split(':')[0]; port = tail.split(':')[1] || null;
  } else {
    const p = s.split(':'); host = p[0] || null; port = p[1] || null;
  }
  let geo = null;
  let m = s.match(/__cr\.([a-z]{2})/i) || s.match(/-cc-([A-Z]{2})/) || s.match(/[-_.]country[-_=]([a-z]{2})/i);
  if (m) geo = m[1].toUpperCase();
  if (!geo && country && country !== '?' && country !== 'FREE') geo = country;
  return { host, port, geo: geo || '?' };
}

async function loadProxies(c) {
  const out = [];
  // ЯВНЫЙ ФАЙЛ ПРОКСИ, ВЫШЕ БАЗЫ. 19.08 обход по пулу 74.81.81.81 встал: за 8 часов 84 аккаунта,
  // из них 6 прочитаны, 36 «лимит», 42 «не прочитан». Инстаграм сжёг репутацию этих IP, и никакие
  // паузы это не лечат, нужен другой выход. Через VIEWS_PROXY подсовываем свежий пул (например
  // резидентские ClickIP), не трогая proxy_pool: эту таблицу читают другие пайплайны.
  const фПрокси = process.env.VIEWS_PROXY;
  if (фПрокси && fs.existsSync(фПрокси)) {
    for (const l of fs.readFileSync(фПрокси, 'utf8').split('\n')) {
      const s = l.trim();
      if (s && !s.startsWith('#')) out.push({ raw: s, ...proxyMeta(s, null) });
    }
    if (out.length) return out;
  }
  // Приоритет базе: пул это единственный источник правды по прокси. Берём весь живой кз-пул
  // (хост один, портов уже 200 после доливки), гео и хост запоминаем сразу для трекинга.
  try {
    const r = await c.query(
      `SELECT proxy, country FROM proxy_pool WHERE status = 'spare' AND proxy LIKE '74.81.81.81:%' ORDER BY id`);
    for (const x of r.rows) out.push({ raw: x.proxy, ...proxyMeta(x.proxy, x.country) });
  } catch {}
  // Фолбэк на файл, если пул почему-то пуст.
  if (!out.length) {
    for (const f of ['/tmp/px/kz_magos_100.txt', '/tmp/px/kz_sous_100.txt']) {
      if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (l.trim()) out.push({ raw: l.trim(), ...proxyMeta(l.trim(), null) });
      }
      if (out.length) break;
    }
  }
  // Перемешиваем: два круга подряд не должны идти по одним и тем же IP в одном порядке.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// СЕРДЦЕБИЕНИЕ. Урок 09.08: сторож на pgrep оказался ненадёжен (после сна ноутбука он перестал
// видеть живой процесс и каждую минуту пытался поднять второй, а nohup внутри сторожа падал с
// «can't detach from console», так что не поднимался вообще никто). Признак жизни теперь ФАКТ,
// который пишет сам демон: pid плюс время последнего шага. Заодно это ловит зависание: процесс
// жив, а tick застыл.
function beat(phase, extra) {
  try {
    fs.writeFileSync(BEAT, JSON.stringify({
      pid: process.pid, phase, tick_at: new Date().toISOString(), ...(extra || {}),
    }));
  } catch {}
}

// ── ЧТЕНИЕ ПРОФИЛЯ ────────────────────────────────────────────────────────────────────────────
function fetchProfile(nick, proxy) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(nick)}`;
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '30',
    '-H', `User-Agent: ${UA}`, '-H', `X-IG-App-ID: ${APPID}`, url];
  if (proxy) args.push('--proxy', toCurlProxy(proxy));
  const t0 = Date.now();
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 24 });
  const ms = Date.now() - t0;
  const out = String(r.stdout || '');
  const nl = out.lastIndexOf('\n');
  const code = Number(out.slice(nl + 1).trim()) || 0;
  const body = nl > 0 ? out.slice(0, nl) : '';
  let json = null;
  try { json = JSON.parse(body); } catch {}
  // Лимит по IP. Инстаграм отдаёт его и с кодом 200, и с 429, поэтому смотрим ещё и текст.
  const limited = code === 429 ||
    /please wait a few minutes/i.test(body) ||
    (json && /wait a few minutes/i.test(String(json.message || '')));
  return { code, body, json, limited, ms };
}

function parseUser(json) {
  const u = json && json.data && json.data.user;
  if (!u) return null;
  const media = u.edge_owner_to_timeline_media || {};
  const posts = (media.edges || []).map((e) => {
    const n = e.node || {};
    let type = 'фото';
    if (n.__typename === 'GraphSidecar') type = 'карусель';
    else if (n.is_video) type = n.product_type === 'clips' ? 'рилс' : 'видео';
    const likes = (n.edge_liked_by && n.edge_liked_by.count) != null
      ? n.edge_liked_by.count
      : (n.edge_media_preview_like ? n.edge_media_preview_like.count : null);
    return {
      shortcode: n.shortcode || null,
      media_type: type,
      // views это video_view_count. Для фото его нет и это НЕ ноль, а «нет счётчика» → null.
      views: n.video_view_count != null ? n.video_view_count : (n.video_play_count != null ? n.video_play_count : null),
      likes,
      comments: n.edge_media_to_comment ? n.edge_media_to_comment.count : null,
      taken_at: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000) : null,
    };
  }).filter((p) => p.shortcode);
  return {
    posts_count: media.count != null ? media.count : null,
    followers: (u.edge_followed_by || {}).count != null ? u.edge_followed_by.count : null,
    is_private: !!u.is_private,
    has_avatar: !!u.profile_pic_url,
    posts,
  };
}

// Один акк: перебираем прокси, лимит переживаем паузой с ростом, а не приговором.
// КАЖДАЯ попытка пишется в proxy_probe_log: без этого нельзя ответить, какие прокси меньше падают,
// потому что в снимке остаётся только тот прокси, который в итоге сработал.
async function checkOne(c, runId, nick, px, state) {
  let tries = 0;
  let lastCode = 0;
  let sawLimit = false;
  const probe = async (p, outcome, code, ms) => {
    if (!p) return;
    await c.query(
      `INSERT INTO proxy_probe_log (run_id, proxy_host, proxy_port, proxy_geo, username, outcome, http_code, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [runId, p.host, p.port, p.geo, nick, outcome, code, ms]).catch(() => {});
  };
  for (let t = 0; t < TRIES; t++) {
    tries++;
    const p = px.length ? px[state.i++ % px.length] : null;
    const r = fetchProfile(nick, p ? p.raw : null);
    lastCode = r.code;
    if (r.limited) {
      sawLimit = true;
      await probe(p, 'лимит', r.code, r.ms);
      state.backoff = Math.min(Math.max(state.backoff * 2, 60), 900); // 60с → 900с
      log(`  лимит IP на ${nick} (прокси ${p && p.host}:${p && p.port}, гео ${p && p.geo}), пауза ${Math.round(state.backoff)}с и другой прокси`);
      await sleep(state.backoff * 1000);
      continue;
    }
    if (r.code === 200) {
      const u = parseUser(r.json);
      if (u) {
        await probe(p, 'ok', 200, r.ms);
        state.backoff = 30; // прошло чисто, отпускаем тормоз
        return { verdict: 'ok', http_code: 200, tries, px: p, ...u };
      }
      // 200 без user это тоже «не отдался», а не «нет акка».
      await probe(p, 'отказ', 200, r.ms);
      await sleep(rnd(3, 7) * 1000);
      continue;
    }
    await probe(p, 'отказ', r.code, r.ms);
    if (r.code === 404) return { verdict: 'нет профиля', http_code: 404, tries, px: p };
    if (r.code === 401 || r.code === 403) {
      // Через прокси 401 бывает и как «читай через вход». Пробуем другой IP, и только потом вердикт.
      if (t < TRIES - 1) { await sleep(rnd(4, 9) * 1000); continue; }
      return { verdict: 'недоступен', http_code: r.code, tries, px: p };
    }
    await sleep(rnd(4, 9) * 1000);
  }
  return { verdict: sawLimit ? 'лимит' : 'не прочитан', http_code: lastCode, tries, px: null };
}

// ── КОГО ПРОВЕРЯЕМ ────────────────────────────────────────────────────────────────────────────
async function targets(c) {
  const r = await c.query(
    `SELECT DISTINCT COALESCE(NULLIF(ig_login,''), slug) AS nick
       FROM accounts
      WHERE deleted_at IS NULL
        -- Отметка о проливе магосом это ровно две формулировки. Широкое «%магос%» ловит лишнее:
        -- например «ВЕРДИКТ МАГОСА НЕВЕРЕН» у акка из другой группы, который магосом не проливали.
        AND (group_id = $1 OR health_note ILIKE '%пролито магосом%' OR health_note ILIKE '%у маго%')
        AND COALESCE(NULLIF(ig_login,''), slug) IS NOT NULL
      ORDER BY 1`, [GROUP_MAGOS]);
  const fromDb = r.rows.map((x) => x.nick);
  // Файлы только для сверки, что никого не потеряли. Источник это база.
  const files = [];
  for (const f of ['/tmp/mago24.txt', '/tmp/fresh26.txt']) {
    if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      const n = l.trim().replace(/^@/, '');
      if (n) files.push(n);
    }
  }
  // ДОПОЛНИТЕЛЬНЫЙ СПИСОК. Аккаунты, купленные и залитые прямо в магос, в нашей таблице accounts
  // не заводятся, а замерять их надо. Вписывать их в accounts НЕЛЬЗЯ: эту таблицу читает десяток
  // пайплайнов (postdaemon, mass100, followbeauty и другие), и новая строка означает, что аккаунт
  // начнут ИСПОЛЬЗОВАТЬ, ломая правило «один рилс в сутки». Поэтому читаем их отдельным файлом:
  // замер пишется по нику в post_views_log и строки в accounts не требует.
  const доп = [];
  const фДоп = process.env.VIEWS_EXTRA || require('node:path').join(ДОМ, 'viewsmon_доп.txt');
  if (fs.existsSync(фДоп)) {
    for (const l of fs.readFileSync(фДоп, 'utf8').split('\n')) {
      const n = l.trim().replace(/^@/, '');
      if (n && !n.startsWith('#')) доп.push(n);
    }
  }
  // ТОЛЬКО ДОПОЛНИТЕЛЬНЫЙ СПИСОК. Когда надо быстро ответить на один вопрос («набрали ли просмотры
  // вчерашние 55»), полный круг по 218 аккам не нужен: он идёт часами и жжёт лимиты на тех, кого
  // мы сейчас не спрашиваем. VIEWS_ONLY=1 сужает обход до файла.
  const толькоДоп = process.env.VIEWS_ONLY === '1' && доп.length;
  const nicks = толькоДоп ? [...new Set(доп)] : [...new Set([...fromDb, ...доп])];
  const miss = files.filter((n) => !nicks.includes(n));
  return { nicks, files, miss, доп: доп.length };
}

// ── ОБХОД ─────────────────────────────────────────────────────────────────────────────────────
async function round(c) {
  const runId = new Date().toISOString();
  let { nicks, files, miss } = await targets(c);
  // LIMIT_N нужен только для отладки движка: прогнать 2-3 акка и убедиться, что пишется в базу.
  if (process.env.LIMIT_N) nicks = nicks.slice(0, Number(process.env.LIMIT_N));
  const px = await loadProxies(c);
  // Пауза считается от объёма, а не задана руками: круг должен укладываться в TARGET_MIN минут,
  // иначе при росте фермы круги наедут друг на друга.
  const pauseAvg = Math.min(Math.max((TARGET_MIN * 60) / Math.max(nicks.length, 1), PAUSE_FLOOR), PAUSE_CAP);
  const pMin = Math.max(PAUSE_FLOOR, pauseAvg * 0.7), pMax = pauseAvg * 1.3;
  const geos = {};
  for (const p of px) geos[p.geo] = (geos[p.geo] || 0) + 1;
  log(`ОБХОД ${runId}: акков ${nicks.length}, прокси ${px.length} (гео ${Object.entries(geos).map(([g, n]) => g + ':' + n).join(', ')}), ` +
    `пауза ${pMin.toFixed(0)}-${pMax.toFixed(0)}с, круг примерно ${Math.round(nicks.length * (pauseAvg + 5) / 60)} мин` +
    (miss.length ? `, в файлах но не в базе: ${miss.join(', ')}` : `, сверка с файлами (${files.length}) чистая`));
  if (!px.length) { log('ПРОКСИ НЕТ, обход отменён: без прокси инстаграм режет по IP'); return; }

  const state = { i: Math.floor(Math.random() * px.length), backoff: 30 };
  const tally = { ok: 0, 'лимит': 0, 'нет профиля': 0, 'недоступен': 0, 'не прочитан': 0 };
  let posts = 0, withViews = 0, zeroViews = 0;

  for (const [i, nick] of nicks.entries()) {
    beat('round', { run_id: runId, done: i, total: nicks.length, now: nick });
    const r = await checkOne(c, runId, nick, px, state);
    tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    const p = r.px || {};
    await c.query(
      `INSERT INTO acct_views_log (run_id, username, verdict, posts_count, followers, is_private, has_avatar, http_code, tries, proxy_host, proxy_port, proxy_geo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [runId, nick, r.verdict, r.posts_count ?? null, r.followers ?? null,
        r.is_private ?? null, r.has_avatar ?? null, r.http_code, r.tries,
        p.host ?? null, p.port ?? null, p.geo ?? null]).catch((e) => log('  база: ' + e.message));

    let line = `  ${String(i + 1).padStart(2)}/${nicks.length} ${nick.padEnd(20)} ${r.verdict}`;
    if (r.verdict === 'ok') {
      line += `, постов ${r.posts_count}, подписчиков ${r.followers}` + (r.is_private ? ', ПРИВАТ' : '') + (r.has_avatar ? '' : ', БЕЗ АВЫ');
      for (const p of r.posts || []) {
        posts++;
        if (p.views != null && p.views > 0) withViews++; else if (p.views === 0) zeroViews++;
        await c.query(
          `INSERT INTO post_views_log (run_id, username, shortcode, media_type, views, likes, comments, taken_at, proxy_host, proxy_port, proxy_geo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [runId, nick, p.shortcode, p.media_type, p.views, p.likes, p.comments, p.taken_at,
            (r.px || {}).host ?? null, (r.px || {}).port ?? null, (r.px || {}).geo ?? null])
          .catch((e) => log('  база: ' + e.message));
        line += `\n        ${p.shortcode} ${p.media_type} просмотров ${p.views == null ? 'нет счётчика' : p.views}, лайков ${p.likes}, комментов ${p.comments}`;
      }
    }
    console.log(line);
    if (i < nicks.length - 1) await sleep(rnd(pMin, pMax) * 1000);
  }
  log(`ОБХОД ЗАКРЫТ: ` + Object.entries(tally).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') +
    `; постов ${posts}, с просмотрами больше нуля ${withViews}, ровно ноль ${zeroViews}`);
}

// ── СВОДКА ────────────────────────────────────────────────────────────────────────────────────
async function report(c) {
  const last = await c.query(`SELECT max(run_id) AS r FROM acct_views_log`);
  const runId = last.rows[0] && last.rows[0].r;
  if (!runId) { console.log('Замеров пока нет: ни одного обхода не было.'); return; }

  const a = await c.query(
    `SELECT verdict, count(*) n FROM acct_views_log WHERE run_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [runId]);
  const tot = a.rows.reduce((s, x) => s + Number(x.n), 0);
  const runs = await c.query(`SELECT count(DISTINCT run_id) n, min(checked_at) f FROM acct_views_log`);
  // Незакрытый обход нельзя подавать как итог: иначе «проверено 12» прочитается как «остальные
  // пропали». Сверяем с числом целей и честно пишем, идёт круг или уже закрыт.
  const { nicks } = await targets(c);
  const running = tot < nicks.length;

  // Последний и предыдущий замер по каждому посту, плюс самый старый за пределами суток.
  const dyn = await c.query(`
    WITH cur AS (
      SELECT DISTINCT ON (shortcode) shortcode, username, media_type, views, likes, comments, taken_at, checked_at
        FROM post_views_log ORDER BY shortcode, checked_at DESC),
    prev AS (
      SELECT DISTINCT ON (p.shortcode) p.shortcode, p.views AS views_prev, p.checked_at AS at_prev
        FROM post_views_log p JOIN cur ON cur.shortcode = p.shortcode AND p.checked_at < cur.checked_at
       ORDER BY p.shortcode, p.checked_at DESC),
    old AS (
      SELECT DISTINCT ON (p.shortcode) p.shortcode, p.views AS views_day, p.checked_at AS at_day
        FROM post_views_log p WHERE p.checked_at < now() - interval '24 hours'
       ORDER BY p.shortcode, p.checked_at DESC)
    SELECT cur.*, prev.views_prev, prev.at_prev, old.views_day, old.at_day
      FROM cur LEFT JOIN prev USING (shortcode) LEFT JOIN old USING (shortcode)
     ORDER BY cur.views DESC NULLS LAST`);

  const rows = dyn.rows;
  const grow = rows.filter((r) => r.views_prev != null && r.views != null && r.views > r.views_prev);
  const flat = rows.filter((r) => r.views_prev != null && r.views != null && r.views === r.views_prev);
  const zero = rows.filter((r) => r.views === 0);
  const zeroDay = rows.filter((r) => r.views === 0 && r.views_day === 0);
  const nonzero = rows.filter((r) => r.views != null && r.views > 0);
  const bad = a.rows.filter((x) => x.verdict !== 'ok');
  const sumViews = nonzero.reduce((s, r) => s + r.views, 0);

  console.log('СВОДКА ПО ПРОСМОТРАМ (акки магоса)');
  console.log(`Последний обход: ${String(runId).replace('T', ' ').slice(0, 19)} UTC. Всего обходов в базе: ${runs.rows[0].n}, ряд ведётся с ${fmt(runs.rows[0].f, 19)} UTC.`);
  console.log('');
  console.log(`Аккаунтов под наблюдением: ${nicks.length}`);
  console.log(`Аккаунтов проверено в этом обходе: ${tot}` +
    (running ? ` — ОБХОД ЕЩЁ ИДЁТ, остальные ${nicks.length - tot} в очереди` : ' (круг закрыт)'));
  for (const x of a.rows) console.log(`  ${x.n} ${x.verdict}`);
  if (bad.length) console.log(`  профиль не отдаётся всего: ${bad.reduce((s, x) => s + Number(x.n), 0)}`);
  console.log('');
  console.log(`Постов под наблюдением: ${rows.length}`);
  console.log(`  с просмотрами больше нуля: ${nonzero.length} (суммарно ${sumViews} просмотров)`);
  console.log(`  ровно ноль просмотров: ${zero.length}`);
  console.log(`  ноль просмотров сутки и дольше: ${zeroDay.length}` +
    (rows.some((r) => r.views_day != null) ? '' : ' (ряд короче суток, цифра появится позже)'));
  console.log(`  просмотры выросли с прошлого замера: ${grow.length}`);
  console.log(`  стоят без изменений: ${flat.length}` +
    (rows.some((r) => r.views_prev != null) ? '' : ' (это первый замер, сравнивать пока не с чем)'));
  console.log('');
  console.log('ПО ПОСТАМ (просмотры, изменение с прошлого замера):');
  for (const r of rows) {
    const d = r.views_prev == null ? 'первый замер'
      : (r.views - r.views_prev > 0 ? `+${r.views - r.views_prev}` : (r.views - r.views_prev < 0 ? String(r.views - r.views_prev) : 'без роста'));
    console.log(`  ${r.username.padEnd(20)} ${r.shortcode} ${String(r.media_type).padEnd(8)} ` +
      `просмотров ${String(r.views == null ? 'нет счётчика' : r.views).padStart(6)}  ${d}` +
      `  лайков ${r.likes}, комментов ${r.comments}, опубликован ${fmt(r.taken_at)}`);
  }
  if (bad.length) {
    const b = await c.query(
      `SELECT username, verdict, http_code FROM acct_views_log WHERE run_id = $1 AND verdict <> 'ok' ORDER BY verdict, username`, [runId]);
    console.log('');
    console.log('ПРОФИЛЬ НЕ ОТДАЛСЯ:');
    for (const x of b.rows) console.log(`  ${x.username.padEnd(20)} ${x.verdict} (код ${x.http_code})`);
  }
  await proxyReport(c);
}

// ── ПРОКСИ: ГДЕ БОЛЬШЕ ВАЛИДА ─────────────────────────────────────────────────────────────────
// Приказ: «где больше валида, какие меньше падают по статистике и с каких больше просмотров,
// например какое гео». Здесь считаются первые две части, по журналу попыток: это гео, через
// которое мы СМОТРИМ статистику, к охвату оно отношения не имеет.
// Третья часть («с каких больше просмотров») живёт отдельно, в viewsgeo.cjs: она считается по
// связке «акк → прокси → гео» в accounts.proxy_geo, которую пишет proxygeo.cjs (миграция
// migrations/2026-08-10-account-proxy-geo.sql). Подавать гео чтения как гео залива было бы врать.
async function proxyReport(c) {
  const q = await c.query(`
    SELECT proxy_geo AS geo, proxy_host AS host,
           count(*) AS probes,
           count(*) FILTER (WHERE outcome = 'ok') AS ok,
           count(*) FILTER (WHERE outcome = 'лимит') AS lim,
           count(*) FILTER (WHERE outcome = 'отказ') AS fail,
           count(DISTINCT proxy_port) AS ips,
           round(avg(ms)) AS ms
      FROM proxy_probe_log
     GROUP BY 1, 2 ORDER BY probes DESC`);
  console.log('');
  console.log('ПРОКСИ (по журналу попыток, каждая попытка учтена):');
  if (!q.rows.length) { console.log('  журнал пуст: обходы шли до включения трекинга прокси'); }
  for (const r of q.rows) {
    const share = r.probes > 0 ? Math.round((Number(r.ok) / Number(r.probes)) * 100) : 0;
    console.log(`  гео ${String(r.geo).padEnd(3)} провайдер ${String(r.host).padEnd(16)} ` +
      `IP в работе ${String(r.ips).padStart(3)}, запросов ${String(r.probes).padStart(4)}, ` +
      `валид ${String(r.ok).padStart(4)} (${share}%), лимитов ${String(r.lim).padStart(3)}, отказов ${String(r.fail).padStart(3)}, ` +
      `среднее время ${r.ms} мс`);
  }
  // Худшие IP: те, что чаще всего отдают лимит или отказ. Их видно только по журналу попыток.
  const worst = await c.query(`
    SELECT proxy_host, proxy_port, proxy_geo,
           count(*) AS n,
           count(*) FILTER (WHERE outcome <> 'ok') AS bad
      FROM proxy_probe_log GROUP BY 1,2,3 HAVING count(*) FILTER (WHERE outcome <> 'ok') > 0
     ORDER BY bad DESC, n DESC LIMIT 10`);
  if (worst.rows.length) {
    console.log('  падучие IP (порт = отдельная sticky-сессия):');
    for (const r of worst.rows) {
      console.log(`    ${r.proxy_host}:${r.proxy_port} гео ${r.proxy_geo} — неудач ${r.bad} из ${r.n}`);
    }
  }
  // Просмотры в разрезе гео ЗАЛИВА. Пока связь не пишется, единственная известная привязка это
  // партия пролива из health_note, и она даётся честно, как партия, а не как «гео прокси».
  const batch = await c.query(`
    WITH cur AS (
      SELECT DISTINCT ON (shortcode) shortcode, username, views
        FROM post_views_log ORDER BY shortcode, checked_at DESC)
    SELECT CASE
             WHEN a.health_note ILIKE '%кз-магос%' THEN 'партия кз-магос-100 (KZ)'
             WHEN a.health_note ILIKE '%у маго%'   THEN 'партия куплен-у-маго (гео не записано)'
             ELSE 'партия не указана'
           END AS batch,
           count(*) AS posts, round(avg(cur.views)) AS avg_views,
           count(*) FILTER (WHERE cur.views = 0) AS zero
      FROM cur JOIN accounts a
        ON COALESCE(NULLIF(a.ig_login,''), a.slug) = cur.username AND a.deleted_at IS NULL
     GROUP BY 1 ORDER BY posts DESC`);
  console.log('  просмотры по партии пролива:');
  for (const r of batch.rows) {
    console.log(`    ${String(r.batch).padEnd(38)} постов ${r.posts}, среднее просмотров ${r.avg_views}, нулей ${r.zero}`);
  }
  // Полнота связки «акк → прокси → гео»: без неё разрез по гео залива остаётся дырявым.
  const link = await c.query(`
    SELECT count(*) n, count(proxy_geo) bound, count(proxy_port) with_port
      FROM accounts WHERE deleted_at IS NULL
        AND (group_id = $1 OR health_note ILIKE '%пролито магосом%' OR health_note ILIKE '%у маго%')`, [GROUP_MAGOS]);
  const l = link.rows[0];
  console.log(`  связка акк → прокси → гео: из ${l.n} акков магоса гео записано у ${l.bound}, точный порт (свой IP) у ${l.with_port}.`);
  console.log('    просмотры по гео:  node viewsgeo.cjs');
  console.log('    дозаполнить связку: node proxygeo.cjs file <файл «ник прокси»> --apply');
}

// ── ТОЧКА ВХОДА ───────────────────────────────────────────────────────────────────────────────
(async () => {
  const mode = (process.argv[2] || 'once').toLowerCase();
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();

  if (mode === 'list') {
    const { nicks, files, miss } = await targets(c);
    console.log(`в базе под наблюдением ${nicks.length}:`);
    nicks.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)} ${n}`));
    console.log(`\nв файлах ников ${files.length}, потерянных (в файле есть, в базе нет): ${miss.length}` + (miss.length ? ' → ' + miss.join(', ') : ''));
    await c.end(); return;
  }
  if (mode === 'report') { await report(c); await c.end(); return; }
  if (mode === 'once') { await round(c); await c.end(); return; }
  if (mode === 'daemon') {
    log(`демон поднят, обход раз в ${ROUND_HOURS} ч, круг рассчитан на ${TARGET_MIN} мин (пауза считается от числа акков)`);
    beat('start', {});
    await c.end().catch(() => {});
    // Бесконечный цикл. Падать нельзя: любую ошибку логируем и ждём круг, сторож всё равно поднимет.
    // Соединение на каждый круг СВОЁ: клиент pg после end уже не оживает, а круги идут часами и
    // разрыв за это время дело обычное.
    for (;;) {
      let cc = null;
      try {
        cc = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
        cc.on('error', () => {});
        await cc.connect();
        await round(cc);
      } catch (e) {
        log('ОШИБКА ОБХОДА: ' + e.message);
      } finally {
        if (cc) await cc.end().catch(() => {});
      }
      const wait = ROUND_HOURS * 3600 * 1000 * rnd(0.9, 1.1); // разброс, чтобы круги не были ровно по часам
      const next = new Date(Date.now() + wait).toISOString();
      log(`следующий обход через ${(wait / 3600000).toFixed(2)} ч`);
      // В простое сердцебиение обязано продолжаться, иначе сторож примет сон за смерть и убьёт
      // работающий демон. Стучим раз в 30 секунд.
      const until = Date.now() + wait;
      while (Date.now() < until) {
        beat('idle', { next_round: next });
        await sleep(Math.min(30000, until - Date.now()));
      }
    }
  }
  console.log('режимы: once | daemon | report | list');
  await c.end();
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
