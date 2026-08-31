// golink.cjs — ПЕРСОНАЛЬНАЯ ТРЕКИНГ-ССЫЛКА ПОД АККАУНТ (приказ начальника 11.08: «ссылка должна
// быть уникальная, в админке есть ссылки, под каждый акк делаешь уникальную»).
//
// ЗАЧЕМ. Одна общая ссылка на все аккаунты не даёт понять, какой акк реально приводит людей: реги и
// покупки сваливаются в общий котёл. Персональная /go/<код> проставляет utm_source=ubt и
// utm_campaign=<код>, а привязка идёт по первому касанию, то есть каждый акк виден в «Источниках»
// отдельной строкой.
//
// ЧЕМ РАБОТАЕМ: РУЧКОЙ, НЕ ИНТЕРФЕЙСОМ. Контракт снят не с догадок, а из фронтенда самой админки
// (кусок бандла раздела «Ссылки», компонент CreateTrackingLink):
//     POST /api/admin/tracking-links   {"title":…, "code":…, "target":…}   → JSON, при ошибке .error
//     PATCH  /api/admin/tracking-links {"id":…, "target":…}                (сменить, куда ведёт)
//     DELETE /api/admin/tracking-links?id=…                                (мы не зовём НИКОГДА)
// Списка через GET у ручки нет вообще (GET отвечает 405), список страница рисует на сервере.
// Поэтому «есть ли уже такая ссылка» проверяем по тексту самой страницы /admin/links.
//
// ХОДИМ ИЗ СТРАНИЦЫ АДМИНКИ (adminbrowser: статичный headless Chrome проекта, окон в доке не
// появляется). Так запрос идёт живой сессией админки, и нам не нужно ни токенов, ни печенек в коде.
//
// КОД ССЫЛКИ КОРОТКИЙ И СТАБИЛЬНЫЙ. Один аккаунт всегда получает один и тот же код, поэтому
// повторный запуск ссылок НЕ ПЛОДИТ: сначала ищем, создаём только если не нашли.
//
// ЗАПУСК
//   node golink.cjs bryan436344              найти или создать и показать адрес
//   node golink.cjs bryan436344 --dry        только сказать, какой будет код, ничего не создавать
//   node golink.cjs --list                   что уже лежит в разделе «Ссылки»
'use strict';
const crypto = require('node:crypto');

const SITE = 'neironka.pro';
const ADMIN_LINKS = `https://${SITE}/admin/links`;
const DEFAULT_TARGET = '/#templates';   // как у существующих ссылок mg41…mg50
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// КОД РАВЕН НИКУ АККАУНТА (11.08, решение начальника после разбора вариантов).
// ПОЧЕМУ ИМЕННО ТАК. В рецепте магоса ссылка задаётся ОДНОЙ строкой с макросом {username}, и магос
// подставляет туда ник аккаунта. Значит код нашей трекинг-ссылки обязан совпадать с ником: тогда
// одна строка в рецепте раздаёт персональную ссылку каждому акку, и в разделе «Источники» видно,
// какой акк приводит людей.
// Короткий код (4 знака) мы пробовали и отказались: он требует раздачи ссылок СПИСКОМ, а у списка
// в магосе есть ловушка (выключение тумблера затирает весь список первой строкой без предупреждения)
// и зависимость от порядка аккаунтов в папке.
// Ник приводим к безопасному для адреса виду. ТОЧКИ И ПОДЧЁРКИВАНИЯ МЕНЯЕМ НА ДЕФИС: 11.08 админка
// ответила 400 на ники вида sergei.bong («Код: 3–32 символа, латиница/цифры/дефис, начинается с
// буквы или цифры»), то есть точку и подчёркивание она не принимает вовсе. Побочный эффект: у таких
// ников макрос {username} магоса даст адрес /go/sergei.bong, которого в админке нет — он уводит на
// главную и НЕ считается. Для них ссылку раздаём списком, а не макросом.
function codeFor(handle) {
  const код = String(handle || '').toLowerCase().replace(/[._]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '').replace(/-+$/, '').slice(0, 32);
  return код.length >= 3 ? код : `acc${код}`;
}
// Название в админке: «ubt <ник>» — та же схема, что у уже созданных «маго <ник>».
const titleFor = (handle) => `ubt ${handle}`;
const urlFor = (code) => `https://${SITE}/go/${code}`;

