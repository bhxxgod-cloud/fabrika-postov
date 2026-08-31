// firstcomment.cjs — СВОЙ ПЕРВЫЙ КОММЕНТ ПОД СВОИМ СВЕЖИМ ПОСТОМ (задача 35, приказ 11.08).
//
// ЗАЧЕМ. Это наш канал трафика. Ссылку в БИО инстаграм наказывает (проверено, память проекта),
// в ПОДПИСИ поста ссылка пессимизируется, а вот первый коммент под своим же постом это законный
// путь дальше: он виден сразу под подписью, живёт вечно и его можно закрепить.
//
// ПОЧЕМУ СВОИМ СКРИПТОМ, А НЕ МАГОСОМ. Магос не умеет ни своего коммента, ни закрепа; заявка
// партнёру написана. Поэтому идём обычным нашим контуром: GoLogin startLocal (локальная Orbita),
// playwright по CDP, куки из базы, сверка ds_user_id, в конце ВСЕГДА stopLocal. Образец контура,
// stories.cjs (проверен на живом акке), интерфейс через iglib.
//
// ═══ ЧТО ИЗМЕРЕНО НА ЖИВОМ АККЕ 11.08 (bryan436344), читать до правок ════════════════════════
//   1. КОММЕНТ ПОД СВОИМ ПОСТОМ ВСТАЁТ. Текст словами, без ссылки и без @, публикуется и виден.
//      Ручка веба отвечает 200 и отдаёт готовый коммент с его id, см. итог прогона ниже.
//   2. ЗАКРЕПИТЬ КОММЕНТ ВЕБ НЕ ДАЁТ. Это ИЗМЕРЕНО тремя способами (probePin), а не прочитано в
//      документации:
//        · по наведению на свой коммент «...» появляется, но в его меню РОВНО ДВА пункта,
//          «Delete» и «Cancel». Пункта «Pin»/«Закрепить» в вебе нет вообще
//          (снимок: /tmp/firstcomment/pin_menu_<media_id>.jpg);
//        · три ручки закрепа (/api/v1/web/comments/<media>/pin/<pk>/,
//          /api/v1/media/<media>/comment/<pk>/pin/ и .../pin_comment/) отвечают 404 и отдают
//          HTML-скелет логина, то есть таких маршрутов в вебе просто не существует;
//        · чтение комментов после попыток: pinned_comments пуст, полей про закреп у коммента нет.
//      Закреп это функция ПРИЛОЖЕНИЯ. Подделывать мобильный user-agent живой сессией мы не будем,
//      за такое жгут акки (тот же вывод, что в stories.cjs про автоархив историй).
//      РАБОЧАЯ СХЕМА ВМЕСТО ЗАКРЕПА: наш коммент ПЕРВЫЙ по времени под своим постом, поэтому он и
//      стоит сверху в ветке. Настоящий закреп ждём от магоса (заявка партнёру написана).
//   3. ССЫЛКУ И «@» В КОММЕНТ НЕ КЛАДЁМ. Проверено ранее: «@ник» даёт отказ публикации, а бренд
//      словами и слово «промпт» проходят. Поэтому пул фраз это ТОЛЬКО слова плюс призыв найти
//      сервис поиском, а гард ниже физически не даёт отправить ни ссылку, ни собачку.
//
// ЗАПУСК
//   node firstcomment.cjs --slug bryan436344              найти свежий пост, дождаться паузы, отписать
//   node firstcomment.cjs --slugs a,b,c                   пачкой, по одному акку за раз
//   node firstcomment.cjs --slug X --now                  без паузы (проверка руками)
//   node firstcomment.cjs --slug X --delay-min 3 --delay-max 10   пауза после публикации, минуты
//   node firstcomment.cjs --slug X --dry                  показать текст и пост, в IG не ходить
//   node firstcomment.cjs --slug X --probe-pin            ТОЛЬКО осмотр: даёт ли веб закрепить
//   node firstcomment.cjs --slug X --no-pin               не пытаться закреплять
//   node firstcomment.cjs --slug X --text "своя фраза"    свой текст (через тот же гард)
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');
const T = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp/firstcomment';
const sleep = L.sleep;

