// igprofile.cjs — ОДНО МЕСТО, ГДЕ РАЗБИРАЕТСЯ ОТВЕТ ИНСТАГРАМА О ПРОФИЛЕ (10.08).
//
// ЗАЧЕМ. Один и тот же разбор ответа `users/web_profile_info` жил копиями в accheck.cjs,
// modelduty.cjs, checkposted.cjs, accjanitor.cjs и ещё пяти файлах. Копии уже разъехались, и это
// стоило дорого дважды:
//   · 07.08 в accheck закрыли дыру «любой ответ без user = профиля нет» (ложные баны от одной 429),
//     а в accjanitor ту же дыру не закрыли, и круглосуточный уборщик писал «акк потерян» по живому;
//   · 10.08 нашлось состояние «профиль спрятан», и его пришлось объяснять в четырёх файлах подряд.
// Дальше копии множить нельзя: следующая правка снова пройдёт мимо половины файлов.
//
// ЧЕТЫРЕ РАЗЛИЧИМЫХ ИСХОДА, а не «получилось или нет»:
//   виден        — есть data.user. Единственный положительный факт.
//   нет-профиля  — ЯВНОЕ data.user === null. Только это доказывает, что профиля нет.
//   спрятан      — ответ ровно {"status":"ok"} БЕЗ ключа data. Ник существует, профиль скрыт от
//                  анонима. Не бан и не сбой: отличить чекпоинт от смерти можно только входом.
//                  Проверено на восьми акках: по 8-12 попыток с 7-10 разных прокси, ни разу 404 и
//                  ни разу не отдался, при этом контрольные живые акки через те же прокси в те же
//                  минуты отдавались 10 из 10, а выдуманные ники честно отвечали 404.
//   сбой         — всё остальное: лимит айпи, checkpoint_required, login_required, пустой {},
//                  {"status":"fail"}, не-JSON. Это про НАШ доступ, а не про аккаунт, поэтому
//                  вердикта по акку тут НЕТ ни при каких условиях.
//
// ПОРЯДОК ПРОВЕРОК: СНАЧАЛА ПОЛОЖИТЕЛЬНЫЙ ФАКТ, ПОТОМ ПРИЗНАКИ СБОЯ. Это не вкусовщина, это
// исправление моей же ошибки от 10.08, которую поймал первый настоящий прогон.
//
// Что я сделал неправильно: поставил признаки сбоя ПЕРВЫМИ, рассуждая, что лимит не должен
// читаться как приговор. На синтетических примерах всё сошлось 12 из 12. А на живом ответе
// развалилось: полный профиль это 170 килобайт JSON, и слова «asset» и «deleted» встречаются в нём
// как имена полей и внутри ссылок на картинки. Значит КАЖДЫЙ живой профиль объявлялся сбоем.
// Прицельный скан из-за этого три круга подряд писал «канал мёртв», хотя аккаунты отдавались.
//
// Почему обратный порядок безопасен: наличие data.user — однозначный положительный факт, он не
// бывает ложным. А слова про сбой имеют смысл только там, где данных НЕТ. Именно так и было
// сделано в accheck.cjs (регексп сбоя живёт внутри ветки «нет user»), и это было правильно.
//
// Урок на будущее: синтетические примеры не проверяют объём. Разбор ответа обязан быть проверен
// на НАСТОЯЩЕМ большом ответе, а не только на коротких заготовках.
//
// ЗДЕСЬ ЖЕ ЖИВЁТ ПРАВИЛО ВЕРДИКТА (`probe`, 10.08). Разобрать ОДИН ответ мало: с одного айпи
// «профиль спрятан» и «нас придушили лимитом» выглядят одинаково. Поэтому отрицательный вердикт
// («спрятан», «нет-профиля», «нет-ника») рождается только из НЕСКОЛЬКИХ попыток с РАЗНЫХ каналов,
// а лимит нашего айпи (401/429, «Please wait a few minutes») не идёт в счёт ни одному из них.
// Пятый исход, `без-вердикта`, ровно про это: подтверждений не набралось, и честнее сказать
// «не знаю», чем записать в базу догадку про живой аккаунт.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GLITCH_RE = /asset|deleted|wait a few|rate limit|try again|checkpoint_required|login_required|feedback_required|challenge_required/i;

