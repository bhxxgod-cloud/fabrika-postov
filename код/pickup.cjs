// ПОДБИРАТЕЛЬ ОПЛАЧЕННОГО (11.08, приказ начальника: «сделай подбиратель, чтобы не пропало то, за
// что уже заплачено»).
//
// ЗАМЕР, ИЗ КОТОРОГО РОДИЛСЯ ФАЙЛ (11.08, около 10:00). Фабрика партнёра встала: 11-12 заказов
// висят в queued с 09:28, 3 в rendering, 27 done, 8 failed. Наши сборки (onepost.cjs) ждали рендер
// РОВНО 10 минут и бросали заказ, а заказ платится в момент постановки: каждый брошенный заказ это
// 17 руб в мусор (providerCostKopecks=1700 на карточный шаблон). Ожидание уже поднято до 25 минут, а
// сторож полосы до 40, но УЖЕ брошенные заказы этим не спасаются: процесс, который их поставил,
// давно умер, и связки «заказ → пост» нет ни в одном логе.
//
// ЧТО ДЕЛАЕТ. Читает очередь фабрики, находит заказы в статусе done, у которых 2 и более кадров и
// которых НЕТ в нашей базе постов, и собирает из них пост ровно тем же путём, каким это делает
// onepost.cjs ПОСЛЕ получения кадров. Ничего у фабрики НЕ ПЕРЕЗАКАЗЫВАЕТ: в этом весь смысл, второй
// раз за те же кадры не платим.
//
// ПО КАКОМУ ПОЛЮ СВЕРЯЕМ «СВОЙ или БЕСХОЗНЫЙ». posts.meta->>'factory_order'. Это id заказа фабрики,
// его пишет onepost.cjs в мету поста одной строкой (`factory_order: ord.id`), и то же поле уже
// используют старые спасатели (harvesthash.cjs, harvestlog.cjs), то есть ключ у конвейера ОДИН.
// Никакой другой связки в базе нет: ни персона, ни исходник, ни время не годятся, потому что при
// восьми параллельных полосах имя персоны в лог не печатается, а исходник у заказа лежит только
// ссылкой в R2.
//
// ОТКУДА БЕРЁТСЯ ОБЛОЖКА, ЕСЛИ ИСХОДНИК НЕ ИЗВЕСТЕН. Заказ хранит customPhotoUrl — это РОВНО тот
// файл, который наша сборка залила на фабрику перед заказом (onepost: uploadRef, потом
// meta.source_cover_url). Скачиваем его и работаем с ним как с исходником: байты те же, а значит и
// отпечаток (sha256), и семя разведения поз совпадают с тем, что взяла бы упавшая полоса.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ onepost.cjs (сознательно, а не по недосмотру):
//   · заказа фабрике НЕ СТАВИТ вообще, только забирает готовое;
//   · брак отдела качества обложки НЕ БРАКУЕТ ФОТОГРАФИЮ и не двигает файл в карантин: файл лежит в
//     R2 у партнёра, а не в нашей папке годных, и наказывать за него нечего. Такой заказ уходит в
//     список «больше не трогать» (/tmp/pickup_skipped.json), чтобы не платить за вердикт модели по
//     нему в каждом цикле дежурства;
//   · в телеграм по умолчанию НЕ ОТПРАВЛЯЕТ (живая волна остановлена, идёт залив): PICKUP_TG=1
//     включает отправку, общий рубильник /tmp/NO_TG всё равно главнее.
//
// ПОЧЕМУ КОД СБОРКИ ЗДЕСЬ СВОЙ, А НЕ ВЫЗОВ onepost.cjs. onepost это один сплошной IIFE без
// экспортов, и он ЖИВОЙ: правился сегодня, по нему сейчас идут полосы. Вынимать из него пол-файла в
// общий модуль под работающей волной значит рисковать волной ради красоты, поэтому шаги сборки
// повторены здесь, а вся тяжёлая механика взята теми же общими модулями (slidekit, promptkit, rgen,
// refretry, framegate, facesim, phonelook, coverguard, validatepost) — то есть расходится только
// порядок вызовов, а не поведение. Когда волна встанет, это место надо вынести в общий модуль:
// два порядка вызовов одного конвейера рано или поздно разъедутся.
//
// ЗАПУСК:
//   node pickup.cjs                  разовый прогон: подобрать всё бесхозное готовое и выйти
//   node pickup.cjs --сторож         дежурство: раз в 5 минут проверять очередь и подбирать
//   node pickup.cjs --сухой          только показать, что подобрал бы (ничего не собирает)
//   node pickup.cjs --limit 3        не больше трёх постов за прогон
// Переменные:
//   PICKUP_ORPHAN_MIN=20   сколько минут заказ должен быть done, чтобы считаться брошенным
//   PICKUP_SINCE_H=24      окно по времени создания заказа (глубже не лезем: там чужие эпохи)
//   PICKUP_EVERY_SEC=300   период дежурства
//   PICKUP_TG=1            разрешить карточку в телеграм
//   PICKUP_CARD_VISION=1   гонять карточку кадра 2 через ПЛАТНЫЙ эшелон card_qa
//   COVER_QA_OFF=1         не проверять обложку отделом качества
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const { to45, to45smart, reframe, ctaSlide, lockMock, lockScenePair, renderHtml, factoryHook,
  postCaption, rotorRead, rotorWrite, хукНизом } = require('./slidekit.cjs');