// ── аргументы ───────────────────────────────────────────────────────────────
function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);
const SLUGS = (arg('slugs') || arg('slug') || process.argv.slice(2).find((x) => !x.startsWith('--')) || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DELAY_MIN = Number(arg('delay-min', 3));
const DELAY_MAX = Number(arg('delay-max', 10));
const NOW = has('now');
const DRY = has('dry');
const NO_PIN = has('no-pin');
const PROBE_PIN = has('probe-pin');
const TEXT_IN = arg('text');

// ЗАПРЕТ ТРОГАТЬ БРЕНДОВЫЕ И МОДЕЛЬНЫЕ АККИ (приказ). Гейт по слагу И по ig_login: у части акков
// слаг технический (case17002 это cherry.mood59), и проверка по одному полю пропускает акк.
const NEVER = ['ai.promt.vibe', 'ai.photo.vibe', 'damari1735', 'cherry.mood59'];

// ═══ ПУЛ ФРАЗ ════════════════════════════════════════════════════════════════════════════════
// Смысл у всех один: ГДЕ ИСКАТЬ, ЧТОБЫ ПОВТОРИТЬ. Требования начальника, они же требования IG:
// от первого лица, разговорно, БЕЗ рода (значит без «делала/делал», только настоящее время),
// без обещаний, без «бесплатно» и «скидка», без ссылки и без «@».
//
// {B} это бренд плюс слово-маркер. Маркер берём из контракта шаблонов (frame4Marker), а не пишем
// руками: канал должен совпасть с тем, что НАРИСОВАНО на четвёртом кадре, иначе вся аналитика
// источников (инстаграм ищет «промпты», тикток «шаблоны») превращается в кашу.
const POOL = [
  'если хотите так же, ищите {B}, там всё и собираю',
  'делаю тут через {B}, наберите в поиске и найдёте',
  'кому надо повторить: {B}, ищется с первого раза',
  'это {B}, просто наберите в поиске',
  'спрашивают где, отвечаю: {B}, туда и хожу',
  'собираю в {B}, найти можно поиском по этим словам',
  'кто хочет так же, слово для поиска: {B}',
  'тут всё из {B}, наберите в поиске, дальше сами',
  'если интересно как, это {B}, ищите по названию',
  'беру оттуда же: {B}, поиском находится сразу',
  'на всякий случай: {B}, это и есть ответ на «где»',
  'повторить просто, ищите {B} и делайте своё',
  'откуда: {B}, наберите в поиске это название',
  'кому интересно, название для поиска: {B}',
];

// РОТАЦИЯ НАПИСАНИЯ БРЕНДА. Ломаем exact-match подпись «нейронка про», это главный флаг IG для
// бренда и ссылки: разные написания читаются человеком как один и тот же сервис, но байт-в-байт
// не совпадают. ДОМЕННЫЕ написания («нейронка.про») здесь НЕ используем, в отличие от vcomment:
// там коммент под ЧУЖИМ постом, а тут под своим, и любой намёк на адрес под своей же публикацией
// это прямой повод для share-restrict на аккаунт, который нам ещё постить.
const BRAND_SPELL = ['нейронка про', 'neironka pro'];

// ГАРД ЗАПРЕТНЫХ СЛОВ. Копия правила из vcomment.cjs (BANNED_WORDS/hasBanned) плюс запреты
// начальника по этой задаче. Копия, а не импорт, по двум причинам: vcomment.cjs это скрипт с
// IIFE (require его ЗАПУСТИТ), а iglib.cjs сейчас лежит с чужой незакоммиченной правкой, и
// трогать его нельзя (дисциплина деплоя). Правило одно: меняешь список там, поменяй здесь.
const BANNED = [
  /даром/i,                      // правило владельца, никогда
  /бесплатн/i, /скидк/i,         // задача 35: без обещаний и без «бесплатно»
  /@/,                           // «@ник» = отказ публикации (проверено)
  /https?:|www\./i,              // ссылка = отказ или тихое непубликование
  // Адрес в любом написании, включая «нейронка.про». Граница слова тут ЛУКАХЕДОМ, а не \b:
  // в JS \b не работает после кириллицы, и с \b это правило молча пропускало «нейронка.про»
  // (та же грабля, что уже ловили в комментинге).
  /[a-zа-яё0-9]\.(com|ru|pro|про|io|net|me|app|ai)(?![a-zа-яё0-9])/i,
  /ссылка|в шапке|в био|в профиле|в описании/i,          // «ссылка в шапке» тоже режется
];
const banReason = (t) => (BANNED.find((r) => r.test(String(t || ''))) || null);

// Ровный выбор без случайности: один и тот же акк на одном и том же посте всегда даёт один текст
// (перезапуск после сбоя не меняет фразу), а РАЗНЫЕ акки дают разные фразы.
const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; };
function pickText(handle, code) {
  const h = hash(handle + '|' + code);
  const brand = BRAND_SPELL[h % BRAND_SPELL.length] + ' ' + T.frame4Marker('reels');
  const raw = POOL[Math.floor(h / BRAND_SPELL.length) % POOL.length];
  // Склонение там, где фраза уже несёт предлог «в»: «в нейронке про промпты» вместо «в нейронка про».
  const text = raw.replace('в {B}', 'в ' + brand.replace(/^нейронка /, 'нейронке '))
    .replace('{B}', brand);
  const bad = banReason(text);
  if (bad) throw new Error(`пул фраз даёт запрещённый текст «${text}» (правило ${bad})`);
  return text;
}