// raw — сырой текст ответа (нужен для признаков сбоя, которые бывают и не в JSON).
// code — http-код, если он известен; 404 это честное «ника нет».
function classify(raw, code) {
  const out = String(raw || '');
  // Код может быть неизвестен (часть читателей отдаёт только тело) — тогда судим по тексту.
  const c = code == null || code === '' ? null : Number(code);
  if (c === 404) return { kind: 'нет-ника' };
  // ЛИМИТ НАШЕГО АЙПИ — ЭТО НЕ ФАКТ ПРО АККАУНТ (10.08). «Please wait a few minutes» приходит с
  // кодом 401, а 429 бывает и вовсе без тела. Такой ответ не идёт в счёт НИКАКОМУ вердикту:
  // он говорит только то, что придушили НАС. Ловим по коду, не надеясь на текст: пустое тело с
  // кодом 401 иначе разбиралось бы как «не JSON», то есть выглядело бы как сбой канала.
  if (c === 401 || c === 429) return { kind: 'сбой', why: `лимит нашего IP (HTTP ${c})` };
  if (c !== null && !(c > 0)) return { kind: 'сбой', why: 'канал молчит (curl не ответил)' };
  if (/Page Not Found|Sorry, this page/i.test(out) && !/"user"/.test(out)) return { kind: 'нет-ника' };
  let j = null;
  try { j = JSON.parse(out); } catch { return { kind: 'сбой', why: 'не JSON' }; }

  // 1. ПОЛОЖИТЕЛЬНЫЙ ФАКТ ПЕРВЫМ. Есть данные пользователя — профиль отдаётся, спорить не о чем.
  const user = j && j.data && j.data.user;
  if (user) return { kind: 'виден', user, json: j };

  // 2. Данных нет. ТЕПЕРЬ слова про сбой имеют смысл: они про наш доступ, а не про аккаунт.
  //    Ищем их в СЛУЖЕБНЫХ полях, а не по всему тексту: по всему тексту ловятся имена полей
  //    («asset», «deleted») из нормального ответа, и на этом я уже обжёгся.
  const служебное = [j.message, j.error, j.error_type, j.status, j.feedback_message]
    .filter((x) => typeof x === 'string').join(' ');
  if (GLITCH_RE.test(служебное)) return { kind: 'сбой', why: String(j.message || j.error || 'сбой IG').slice(0, 60), json: j };

  const hasData = j && Object.prototype.hasOwnProperty.call(j, 'data');
  // 3. Спрятан: ответ ровно {"status":"ok"} БЕЗ ключа data.
  if (j && j.status === 'ok' && !hasData) return { kind: 'спрятан', json: j };

  // 4. Профиля нет: только ЯВНОЕ data.user === null.
  const explicitNull = hasData && Object.prototype.hasOwnProperty.call(j.data, 'user') && j.data.user === null;
  if (explicitNull) return { kind: 'нет-профиля', json: j };

  return { kind: 'сбой', why: String(j.message || j.status || j.error || 'ответ без user').slice(0, 60), json: j };
}

// Человеческая формулировка для отчётов и нарядов, одна на весь проект.
const WORDS = {
  'виден': 'профиль отдаётся',
  'спрятан': 'ник есть, но профиль спрятан от анонима — нужен чек входом',
  'нет-профиля': 'профиля нет снаружи (снесён или забанен)',
  'нет-ника': 'ника не существует',
  'сбой': 'вердикта нет: сбой или наш доступ',
  'без-вердикта': 'вердикта нет: подтверждений с разных каналов не хватило',
};

// ЧТО АНОНИМНЫЙ ЧЕК НЕ ИМЕЕТ ПРАВА ПЕРЕТИРАТЬ В health_state.
// Снаружи видно ровно одно: отдаётся профиль или нет. Всё, что стоит в этом списке, поставлено
// ДОРОЖЕ: реальным заходом, ответом Instagram про вход, или рукой начальника. Отдельно про 'keep':
// это ЗАМОК АВТОСНОСА (ARCHITECTURE §3), уборщик ставит его вместе с паузой, и если внешний чек
// перепишет 'keep' на свой вердикт, акк через 20 минут заберёт автозамена вместе с профилем
// GoLogin. Один такой случай уже стоил проекту трёх акков (§9, урок приёмки 06.08).
const PROTECTED = ['keep', 'restricted', 'banned', 'suspended', 'captcha', 'challenge',
  'need_login', 'needs_human_verify', 'no_session', 'deleted'];

// «Нас душат» — по этой примете читатели решают, что обход пора сворачивать (уборщик так и делает).
// Формулировка «лимит нашего IP» приходит от кода 401/429, когда тела нет вовсе.
const THROTTLE_RE = /wait a few|rate limit|rate|too many|лимит нашего IP/i;
const isThrottle = (why) => THROTTLE_RE.test(String(why || ''));

