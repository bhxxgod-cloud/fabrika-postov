// ЕДИНЫЙ РЕГУЛЯРНЫЙ ЧЕК АККАУНТА (06.08, начальник: «какая у нас логика чека акков, когда он
// случается и повторяется ли, переделай всё»).
//
// ПОВОД. У damari1735 (персона Анечка) на аватарке стояла ЧУЖАЯ девушка, брюнетка с косичками,
// а во всех постах ленты блондинка Анечка. Имя профиля техническое «Damari», био пустое,
// подписчиков ноль. Ни один наш чек этого не заметил, и вот почему:
//   • maybeSessions/maybeSilenceWatch в воркере проверяют ТОЛЬКО «жива ли кука», про внешность
//     профиля они не знают ничего;
//   • ighealth.cjs заходит В акк и читает ограничения, но профиль глазами зрителя не смотрит;
//   • accaudit.cjs читал профиль снаружи, но проверял лишь «ава есть / био есть» — булевами.
//     Флаг «ава есть» на чужом лице стоит true, поэтому дефект был невидим для базы.
// Вывод: чек, который смотрит только на флаги, чужое лицо не поймает НИКОГДА. Нужна сверка лиц.
//
// ПРИНЦИПЫ (перенесены из accaudit.cjs, они себя оправдали).
//   1. НЕ ВЕРИМ САМООТЧЁТАМ СКРИПТОВ. dressup писал «✓ био вписано», а био было пустое: IG
//      отвечал 400, скрипт этого не видел. Правда о профиле — только СНАРУЖИ.
//   2. РАБОТАЕМ КАК ПОСТОРОННИЙ ЗРИТЕЛЬ: анонимный запрос web_profile_info. Ноль входов, ноль
//      сессий, ноль действий, ноль окон браузера — значит ноль поводов для бана. Браузер здесь
//      не нужен вообще (если однажды понадобится, только adminbrowser.cjs/openAdmin, он headless).
//   3. ЧЕТЫРЕ ИСХОДА, и путать их нельзя: сбой IG (вердикта нет, базу не трогаем), профиля нет
//      (снесён или забанен), ПРОФИЛЬ СПРЯТАН ОТ АНОНИМА (ник занят, данные не отдаются — не бан
//      и не сбой, нужен чек входом), профиль прочитан. Иначе живой акк получает клеймо мёртвого,
//      а спрятанный числится здоровым и публикует в пустоту.
//
// ЧТО ПРОВЕРЯЕТ (всё одним прогоном, ради этого чек и делался единым):
//   доступность профиля · закрыт ли он · постов/подписчиков/подписок · динамику подписчиков ·
//   стоит ли ава и не дефолтная ли она · стоит ли био и есть ли в нём наша ссылка ·
//   имя профиля (женское или техническое, как «Damari» от логина damari1735) ·
//   последний пост и его дату · и ГЛАВНОЕ — сверку ЛИЦА: ава ↔ refs/<персона>.jpg ↔ лица в ленте.
//
// ПОЧЕМУ ЛИЦО СВЕРЯЕТ МОДЕЛЬ, А НЕ КОД. Хэш картинки, размер, категория авы — всё это у чужой
// девушки выглядит абсолютно нормально. Различить людей может только зрение, поэтому вопрос
// задаём vision-модели тем же механизмом, что и в validatepost.cjs (OpenRouter, ключ из
// /tmp/orkey.txt), и спрашиваем прямо про ЧЕРТЫ лица. Цвет и длина волос, макияж и свет между
// эталоном и постами меняются по замыслу, поэтому различием их не считаем — иначе получим поток
// ложных дефектов на своих же моделях.
//
// КУДА ПИШЕТ: accounts.health_state / health_note / health_checked_at (+ face_state,
// followers_count/followers_prev, posts_count, avatar_set, bio_set, avatar_thumb).
// health_state='defect' — ИНФОРМАЦИОННЫЙ статус, не гейт: постинг режут только 'restricted' и
// терминальные ig_status. Так задумано: косметическая придирка не должна останавливать ферму.
// health_state='hidden' — тоже НЕ гейт и тем более НЕ бан: снаружи видно только «профиль не
// отдаётся», а чекпоинт это или смерть акка, показывает лишь вход. Ни автосноса, ни автозамены
// по этой метке не запускать НИКОГДА (ARCHITECTURE §3: снос уносит профиль GoLogin навсегда).
// Ставится только после подтверждения с нескольких РАЗНЫХ прокси, снимается сама, когда профиль
// снова отдаётся.
// Статусы про СЕССИЮ (need_login, banned, suspended, restricted…) чек не перетирает — он про
// публичный профиль, а не про вход; отчёт всё равно ляжет в health_note.
//
// Запуск: node accheck.cjs                 — все живые акки
//         node accheck.cjs damari1735      — один акк (slug, логин или персона)
//         node accheck.cjs --all           — включая мёртвые
//         node accheck.cjs --no-vision     — без сверки лиц (быстро и бесплатно)
// Регулярно: крон раз в 6 часов, лог /tmp/accheck.log.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const igp = require('./igprofile.cjs');            // общий разбор ответа IG + подтверждение вердикта

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const KEY = process.env.OPENROUTER_API_KEY
  || (fs.existsSync('/tmp/orkey.txt') ? fs.readFileSync('/tmp/orkey.txt', 'utf8').trim() : '');