// ═══ СЕССИЯ ══════════════════════════════════════════════════════════════════════════════════
global.__GL = null;
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try {
    // ТОЛЬКО stopLocal. pkill по Orbita и по Chrome запрещён: в этих окнах личные профили
    // начальника, а без синхронизации профиля акк вылогинивается.
    await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(8000)]);
    if (typeof gl.killBrowser === 'function') gl.killBrowser();
    console.log(`  ⏹ профиль закрыт (${why})`);
  } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT ' + e.message); await closeLocal('uncaught'); process.exit(1); });

async function openSession(row) {
  const { default: GoLogin } = await import('gologin');
  L.dropBrokenProfileZip(row.pid);   // пустой архив профиля = браузер без кук (разбор 07.08)
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  let st = null;
  for (let t = 1; t <= 3 && !st; t++) {
    try { st = await gl.startLocal(); if (!st || !st.wsUrl) { st = null; throw new Error('startLocal без wsUrl'); } }
    catch (e) { console.log(`  ⚠ GoLogin попытка ${t}/3: ${String(e.message).slice(0, 90)}`); if (t < 3) await sleep(45000); }
  }
  if (!st) throw new Error('GoLogin не поднял профиль (3 попытки)');
  const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
  await L.hardenContext(ctx);
  await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
  await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
  const cks = L.normCookies(row.ig_cookies);
  if (cks.length) await ctx.addCookies(cks);
  console.log(`  🍪 сессия подставлена (${cks.length} кук)`);
  await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000); await L.dismissDialogs(page);
  // Экран выбора профиля («Continue»): сессия живая, надо подтвердить.
  for (let t = 0; t < 3; t++) {
    let cont = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
    if (!(await cont.isVisible({ timeout: 2000 }).catch(() => false))) {
      cont = page.locator('div[role="button"], button').filter({ hasText: /^(Continue|Продолжить)$/i }).first();
      if (!(await cont.isVisible({ timeout: 2000 }).catch(() => false))) break;
    }
    await cont.click({ timeout: 5000 }).catch(() => {});
    await sleep(7000); await L.dismissDialogs(page);
  }
  // КТО МЫ. Положительная классификация плюс сверка ds_user_id: коммент от нашего имени под чужим
  // постом это худшее, что может выдать этот скрипт.
  const cls = await L.classifyScreen(ctx, page);
  if (cls.state !== 'logged_in') throw new Error(`экран=${cls.state} (${cls.evidence}), сессия не подтверждена`);
  const expected = (cks.find((x) => x.name === 'ds_user_id') || {}).value;
  if (expected && String(cls.dsUserId) !== String(expected)) {
    throw new Error(`в браузере ds_user_id=${cls.dsUserId}, у акка ${expected}, ЧУЖАЯ сессия, стоп`);
  }
  console.log(`  ✓ в нужном аккаунте (ds_user_id=${cls.dsUserId})`);
  return { gl, b, ctx, page, uid: String(cls.dsUserId) };
}