// --- КАНАЛЫ (EGRESS) ---------------------------------------------------------------------------
// «Разные прокси» — не украшение, а условие вердикта: с одного айпи «спрятан» и «нас придушили»
// выглядят одинаково. Список собираем из того, что уже лежит на диске, пароли никуда не печатаем.
function normProxy(s) {
  let p = String(s == null ? '' : s).trim();
  if (!p) return null;
  p = p.replace(/^(https?|socks5)\s+/i, '');            // формат панели: «http 1.2.3.4:8000»
  if (/^[a-z0-9]+:\/\//i.test(p)) return p;
  const parts = p.split(':');
  if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`; // host:port:user:pass
  if (parts.length === 2 || p.includes('@')) return `http://${p}`;
  return null;
}

function proxies(extra = []) {
  const out = [];
  const add = (v) => { const p = normProxy(v); if (p && !out.includes(p)) out.push(p); };
  for (const v of extra) add(v);
  for (const v of String(process.env.IG_PROBE_PROXIES || '').split(',')) add(v);
  try {
    for (const f of fs.readdirSync('/tmp/px')) {
      if (!f.endsWith('.txt')) continue;
      for (const l of fs.readFileSync(path.join('/tmp/px', f), 'utf8').split('\n')) add(l);
    }
  } catch { /* папки нет — работаем тем, что дали */ }
  return out;
}

const APP_ID = '936619743392459';
const UA = 'Instagram 269.0.0.18.75 Android';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Один анонимный запрос через конкретный канал. Возвращает разбор + чем спрашивали.
function ask(nick, proxy, opts = {}) {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', String(opts.timeout || 25),
    '-H', `User-Agent: ${opts.ua || UA}`, '-H', `X-IG-App-ID: ${APP_ID}`,
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(nick)}`];
  const px = normProxy(proxy);
  if (px) args.push('--proxy', px);
  const out = String(spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 24 }).stdout || '');
  const nl = out.lastIndexOf('\n');
  const code = Number(out.slice(nl + 1).trim());
  const r = classify(nl < 0 ? out : out.slice(0, nl), Number.isFinite(code) ? code : 0);
  r.code = Number.isFinite(code) ? code : 0;
  r.egress = px || 'direct';
  r.egressShort = px ? px.replace(/^[a-z0-9]+:\/\/[^@]*@/i, '') : 'direct';  // без логина и пароля
  return r;
}

// --- ПОДТВЕРЖДЁННЫЙ ВЕРДИКТ --------------------------------------------------------------------
// ПРАВИЛО (приказ начальника 10.08): «спрятан» ставится ТОЛЬКО после нескольких попыток с РАЗНЫХ
// прокси, и ответ «Please wait a few minutes» (401) в счёт не идёт. Цена ошибки максимальная:
// метка про акк не должна рождаться из нашего же лимита. Поэтому:
//   • «виден» — единственный положительный факт, принимается с ПЕРВОГО ответа и обрывает опрос;
//   • «спрятан» / «нет-профиля» / «нет-ника» — только когда так ответили minConfirm РАЗНЫХ каналов;
//   • сбой и лимит не считаются вообще: они про наш доступ;
//   • подтверждений не набралось — честное «вердикта нет», а не догадка.
// Канал «direct» (наш собственный айпи) идёт ПОСЛЕДНИМ: именно он выжигается лимитом первым.
async function probe(nick, opts = {}) {
  const list = opts.proxies || proxies();
  const tries = Math.max(1, Number(opts.tries || process.env.IG_PROBE_TRIES || 4));
  const minConfirm = Math.max(1, Number(opts.minConfirm || process.env.IG_PROBE_CONFIRM || 2));
  const pause = Number(opts.pause == null ? (process.env.IG_PROBE_PAUSE_MS || 2000) : opts.pause);
  const allowDirect = opts.allowDirect !== false;
  // Сдвиг по нику: разные акки начинают с разных прокси, иначе первые в списке выжигаются первыми.
  let off = 0;
  for (const ch of String(nick)) off = (off * 31 + ch.charCodeAt(0)) % 9973;
  const plan = [];
  for (let i = 0; i < list.length && plan.length < tries; i++) plan.push(list[(off + i) % list.length]);
  if (allowDirect && plan.length < tries) plan.push(null);

  const attempts = [];
  const byKind = new Map();                              // вердикт → множество РАЗНЫХ каналов
  for (const [i, px] of plan.entries()) {
    const r = ask(nick, px, opts);
    attempts.push({ kind: r.kind, code: r.code, egress: r.egressShort, why: r.why || '' });
    if (typeof opts.onAttempt === 'function') opts.onAttempt(r);
    if (r.kind === 'виден') {
      return { kind: 'виден', why: 'профиль отдался', attempts, confirms: 1, egress: r.egress, user: r.user, json: r.json };
    }
    if (r.kind !== 'сбой') {
      if (!byKind.has(r.kind)) byKind.set(r.kind, new Set());
      byKind.get(r.kind).add(r.egress);
      if (byKind.get(r.kind).size >= minConfirm) {
        return { kind: r.kind, why: `подтверждено ${byKind.get(r.kind).size} разными каналами`, attempts, confirms: byKind.get(r.kind).size };
      }
    }
    if (pause && i < plan.length - 1) await sleep(pause);
  }
  const answered = attempts.filter((a) => a.kind !== 'сбой');
  const best = [...byKind.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  return {
    kind: 'без-вердикта',
    why: !answered.length
      ? `ни один канал не ответил по делу (попыток ${attempts.length}, из них лимит/сбой ${attempts.length})`
      : `«${best[0]}» подтвердили ${best[1].size} канал(ов) из нужных ${minConfirm} (попыток ${attempts.length}, каналов в запасе ${list.length + (allowDirect ? 1 : 0)})`,
    attempts,
    confirms: best ? best[1].size : 0,
    leaning: best ? best[0] : null,
  };
}

module.exports = { classify, WORDS, GLITCH_RE, PROTECTED, THROTTLE_RE, isThrottle, proxies, normProxy, ask, probe, APP_ID };