const { coverUsed, registerCover } = require('./coverguard.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
const TPL = require('./templates.cjs');
const rgen = require('./rgen.cjs');
const refretry = require('./refretry.cjs');
const pk = require('./promptkit.cjs');
const { checkCarousel, hairFamily, hairColor, hairColorDistance, T: gateT } = require('./framegate.cjs');
const fk = require('./facesim.cjs');
const cardQA = require('./card_qa.cjs');
const coverQA = require('./cover_qa.cjs');

// СТРОКА БАЗЫ ЧЕРЕЗ ОБЩИЙ МОДУЛЬ (14.08). Прямое чтение /tmp стоило нам остановки всей фермы в
// ночь 13-14: уборка временных файлов унесла строку, а запасного пути не было. Модуль ищет её по
// цепочке окружение → ~/.neironka/secrets → /tmp и сам возвращает копию в /tmp. Разбор в dburl.cjs.
const DBURL = require('./dburl.cjs')();
const ADMIN_URL = 'https://neironka.pro/admin/promo';
const LOG = process.env.PICKUP_LOG || '/tmp/pickup.log';
// Список заказов, которые подбирать НЕЛЬЗЯ И БОЛЬШЕ НЕ НАДО (брак обложки, обложка уже стоит в
// другом посте). Без него дежурство в каждом цикле заново платило бы за вердикт модели по одному и
// тому же безнадёжному заказу.
const SKIPFILE = process.env.PICKUP_SKIPFILE || '/tmp/pickup_skipped.json';
const LOCK = '/tmp/genposts.lock';          // тот же файл, что у onepost: конвейер один
const MYLOCK = '/tmp/pickup.lock';          // и второй подбиратель нам не нужен
const ORPHAN_MIN = Number(process.env.PICKUP_ORPHAN_MIN || 20);
const SINCE_H = Number(process.env.PICKUP_SINCE_H || 24);
const EVERY = Number(process.env.PICKUP_EVERY_SEC || 300) * 1000;
const ДЕЖУРСТВО = process.argv.some((a) => /^--(сторож|storozh|watch|duty)$/i.test(a));
const СУХОЙ = process.argv.some((a) => /^--(сухой|dry|dry-run)$/i.test(a));
const ЛИМИТ = (() => {
  const i = process.argv.findIndex((a) => /^--(limit|сколько)$/i.test(a));
  return i > 0 ? Number(process.argv[i + 1] || 0) : Number(process.env.PICKUP_LIMIT || 0);
})();
const W = 1080, H = 1350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const кор = (id) => String(id).slice(0, 8);

// ЛОГ С МАШИННЫМ ВРЕМЕНЕМ. Дежурство живёт часами, и «в какую минуту фабрика отдала заказ» это
// главный вопрос при разборе: без метки времени лог дежурного бесполезен.
function лог(строка) {
  const s = `${new Date().toISOString()} ${строка}`;
  console.log(строка);
  try { fs.appendFileSync(LOG, s + '\n'); } catch { /* лог не причина падать */ }
}

// КЛЮЧ ПРОВЕРЯЮЩЕЙ МОДЕЛИ В ОКРУЖЕНИЕ ДО ПЕРВОГО require validatepost (тот же приём и та же причина,
// что в onepost.cjs: validatepost читает ключ ОДИН раз на загрузке модуля).
function armValidationKey() {
  if (String(process.env.OPENROUTER_API_KEY || '').trim()) return 'окружение';
  for (const f of ['/tmp/orkey.txt', path.join(os.homedir(), '.openrouter_key')]) {
    try {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s) { process.env.OPENROUTER_API_KEY = s; return f; }
    } catch { /* нет файла, идём дальше */ }
  }
  return null;
}
const VKEY_FROM = armValidationKey();

// Хук в НИЖНЕЙ зоне с мягкой подложкой. Обложка подобранного поста обязана выглядеть ровно так же,
// как у поста, собранного полосой, иначе на контактном листе два вида обложек.
// ЗДЕСЬ БЫЛА КОПИЯ (до 14.08). Она честно помечалась как «один в один с onepost», но за три дня
// разъехалась: низ поправили в onepost, здесь остался bottom:96px — то есть pickup продолжал
// рождать обложки с хуком ПОД интерфейсом рилса. Теперь вёрстка одна на всех, в slidekit.
const drawHook = (src, out, text) => хукНизом(src, out, text);

const grab = (url, out) => fetchToFile(url, out, { what: 'кадр', ms: 90000, min: 20000 });

// ═══ ПОЛОСА КОНВЕЙЕРА ═══════════════════════════════════════════════════════════════════════════
// Берём ТОТ ЖЕ лок, что onepost (/tmp/genposts.lock и полосы .1 .2), чтобы подбиратель не грузил
// машину поверх живых полос: рендер кадров это ffmpeg и хром, и лишний параллельный процесс уже
// однажды положил волну. Если все полосы заняты, подбиратель молча ждёт следующего цикла: заказ
// оплачен, он никуда не убежит.
const LANES = Math.max(1, Number(process.env.OP_LANES || 1));
const lanePath = (n) => (n === 0 ? LOCK : `${LOCK}.${n}`);
let myLane = null;
async function взятьПолосу(waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    for (let n = 0; n < LANES; n++) {
      const p = lanePath(n);
      try { fs.writeFileSync(p, String(process.pid), { flag: 'wx' }); myLane = p; return true; }
      catch {
        const pid = Number(fs.readFileSync(p, 'utf8').trim() || 0);
        let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
        let stale = false; try { stale = Date.now() - fs.statSync(p).mtimeMs > 45 * 60000; } catch {}
        if (!alive || stale) { try { fs.unlinkSync(p); } catch {} n--; }
      }
    }
    if (Date.now() > until) return false;
    await sleep(15000);
  }
}
function отдатьПолосу() {
  if (!myLane) return;
  try { if (Number(fs.readFileSync(myLane, 'utf8').trim()) === process.pid) fs.unlinkSync(myLane); } catch {}
  myLane = null;
}