// ═══ САМЫЙ СВЕЖИЙ ПОСТ ═══════════════════════════════════════════════════════════════════════
// Спрашиваем сам инстаграм изнутри живой сессии, а не читаем базу: база знает только то, что
// публиковали МЫ, а свежим может оказаться пост от магоса или сделанный руками. На bryan436344
// это и вышло: в базе последний пост от 08.08, а на профиле лежат ещё два, от 11.08.
//
// ЧЕМ БЕРЁМ (измерено 11.08, а не выбрано по вкусу):
//   · /api/v1/feed/user/<uid>/ отвечает 200 и отдаёт ровно то, что нужно: pk, code, taken_at и
//     признак закрепа. Это основной путь.
//   · users/web_profile_info НЕ ГОДИТСЯ в одиночку: отдаёт edge_owner_to_timeline_media.count=15
//     и ПУСТОЙ edges. Оставлен запасным, потому что пустой список тут не значит «постов нет».
//   · сетка DOM это последний рубеж: коды из неё есть всегда, а media_id считается из кода
//     (shortcode это base64 от pk, проверено сверкой с pk из feed/user на трёх постах).
//
// ПОЧЕМУ ПО ВРЕМЕНИ, А НЕ ПО ПОРЯДКУ В СЕТКЕ. Закреплённый пост инстаграм ставит в сетке ПЕРВЫМ,
// хотя он может быть годовалым: выбор «первый в сетке» отправил бы коммент под старьё. Берём
// максимум taken_at и закреплённые из выбора исключаем.
async function readLatest({ uid, handle }) {
  const APP = { 'x-ig-app-id': '936619743392459' };
  const срез = (list, источник) => {
    const live = list.filter((x) => !x.pinned && x.code).sort((a, b) => b.ts - a.ts);
    return { ok: !!live.length, источник, latest: live[0] || null, list: list.slice(0, 6) };
  };
  // 1. Лента аккаунта.
  try {
    const r = await fetch(`/api/v1/feed/user/${uid}/?count=12`, { credentials: 'include', headers: APP });
    if (r.status === 200) {
      const d = await r.json();
      const list = (d.items || []).filter((i) => i && i.code).map((i) => ({
        code: i.code, id: String(i.pk), ts: i.taken_at || 0,
        pinned: !!((i.timeline_pinned_user_ids || []).length),
        comments: i.comment_count || 0,
      }));
      if (list.length) return срез(list, 'feed/user');
    }
  } catch {}
  // 2. Публичная ручка профиля (бывает пустой, см. выше).
  try {
    const r = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
      { credentials: 'include', headers: APP });
    if (r.status === 200) {
      const u = (((await r.json()) || {}).data || {}).user;
      const nodes = (((u || {}).edge_owner_to_timeline_media || {}).edges || []).map((e) => e.node).filter(Boolean);
      const list = nodes.map((n) => ({
        code: n.shortcode, id: String(n.id), ts: n.taken_at_timestamp || 0,
        pinned: !!((n.pinned_for_users || []).length),
        comments: ((n.edge_media_to_comment || {}).count) || 0,
      }));
      if (list.length) return срез(list, 'web_profile_info');
    }
  } catch {}
  return { ok: false, why: 'ни feed/user, ни web_profile_info не отдали постов', list: [] };
}

// media_id из кода поста: shortcode это обычный base64 от числового pk. Нужен запасному пути
// (сетка DOM отдаёт только коды), и он же служит сверкой: посчитанный id совпал с pk из
// feed/user на трёх постах подряд.
function idFromCode(code) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = 0n;
  for (const ch of String(code)) { const i = A.indexOf(ch); if (i < 0) return null; n = n * 64n + BigInt(i); }
  return n.toString();
}

// Запасной путь: коды из сетки профиля. Времени публикации в сетке нет, поэтому порядок берём как
// он есть (для незакреплённых он обратно-хронологический), а время читаем уже на самом посте.
async function gridCodes() {
  const out = []; const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/(p|reel)\/([^/?]+)/);
    if (!m || seen.has(m[2])) continue; seen.add(m[2]);
    out.push({ code: m[2], pinned: !!a.querySelector('svg[aria-label*="Pinned" i]') });
  }
  return out.slice(0, 9);
}