const MODEL = process.env.ACCHECK_MODEL || 'anthropic/claude-sonnet-4.5';
const WORK_DIR = '/tmp/accheck';                       // сюда падают ава и кадры ленты, смотреть глазами
const REFS_DIR = path.join(__dirname, 'refs');         // эталонные портреты моделей
const UA_MOB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const FRAMES = Math.max(1, Number(process.env.ACCHECK_FRAMES) || 3); // сколько кадров ленты показываем модели
const GAP_MS = Math.max(500, Number(process.env.ACCHECK_GAP_MS) || 2500); // пауза между акками
const STALE_POST_D = Number(process.env.ACCHECK_STALE_POST_D) || 3;  // «давно не постил», суток
// Подтверждение вердикта «спрятан»: сколько попыток и со скольких РАЗНЫХ каналов. Меньше двух
// каналов ставить нельзя — это ровно та ошибка, из-за которой лимит нашего айпи превращался в
// метку на живом аккаунте.
const HID_TRIES = Math.max(2, Number(process.env.ACCHECK_HIDDEN_TRIES) || 4);
const HID_CONFIRM = Math.max(2, Number(process.env.ACCHECK_HIDDEN_CONFIRM) || 2);
// ЧИТАЕМ ЧЕРЕЗ ПУЛ ПРОКСИ, А НЕ СО СВОЕГО АЙПИ (10.08). Наш адрес Instagram душит примерно после
// сотни анонимных запросов, и тогда ВЕСЬ прогон превращается в «СБОЙ IG»: вердиктов нет ни по
// одному акку, а спрятанные так и остаются незамеченными (поймано на damari1735 — прогон с нашего
// айпи не дошёл даже до разбора ответа). Прокси берём те же, что и остальные анонимные чеки.
// ACCHECK_DIRECT=1 возвращает прежнее поведение (читать напрямую).
const PX = String(process.env.ACCHECK_DIRECT || '') === '1' ? [] : igp.proxies();
let pxTurn = 0;
const nextProxy = () => (PX.length ? PX[pxTurn++ % PX.length] : null);

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const NO_VISION = args.includes('--no-vision') || !KEY;
const TARGET = args.find((a) => !a.startsWith('--')) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Статусы про СЕССИЮ И БАН: их ставят другие чеки (modelduty, ighealth, воркер), и они дороже
// нашего косметического вердикта. Мы их не перетираем, иначе «профиль снаружи в порядке»
// воскресит акк, в который на деле нельзя войти.
// Список общий на весь проект (igprofile.PROTECTED). В нём же 'keep' — ЗАМОК АВТОСНОСА: раньше
// его тут не было, и очередной косметический прогон переписывал 'keep' на 'ok'/'defect', молча
// снимая защиту от автозамены (ARCHITECTURE §9, проверка C11 уборщика — она за этим и следит,
// но правильное место починки было здесь).
const KEEP_STATE = igp.PROTECTED;
// Наша ссылка в био. Владелец варьирует написание, поэтому ловим все формы, а не одну строку.
const BRAND_RE = /нейронка\s*[.\s]?\s*(про|pro)|neironka\s*[.\s]?\s*pro|нейронка\.про/i;

// --- ПРОФИЛЬ СНАРУЖИ ---------------------------------------------------------------------------
// Отдаёт {glitch} | {gone} | данные профиля + кадры ленты. Кадры берём из того же ответа:
// edge_owner_to_timeline_media отдаёт display_url и дату каждого поста, отдельные запросы не нужны.
// РАЗБОР ОТВЕТА ЖИВЁТ В ОДНОМ МЕСТЕ — igprofile.cjs (10.08). Своя копия тут была, и она уже
// разъезжалась с копиями в accjanitor/modelduty/checkposted: дыру «любой ответ без user = профиля
// нет» закрыли 07.08 здесь и не закрыли у уборщика, и он писал «акк потерян» по живому. Все уроки
// (почему приговор только по data.user===null, почему признаки сбоя ищутся ПОСЛЕ данных, почему
// {"status":"ok"} без data — это «спрятан», а 401 — это лимит НАШЕГО айпи) описаны там.
function fetchProfile(handle, proxy) {
  const r = igp.ask(handle, proxy, { ua: UA_MOB });
  if (r.kind === 'сбой') return { glitch: true, why: r.why || 'сбой IG', code: r.code };
  if (r.kind === 'нет-ника' || r.kind === 'нет-профиля') return { gone: true };
  if (r.kind === 'спрятан') return { hidden: true };
  const u = r.user;
  const media = u.edge_owner_to_timeline_media || {};
  const feed = (media.edges || []).map((e) => e.node || {}).map((n) => ({
    code: n.shortcode || '',
    at: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000) : null,
    url: n.display_url || '',
    video: n.__typename === 'GraphVideo' || !!n.is_video,
  })).filter((x) => x.url);
  return {
    name: (u.full_name || '').trim(),
    bio: (u.biography || '').trim(),
    pic: u.profile_pic_url_hd || u.profile_pic_url || '',
    posts: media.count ?? null,
    followers: (u.edge_followed_by || {}).count ?? null,
    following: (u.edge_follow || {}).count ?? null,
    private: !!u.is_private,
    feed,
  };
}