// Все коды, которые СЕЙЧАС лежат в разделе. Читаем текст страницы: списка через ручку нет.
async function readCodes(page) {
  const txt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  return [...new Set([...String(txt).matchAll(/(?:neironka\.pro)?\/go\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
}

/**
 * Найти или создать персональную ссылку аккаунта.
 * @param {string} handle ник аккаунта (@ не нужен)
 * @param {object} o {target, dry, log, code}
 *   code — ЯВНЫЙ код вместо расчётного. Нужен, когда адрес собирает не наш код, а чужой шаблон:
 *   в рецепте магоса стоит макрос https://neironka.pro/go/{username}, магос сам подставит туда НИК,
 *   поэтому код обязан быть РАВЕН нику, иначе метка utm_campaign не сойдётся с аккаунтом.
 * @returns {Promise<{url, code, title, mode}>} mode: 'нашёл' | 'создал'
 */
async function ensureLink(handle, o = {}) {
  const log = o.log || console.log;
  // let, а НЕ const: ниже есть ветка разрешения столкновений, которая переприсваивает код.
  // С const это падало бы TypeError ровно в тот момент, когда столкновение случится, то есть
  // в самый неудобный. Поймано разбором кода, не на живом запуске.
  let code = o.code ? String(o.code) : codeFor(handle);
  const title = titleFor(handle);
  if (o.dry) return { url: urlFor(code), code, title, mode: 'только расчёт' };

  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  try {
    await page.goto(ADMIN_LINKS, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(4000);
    const before = await readCodes(page);
    // СТОЛКНОВЕНИЕ КОРОТКИХ КОДОВ (11.08). Код теперь 4 знака, и хотя на 3000 ников столкновений
    // всего 5, «почти не бывает» тут не годится: два аккаунта с одним кодом это склеенная
    // статистика и неверная атрибуция. Поэтому «код занят» больше не означает «это наша ссылка»:
    // ищем на странице НАШЕ название (ubt <ник>). Если названия нет, код чужой, и мы берём
    // следующий вариант, подмешивая номер попытки в хеш.
    const текст = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const наше = текст.includes(title);
    if (before.includes(code) && наше) {
      log(`  🔗 ссылка уже есть: ${urlFor(code)} (новую не создаю)`);
      return { url: urlFor(code), code, title, mode: 'нашёл' };
    }
    if (before.includes(code) && !наше) {
      for (let n = 1; n <= 20; n++) {
        const запасной = codeFor(`${handle}#${n}`);
        if (!before.includes(запасной)) {
          log(`  ⚠ код ${code} занят чужим аккаунтом, беру ${запасной}`);
          code = запасной;
          break;
        }
      }
    }
    // СОЗДАЁМ. Ошибку ручки читаем и называем вслух: молча «ну наверное создалась» здесь нельзя,
    // иначе на кадр уедет адрес, которого не существует, и весь пост будет мимо.
    const r = await page.evaluate(async ({ title: t, code: cd, target }) => {
      const res = await fetch('/api/admin/tracking-links', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, code: cd, target }),
      });
      let body = null;
      try { body = await res.json(); } catch {}
      return { ok: res.ok, status: res.status, error: body && body.error ? String(body.error) : null };
    }, { title, code, target: o.target || DEFAULT_TARGET });
    if (!r.ok) throw new Error(`админка не создала ссылку (${r.status}): ${r.error || 'без причины'}`);
    // ПРОВЕРКА ПОЛОЖИТЕЛЬНЫМ ПРИЗНАКОМ: код появился в списке на перезагруженной странице.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await sleep(4000);
    const after = await readCodes(page);
    if (!after.includes(code)) throw new Error(`ручка ответила «ок», но кода ${code} в списке нет — не верю`);
    log(`  🔗 создал ссылку: ${urlFor(code)} («${title}» → ${o.target || DEFAULT_TARGET})`);
    return { url: urlFor(code), code, title, mode: 'создал' };
  } finally { await done(); }
}

module.exports = { ensureLink, codeFor, titleFor, urlFor, readCodes, SITE, DEFAULT_TARGET };

// ── запуск руками ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes('--list')) {
      const { openAdmin } = require('./adminbrowser.cjs');
      const { page, done } = await openAdmin();
      try {
        await page.goto(ADMIN_LINKS, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await sleep(4000);
        const codes = await readCodes(page);
        console.log(`ссылок в разделе: ${codes.length}\n  ${codes.join(', ')}`);
      } finally { await done(); }
      process.exit(0);
    }
    const handle = args.find((x) => !x.startsWith('--'));
    if (!handle) { console.log('usage: node golink.cjs <ник> [--target /#templates] [--dry] | --list'); process.exit(1); }
    const ti = args.indexOf('--target');
    const target = ti > 0 ? args[ti + 1] : undefined;
    const r = await ensureLink(handle, { dry: args.includes('--dry'), target });
    console.log(`${r.mode}: ${r.url}  (код ${r.code}, название «${r.title}»)`);
    process.exit(0);
  })().catch((e) => { console.log('⛔ ' + e.message); process.exit(1); });
}