// ═══ КОММЕНТЫ ПОСТА ГЛАЗАМИ ИНСТАГРАМА ═══════════════════════════════════════════════════════
// Нужны трижды: дедуп (не отписаться дважды), поиск ID своего коммента (для закрепа) и
// доказательство, что коммент ВСТАЛ. Правило проекта: успех это положительный признак, а не
// «запрос не упал».
async function readComments(mediaId) {
  const uid = (document.cookie.match(/ds_user_id=([^;]+)/) || [])[1];
  const r = await fetch(`/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`,
    { credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' } });
  if (r.status !== 200) return { known: false, why: `comments ответил ${r.status}` };
  const d = await r.json().catch(() => null);
  if (!d) return { known: false, why: 'comments отдал не JSON' };
  const all = (d.comments || []).map((c) => ({
    pk: String(c.pk), uid: String((c.user || {}).pk || ''), user: (c.user || {}).username || '',
    text: c.text || '', created: c.created_at || 0,
    // Любые поля про закреп: как раз здесь и видно, дал ли инстаграм закрепить.
    pin: Object.keys(c).filter((k) => /pin/i.test(k)).reduce((o, k) => (o[k] = c[k], o), {}),
  }));
  return { known: true, uid, count: d.comment_count, mine: all.filter((c) => c.uid === String(uid)), all,
    trayKeys: Object.keys(d).filter((k) => /pin/i.test(k)),
    pinnedTray: (d.pinned_comments || []).map((c) => String(c.pk)) };
}

// ═══ ПУБЛИКАЦИЯ КОММЕНТА ═════════════════════════════════════════════════════════════════════
// Печатаем В ИНТЕРФЕЙСЕ, а не ручкой: под своим постом это единственное действие акка за заход, и
// живой ввод дешевле любой экономии. Ответ инстаграма при этом ПЕРЕХВАТЫВАЕМ с сети, потому что
// отказ («не удалось опубликовать») он показывает всплывашкой, которая исчезает, а в ответе ручки
// add_comment лежит точная причина. Без этого перехвата «режется» превращается в догадку.
async function postComment(page, url, text, log = console.log) {
  const seen = [];
  const onResp = async (res) => {
    if (!/\/comments\/(add|.*add_comment)|add_comment/i.test(res.url())) return;
    let body = '';
    try { body = (await res.text()).slice(0, 400); } catch {}
    seen.push({ url: res.url().replace('https://www.instagram.com', ''), status: res.status(), body });
  };
  page.on('response', onResp);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000); await L.clearOverlays(page);
    let box = await L.visEdit(page, 'textarea[aria-label*="omment" i], div[contenteditable="true"][role="textbox"]', 5000);
    if (!box) {
      const icon = page.locator('svg[aria-label="Comment" i], svg[aria-label="Комментировать" i]').first();
      if (!(await icon.isVisible({ timeout: 5000 }).catch(() => false))) throw new Error('нет ни поля коммента, ни иконки Comment');
      await L.clickSafe(page, icon, 'иконка Comment');
      await sleep(2500);
      box = await L.visEdit(page, 'textarea[aria-label*="omment" i], div[contenteditable="true"][role="textbox"]', 6000);
      if (!box) throw new Error('поле коммента не появилось после клика по иконке');
    }
    const r = await L.typeVerified(box, text);
    if (!r.ok) throw new Error('текст коммента не прочитался обратно из поля');
    // Кнопка отправки: сначала по роли, потом по видимому тексту (доступное имя портит <title> из
    // svg), в последнюю очередь Enter.
    const pb = page.getByRole('button', { name: /^(Post|Опубликовать)$/i }).first();
    if (await pb.isVisible({ timeout: 3000 }).catch(() => false)) await pb.click({ timeout: 4000 });
    else if (!(await L.clickByText(page, /^(post|опубликовать)$/i, { timeout: 3000 })).ok) await box.press('Enter');
    await sleep(7000);
    for (const s of seen) log(`    ручка ${s.url}: ${s.status} ${s.body.slice(0, 160)}`);
    // Всплывашка отказа, если она ещё висит: точные слова инстаграма нам и нужны в отчёте.
    const warn = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/[^\n]*(couldn't post|could not post|не удалось|попробуйте позже|try again|action blocked|restricted)[^\n]*/i);
      return m ? m[0].slice(0, 200) : '';
    }).catch(() => '');
    if (warn) log(`    ⚠ инстаграм на экране: «${warn}»`);
    return { net: seen, warn };
  } finally { page.off('response', onResp); }
}

// ═══ ЗАКРЕП: ОСМОТР ПО-ЧЕСТНОМУ ══════════════════════════════════════════════════════════════
// Отчитываться «закрепление работает/не работает» можно ТОЛЬКО по замеру. Здесь три независимых
// проверки, и каждая печатает то, что реально ответил инстаграм:
//   1. ИНТЕРФЕЙС: что вообще есть рядом с нашим комментом (кнопки, меню, «...»).
//   2. РУЧКИ: веб-путь по образцу удаления коммента (/api/v1/web/comments/<media>/delete/<pk>/,
//      он в вебе живой) и путь приложения /api/v1/media/<media>/comment/<pk>/pin/.
//   3. ЧТЕНИЕ: появился ли коммент в pinned_comments или поле is_pinned у самого коммента.
// Мобильный user-agent НЕ подделываем: за это жгут акки (тот же вывод в stories.cjs).
async function pinApi({ mediaId, commentId }) {
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const H = { 'x-csrftoken': csrf, 'content-type': 'application/x-www-form-urlencoded',
    'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' };
  const tries = [
    `/api/v1/web/comments/${mediaId}/pin/${commentId}/`,
    `/api/v1/media/${mediaId}/comment/${commentId}/pin/`,
    `/api/v1/media/${mediaId}/comment/${commentId}/pin_comment/`,
  ];
  const out = [];
  for (const u of tries) {
    try {
      const r = await fetch(u, { method: 'POST', credentials: 'include', headers: H, body: '' });
      out.push({ ручка: u, status: r.status, body: (await r.text()).slice(0, 200) });
    } catch (e) { out.push({ ручка: u, status: 'сбой', body: String(e.message).slice(0, 120) }); }
  }
  return out;
}

