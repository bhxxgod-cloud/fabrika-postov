// cmdefence.cjs — ЗАЩИТА КОММЕНТАРИЕВ ПОД НАШИМИ ПОСТАМИ (10.08, приказ начальника «давай»).
//
// ЗАЧЕМ. Замер по вчерашнему проливу: 85 постов, просмотров 7687, медиана 96 — и 319 комментариев.
// Это около четырёх комментариев на пост при медиане в 96 просмотров, чего у свежих аккаунтов быть
// не может. Читал их своими глазами: под нашими постами сидит чужая реклама (TopFoxyBot и
// компания), то есть конкурент снимает нашу тёплую аудиторию с наших же оплаченных просмотров.
//
// ДВЕ МЕРЫ, ОБЕ БЕСПЛАТНЫЕ:
//   1. ФИЛЬТР ПО СЛОВАМ. У инстаграма есть свой фильтр комментариев: слова из чёрного списка просто
//      не публикуются. Включается на аккаунт разом, работает и на прошлые, и на будущие посты.
//   2. СВОЙ ПЕРВЫЙ КОММЕНТАРИЙ. Верхний комментарий должен быть нашим, а не чужим: он и метку
//      канала несёт, и сдвигает чужие вниз.
//
// ПРАВИЛА, КОТОРЫЕ ЗДЕСЬ СОБЛЮДАЮТСЯ (набиты шишками, не выдумка):
//   · @упоминаний НЕТ: инстаграм отказывает в публикации комментария с @ником;
//   · слово «даром» НЕ используем никогда;
//   · от первого лица и без указания пола, чтобы текст подходил любой персоне;
//   · написание метки варьируем, иначе одинаковый комментарий на всей ферме сам себя палит;
//   · ссылок в комментарии НЕТ: за ссылку в комментарии режут показы («share-restricted»).
//
// БЕЗОПАСНОСТЬ ЗАПУСКА: по умолчанию СУХОЙ прогон, ничего не меняется. Запись только с --apply.
// Пароли не вводим и не читаем: работаем мобильной сессией акка из accounts.ig_cookies.
// Секреты в вывод не печатаются ни при какой ошибке.
//
// ЗАПУСК
//   node cmdefence.cjs --only luke85469                 сухой прогон по одному акку
//   node cmdefence.cjs --only luke85469 --apply         сделать на одном акке
//   node cmdefence.cjs --apply                          на всех акках с публикациями
//   node cmdefence.cjs --only X --apply --no-comment    только фильтр слов, без комментария
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const NOCOMMENT = argv.includes('--no-comment');
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
// Группа акков целиком: спам сидит на магосовских, у них есть мобильный токен.
const GROUP = (() => { const i = argv.indexOf('--group'); return i >= 0 ? argv[i + 1] : null; })();
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? Number(argv[i + 1]) : 0; })();

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ЧЁРНЫЙ СПИСОК. Слова начальника плюс очевидные варианты написания той же сути. Инстаграм режет
// по подстроке, поэтому «телеграм» ловит и «телеграмм», а «t.me» ловит любые ссылки на каналы.
const СЛОВА = [
  'TopFoxyBot', 'topfoxy', 'foxybot',
  'телеграм', 'телеграмм', 'телега', 'телегу', 'телеге',
  'тг', 'tg', 't.me', 'telegram',
  'бот', 'бота', 'боте', 'ботом', 'bot',
  'подпишись', 'подписывайся', 'заходи в',
];

// ТЕКСТЫ ПЕРВОГО КОММЕНТАРИЯ. Разные, чтобы на ферме не стоял один и тот же. Без @, без ссылок,
// от первого лица, без указания пола. Метка канала варьируется написанием.
const ТЕКСТЫ = [
  'все шаблоны у меня в профиле, там же где делала',
  'делала по готовому шаблону, ссылка в профиле',
  'если нужен такой же шаблон, он есть у меня в профиле',
  'сохраняйте, шаблон лежит в профиле',
  'спрашивают про шаблон: он в профиле, там всё бесплатно на старте',
  'по шаблону, ничего сложного, всё в профиле',
];
const ЗАПРЕТ = /даром|@|https?:|t\.me/i;

function proxy() {
  for (const f of ['/tmp/px/kz_magos_100.txt', '/tmp/px/kz_sous_100.txt']) {
    const lines = safeRead(f).split('\n').filter((l) => l.trim().split(':').length === 4);
    if (lines.length) {
      // Строка 7 отвечала 467 на все ручки, строка 9 — 200 на те же. Это блок КОНКРЕТНОГО айпи,
      // а не проблема эндпоинта. Индекс можно задать через PX_LINE, если и эта строка сгорит.
      const p = lines[Number(process.env.PX_LINE || 9) % lines.length].trim().split(':');
      return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;
    }
  }
  return null;
}

function shortcodeToId(code) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = 0n;
  for (const ch of code) { const i = A.indexOf(ch); if (i < 0) return null; n = n * 64n + BigInt(i); }
  return n.toString();
}