// --- ИМЯ ПРОФИЛЯ -------------------------------------------------------------------------------
// Дыра, из-за которой «Damari» жило в профиле неделями: техническое имя ВЫГЛЯДИТ как имя, флагом
// его не отличить. Отличаем по происхождению: если имя это просто логин без цифр, его никто не
// вписывал — это заводская заглушка. Дальше смотрим, женское ли оно: по легенде акк ведёт девушка.
const FEM_LAT = /^(anna|anya|ann|alina|alice|amy|bella|dasha|darya|daria|diana|elena|emma|eva|julia|kate|karina|katya|kira|lana|lera|lena|liza|lily|mary|masha|maria|mia|mila|nastya|nica|nika|olga|polina|rita|sasha|sofia|sonya|tanya|tati|vera|vika|yana|zoya)$/i;
function nameKind(name, login) {
  const n = String(name || '').trim();
  if (!n) return { kind: 'пусто', bad: true };
  const bare = n.toLowerCase().replace(/[^a-zа-яё]/gi, '');
  const lgAlpha = String(login || '').toLowerCase().replace(/[^a-z]/g, '');
  if (bare && lgAlpha && bare.length >= 4 && (bare === lgAlpha || lgAlpha.startsWith(bare) || bare.startsWith(lgAlpha))) {
    return { kind: 'техническое (из логина)', bad: true };
  }
  const first = n.split(/[\s._-]+/)[0] || '';
  if (/[а-яё]/i.test(first)) {
    // Русское имя: женские почти все на -а/-я (Дарья, Полина, Карина). Мужское или обрубок — брак.
    return /(а|я)$/i.test(first) ? { kind: 'женское', bad: false } : { kind: 'не женское', bad: true };
  }
  if (FEM_LAT.test(first)) return { kind: 'женское (латиницей)', bad: false };
  return { kind: 'непонятное', bad: false, soft: true };
}

// --- КАРТИНКИ ДЛЯ СВЕРКИ -----------------------------------------------------------------------
// Уменьшаем перед отправкой: эталоны в refs/ весят по 5-6 МБ, в data-url такое гнать бессмысленно
// (медленно и дорого), а для сверки черт лица хватает 640 px по ширине.
function shrink(src, out, w = 640) {
  try {
    const bin = require('ffmpeg-static');
    execFileSync(bin, ['-y', '-i', src, '-vf', `scale=${w}:-2`, '-q:v', '4', out], { stdio: 'ignore' });
    if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  } catch { /* уменьшить не вышло — отдадим как есть */ }
  return src;
}
function download(url, out) {
  try {
    execFileSync('curl', ['-s', '--max-time', '25', '-A', UA_MOB, '-o', out, url], { stdio: 'ignore' });
    if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  } catch { /* нет картинки — сверять будет нечего */ }
  return '';
}
function dataUrl(file) {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
}
// Имя файла из русского имени модели. КЛЮЧЕВОЕ: \W в JS считает кириллицу «не буквой», поэтому
// «Дарья».replace(/\W+/g,'_') даёт «_» — все персоны схлопывались в один ref__.jpg и затирали
// эталон друг друга. Нужен флаг u и юникод-классы (та же грабля, что и с \b в recH-баге).
function safeName(s) {
  return String(s || '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'x';
}
// Эталон модели. Файлы лежат как refs/<Персона>.jpg (Анечка.jpg, Дарья.jpg); ищем без учёта
// регистра и расширения, чтобы одна опечатка в имени файла не отключала сверку молча.
function refFor(persona) {
  if (!persona) return '';
  const want = String(persona).trim().toLowerCase();
  let list = [];
  try { list = fs.readdirSync(REFS_DIR); } catch { return ''; }
  const hit = list.find((f) => path.parse(f).name.toLowerCase() === want && /\.(jpg|jpeg|png)$/i.test(f));
  return hit ? path.join(REFS_DIR, hit) : '';
}

// --- СВЕРКА ЛИЦ --------------------------------------------------------------------------------
// Прямой вопрос модели про ЧЕРТЫ. Формулировка защищена от двух ложняков, на которых мы уже
// горели в validatepost.cjs: смена цвета/длины волос и макияжа — это замысел постов «до/после»,
// а не подмена человека; ава без лица (промптовая картинка на мультиакке) — тоже не подмена.
// ЗАПРОС ЧЕРЕЗ ОБЩИЙ КЭШ (14.08). Один и тот же вопрос оплачивается ровно один раз: ключ
// собирается из модели, промпта и СОДЕРЖИМОГО картинок. Разбор — в llmcache.cjs.
// Сбои не кэшируются: «не ответила» это не вердикт.
async function faceCheckЗапрос({ refFile, avaFile, frames, name, persona }) {
  const content = [];
  const parts = [];
  content.push({ type: 'text', text:
`Проверь личность в аккаунте Instagram, который по легенде ведёт ОДНА девушка-модель${persona ? ` (${persona})` : ''}.
Порядок картинок ниже: 1) ЭТАЛОН — как выглядит модель; 2) АВАТАРКА аккаунта; далее ${frames.length} КАДР(А) из ленты аккаунта.
Сравнивай ТОЛЬКО черты: разрез и посадку глаз, брови, форму носа, губ, овал лица.
Цвет и длина волос, укладка, макияж, свет, ретушь, одежда и фон меняются НАМЕРЕННО (посты «до/после») и различием НЕ считаются.
Если на картинке нет живого человеческого лица (рисунок, предмет, пейзаж, текст, логотип) — это "no_face", а не "different".
Имя, указанное в профиле: ${JSON.stringify(name || '')}.

Ответь ТОЛЬКО JSON, без пояснений вокруг:
{"ava":"same|different|no_face|unclear",
 "feed":"same|different|no_face|unclear",
 "ava_vs_feed":"same|different|no_face|unclear",
 "name_kind":"female|male|technical|brand|unclear",
 "why":"одна короткая фраза по-русски"}
ava — аватарка против эталона. feed — лица в кадрах ленты против эталона. ava_vs_feed — человек на аватарке против человека в ленте.
name_kind: "technical" — если имя выглядит машинной заглушкой (совпадает с логином, набор букв), "female" — обычное женское имя.` });
  content.push({ type: 'image_url', image_url: { url: dataUrl(refFile) } }); parts.push('эталон');
  content.push({ type: 'image_url', image_url: { url: dataUrl(avaFile) } }); parts.push('ава');
  for (const f of frames) { content.push({ type: 'image_url', image_url: { url: dataUrl(f) } }); parts.push('кадр'); }

  let txt = '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'neironka-accheck' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, temperature: 0, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return { state: 'unknown', why: `vision HTTP ${r.status}` };
    const j = await r.json();
    txt = j.choices?.[0]?.message?.content || '';
  } catch (e) { return { state: 'unknown', why: `vision не ответил: ${String(e.message).slice(0, 60)}` }; }
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { state: 'unknown', why: 'вердикт не разобран' };
  let v; try { v = JSON.parse(m[0]); } catch { return { state: 'unknown', why: 'вердикт не разобран' }; }
  return {
    state: v.ava === 'different' || v.feed === 'different' || v.ava_vs_feed === 'different' ? 'mismatch'
      : (v.ava === 'same' || v.feed === 'same') ? 'ok'
      : (v.ava === 'no_face' && v.feed === 'no_face') ? 'no_face' : 'unknown',
    ava: v.ava, feed: v.feed, avaFeed: v.ava_vs_feed, nameKind: v.name_kind,
    why: String(v.why || '').slice(0, 120),
  };
}