async function probePin(page, url, mediaId, commentId, текстКоммента = '', log = console.log) {
  const res = { ui: [], api: [], pinned: false };
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000); await L.clearOverlays(page);
  // 1. ИНТЕРФЕЙС. Сначала НАВОДИМСЯ на свой коммент: часть кнопок инстаграм рисует только по
  // наведению, и дамп без наведения был бы нечестным доказательством «пункта нет».
  if (текстКоммента) {
    const узел = page.getByText(текстКоммента.slice(0, 30), { exact: false }).first();
    if (await узел.isVisible({ timeout: 5000 }).catch(() => false)) {
      await узел.hover({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
      // «...» рядом с комментом, если он вообще появляется: это и был бы путь к закрепу.
      const троеточие = page.locator('svg[aria-label*="More options" i], svg[aria-label*="Comment options" i]');
      const n = await троеточие.count().catch(() => 0);
      res.dots = n;
      log(`  «...» рядом с комментом по наведению: ${n ? n + ' шт, открываю' : 'не появляется'}`);
      if (n) { await троеточие.last().click({ timeout: 4000 }).catch(() => {}); await sleep(2000); }
    } else log('  ⚠ своего коммента на странице не нашёл, наводиться не на что');
  }
  res.ui = await page.evaluate(() => {
    const узлы = [...document.querySelectorAll('div[role="button"],button,[role="menuitem"],svg[aria-label]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 40);
    return [...new Set(узлы)].slice(0, 60);
  }).catch(() => []);
  // Снимок МЕНЮ до закрытия: это и есть доказательство, что закрепа в вебе нет (в меню своего
  // коммента лежат ровно «Delete» и «Cancel»).
  if (res.dots) { res.menuShot = await L.snap(page, SHOT, `pin_menu_${mediaId}`); log(`  📷 меню коммента: ${res.menuShot}`); }
  // ДИАЛОГ ЗАКРЫВАЕМ СРАЗУ. В меню своего коммента лежит «Delete», и оставлять его открытым нельзя:
  // любой случайный Enter снёс бы коммент, за который мы только что заходили в акк.
  const cancel = page.locator('button, div[role="button"]').filter({ hasText: /^(Cancel|Отмена)$/i }).first();
  if (await cancel.isVisible({ timeout: 2000 }).catch(() => false)) {
    await cancel.click({ timeout: 4000 }).catch(() => {});
    log('  ✓ меню коммента закрыто (в нём «Delete», открытым не оставляем)');
    await sleep(1500);
  }
  const uiPin = res.ui.some((t) => /^(pin|закреп)/i.test(t));
  log(`  интерфейс рядом с комментом: ${JSON.stringify(res.ui).slice(0, 500)}`);
  log(`  пункт «Pin»/«Закрепить» в интерфейсе: ${uiPin ? 'ЕСТЬ' : 'НЕТ'}`);
  res.uiPin = uiPin;
  // 2. РУЧКИ.
  res.api = await page.evaluate(pinApi, { mediaId, commentId });
  for (const a of res.api) log(`  ручка ${a.ручка}: ${a.status} ${String(a.body).slice(0, 140)}`);
  // 3. ЧТЕНИЕ: единственное настоящее доказательство закрепа.
  await sleep(3000);
  const cm = await page.evaluate(readComments, mediaId).catch(() => ({ known: false, why: 'чтение не выполнилось' }));
  if (cm.known) {
    const mine = (cm.mine || []).find((c) => String(c.pk) === String(commentId));
    res.pinned = (cm.pinnedTray || []).includes(String(commentId))
      || !!(mine && Object.values(mine.pin || {}).some(Boolean));
    log(`  чтение комментов: pinned_comments=${JSON.stringify(cm.pinnedTray)} поля про закреп у нашего=${JSON.stringify(mine && mine.pin)}`);
  } else log(`  чтение комментов не вышло: ${cm.why}`);
  res.shot = await L.snap(page, SHOT, `pin_probe_${mediaId}`);
  log(`  📷 ${res.shot}`);
  return res;
}

// ═══ ПАУЗА ПОСЛЕ ПУБЛИКАЦИИ ══════════════════════════════════════════════════════════════════
// Живой человек не комментирует свой пост в ту же секунду: мгновенный коммент от автора это
// машинный след. Считаем паузу ОТ ВРЕМЕНИ ПУБЛИКАЦИИ, а не от запуска скрипта: пост мог выйти
// десять минут назад, и тогда ждать нечего, а мог родиться только что, тогда доспим остаток.
function waitPlan(takenAtSec) {
  const target = (DELAY_MIN + Math.random() * Math.max(0, DELAY_MAX - DELAY_MIN)) * 60000;
  const age = Date.now() - takenAtSec * 1000;
  return { target: Math.round(target / 60000 * 10) / 10, ageMin: Math.round(age / 60000), left: Math.max(0, target - age) };
}

// ═══ ПРОГОН ОДНОГО АККА ══════════════════════════════════════════════════════════════════════
async function runOne(c, slug) {
  const r = await c.query(
    `SELECT a.id, a.slug, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies, a.gologin_profile_id pid,
            a.session_status ss, coalesce(a.ig_status,'-') ig, coalesce(a.health_state,'-') hs, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE a.deleted_at IS NULL AND (a.slug=$1 OR a.ig_login=$1)`, [slug]);
  if (!r.rowCount) { console.log(`  ✗ акка «${slug}» нет в базе`); return; }
  const row = r.rows[0];
  console.log(`\n[firstcomment] @${row.h} (${row.slug}, ${row.persona || 'без персоны'}) | сессия ${row.ss} | ig ${row.ig} | health ${row.hs}`);
  if (NEVER.includes(row.slug) || NEVER.includes(row.h)) {
    console.log('  ⛔ брендовый/модельный акк из запретного списка, не трогаю'); return;
  }
  if (row.ig === 'restricted') { console.log('  ⛔ ig_status=restricted, коммент от такого акка не встанет'); return; }
  if (!row.pid || !row.ig_cookies) { console.log('  ✗ нет профиля GoLogin или кук, работать нечем'); return; }

  L.setShotTag(`fc_${String(row.slug).replace(/\W/g, '_')}`);
  let s = null;
  try {
    s = await openSession(row);
    // 1. Самый свежий пост.
    let lp = await s.page.evaluate(readLatest, { uid: s.uid, handle: row.h });
    if (!lp.ok) {
      // Запасной путь: коды из сетки профиля, media_id считаем из кода, время читаем на посте.
      console.log(`  ⚠ ${lp.why}, иду через сетку профиля`);
      await s.page.goto(`https://www.instagram.com/${row.h}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(8000); await L.clearOverlays(s.page);
      const g = (await s.page.evaluate(gridCodes).catch(() => [])).filter((x) => !x.pinned);
      if (!g.length) throw new Error('в сетке профиля постов не видно (пустота НЕ значит «постов нет»)');
      const id = idFromCode(g[0].code);
      if (!id) throw new Error(`код ${g[0].code} не разбирается в media_id`);
      lp = { ok: true, источник: 'сетка DOM', latest: { code: g[0].code, id, ts: 0, comments: 0 }, list: g };
    }
    // Печатаем сетку ВСЕГДА: «поста нет» это самая частая причина пустого прогона, и без списка
    // непонятно, профиль пуст, всё закреплено или ручка отдала пустоту.
    console.log(`  сетка профиля (${lp.источник}): ${JSON.stringify(lp.list)}`);
    if (!lp.latest) throw new Error('свежего (незакреплённого) поста на профиле нет');
    const P = lp.latest;
    const url = `https://www.instagram.com/p/${P.code}/`;
    const возраст = P.ts ? `опубликован ${Math.round((Date.now() - P.ts * 1000) / 60000)} мин назад`
      : 'время публикации неизвестно (запасной путь), паузу не считаю';
    console.log(`  📄 свежий пост: ${url} (media_id=${P.id}, ${возраст}, комментов ${P.comments})`);

    // 2. Дедуп ПО ФАКТУ, а не по флагу в базе: смотрим, нет ли уже нашего коммента под постом.
    const before = await s.page.evaluate(readComments, P.id)
      .catch((e) => ({ known: false, why: 'чтение комментов не выполнилось: ' + String(e.message).slice(0, 80) }));
    if (before.known && before.mine.length) {
      console.log(`  ⏭ свой коммент уже стоит («${before.mine[0].text.slice(0, 60)}»), повтор запрещён`);
      if (PROBE_PIN) await probePin(s.page, url, P.id, before.mine[0].pk, before.mine[0].text);
      return;
    }
    if (!before.known) console.log(`  ⚠ комменты до публикации прочитать не вышло: ${before.why}`);

    // 3. Текст и гард.
    const text = TEXT_IN || pickText(row.h, P.code);
    const bad = banReason(text);
    if (bad) throw new Error(`текст не проходит гард (${bad}): «${text}»`);
    console.log(`  💬 текст: «${text}»`);
    if (DRY) { console.log('  (--dry, в интерфейс не хожу)'); return; }

    // 4. Пауза как у живых.
    const w = waitPlan(P.ts);
    if (NOW) console.log(`  ⏱ --now, паузу пропускаю (посту ${w.ageMin} мин)`);
    else if (w.left > 0) { console.log(`  ⏱ пауза до ${w.target} мин от публикации, досыпаю ${Math.round(w.left / 60000)} мин`); await sleep(w.left); }
    else console.log(`  ⏱ посту уже ${w.ageMin} мин (цель ${w.target}), ждать нечего`);

    // 5. Публикация.
    const pr = await postComment(s.page, url, text);

    // 6. ДОКАЗАТЕЛЬСТВО: коммент есть в списке комментов поста глазами инстаграма, и он виден на
    // странице. Ответ 200 сам по себе ничего не значит (урок stories.cjs про наклейку ссылки).
    await sleep(4000);
    const after = await s.page.evaluate(readComments, P.id)
      .catch((e) => ({ known: false, why: 'чтение комментов не выполнилось: ' + String(e.message).slice(0, 80) }));
    const mine = after.known ? (after.mine || []).find((x) => x.text.trim() === text.trim()) : null;
    const onPage = await s.page.evaluate((t) => (document.body.innerText || '').includes(t.slice(0, 30)), text).catch(() => false);
    const shot = await L.snap(s.page, SHOT, `comment_${row.slug}_${P.code}`);
    console.log(`  📷 ${shot}`);
    if (!mine) {
      console.log(`  ⛔ коммент НЕ ВСТАЛ: в списке комментов поста его нет${after.known ? '' : ' (список не прочитали: ' + after.why + ')'}`);
      console.log(`     на странице текст ${onPage ? 'виден (значит поле не отправилось, а только заполнилось)' : 'не виден'}`);
      if (pr.warn) console.log(`     инстаграм сказал: «${pr.warn}»`);
      return;
    }
    console.log(`  ✅ коммент СТОИТ: id=${mine.pk}, всего комментов ${after.count}, на странице ${onPage ? 'виден' : 'не разобрал'}`);
    // Метка в базу, чтобы второй заход не отписался повторно (тот же ключ, что у igfirstcomment).
    await c.query(`UPDATE posts SET meta = coalesce(meta,'{}'::jsonb) || '{"first_comment":true}'
                    WHERE account_id=$1 AND external_url LIKE '%' || $2 || '%'`, [row.id, P.code]).catch(() => {});

    // 7. Закреп: пробуем и говорим правду.
    if (NO_PIN) { console.log('  (--no-pin, закреп не пробую)'); return; }
    const pin = await probePin(s.page, url, P.id, mine.pk, mine.text);
    console.log(`  📌 закреп: ${pin.pinned ? 'ЕСТЬ' : 'НЕ ВЫШЕЛ (веб этого не даёт, подробности выше)'}`);
    if (!pin.pinned) {
      console.log('     ↪ что работает вместо закрепа: наш коммент ПЕРВЫЙ по времени под своим постом, '
        + 'поэтому он и стоит сверху в ветке, пока чужих комментов мало');
    }
  } catch (e) {
    console.log(`  ⛔ ${String(e.message).slice(0, 400)}`);
    if (/checkpoint|challenge|confirm your email|подтверд/i.test(String(e.message))) {
      console.log('  ⚠ похоже на чекпоинт, НЕ ломлюсь, разбирает человек');
    }
  } finally {
    // Пересъём кук: заход был, сессия свежая, пусть база это знает.
    try {
      if (s) {
        const fresh = (await s.ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
        if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) {
          await c.query(`UPDATE accounts SET ig_cookies=$2 WHERE id=$1`, [row.id, JSON.stringify(fresh)]);
          console.log(`  🔄 куки пересохранены (${fresh.length})`);
        }
        await s.b.close().catch(() => {});
      }
    } catch {}
    await closeLocal('конец акка');
  }
}

(async () => {
  if (!SLUGS.length) { console.log('нужен --slug <акк> или --slugs a,b,c'); process.exit(1); }
  fs.mkdirSync(SHOT, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // ПО ОДНОМУ АККУ ЗА РАЗ. Локальная Orbita на маке одна, и параллельные заходы у нас уже
  // оборачивались рассинхроном профилей (правило комментинга: CONC=1).
  for (const slug of SLUGS) await runOne(c, slug);
  await c.end();
  process.exit(0);
})();