// Свой лок подбирателя: два подбирателя разом собрали бы ОДИН заказ дважды.
function взятьСвойЛок() {
  try { fs.writeFileSync(MYLOCK, String(process.pid), { flag: 'wx' }); return true; } catch {}
  const pid = Number((() => { try { return fs.readFileSync(MYLOCK, 'utf8').trim(); } catch { return '0'; } })());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) return false;
  try { fs.unlinkSync(MYLOCK); fs.writeFileSync(MYLOCK, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}
function отдатьСвойЛок() {
  try { if (Number(fs.readFileSync(MYLOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(MYLOCK); } catch {}
}
process.on('exit', () => { отдатьПолосу(); отдатьСвойЛок(); });
// ДЕЖУРНОГО ГЛУШАТ СИГНАЛОМ, А НЕ ВЫХОДОМ ИЗ ЦИКЛА. На SIGTERM и Ctrl+C обработчик exit сам не
// срабатывает, и локи оставались лежать: полоса конвейера числилась занятой чужим мёртвым pid,
// пока её не подберёт проверка «держатель жив». Отдаём явно.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { отдатьПолосу(); отдатьСвойЛок(); process.exit(0); });
}

// ═══ СПИСОК БЕЗНАДЁЖНЫХ ═════════════════════════════════════════════════════════════════════════
function читатьСписок() {
  try { return JSON.parse(fs.readFileSync(SKIPFILE, 'utf8')); } catch { return {}; }
}
function вСписок(id, причина) {
  const j = читатьСписок();
  j[id] = { причина, at: new Date().toISOString() };
  try { fs.writeFileSync(SKIPFILE, JSON.stringify(j, null, 1)); } catch {}
}

// ═══ ОЧЕРЕДЬ ФАБРИКИ ════════════════════════════════════════════════════════════════════════════
/** Прочитать очередь фабрики одной вкладкой и вкладку сразу закрыть (иначе вкладки текут). */
async function прочитатьОчередь() {
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  try {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    return await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo/posts');
      if (!r.ok) return { err: `HTTP ${r.status}` };
      const posts = ((await r.json()).posts || []).map((p) => ({
        id: p.id, status: p.status, urls: p.imageUrls || [], tpl: p.templateId,
        hook: p.hookText || '', caption: p.captionText || '', ref: p.customPhotoUrl || null,
        cost: p.providerCostKopecks || 0, at: p.createdAt, upd: p.updatedAt,
      }));
      const св = {};
      for (const p of posts) св[p.status] = (св[p.status] || 0) + 1;
      return { posts, св };
    });
  } finally { await done(); }
}

/** Бесхозные готовые заказы: done, кадров 2+, в базе поста нет, лежат готовыми уже давно. */
async function найтиБесхозных(c, очередь) {
  const порог = Date.now() - ORPHAN_MIN * 60000;
  const окно = Date.now() - SINCE_H * 3600e3;
  const список = читатьСписок();
  const итог = { мимо: [], бесхозные: [] };
  for (const o of очередь.posts) {
    if (o.status !== 'done' || o.urls.length < 2) continue;
    if (new Date(o.at).getTime() < окно) { итог.мимо.push([o.id, `создан раньше окна ${SINCE_H} ч`]); continue; }
    if (список[o.id]) { итог.мимо.push([o.id, `в списке безнадёжных: ${список[o.id].причина}`]); continue; }
    // ЖИВАЯ ПОЛОСА МОЖЕТ БЫТЬ ЕЩЁ В РАБОТЕ. Заказ уже done, но сборка после кадров занимает минуты
    // (наши генерации, гейт, заливка), и поста в базе пока нет. Подобрать такой заказ значит
    // собрать пост ДВАЖДЫ. Поэтому берём только те, что готовы дольше ORPHAN_MIN минут.
    if (new Date(o.upd).getTime() > порог) { итог.мимо.push([o.id, 'готов только что, полоса может ещё собирать']); continue; }
    if (!o.ref) { итог.мимо.push([o.id, 'у заказа нет customPhotoUrl: обложку взять негде']); continue; }
    if (!TPL.isKnown(o.tpl)) { итог.мимо.push([o.id, `шаблон «${o.tpl}» не описан в templates.cjs`]); continue; }
    const has = await c.query(`SELECT 1 FROM posts WHERE meta->>'factory_order' = $1 LIMIT 1`, [o.id]);
    if (has.rowCount) { итог.мимо.push([o.id, 'пост в базе уже есть']); continue; }
    итог.бесхозные.push(o);
  }
  итог.бесхозные.sort((a, b) => new Date(a.at) - new Date(b.at));
  return итог;
}

/** Номер персоны продолжаем СВОЮ нумерацию «подNN»: по метке сразу видно, что пост подобран. */
async function следующаяПерсона(c) {
  const r = await c.query(`SELECT max((regexp_replace(meta->>'persona','\\D','','g'))::int) n
    FROM posts WHERE meta->>'persona' ~ '^под[0-9]+$'`);
  return `под${String((r.rows[0].n || 0) + 1).padStart(2, '0')}`;
}

// ═══ СБОРКА ОДНОГО ПОДОБРАННОГО ЗАКАЗА ══════════════════════════════════════════════════════════
/**
 * Собрать пост из готового заказа фабрики. Шаги ровно те, что у onepost.cjs после «фабрика отдала
 * кадры»: кадр 2 из кадра фабрики, кадры 3 и 4 нашей генерацией, плёнка по вайбу кадра 1, заливка,
 * бесплатный гейт правил, платная проверка моделью только для чистых, запись в базу со всей метой.
 *
 * Возвращает { id, status, files, tag } либо кидает ошибку. Ничего у фабрики не заказывает.
 */
async function собрать(c, wd, o) {
  const TEMPLATE = o.tpl;
  const CARD_TPL = TPL.isCard(TEMPLATE);
  const PHONE_OK = TPL.phoneOk(TEMPLATE);
  const tag = `pk_${кор(o.id)}_${process.pid}`;
  const genModel = process.env.GEN_MODEL || 'nano-banana-pro';

  // 1. ИСХОДНИК. Это тот самый файл, который полоса залила фабрике перед заказом (customPhotoUrl).
  wd.stage(`скачиваю исходник заказа ${кор(o.id)}`);
  const src = await grab(o.ref, `/tmp/${tag}_src.jpg`);
  const buf = fs.readFileSync(src);
  const srcBytes = buf.length;
  const srcSha = crypto.createHash('sha256').update(buf).digest('hex');
  // Семя разведения поз это отпечаток исходника (как в onepost): байты те же, значит и позы кадров
  // 3 и 4 будут те же, что взяла бы упавшая полоса, и пересборка финала не разъедется с образом.
  const позаСемя = srcSha;

  const persona = await следующаяПерсона(c);

  // 2. ОБЛОЖКА С ХУКОМ. Хук берём из пула шаблона, но НЕ тот, что фабрика уже напечатала на своём
  // кадре (o.hook): иначе одна фраза в посте дважды. Это ровно правило onepost, только там avoid
  // шёл в другую сторону (сначала обложка, потом заказ). Свою вкладку renderHtml открывает и
  // закрывает сам, поэтому шаг стоит ДО openAdmin.
  wd.stage('рисую хук на обложке');
  const hook = factoryHook(TEMPLATE, null, { avoid: o.hook });
  const s1 = await drawHook(to45(src, `/tmp/${tag}_flat.jpg`), `/tmp/${tag}_1.jpg`, hook);

  // 3. ЭТА ОБЛОЖКА УЖЕ ГДЕ-ТО СТОИТ? Проверка БЕСПЛАТНАЯ и стоит первой из двух, потому что она же
  // прикрывает главную дыру сверки по meta.factory_order: заказ с customPhotoUrl умеют ставить не
  // только onepost, но и makepost, factorypost, salvo28 и genref, а вот id заказа в мету поста из
  // них не пишет НИ ОДИН. Их готовый заказ выглядит бесхозным, хотя пост по нему есть, и узнаётся
  // он ровно по обложке: журнал обложек сравнивает перцептивные отпечатки.
  {
    const cu = await coverUsed(s1, persona).catch(() => ({ used: false }));
    if (cu.used) {
      вСписок(o.id, `обложка уже стоит в посте ${кор(cu.postId)}`);
      const e = new Error(`обложка уже стоит обложкой в посте ${кор(cu.postId)}: пост по этому заказу есть, `
        + 'просто без id заказа в мете');
      e.безнадёжно = true;
      throw e;
    }
  }

  // 4. ОТДЕЛ КАЧЕСТВА ОБЛОЖКИ. Стоит ДО наших генераций: если обложка мутная или лицо не читается,
  // кадры 3 и 4 по ней рисовать бессмысленно, а это 0.06 за пост. Кадры фабрики уже оплачены, их
  // мы не вернём, но доплачивать за брак не станем. Файл в карантин НЕ уводим: он лежит в R2 у
  // партнёра, наша папка годных за него не отвечает.
  if (process.env.COVER_QA_OFF !== '1') {
    wd.stage('отдел качества обложки');
    const qa = await coverQA.проверить(src);
    const м = (qa.рез && qa.рез.метрики) || {};
    лог(`  гейт обложки: кадр ${м.кадр ?? '-'} лицо ${м.лицо ?? '-'} глаза ${м.глаза ?? '-'}`
      + `${qa.годится ? ' — годится' : ` — БРАК: ${qa.причины.join('; ')}`}`);
    if (!qa.годится) {
      вСписок(o.id, `обложка не прошла отдел качества: ${qa.причины.join('; ')}`);
      const e = new Error(`обложка не прошла отдел качества: ${qa.причины.join('; ')}`);
      e.безнадёжно = true;
      throw e;
    }
    if (qa.непроверено) лог(`  ⚠ вердикт модели по обложке не получен (${qa.причины.join('; ')}), пропустил числовой эшелон`);
  }

  лог(`ПОДБОР: заказ ${кор(o.id)} (${TEMPLATE}, ${(o.cost / 100).toFixed(2)} руб, готов ${o.upd}) → персона ${persona}`);

  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  try {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    // Перезаливка исходника нужна только ретраю заказа кадра: RenderGrid иногда не может скачать
    // референс, и повтор просит НОВЫЙ адрес того же файла (см. refretry.cjs).
    const uploadFile = (f) => {
      const b64f = fs.readFileSync(f).toString('base64');
      return page.evaluate(async ({ b64f, fname }) => {
        const bin = Uint8Array.from(atob(b64f), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
        const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error(j.error || `upload HTTP ${r.status}`);
        return j.url;
      }, { b64f, fname: path.basename(f) });
    };
    let refUrl = o.ref;                     // ссылка фабрики на наш исходник, уже публичная
    const myRefUrls = new Set([refUrl]);
    const genFrame = (dest, opts) => refretry.genToFile(dest, opts, {
      freshRefs: async (old) => {
        if (!old.some((u) => myRefUrls.has(u))) return old;
        const fresh = await uploadFile(src);
        myRefUrls.add(fresh);
        return old.map((u) => (myRefUrls.has(u) ? fresh : u));
      },
    });

    // 5. КАДР 2 из кадра фабрики. У карточки режем от верха: центр-кроп срезает ей заголовок.
    const art = await grab(o.urls[1] || o.urls[0], `/tmp/${tag}_art.jpg`);
    const s2 = to45smart(art, `/tmp/${tag}_2.jpg`, { topBias: TPL.frame2Kind(TEMPLATE) === 'card' });

    const srcHair = hairFamily(s1);
    const hairIdx = Array.from(persona).reduce((a, ch) => a + ch.codePointAt(0), 0) % 2;
    const hairLenIdx = pk.hairLenByHash(tag);
    const locRotor = process.env.PLACE_ROTOR
      ? Number(process.env.PLACE_ROTOR)
      : (Number(rotorRead().place) || 0) + 1;
    if (!process.env.PLACE_ROTOR) rotorWrite({ place: locRotor });
    const CITY = !/^(0|no|home|дом|домашний)$/i.test(String(process.env.PLACE_POOL || 'city'));
    const places = CITY ? pk.pickCityPlaces(locRotor) : { ...pk.pickPlaces(locRotor), bg3: 'home', bg4: 'home' };
    const { loc3, bg3, bg4 } = places;
    let loc4 = places.loc4;
    let slug4 = places.slug4 || null;
    let light4 = places.light4 || '';
    лог(`  локации (${CITY ? 'заставка+дома' : 'домашний пул'}, ротор ${locRotor}): `
      + `кадр 3 «${places.name3 || loc3}», кадр 4 «${places.name4 || loc4}»`);
    const ctaStyleWithTone = () => (locRotor % 2 === 0 ? 'search' : 'domain');

    /** Кадр 4 с одним отступным ходом по фильтру безопасности (обоснование в onepost.cjs). */
    async function genQuietFrame4() {
      const ask = () => genFrame(`/tmp/${tag}_4gen.jpg`, {
        prompt: pk.lookPrompt({ template: TEMPLATE, step: 4, srcHair, hairIdx, hairLenIdx, place: loc4,
          light: light4, bgMode: bg4, poseSeed: позаСемя }),
        refUrls: [refUrl], model: genModel, tag: `${persona} кадр 4`,
      });
      try { return await ask(); } catch (e) {
        const msg = String((e && e.message) || '');
        const safety = /safety|rejected|moderation|policy|фильтр/i.test(msg);
        const alt = safety && CITY ? pk.nextQuietPlace(slug4) : null;
        if (!alt) throw e;
        лог(`  ⚠ модель отклонила локацию «${slug4}» по фильтру безопасности (${msg.slice(0, 60)}), `
          + `беру следующую тихую: «${alt.name}»`);
        loc4 = alt.loc; slug4 = alt.slug; light4 = alt.light;
        return ask();
      }
    }

    let s3, s4, frame4art = false, frame4gen = false, frame4files = null, frame4meta = null;
    let base4file = null;
    let hairD = null, hairRetry = false;
    let faceD3 = null, faceD4 = null, faceRetry = [];

    if (CARD_TPL) {
      // КАРТОЧНЫЙ ШАБЛОН: образ и финал генерим САМИ по чистому исходнику. Порядок как в onepost:
      // кадр 3, бесплатные проверки цвета волос и лица, и только с чистой мерой платим за кадр 4.
      wd.stage('генерю кадр 3 (образ)');
      const p3 = (aim) => pk.lookPrompt({ template: TEMPLATE, step: 3, srcHair, hairIdx, hairLenIdx,
        place: loc3, light: places.light3 || '', bgMode: bg3, poseSeed: позаСемя,
        ...(aim ? { hairAim: aim } : {}) });
      let g3 = await genFrame(`/tmp/${tag}_3gen.jpg`, {
        prompt: p3(null), refUrls: [refUrl], model: genModel, tag: `${persona} кадр 3`,
      });
      s3 = to45smart(g3, `/tmp/${tag}_3.jpg`);
      hairD = hairColorDistance(hairColor(s1), hairColor(s3));
      if (hairD < gateT.hairDelta) {
        hairRetry = true;
        лог(`  ⚠ цвет волос на кадре 3 почти как на обложке (${hairD} при норме ${gateT.hairDelta}), `
          + `один ретрай с прямо названной целью: ${pk.hairTarget(srcHair, hairIdx)}`);
        wd.stage('ретрай кадра 3 с названным цветом волос');
        g3 = await genFrame(`/tmp/${tag}_3gen_r2.jpg`, {
          prompt: p3(pk.hairTarget(srcHair, hairIdx)), refUrls: [refUrl], model: genModel,
          tag: `${persona} кадр 3, вторая попытка`,
        });
        s3 = to45smart(g3, `/tmp/${tag}_3.jpg`);
        hairD = hairColorDistance(hairColor(s1), hairColor(s3));
        лог(`  → после ретрая расстояние по цвету волос ${hairD}`);
      }
      // Схожесть лица и ОДИН спасательный ретрай коротким промптом (числа и обоснование в onepost).
      {
        const chk = fk.keepsFace(s1, s3);
        faceD3 = chk.d;
        if (chk.ok === null) {
          лог(`  ⚠ схожесть лица не проверена (${chk.error}): пост пойдёт дальше, гейт скажет то же`);
        } else if (!chk.ok) {
          лог(`  ⛔ на кадре 3 ДРУГОЙ ЧЕЛОВЕК: схожесть ${chk.d} при пороге ${fk.SAME_FACE}. Один спасательный ретрай`);
          wd.stage('ретрай кадра 3 по лицу');
          const g3b = await genFrame(`/tmp/${tag}_3gen_face.jpg`, {
            prompt: pk.keepFacePrompt({ srcHair, hairIdx, place: loc3, light: places.light3 || '' }),
            refUrls: [refUrl], model: genModel, tag: `${persona} кадр 3, спасение лица`,
          });
          const s3b = to45smart(g3b, `/tmp/${tag}_3face.jpg`);
          const chk2 = fk.keepsFace(s1, s3b);
          faceRetry.push({ frame: 3, before: chk.d, after: chk2.d });
          if ((chk2.d || -1) > (chk.d || -1)) {
            s3 = s3b; faceD3 = chk2.d;
            hairD = hairColorDistance(hairColor(s1), hairColor(s3));
            лог(`  → после спасения схожесть ${chk2.d}, цвет волос ${hairD}`);
          } else {
            лог(`  → спасение не помогло (${chk2.d} против ${chk.d}), оставляю первый кадр`);
          }
        } else {
          лог(`  ✓ кадр 3 держит лицо обложки (схожесть ${chk.d} при пороге ${fk.SAME_FACE})`);
        }
      }
      let base4;
      const faceLost3 = faceD3 !== null && faceD3 < fk.SAME_FACE;
      if (hairD < gateT.hairDelta || faceLost3) {
        лог(faceLost3
          ? `  ⛔ кадр 3 так и не удержал лицо (${faceD3}): кадр 4 НЕ ЗАКАЗЫВАЮ, экономлю 0.03`
          : '  ⛔ цвет волос не сменился и после ретрая: кадр 4 НЕ ЗАКАЗЫВАЮ, экономлю 0.03');
        base4 = reframe(s3, `/tmp/${tag}_4raw.jpg`, `${persona}_4`);
      } else {
        wd.stage('генерю кадр 4 (финал)');
        const g4 = await genQuietFrame4();
        base4 = to45smart(g4, `/tmp/${tag}_4raw.jpg`);
        frame4gen = true;
        const c4 = fk.keepsFace(s1, base4);
        faceD4 = c4.d;
        if (c4.ok === false) {
          лог(`  ⛔ на кадре 4 ДРУГОЙ ЧЕЛОВЕК: схожесть ${c4.d}. Один спасательный ретрай`);
          wd.stage('ретрай кадра 4 по лицу');
          const g4b = await genFrame(`/tmp/${tag}_4gen_face.jpg`, {
            prompt: pk.keepFacePrompt({ srcHair, hairIdx, place: loc4, light: light4 }),
            refUrls: [refUrl], model: genModel, tag: `${persona} кадр 4, спасение лица`,
          });
          const b4b = to45smart(g4b, `/tmp/${tag}_4raw_face.jpg`);
          const c4b = fk.keepsFace(s1, b4b);
          faceRetry.push({ frame: 4, before: c4.d, after: c4b.d });
          if ((c4b.d || -1) > (c4.d || -1)) { base4 = b4b; faceD4 = c4b.d; }
          лог(`  → после спасения финала схожесть ${c4b.d}`);
        }
      }
      const ctaStyle = process.env.CTA_STYLE || ctaStyleWithTone();
      const four = {};
      for (const pl of TPL.frame4Platforms()) {
        const r = await ctaSlide(base4, `/tmp/${tag}_4_${pl}.jpg`,
          { seed: `${persona}_4`, platform: pl, cover: s1, ...(ctaStyle ? { style: ctaStyle } : {}) });
        four[pl] = r.out || `/tmp/${tag}_4_${pl}.jpg`;
        frame4meta = { style: r.style, tone: r.tone };
      }
      s4 = four.tiktok;
      frame4files = four;
      base4file = base4;
      frame4art = true;
    } else {
      // АРТ И ТРЕНД: кадр 2 это уже обработанное фото, цвет волос не трогаем. Кадр 3 как раньше
      // (у тренда телефон, у арта второй образ фабрики), финал догенериваем по второму кадру.
      const lookUrl = !PHONE_OK && o.urls[2] ? o.urls[2] : null;
      const lookFlat = lookUrl
        ? to45smart(await grab(lookUrl, `/tmp/${tag}_look.jpg`), `/tmp/${tag}_lookflat.jpg`)
        : s2;
      if (PHONE_OK) {
        const [sc3] = lockScenePair(tag);
        s3 = o.urls[2]
          ? to45smart(await grab(o.urls[2], `/tmp/${tag}_3src.jpg`), `/tmp/${tag}_3.jpg`)
          : to45(await lockMock(s2, `/tmp/${tag}_3mock.jpg`, { scene: sc3, seed: tag + '-3' }), `/tmp/${tag}_3.jpg`);
        лог('  → кадр 3: телефон с локскрином, без плашки (тренд с волосами)');
      } else if (lookUrl) {
        s3 = to45smart(lookFlat, `/tmp/${tag}_3.jpg`);
        лог('  → кадр 3: второй сгенерированный образ фабрики');
      } else {
        s3 = reframe(lookFlat, `/tmp/${tag}_3.jpg`, `${persona}_3`);
        лог('  → кадр 3: единственный образ с другой перекадрировкой (образ один)');
      }
      wd.stage('догенериваю финал по второму кадру');
      let base4;
      try {
        const g4 = await genFrame(`/tmp/${tag}_4gen.jpg`, {
          prompt: pk.artFinalPrompt({ template: TEMPLATE }),
          refUrls: [o.urls[1] || o.urls[0]], model: genModel, tag: `${persona} финал арта`,
        });
        base4 = to45smart(g4, `/tmp/${tag}_4raw.jpg`);
        frame4gen = true;
        лог('  → кадр 4: догенерирован по второму кадру (тот же эффект, другой ракурс)');
      } catch (e) {
        base4 = reframe(lookFlat, `/tmp/${tag}_4raw.jpg`, `${persona}_4`);
        лог(`  ⚠ финал не догенерился (${String(e.message).slice(0, 70)}), лежит кроп — пост пойдёт в брак`);
      }
      try {
        const ctaStyle = process.env.CTA_STYLE || ctaStyleWithTone();
        const four = {};
        for (const pl of TPL.frame4Platforms()) {
          const r = await ctaSlide(base4, `/tmp/${tag}_4_${pl}.jpg`,
            { seed: `${persona}_4`, platform: pl, cover: s1, ...(ctaStyle ? { style: ctaStyle } : {}) });
          four[pl] = r.out || `/tmp/${tag}_4_${pl}.jpg`;
          frame4meta = { style: r.style, tone: r.tone };
        }
        s4 = four.tiktok; frame4files = four;
        base4file = base4;
        frame4art = true;
      } catch (e) {
        s4 = base4;
        лог(`  ⚠ плашка не легла (${String(e.message).slice(0, 60)}), финал ждёт пересборки`);
      }
    }
    const files = [s1, s2, s3, s4];

    // 6. ПЛЁНКА ПО ВАЙБУ КАДРА 1: карусель обязана читаться одной камерой, а не «фото плюс рендеры».
    wd.stage('подгоняю кадры 3 и 4 под телефонный вайб обложки');
    require('./phonelook.cjs').подогнатьПоЭталону({ эталон: s1,
      кадры: [s3, s4, base4file, ...Object.values(frame4files || {})],
      места: Object.fromEntries([
        [s3, loc3],
        ...[s4, base4file, ...Object.values(frame4files || {})].filter(Boolean).map((f) => [f, loc4]),
      ]) });

    // 7. ЗАЛИВКА. Перед ней возвращаем вкладку на админ-страницу: рендер кадров идёт через
    // setContent, а он сбрасывает документ на about:blank, и относительный адрес заливки
    // перестаёт собираться в ссылку (та самая сгоревшая волна на 30 постов, разбор в onepost).
    wd.stage('заливаю кадры в хранилище');
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const up = [];
    for (const f of files) { up.push(await uploadFile(f)); await sleep(600); }
    let up4reels = null;
    if (frame4files && frame4files.reels) up4reels = await uploadFile(frame4files.reels);
    let up4raw = null;
    if (base4file && fs.existsSync(base4file)) {
      try { up4raw = await uploadFile(base4file); }
      catch (e) { лог(`  ⚠ чистый финал не залился (${String(e.message).slice(0, 60)})`); }
    }

    // 8. ПОДПИСЬ ИЗ ФАКТОВ ПОСТА (правило captions.cjs: нет факта — нет блока).
    const фактыПоста = {
      template: TEMPLATE, persona, hook_text: hook.replace(/\n/g, ' '),
      loc3, loc4, bg3, bg4, loc3_slug: places.slug3 || null, loc4_slug: slug4,
      src_hair: srcHair, hair_idx: hairIdx, hair_d: hairD,
      frame3_phone: PHONE_OK, frame4_art: frame4art, place_pool: CITY ? 'city' : 'home',
    };
    const capText = postCaption(TEMPLATE, { hook, meta: фактыПоста, seed: tag });

    // 9. ГЕЙТЫ. Бесплатный гейт правил первым, платная проверка моделью только для чистых постов.
    const gate = checkCarousel(files, { template: TEMPLATE, hook, caption: capText, frame4gen,
      phoneUsed: PHONE_OK, loc3, loc4, frame4Variants: frame4files });
    if (frame4files && frame4files.reels && !up4reels) {
      gate.ok = false;
      gate.problems.push('вариант кадра 4 для рилса не залился: в инстаграм уйдёт плашка со словом '
        + '«шаблоны» вместо «промпты»');
    }
    if (gate.ok) лог('  гейт правил: чисто');
    else for (const p of gate.problems) лог(`  ⛔ гейт: ${p}`);

    // ОТБРАКОВКА КАРТОЧКИ (card_qa) БЕСПЛАТНЫМ ЭШЕЛОНОМ. Численная проверка поля снизу умеет
    // говорить только «снизу точно не срезано» (в самой шапке card_qa так и написано: разрыва нет),
    // поэтому браковать по ней нельзя — записываем число и ярлыки локаций в мету, а платный
    // вердикт модели по всему складу всё равно снимает card_qa --backlog перед сборкой рилсов.
    // PICKUP_CARD_VISION=1 включает платный эшелон прямо здесь.
    let cardQaRes = null;
    if (CARD_TPL) {
      try {
        const num = cardQA.cardNumeric(s2);
        const locBad = [...cardQA.locTags(loc3), ...cardQA.locTags(loc4)];
        cardQaRes = { numeric: { state: num.state, why: num.why, bot: num.m && num.m.bot }, loc_tags: locBad, vision: null };
        лог(`  карточка кадра 2: ${num.state} (${num.why})${locBad.length ? `, локации в чёрном списке: ${locBad.join(', ')}` : ''}`);
        if (/^(1|true|yes)$/i.test(String(process.env.PICKUP_CARD_VISION || '')) && gate.ok) {
          const v = await cardQA.visionCard(s2, [s3, s4]);
          cardQaRes.vision = v;
          лог(`  карточка кадра 2, модель: ${v && v.verdict ? v.verdict : 'нет вердикта'}`);
        }
      } catch (e) { лог(`  ⚠ card_qa не отработал (${String(e.message).slice(0, 70)}): это не брак`); }
    }

    let verdict = 'unknown', problems = [];
    if (!gate.ok) {
      problems = ['проверка моделью не запускалась: пост уже забракован бесплатным гейтом правил'];
      лог('  проверку моделью не заказываю: пост забракован гейтом, платить за это незачем');
    } else {
      try {
        const vr = await require('./validatepost.cjs').validateCarousel(files, { template: TEMPLATE, coverRef: true });
        verdict = vr.verdict; problems = vr.problems || [];
        лог(`  проверка моделью: ${verdict}${problems.length ? ' — ' + problems[0].slice(0, 60) : ''}`);
      } catch (e) {
        problems = [`проверка моделью упала: ${String(e.message).slice(0, 90)}`];
        лог(`  ⚠ ${problems[0]}`);
      }
    }

    // 10. ЗАПИСЬ В БАЗУ. Мета один в один как у onepost, плюс метка подбора и цена заказа: по ней
    // потом видно, сколько денег подбиратель вернул в дело.
    const status = (verdict === 'reject' || !gate.ok) ? 'rejected' : 'backlog';
    // ПОСЛЕДНЯЯ СВЕРКА ПЕРЕД ВСТАВКОЙ. Сборка идёт минуты, и за это время живая полоса могла успеть
    // записать свой пост по этому же заказу: вставить второй значит сделать дубль в ленте.
    const ещёНет = await c.query(`SELECT 1 FROM posts WHERE meta->>'factory_order' = $1 LIMIT 1`, [o.id]);
    if (ещёНет.rowCount) throw new Error('пока собирал, пост по этому заказу записал кто-то другой: в базу не пишу');
    const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
      AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
    if (!acc) throw new Error('нет ни одного живого акка для привязки поста');
    const ins = await c.query(
      `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
       VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
      [acc.id, capText, up[0], 'https://neironka.pro',
       JSON.stringify({ template: TEMPLATE, persona, image_urls: up, frame4: true, refit4: true,
         frame4_art: frame4art, frame4_gen: frame4gen, frame3_phone: PHONE_OK,
         gen_model: genModel, src_hair: srcHair, hair_idx: hairIdx,
         loc3, loc4, bg3, bg4, place_pool: CITY ? 'city' : 'home',
         loc3_slug: places.slug3 || null, loc4_slug: slug4,
         hair_d: hairD, hair_retry: hairRetry,
         face_d3: faceD3, face_d4: faceD4,
         face_retry: faceRetry.length ? faceRetry : null,
         frame4_reels: up4reels, frame4_marker: TPL.FRAME4_CTA,
         frame4_raw: up4raw, frame4_cta: frame4meta,
         cover_from_owner: true, cover_hooked: true, hook_text: hook.replace(/\n/g, ' '),
         onepost: true, source_cover: o.ref, factory_order: o.id,
         source_cover_url: refUrl, source_bytes: srcBytes, source_sha256: srcSha,
         // МЕТКА ПОДБОРА: пост собран не полосой, а подбирателем из брошенного оплаченного заказа.
         // cost_kopecks это цена заказа у фабрики, то есть сумма, которая иначе была бы потеряна.
         pickup: true, pickup_at: new Date().toISOString(), factory_cost_kopecks: o.cost,
         factory_hook: o.hook || null,
         card_qa: cardQaRes,
         validation: { verdict, problems, at: new Date().toISOString() },
         gate: { ok: gate.ok, problems: gate.problems, numbers: gate.numbers, at: new Date().toISOString() } }),
       status]);
    const id = ins.rows[0].id;
    try { await registerCover(s1, persona, id); } catch {}

    // 11. ТЕЛЕГРАМ. По умолчанию МОЛЧИМ: волна остановлена, идёт залив, и карточки в группу отправляет
    // тот, кто осматривает листы. PICKUP_TG=1 разрешает, общий рубильник /tmp/NO_TG всё равно главнее.
    if (!/^(1|true|yes)$/i.test(String(process.env.PICKUP_TG || ''))) {
      лог('  → в ТГ не отправляю: подбиратель по умолчанию молчит (PICKUP_TG=1 разрешает)');
    } else if (fs.existsSync('/tmp/NO_TG')) {
      лог('  → в ТГ не отправляю: включён общий стоп отправки (/tmp/NO_TG)');
    } else if (status !== 'backlog' || !frame4art) {
      лог(`  → в ТГ не отправляю: пост ${кор(id)} не по стандарту (${status}, финал ${frame4art ? 'с плашкой' : 'без плашки'})`);
    } else {
      wd.stage('карточка в телеграм');
      try {
        execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
          '--key', String(id), '--persona', persona, '--type', `${TPL.kindRu(TEMPLATE)} · твой кадр`,
          '--note', capText], { cwd: __dirname, encoding: 'utf8', stdio: 'inherit', timeout: 4 * 60000 });
      } catch { лог('  ⚠ в ТГ не ушло'); }
    }

    // ПУТИ КАДРОВ ПЕРЕЧИСЛЯЕМ ЦЕЛИКОМ, А НЕ МАСКОЙ «[1-4]». Четвёртый кадр лежит НЕ в
    // <tag>_4.jpg: в карусель идёт вариант площадки (<tag>_4_tiktok.jpg), и по маске его не найти,
    // а искать кадры руками приходится ровно тогда, когда пост забракован и надо смотреть глазами.
    лог(`  ${status === 'rejected' ? '⛔ БРАК' : '✅ ПОДОБРАН'} пост ${кор(id)} (${status}) `
      + `· кадры ${files.join(' ')} · спасено ${(o.cost / 100).toFixed(2)} руб · ${JSON.stringify(rgen.spentSoFar())}`);
    return { id, status, files, tag, persona };
  } finally { await done(); }
}

// ═══ ОДИН ЦИКЛ ══════════════════════════════════════════════════════════════════════════════════
async function цикл(c, wd) {
  const итог = { очередь: 0, queued: 0, rendering: 0, done: 0, failed: 0, бесхозных: 0,
    собрано: 0, брак: 0, несобралось: [], спасено: 0 };
  wd.stage('читаю очередь фабрики');
  const q = await прочитатьОчередь();
  if (q.err) { лог(`⚠ очередь не прочиталась: ${q.err}`); итог.несобралось.push(['—', `очередь: ${q.err}`]); return итог; }
  итог.очередь = q.posts.length;
  итог.queued = q.св.queued || 0;
  итог.rendering = q.св.rendering || 0;
  итог.done = q.св.done || 0;
  итог.failed = (q.св.failed || 0) + (q.св.error || 0);
  лог(`очередь фабрики: всего ${итог.очередь} · queued ${итог.queued} · rendering ${итог.rendering} `
    + `· done ${итог.done} · упавших ${итог.failed}`);

  const { бесхозные, мимо } = await найтиБесхозных(c, q);
  итог.бесхозных = бесхозные.length;
  лог(`готовых бесхозных заказов: ${бесхозные.length}`
    + (мимо.length ? ` (мимо ${мимо.length}: ${[...new Set(мимо.map((m) => m[1]))].slice(0, 4).join('; ')})` : ''));
  if (!бесхозные.length) return итог;

  const работа = ЛИМИТ > 0 ? бесхозные.slice(0, ЛИМИТ) : бесхозные;
  if (СУХОЙ) {
    for (const o of работа) {
      лог(`  (сухой прогон) подобрал бы заказ ${кор(o.id)} ${o.tpl}, кадров ${o.urls.length}, `
        + `${(o.cost / 100).toFixed(2)} руб, готов ${o.upd}`);
    }
    return итог;
  }

  for (const [i, o] of работа.entries()) {
    wd.stage(`заказ ${i + 1} из ${работа.length} (${кор(o.id)})`);
    // Полоса конвейера: чтобы не грузить машину поверх живых сборок. Не дождались — не беда,
    // заказ оплачен и никуда не денется, подберём в следующем цикле.
    if (!await взятьПолосу(ДЕЖУРСТВО ? 4 * 60000 : 20 * 60000)) {
      лог(`  ⏳ конвейер занят (полос ${LANES}), заказ ${кор(o.id)} оставляю на следующий круг`);
      итог.несобралось.push([кор(o.id), 'конвейер занят живыми полосами']);
      continue;
    }
    try {
      const r = await собрать(c, wd, o);
      if (r.status === 'rejected') итог.брак++; else итог.собрано++;
      итог.спасено += o.cost;
    } catch (e) {
      const m = String((e && e.message) || e).split('\n')[0].slice(0, 160);
      лог(`  ✗ заказ ${кор(o.id)} не собрался: ${m}${e && e.безнадёжно ? ' (в список безнадёжных)' : ''}`);
      итог.несобралось.push([кор(o.id), m]);
    } finally { отдатьПолосу(); }
  }
  return итог;
}

function отчёт(и) {
  лог('ИТОГ ПОДБОРА: '
    + `заказов в очереди ${и.очередь} (queued ${и.queued}, в рендере ${и.rendering}, готовых ${и.done}, упавших ${и.failed})`
    + ` · готовых бесхозных ${и.бесхозных}`
    + ` · собрано постов ${и.собрано}${и.брак ? ` (плюс ${и.брак} записаны браком)` : ''}`
    + ` · не собралось ${и.несобралось.length}`
    + (и.собрано || и.брак ? ` · спасено ${(и.спасено / 100).toFixed(2)} руб` : ''));
  for (const [id, why] of и.несобралось) лог(`  не собралось ${id}: ${why}`);
}

(async () => {
  if (!взятьСвойЛок()) {
    лог('другой подбиратель уже работает (/tmp/pickup.lock), выхожу');
    process.exit(0);
  }
  // В дежурстве общий лимит большой, но защита «шаг не менялся» остаётся: она и ловит настоящий висяк.
  const wd = armWatchdog(ДЕЖУРСТВО
    ? { minutes: Number(process.env.WD_MINUTES || 12 * 60), stallMinutes: 30, label: 'подбиратель оплаченного (дежурство)' }
    : { minutes: Number(process.env.WD_MINUTES || 90), stallMinutes: 15, label: 'подбиратель оплаченного' });
  лог(`ПОДБИРАТЕЛЬ: ${ДЕЖУРСТВО ? `дежурство, круг раз в ${Math.round(EVERY / 1000)} с` : 'разовый прогон'}`
    + `${СУХОЙ ? ', СУХОЙ (ничего не собираю)' : ''} · брошенным считаю заказ, готовый дольше ${ORPHAN_MIN} мин`
    + ` · окно ${SINCE_H} ч · ключ проверки моделью ${VKEY_FROM ? `из ${VKEY_FROM}` : 'НЕ НАЙДЕН'}`);

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  try {
    if (!ДЕЖУРСТВО) {
      отчёт(await цикл(c, wd));
    } else {
      const свод = { собрано: 0, брак: 0, спасено: 0, кругов: 0 };
      for (;;) {
        свод.кругов++;
        лог(`── круг ${свод.кругов} ──`);
        const и = await цикл(c, wd);
        отчёт(и);
        свод.собрано += и.собрано; свод.брак += и.брак; свод.спасено += и.спасено;
        лог(`сводка дежурства: кругов ${свод.кругов}, собрано ${свод.собрано}, браком ${свод.брак}, `
          + `спасено ${(свод.спасено / 100).toFixed(2)} руб. Жду ${Math.round(EVERY / 1000)} с`);
        wd.poke(`жду следующий круг (собрано за дежурство ${свод.собрано})`);
        await sleep(EVERY);
      }
    }
  } finally { await c.end().catch(() => {}); отдатьПолосу(); отдатьСвойЛок(); }
  wd.done(0);
})().catch((e) => {
  отдатьПолосу(); отдатьСвойЛок();
  лог(`ОШИБКА подбирателя: ${String((e && e.message) || e).slice(0, 200)}`);
  setTimeout(() => process.exit(1), 60);
});