// --- ОДИН АКК ----------------------------------------------------------------------------------
async function checkOne(c, a) {
  const row = { h: a.h, slug: a.slug, persona: a.persona || '' };
  let p = fetchProfile(a.h, nextProxy());
  // Канал не ответил по делу (чаще всего лимит) — переспрашиваем через ДРУГИЕ прокси, прежде чем
  // расписаться в бессилии. Иначе один придушенный адрес выключает весь прогон целиком.
  if (p.glitch && PX.length) {
    const v = await igp.probe(a.h, { ua: UA_MOB, tries: HID_TRIES, minConfirm: HID_CONFIRM, allowDirect: false });
    if (v.kind === 'виден') p = fetchProfile(a.h, v.egress);
    else if (v.kind === 'спрятан') p = { hidden: true, confirmed: v };
    // «Нет профиля» по этой ветке НЕ выносим: первый ответ был про наш доступ, и строить на нём
    // приговор (health_state='banned' + глушение постинга) — ровно та ошибка, что уже стоила акков.
    else p = { glitch: true, why: `${p.why}; переспрос с прокси: ${v.why}` };
  }

  // СПРЯТАННЫЙ АКК (10.08) — ТРЕТИЙ ИСХОД, КОТОРОГО РАНЬШЕ НЕ БЫЛО.
  // Ответ ровно {"status":"ok"} без ключа data: ник занят, но профиль анониму не отдаётся. В старой
  // логике это уходило в «сбой», акк оставался health_state='ok' и шёл в работу как здоровый, хотя
  // снаружи его постов не видит никто (все восемь разобранных 10.08 стояли warming/ok).
  // ОДНОГО ОТВЕТА МАЛО. С нашего айпи «спрятан» и «нас придушили» выглядят одинаково, поэтому
  // вердикт подтверждаем с РАЗНЫХ прокси (igprofile.probe), а лимит (401 «Please wait a few
  // minutes») в счёт не идёт. Не подтвердилось — пишем «вердикта нет», а не догадку.
  if (p.hidden) {
    const v = p.confirmed || await igp.probe(a.h, { ua: UA_MOB, tries: HID_TRIES, minConfirm: HID_CONFIRM });
    if (v.kind === 'виден') {
      // Другой канал профиль ОТДАЛ — значит первый ответ был про наш доступ, а не про акк.
      // Забираем данные оттуда и идём обычным путём, как будто ничего не было.
      p = fetchProfile(a.h, v.egress);
      // Тот же канал только что отдавал профиль, а теперь нет — это флап, а не факт. Приговор
      // «профиля нет» на нём не строим (он пишет 'banned' и глушит постинг), вердикта просто нет.
      if (p.hidden || p.glitch || p.gone) {
        await c.query(`UPDATE accounts SET profile_try_at=now() WHERE id=$1`, [a.id]).catch(() => {});
        return Object.assign(row, { verdict: 'СБОЙ IG', note: 'профиль то отдаётся, то нет — вердикта нет', hard: [], soft: [], skipped: true });
      }
    } else if (v.kind === 'спрятан') {
      // ФАКТ, А НЕ ПРИГОВОР. Баном не метим и на паузу не ставим: анонимно чекпоинт от насмерть
      // отключённого акка не отличить, а цена ошибки — снос профиля GoLogin автозаменой.
      // 'keep' и статусы про вход/бан не перетираем (igprofile.PROTECTED): их ставят дороже.
      const note = `чек: ник существует, но профиль спрятан от анонима (${v.why}). `
        + 'Это не бан и не сбой: нужен чек входом (чекпоинт или бан). Пока спрятан — посты снаружи не видны';
      await c.query(
        `UPDATE accounts SET health_state = CASE WHEN coalesce(health_state,'') = ANY($3) THEN health_state ELSE 'hidden' END,
           health_note=$2, health_checked_at=now(), profile_try_at=now() WHERE id=$1`,
        [a.id, note.slice(0, 400), KEEP_STATE]).catch(() => {});
      return Object.assign(row, {
        verdict: 'СПРЯТАН', state: 'hidden', note, hidden: true,
        hard: ['профиль спрятан снаружи — нужен чек входом'], soft: [],
        tries: v.attempts.map((x) => x.kind).join(','),
      });
    } else {
      // Подтверждений не набралось (обычно нас душат лимитом). Ничего в базу не решаем.
      const note = `похоже, профиль спрятан, но ПОДТВЕРЖДЕНИЯ НЕТ: ${v.why}`;
      await c.query(`UPDATE accounts SET profile_try_at=now() WHERE id=$1`, [a.id]).catch(() => {});
      return Object.assign(row, { verdict: 'СПРЯТАН?', note, hard: [], soft: [note], skipped: true });
    }
  }

  if (p.glitch) {
    // Сбой на стороне IG — вердикта по акку НЕТ. Данные не трогаем: чужая ошибка не должна
    // становиться клеймом на рабочем акке. Единственная запись — ВРЕМЯ ПОПЫТКИ (profile_try_at):
    // по паре try_at/checked_at панель честно показывает «пробовали, не прочиталось», а не
    // рисует «нет авы/нет био» (сюда падают и лимит «Please wait a few minutes», и заглушки,
    // и «Asset has been deleted» у бизнес-профилей — всё это НЕ значит, что акка нет).
    await c.query(`UPDATE accounts SET profile_try_at=now() WHERE id=$1`, [a.id]).catch(() => {});
    return Object.assign(row, { verdict: 'СБОЙ IG', note: `сбой IG (${p.why}) — вердикта нет`, hard: [], soft: [], skipped: true });
  }
  if (p.gone) {
    const note = `чек: профиля нет снаружи (снесён или забанен)`;
    await c.query(`UPDATE accounts SET health_state='banned', health_note=$2, health_checked_at=now(), profile_try_at=now() WHERE id=$1`,
      [a.id, note]).catch(() => {});
    return Object.assign(row, { verdict: 'НЕТ ПРОФИЛЯ', note, hard: ['профиля нет снаружи'], soft: [] });
  }

  const hard = [];   // дефекты: акк выглядит не как наш, надо править
  const soft = [];   // замечания: смотреть, но не бить тревогу
  // ДВА РОЛЕВЫХ НАБОРА ПРАВИЛ. Первый прогон 06.08 дал 22 дефекта из 24 и стал бесполезным:
  // купленной ферме комментинга (FOL_*, без персоны) он вменял «в био нет нашей ссылки» и
  // «имя как логин». Но ферма и не должна выглядеть нашей моделью — у неё чужая легенда, свои
  // имена и своё био, она комментит, а не ведёт модель. Строго спрашиваем с МОДЕЛЬНЫХ акков
  // (у них есть персона): именно там ложь в профиле рушит легенду и палит сетку. С фермы
  // спрашиваем только то, что мешает работе: ава на месте, профиль открыт, имя не пустое.
  const isModel = !!a.persona;
  const push = (strict, msg) => (strict && isModel ? hard : soft).push(msg);
  const noAva = !p.pic || /anonymousUser|profilePicDefault/i.test(p.pic);
  if (noAva) hard.push('нет авы (дефолтная)');
  if (!p.bio) push(true, 'пустое био');
  else if (!BRAND_RE.test(p.bio)) push(true, 'в био нет нашей ссылки');
  const nk = nameKind(p.name, a.h);
  if (nk.kind === 'пусто') hard.push('имя пусто');
  else if (nk.bad) push(true, `имя ${nk.kind}`);
  else if (nk.soft) soft.push(`имя ${nk.kind}`);
  if (p.private) hard.push('профиль закрыт');
  if (!p.posts && a.dress_at) push(true, 'ноль постов у оформленного акка');

  const last = p.feed[0] && p.feed[0].at ? p.feed[0].at : null;
  const ageD = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
  if (ageD !== null && ageD > STALE_POST_D) soft.push(`последний пост ${ageD} сут назад`);
  if ((p.followers ?? 0) === 0 && (p.posts ?? 0) >= 3) soft.push(`ноль подписчиков при ${p.posts} постах`);
  if ((p.following ?? 0) === 0) soft.push('ноль подписок');
  const prev = a.followers_count;
  if (prev != null && p.followers != null && p.followers < prev) soft.push(`подписчиков стало меньше (${prev}→${p.followers})`);

  // --- СВЕРКА ЛИЦ. Ради неё чек и переделывался: остальное ловилось и раньше. ---
  let face = { state: 'unknown', why: '' };
  const ref = refFor(a.persona);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (!a.persona) face = { state: 'unknown', why: 'у акка нет персоны — сверять не с кем' };
  else if (!ref) face = { state: 'no_ref', why: `нет эталона refs/${a.persona}.jpg` };
  else if (NO_VISION) face = { state: 'unknown', why: KEY ? 'сверка лиц выключена (--no-vision)' : 'нет OPENROUTER_API_KEY' };
  else if (noAva) face = { state: 'unknown', why: 'авы нет — сверять нечего' };
  else {
    const tag = safeName(a.slug);
    const avaRaw = download(p.pic, path.join(WORK_DIR, `${tag}_ava_raw.jpg`));
    const frames = [];
    for (const [i, f] of p.feed.slice(0, FRAMES).entries()) {
      const got = download(f.url, path.join(WORK_DIR, `${tag}_f${i}_raw.jpg`));
      if (got) frames.push(shrink(got, path.join(WORK_DIR, `${tag}_f${i}.jpg`)));
    }
    if (!avaRaw) face = { state: 'unknown', why: 'ава не скачалась' };
    else if (!frames.length) face = { state: 'unknown', why: 'в ленте нет кадров для сверки' };
    else {
      face = await faceCheck({
        refFile: shrink(ref, path.join(WORK_DIR, `ref_${safeName(a.persona)}.jpg`)),
        avaFile: shrink(avaRaw, path.join(WORK_DIR, `${tag}_ava.jpg`)),
        frames, name: p.name, persona: a.persona,
      });
    }
  }
  if (face.state === 'mismatch') {
    // ГЛАВНЫЙ дефект, из-за которого всё это писалось: на аккаунте живёт не наша модель.
    const who = [];
    if (face.ava === 'different') who.push('на аве чужой человек');
    if (face.feed === 'different') who.push('в ленте чужое лицо');
    if (face.avaFeed === 'different' && !who.length) who.push('ава и лента — разные люди');
    hard.push(`ЧУЖОЕ ЛИЦО: ${who.join(', ')}${face.why ? ` (${face.why})` : ''}`);
  } else if (face.state === 'no_face' && a.persona) {
    soft.push('на аве нет лица (для мультиакка норма)');
  } else if (face.state === 'no_ref') {
    // Дыра в НАШЕМ контроле, а не в акке: без эталона лицо сверять нечем, и подмена пройдёт молча.
    soft.push(`нет эталона refs/${a.persona}.jpg — лицо не сверено`);
  } else if (face.state === 'unknown' && a.persona && !NO_VISION) {
    soft.push(`сверка лиц не дала ответа: ${face.why}`);
  }

  // --- ВЕРДИКТ И ЗАПИСЬ ---
  const cur = String(a.health_state || '');
  let next;
  // СНИМАЕМ СВОЙ ЖЕ ЛОЖНЫЙ 'banned' (07.08). 'banned' в этой базе ставит только этот скрипт и
  // только в ветке p.gone («профиля нет снаружи»). Если сейчас профиль ЧИТАЕТСЯ — это прямое
  // опровержение того вердикта, и держать метку нельзя: она стоит в KEEP_STATE, то есть сама себя
  // продлевает вечно, а postguard по ней наглухо запрещает постинг (BLOCK_HEALTH). Раз мы дошли
  // досюда, значит fetchProfile отдал живого user, то есть проверяющий реально ответил и ответил
  // «профиль на месте». Остальные состояния KEEP_STATE (про сессию, капчу, вход) не трогаем: их
  // ставят другие чеки, и наш косметический прогон о них ничего не знает.
  if (cur === 'banned') {
    next = hard.length ? 'defect' : 'ok';
    console.log(`  ↩ ${a.h}: снял ложный banned — профиль читается снаружи (постов ${p.posts}, подписчиков ${p.followers})`);
  } else if (cur === 'hidden') {
    // Метку «спрятан» снимает тот же факт, что её ставил: профиль снова отдаётся анониму. Держать
    // её нельзя — иначе одно временное ограничение висит на акке вечно (ровно так самозапечатывался
    // ложный 'banned'). В KEEP_STATE 'hidden' поэтому и не входит.
    next = hard.length ? 'defect' : 'ok';
    console.log(`  ↩ ${a.h}: снял метку hidden — профиль снова отдаётся снаружи (постов ${p.posts}, подписчиков ${p.followers})`);
  } else if (KEEP_STATE.includes(cur)) next = cur;      // про сессию/бан решают другие чеки, не мы
  else if (hard.length) next = 'defect';
  else next = 'ok';
  const note = 'чек: ' + (hard.length ? hard.join('; ') : (soft.length ? 'профиль в порядке, замечания: ' + soft.join('; ') : 'профиль в порядке'));

  // face_state пишем ТОЛЬКО если сверка реально состоялась. Иначе дешёвый прогон --no-vision
  // затирал бы 'mismatch', добытый платной сверкой, и найденное чужое лицо исчезало из базы.
  const faceWrite = ['ok', 'mismatch', 'no_face', 'no_ref'].includes(face.state) ? face.state : null;
  // АВА ДЛЯ ПАНЕЛИ (07.08). Раньше в avatar_thumb писался сырой CDN-адрес — а он ПОДПИСАН и
  // ИСТЕКАЕТ, через пару дней панель показывала битые картинки. Теперь: сырой адрес — в
  // avatar_url (факт), а в avatar_thumb — маленький НЕумирающий снимок (скачали + ужали в
  // data-url, как делает dressup). Ава подтверждённо дефолтная → thumb честно чистим; ава есть,
  // но не скачалась → старый thumb НЕ трогаем (сбой скачивания — не вердикт).
  let thumb = null;
  if (!noAva && p.pic) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const tag = safeName(a.slug);
    const raw = download(p.pic, path.join(WORK_DIR, `${tag}_ava_raw.jpg`));
    if (raw) {
      const small = shrink(raw, path.join(WORK_DIR, `${tag}_ava_thumb.jpg`), 160);
      try {
        const buf = fs.readFileSync(small);
        if (buf.length && buf.length < 150 * 1024) thumb = `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch { /* снимка не вышло — оставим прежний */ }
    }
  }
  await c.query(
    `UPDATE accounts SET avatar_set=$2, bio_set=$3,
       avatar_thumb=CASE WHEN $4::boolean THEN NULL ELSE coalesce($5, avatar_thumb) END,
       avatar_url=$6, posts_count=$7,
       followers_prev=followers_count, followers_count=$8, face_state=coalesce($9, face_state),
       health_state=$10, health_note=$11, ig_bio=$12, ig_full_name=$13,
       health_checked_at=now(), profile_checked_at=now(), profile_try_at=now() WHERE id=$1`,
    // ig_bio/ig_full_name — ТЕКСТ био и имени, как их видит зритель (таблица акков в панели).
    // profile_checked_at ставится ТОЛЬКО здесь и в p.gone-ветке нет: успешное чтение профиля.
    [a.id, !noAva, !!p.bio, noAva, thumb, p.pic || null, p.posts, p.followers, faceWrite,
      next, note.slice(0, 400), p.bio || null, p.name || null],
  ).catch((e) => console.log(`  ⚠ запись в базу не прошла (${a.h}): ${String(e.message).slice(0, 70)}`));

  return Object.assign(row, {
    verdict: hard.length ? 'ДЕФЕКТ' : (soft.length ? 'ок (замечания)' : 'ОК'),
    state: next, name: p.name, nameKind: nk.kind, bio: p.bio, ava: noAva ? 'НЕТ' : 'есть',
    posts: p.posts, followers: p.followers, following: p.following, prev,
    lastAt: last, ageD, face: face.state, faceWhy: face.why, hard, soft, note,
  });
}

// --- ПРОГОН ------------------------------------------------------------------------------------
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const where = [`a.deleted_at IS NULL`, `a.platform IN ('promo','comments')`,
    `a.slug NOT IN ('TT2 KZ','TT KZ SELF 1','акк 2','поисковик','акк 5')`];
  const par = [];
  if (TARGET) { par.push(TARGET); where.push(`(a.slug=$1 OR a.ig_login=$1 OR a.persona=$1)`); }
  else if (!ALL) where.push(`a.session_status='live'`);
  // Порядок = «продолжить с места обрыва»: анонимное чтение с одного IP упирается в стену IG
  // примерно после сотни запросов, и прерванный обход раньше начинался бы сначала — одни и те же
  // акки жгли лимит, хвост не проверялся никогда. Теперь первыми идут ни разу не проверенные и
  // самые залежавшиеся (по УСПЕШНОМУ чеку profile_checked_at, попытки-сбои место в очереди не съедают).
  const rows = (await c.query(
    `SELECT a.id, a.slug, coalesce(a.ig_login,a.slug) h, a.persona, a.platform, a.session_status,
            a.ig_status, a.health_state, a.dress_at, a.followers_count
       FROM accounts a WHERE ${where.join(' AND ')}
      ORDER BY a.profile_checked_at ASC NULLS FIRST, (coalesce(a.persona,'')='') , a.persona, a.slug`, par)).rows;

  if (!rows.length) { console.log('нет акков под условие'); await c.end(); return; }
  console.log(`ЕДИНЫЙ ЧЕК: ${rows.length} акк(ов), снаружи, без входов и без окон браузера`);
  console.log(`сверка лиц: ${NO_VISION ? 'ВЫКЛЮЧЕНА' : MODEL}\n`);

  const out = [];
  for (const a of rows) {
    const r = await checkOne(c, a).catch((e) => Object.assign({ h: a.h, slug: a.slug, persona: a.persona },
      { verdict: 'ОШИБКА', note: String(e.message).slice(0, 80), hard: [], soft: [], skipped: true }));
    out.push(r);
    const mark = r.verdict === 'ДЕФЕКТ' ? '✗' : r.verdict === 'ОК' ? '✓' : '·';
    console.log(`  ${mark} ${String(r.h).padEnd(28)} ${r.verdict}${r.hard && r.hard.length ? ' — ' + r.hard.join('; ') : ''}`);
    await sleep(GAP_MS);
  }
  await c.end();

  // СВОДНАЯ ТАБЛИЦА — чтобы состояние фермы читалось одним взглядом, без лазанья в базу.
  const cols = [['акк', 26], ['персона', 9], ['вердикт', 14], ['ава', 5], ['лицо', 9], ['имя', 20], ['био', 5], ['постов', 6], ['подпис.', 8], ['посл.пост', 10]];
  const line = (v) => v.map((x, i) => String(x == null ? '' : x).slice(0, cols[i][1]).padEnd(cols[i][1])).join(' | ');
  console.log('\nСВОДКА:');
  console.log(line(cols.map((x) => x[0])));
  console.log('-'.repeat(cols.reduce((s, x) => s + x[1] + 3, 0)));
  for (const r of out) {
    const dyn = r.prev != null && r.followers != null && r.followers !== r.prev ? `${r.followers}(${r.followers > r.prev ? '+' : ''}${r.followers - r.prev})` : r.followers;
    console.log(line([r.h, r.persona, r.verdict, r.ava, r.face, r.name, r.bio ? 'есть' : 'ПУСТО',
      r.posts, dyn, r.ageD == null ? '' : `${r.ageD} сут`]));
  }
  // СПРЯТАННЫЕ — ОТДЕЛЬНОЙ СТРОКОЙ, А НЕ В ОБЩЕЙ КУЧЕ ДЕФЕКТОВ. Это не косметика: пока акк
  // спрятан, его посты снаружи не видит никто, и гнать через него публикации бессмысленно.
  // Приговор при этом не вынесен — отличить чекпоинт от бана можно только входом.
  const hid = out.filter((r) => r.hidden);
  const hidMaybe = out.filter((r) => r.verdict === 'СПРЯТАН?');
  const bad = out.filter((r) => r.hard && r.hard.length && !r.hidden);
  const notes = out.filter((r) => (!r.hard || !r.hard.length) && r.soft && r.soft.length && r.verdict !== 'СПРЯТАН?');
  console.log(`\nИТОГ: проверено ${out.length}, дефектных ${bad.length}, спрятанных ${hid.length}, с замечаниями ${notes.length}`);
  if (hid.length) {
    console.log('\nСПРЯТАНЫ СНАРУЖИ (ник есть, профиль анониму не отдаётся — НЕ бан, нужен чек входом):');
    for (const r of hid) console.log(`  🙈 ${r.h}${r.persona ? ` (${r.persona})` : ''}: попытки [${r.tries}] — health_state='hidden'`);
    console.log('  Автоснос и автозамену по этой метке НЕ запускаем: анонимно чекпоинт от бана не отличить.');
    console.log('  Проверять входом (без пароля): node modelduty.cjs <slug> — куки-реанимация покажет экран.');
  }
  if (hidMaybe.length) {
    console.log(`\nПОХОЖЕ, СПРЯТАНЫ, НО ПОДТВЕРЖДЕНИЯ НЕТ (${hidMaybe.length}) — нас душат лимитом, повторить позже:`);
    for (const r of hidMaybe) console.log(`  ? ${r.h}: ${r.note}`);
  }
  if (bad.length) {
    console.log('\nДЕФЕКТЫ (править):');
    for (const r of bad) console.log(`  ✗ ${r.h}${r.persona ? ` (${r.persona})` : ''}: ${r.hard.join('; ')}`);
  }
  if (notes.length) {
    console.log('\nЗАМЕЧАНИЯ:');
    for (const r of notes) console.log(`  · ${r.h}: ${r.soft.join('; ')}`);
  }
  console.log(`\nАвы и кадры лежат в ${WORK_DIR} — можно посмотреть глазами.`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });

const { спросить: _спросить } = require('./llmcache.cjs');
async function faceCheck(...дов) {
  const карт = (() => { try { return [(дов[0]||{}).refFile, (дов[0]||{}).avaFile, ...((дов[0]||{}).frames||[])]; } catch { return []; } })();
  return _спросить({
    ключ: {
      model: MODEL,
      // В КЛЮЧ ВХОДЯТ И НАСТРОЙКИ ЗАПРОСА (14.08, поймано аудитом). Второй довод меняет ПРОМПТ:
      // у validateCarousel это {template, coverRef, frame4Art}, у card_qa — gridWarn. Пока их в
      // ключе не было, один и тот же набор картинок отдавал вердикт, посчитанный под ЧУЖИЕ флаги:
      // сборщик спрашивал с coverRef, а публикатор получал его ответ без своих. Ложный отказ так
      // залипал навсегда.
      prompt: 'faceCheck|' + (() => { try { return JSON.stringify(дов.slice(1)); } catch { return ''; } })(),
      images: Array.isArray(карт) ? карт : [карт],
    },
    запрос: () => faceCheckЗапрос(...дов),
    годен: (о) => o_годен(о),
    чей: 'accheck',
  });
}
// ЧТО СЧИТАТЬ НАСТОЯЩИМ ВЕРДИКТОМ (переписано 14.08 после аудита — первая версия была опасной).
//
// БЫЛО: проверка искала слова «таймаут», «нет ключа» и им подобные в тексте ответа. Она пропускала
// ГЛАВНЫЙ признак сбоя — поле ok:false, которое ставит функция failed() в самих проверках. То есть
// {verdict:'unknown', ok:false, reason:'infra'} — ответ «проверка не состоялась» — оседал в кэше
// НАВСЕГДА и выдавался как настоящий вердикт. Один период с нулевым балансом на ключе отравил бы
// каждую карусель, собранную в это время, и повторная проверка уже никогда бы не сделалась.
// Отдельно: регулярка искала «не загрузилась», а в сообщении стоит «не загрузились» — промах на
// одну букву, из-за которого сбой загрузки картинок тоже кэшировался.
//
// СТАЛО: сначала смотрим явные признаки несостоявшейся проверки, потом уже слова.
function o_годен(о) {
  if (!о || typeof о !== 'object') return false;
  if (о.ok === false) return false;                 // failed() — проверка не состоялась
  if (о.checkFailed) return false;                  // тот же смысл под другим именем
  if (о.reason === 'infra' || о.сбой) return false;
  if ('вердикт' in о && !о.вердикт) return false;
  if (о.verdict === 'unknown') return false;        // «не знаю» — не вердикт, спросим заново
  const s = JSON.stringify(о);
  return !/no_key|нет ключа|таймаут|timeout|не получен|не загрузил|http_(4|5)\d\d|\b402\b|\b429\b/i.test(s);
}