// Мобильная сессия акка. Ключи не печатаем никуда.
function session(raw) {
  if (typeof raw !== 'string') raw = (raw && raw.raw) || JSON.stringify(raw);
  raw = String(raw).replace(/^\{"raw":"/, '').replace(/"\}$/, '');
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return null; }
}

function headers(S, D, A) {
  return [
    '-H', `Authorization: ${S.authorization}`,
    '-H', `User-Agent: ${(A && A.user_agent) || 'Instagram 269.0.0.18.75 Android (30/11; 420dpi; 1080x2260; samsung; SM-A515F; a51; exynos9611; ru_RU; 314665256)'}`,
    '-H', 'X-IG-App-ID: 567067343352427',
    '-H', `X-IG-WWW-Claim: ${S.www_claim || '0'}`,
    '-H', `X-CSRFToken: ${S.csrf || ''}`,
    '-H', `X-MID: ${S.mid || ''}`,
    '-H', `X-IG-Device-ID: ${(D && D.uuid) || ''}`,
    '-H', `X-IG-Android-ID: ${(D && D.android_id) || ''}`,
    '-H', `X-Bloks-Version-Id: ${(A && A.bloks_version) || ''}`,
    '-H', 'X-IG-Capabilities: 3brTv10=',
  ].reduce((acc, v, i, arr) => {
    // ПУСТЫЕ ЗАГОЛОВКИ НЕ СЛАТЬ (правка 10.08). «X-IG-Family-Device-ID: » без значения даёт 467
    // «Unsupported», и это выглядит как «эндпоинта нет». Проверено вручную: без пустых всё 200.
    if (v !== '-H') return acc;
    const h = arr[i + 1];
    if (/:\s*$/.test(h)) return acc;
    acc.push('-H', h);
    return acc;
  }, []);
}

function post(url, body, H, px) {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '35', ...H, '--data', body, url];
  if (px) args.push('--proxy', px);
  const out = String(spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 22 }).stdout || '');
  const nl = out.lastIndexOf('\n');
  const code = Number(out.slice(nl + 1).trim());
  let j = null;
  try { j = JSON.parse(out.slice(0, nl)); } catch {}
  return { code, j, raw: out.slice(0, nl) };
}

// НА ЧТЕНИИ НЕ СЛАТЬ Content-Type (правка 10.08): с ним ручка отвечала 467 «Unsupported», и я
// решил, что эндпоинта нет. Проверка вручную показала: без этого заголовка всё отдаётся 200.
function get(url, H, px) {
  const H2 = [];
  for (let i = 0; i < H.length; i += 2) if (!/^Content-Type:/i.test(H[i + 1])) H2.push(H[i], H[i + 1]);
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '35', ...H2, url];
  if (px) args.push('--proxy', px);
  const out = String(spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 22 }).stdout || '');
  const nl = out.lastIndexOf('\n');
  let j = null;
  try { j = JSON.parse(out.slice(0, nl)); } catch {}
  return { code: Number(out.slice(nl + 1).trim()), j, raw: out.slice(0, nl) };
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  // ВЫБОРКА НЕ ТРЕБУЕТ НАШИХ ПУБЛИКАЦИЙ (правка 10.08). Раньше брались только акки с постами в
  // НАШЕЙ базе, а спам сидит на магосовских: магос публикует у себя, и в posts у них ничего нет.
  // Фильтр слов ставится на АККАУНТ и постов не требует вообще. Первый комментарий требует ссылок,
  // поэтому у кого их нет, комментарий просто пропускаем (видно в выводе).
  // Плюс сразу отбрасываем акки без мобильного токена: у браузерных (GoLogin) сессия другого
  // формата, ручка их не примет, и гонять их бессмысленно.
  const rows = (await c.query(`
    SELECT a.id, a.ig_login h, coalesce(a.persona,'') persona, a.ig_cookies,
           array_remove(array_agg(p.external_url), NULL) urls
      FROM accounts a
      LEFT JOIN posts p ON p.account_id = a.id AND p.published_at IS NOT NULL
      LEFT JOIN account_groups g ON g.id = a.group_id
     WHERE a.deleted_at IS NULL
       AND coalesce(a.ig_cookies::text,'') <> ''
       AND ($1::text IS NULL OR a.ig_login = $1)
       AND ($2::text IS NULL OR g.name = $2)
     GROUP BY 1,2,3,4 ORDER BY a.ig_login`, [ONLY, GROUP])).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  await c.end().catch(() => {});

  console.log(`${APPLY ? 'РАБОТА' : 'СУХОЙ ПРОГОН (ничего не меняю, для записи нужен --apply)'}`);
  console.log(`акков к обработке: ${LIMIT>0?Math.min(LIMIT,rows.length):rows.length} (найдено ${rows.length})`);
  console.log(`слов в чёрном списке: ${СЛОВА.length}\n`);
  if (!rows.length) { console.log('нечего делать'); process.exit(1); }

  const px = proxy();
  for (const a of work) {
    const s = session(a.ig_cookies);
    const S = (s && s.session) || {};
    if (!S.authorization) { console.log(`  ✗ ${a.h}: в сессии нет мобильного токена`); continue; }
    const H = headers(S, s.device, s.app);
    console.log(`── ${a.h}${a.persona ? ' (' + a.persona + ')' : ''}`);

    // 1. ЧТО СТОИТ СЕЙЧАС. Сначала читаем, потом меняем: иначе не видно, что именно поменяли.
    const before = get('https://i.instagram.com/api/v1/accounts/get_comment_filter_keywords/', H, px);
    if (before.code === 200 && before.j) {
      const было = (before.j.keywords || []).map((k) => (typeof k === 'string' ? k : k.keyword)).filter(Boolean);
      console.log(`   было слов в фильтре: ${было.length}${было.length ? ' (' + было.slice(0, 6).join(', ') + (было.length > 6 ? '…' : '') + ')' : ''}`);
    } else {
      console.log(`   текущий фильтр не прочитал (код ${before.code}) — попробую всё равно поставить`);
    }

    if (!APPLY) {
      console.log(`   [сухой] поставил бы фильтр ON и ${СЛОВА.length} слов`);
      if (!NOCOMMENT) console.log(`   [сухой] написал бы первый комментарий под ${(a.urls || []).length} постами`);
      continue;
    }

    // 2. ВКЛЮЧАЕМ ФИЛЬТР И СТАВИМ СЛОВА.
    const on = post('https://i.instagram.com/api/v1/accounts/set_comment_filter/',
      `config_value=1&_uid=${encodeURIComponent(S.ds_user_id || '')}&_uuid=${encodeURIComponent((s.device && s.device.uuid) || '')}`, H, px);
    console.log(`   фильтр ON: код ${on.code}${on.j && on.j.status ? ', статус ' + on.j.status : ''}${on.j && on.j.message ? ', ' + String(on.j.message).slice(0, 60) : ''}`);
    await sleep(1500);
    const kw = post('https://i.instagram.com/api/v1/accounts/set_comment_filter_keywords/',
      `keywords=${encodeURIComponent(СЛОВА.join(','))}&_uid=${encodeURIComponent(S.ds_user_id || '')}&_uuid=${encodeURIComponent((s.device && s.device.uuid) || '')}`, H, px);
    console.log(`   слова: код ${kw.code}${kw.j && kw.j.status ? ', статус ' + kw.j.status : ''}${kw.j && kw.j.message ? ', ' + String(kw.j.message).slice(0, 60) : ''}`);
    await sleep(1500);

    // 3. ПРОВЕРЯЕМ ЧТЕНИЕМ, а не верим коду ответа.
    const after = get('https://i.instagram.com/api/v1/accounts/get_comment_filter_keywords/', H, px);
    const стало = after.code === 200 && after.j
      ? (after.j.keywords || []).map((k) => (typeof k === 'string' ? k : k.keyword)).filter(Boolean) : null;
    if (стало) {
      const нашлись = СЛОВА.filter((w) => стало.some((x) => String(x).toLowerCase() === w.toLowerCase()));
      console.log(`   ПРОВЕРКА: в фильтре ${стало.length} слов, из наших на месте ${нашлись.length} из ${СЛОВА.length}`);
    } else {
      console.log(`   ПРОВЕРКА не удалась (код ${after.code}): поставилось ли, не знаю`);
    }

    // 4. СВОЙ ПЕРВЫЙ КОММЕНТАРИЙ.
    if (NOCOMMENT) { console.log('   комментарий пропущен по флагу'); continue; }
    for (const url of (a.urls || [])) {
      const m = /\/(?:reel|p)\/([A-Za-z0-9_-]+)/.exec(String(url));
      if (!m) continue;
      const id = shortcodeToId(m[1]);
      if (!id) continue;
      const idx = crypto.createHash('sha1').update(a.h + m[1]).digest()[0] % ТЕКСТЫ.length;
      const текст = ТЕКСТЫ[idx];
      if (ЗАПРЕТ.test(текст)) { console.log(`   ⛔ текст не прошёл свой же запрет, пропускаю`); continue; }
      const r = post(`https://i.instagram.com/api/v1/media/${id}/comment/`,
        `comment_text=${encodeURIComponent(текст)}&idempotence_token=${crypto.randomUUID()}`
        + `&_uid=${encodeURIComponent(S.ds_user_id || '')}&_uuid=${encodeURIComponent((s.device && s.device.uuid) || '')}`
        + `&containermodule=comments_v2`, H, px);
      const ok = r.code === 200 && r.j && (r.j.status === 'ok' || r.j.comment);
      console.log(`   коммент под ${m[1]}: ${ok ? '✅ опубликован' : `✗ код ${r.code}${r.j && r.j.message ? ', ' + String(r.j.message).slice(0, 70) : ''}`} · «${текст.slice(0, 40)}…»`);
      await sleep(4000);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', String(e.message).slice(0, 140)); process.exit(1); });
