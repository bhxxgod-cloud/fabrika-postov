// ВАЛИДАЦИЯ ФОТОПОСТА ПЕРЕД ПУБЛИКАЦИЕЙ.
//
// Зачем: фабрика иногда отдаёт брак, и мы это увидели только ПОСЛЕ выхода постов (03.08).
// Три типа брака, все три ловятся глазами, но не ловятся кодом:
//   1. ПОДМЕНА ЛИЦА — на фото «после» другая девушка. Смертельно: аккаунт ведёт одна модель,
//      чужое лицо в карусели рушит легенду и палит сетку.
//   2. БИТЫЙ ТЕКСТ на плашке — «ОФАЛ» вместо «ОВАЛ», «sleek jow l», «we f cut». Читается как
//      машинный мусор, доверия к посту ноль.
//   3. АРТЕФАКТЫ — размытые/дублированные лица, обрезанные надписи, каша вместо цифр.
//
// Как проверяем: показываем карусель vision-модели и требуем СТРУКТУРНЫЙ вердикт. Модель не
// «оценивает красоту», а отвечает на конкретные вопросы, где ошибка видна.
//
// ПРИНЦИП СТРОГОСТИ: сомнение = брак. Пропустить брак дороже, чем перегенерить пост за 12 ₽.
// Поэтому при неуверенности модели и при любой ошибке разбора вердикт «не публиковать».
// ИСКЛЮЧЕНИЕ: если проверка вообще не смогла отработать (нет ключа, сеть легла, кончилась оплата,
// сервис отдал пустой ответ) — это НЕ брак, это «не проверено»: возвращаем ok:false + reason
// (см. блок про признак сбоя ниже), и вызывающий обязан дать нейтральный исход с пометкой.
// 07.08 именно на этом встала публикация: HTTP 402 от vision был прочитан как брак картинок.
//
// Запуск: node validatepost.cjs <файл|url> [ещё файлы…]
//         node validatepost.cjs --post <uuid поста из БД>
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// КЛЮЧ ПРОВЕРЯЮЩЕЙ МОДЕЛИ. Порядок: окружение, потом файлы. Домашний файл ~/.openrouter_key добавлен
// 09.08: ключ живёт там под chmod 600, а в окружении дочерних процессов волны его не было, и каждый
// пост в волне получал вердикт unknown с причиной «нет ключа». Ключ в коде не держим никогда.
const KEY = process.env.OPENROUTER_API_KEY
  || (() => {
    for (const f of [path.join(require('node:os').homedir(), '.openrouter_key'), '/tmp/orkey.txt']) {
      try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch { /* нет файла, идём дальше */ }
    }
    return '';
  })();
const MODEL = process.env.VALIDATE_MODEL || 'anthropic/claude-sonnet-4.5';

// ЯВНЫЙ ПРИЗНАК «ПРОВЕРКА НЕ СОСТОЯЛАСЬ» (07.08, разбор инцидента).
// Что случилось: платный vision ответил HTTP 402 «нужна оплата». Функция честно вернула
// verdict='unknown', но публикатор прочитал это как брак картинок и отправил ДЕВЯТЬ годных
// постов подряд в rejected. Публикация встала полностью, снаружи это выглядело как «ничего
// не произошло».
// Почему сломалось: единственным признаком сбоя был ТЕКСТ внутри problems, и вызывающие
// разбирали его регулярками. Регулярка ловила «HTTP 402», но молча пропускала, например,
// «нет OPENROUTER_API_KEY» и «меньше двух картинок», и такие посты тоже уходили в брак.
// Теперь у результата есть явные поля, регулярки не нужны:
//   ok:true                     проверяющий реально ответил, вердикт его: 'ok' либо 'reject';
//   ok:false + reason:'infra'   сервис недоступен, нет оплаты, таймаут, пустой ответ, нет ключа;
//   ok:false + reason:'input'   нам нечего проверять (мало картинок, нет файла).
// Правило по коду: «не смог проверить» НЕ РАВНО «плохо». При ok:false вызывающий обязан дать
// нейтральный исход и пометку, отрицательный вердикт о контенте ставит только сама модель.
function failed(reason, kind, problems) {
  return { verdict: 'unknown', ok: false, reason, kind, problems };
}
const infra = (kind, ...problems) => failed('infra', kind, problems);
const badInput = (kind, ...problems) => failed('input', kind, problems);

/**
 * Проверка не состоялась, судить по ней контент нельзя.
 * Вызывающим: пользуйтесь этим, а НЕ разбором текста problems.
 * Условие verdict==='unknown' оставлено для старых мест, которые сами собирают заглушку
 * { verdict:'unknown' } в своих catch.
 */
function checkFailed(vr) { return !vr || vr.ok === false || vr.verdict === 'unknown'; }
/** Сбой именно инфраструктуры (сервис, сеть, оплата), а не входных данных. */
function isInfra(vr) { return !!vr && vr.ok === false && vr.reason === 'infra'; }

const SYSTEM = `Ты технический контролёр фотопостов для Instagram-аккаунта одной девушки-модели.
Карусель — 4 кадра, легитимные структуры (все три — норма, не брак):
А) обычный пост: 1 домашнее фото с текстом-хуком · 2 инфографика-разбор ИЛИ сразу результат ·
   3 результат обработки · 4 другой снимок результата с плашкой-призывом внизу;
Б) тренд «волосы сердечками»: 1 домашнее фото с хуком · 2 чёрно-белый арт (девушка лежит, из
   волос выложены сердца) · 3 телефон, на экране блокировки ТОТ ЖЕ арт (это замысел, НЕ дубль) ·
   4 второй ч/б арт с плашкой-призывом;
В) фабричная сборка: как А, но кадр 4 может быть телефоном с артом и плашкой.

КЛЮЧЕВОЕ ПРО ФОРМАТ: это посты «до/после». Между «до» (кадр 1) и «после» (результаты) девушке
ПО ЗАМЫСЛУ КАРДИНАЛЬНО меняют цвет и укладку волос, макияж, свет и одежду. Смена цвета волос,
длины укладки, макияжа — НИКОГДА не брак сама по себе.

Твоя работа: найти БРАК. Отвечай ТОЛЬКО JSON, без пояснений вокруг.

Проверь по пунктам:
1. same_person: на ВСЕХ кадрах, где видно лицо (включая арты и экраны телефонов), ОДНА И ТА ЖЕ
   девушка? Сравнивай ТОЛЬКО черты: разрез и посадку глаз, брови, форму носа, губ, овал лица.
   Цвет и длина волос, макияж, свет, ретушь, одежда и фон ДОЛЖНЫ отличаться — это формат.
   Другой человек по чертам (в том числе на экране телефона внутри кадра) = false.
2. text_ok: весь текст на картинках — осмысленные слова на русском/английском? Ищи именно
   исковерканные слова: пропущенные или переставленные буквы («ОФАЛ» вместо «ОВАЛ»), обрывки
   («sleek jow l», «we f cut»), нечитаемую кашу. Если такое есть — false.
3. artifacts_ok: нет грубых дефектов? Смотри ОСОБЕННО внимательно на такое:
   • ПРОЗРАЧНЫЙ СЛОЙ-ПРИЗРАК: поверх картинки просвечивает чужое лицо, волосы, лоб или глаза —
     как двойная экспозиция. Это ВСЕГДА брак, даже если сама картинка аккуратная.
     Он бывает еле заметным: дымчатое пятно или полупрозрачные пряди волос поверх ровного фона,
     приглушённый или размытый заголовок, мутная область без причины посреди чистой инфографики.
     ОСОБО ПРОВЕРЬ ВЕРХНЮЮ ТРЕТЬ картинки и зоны вокруг крупных заголовков.
   • ЗАГОЛОВОК ПЕРЕКРЫТ или разорван («ТЕ БЕ ИДЁ» вместо «ТЕБЕ ИДЁТ»).
   • Подпись есть, а значение под ней пустое («ТВОЯ ДЛИНА» без ответа).
   • Дубли лица, лишние конечности, нечитаемое размытие, элементы внахлёст.
4. numbers_ok: если есть цифры/шкалы — они непротиворечивы? Если цифр нет, ставь true.
5. frames_distinct: среди кадров НЕТ двух практически одинаковых снимков? Два кадра с одной
   позой, ракурсом и фоном, различающиеся только мелочью или подписью = false. НЕ дубль:
   инфографика, телефон с артом на экране (арт совпадает с другим кадром по замыслу), плашка
   призыва поверх другого снимка.
6. no_collage: ни один кадр НЕ является коллажом? Рамки, разделительные линии, сетка из
   нескольких фото внутри ОДНОГО кадра = false. НЕ коллаж: инфографика со вставкой лица,
   телефон с картинкой на экране.
7. text_placement_ok: текст-хук на первом кадре лежит В НИЖНЕЙ ЧАСТИ кадра и НЕ перекрывает
   лицо? Если строки заходят на подбородок, рот, нос или глаза, либо висят в середине кадра
   поверх лица — false. Текст поверх одежды, торса или фона внизу — норма, это true.

Формат ответа строго:
{"same_person":bool,"text_ok":bool,"artifacts_ok":bool,"numbers_ok":bool,"frames_distinct":bool,"no_collage":bool,"text_placement_ok":bool,"confidence":0..1,"problems":["коротко по-русски"]}

Если сомневаешься по пунктам 2-6 — ставь false и опиши сомнение в problems. По пункту 1
(same_person) наоборот: false только при УВЕРЕННОСТИ, что черты лица другого человека; сомнение
из-за смены волос, света или ретуши = true (это формат «до/после»).

ВАЖНО, что браком НЕ является:
• Слова «ИИшка», «ИИшку», «нейронка», «глоуап», «тутор», «вайб» — живой сленг аудитории.
• Разговорный стиль, отсутствие заглавных букв и точек.
• Кардинальная смена цвета волос, укладки, макияжа, света, одежды, фона между кадрами.
• Чёрно-белые арт-кадры в тренде сердечек и телефон с этим артом на экране.`;

async function toDataUrl(src) {
  if (/^https?:/i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`не скачалось: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  if (!fs.existsSync(src)) throw new Error(`нет файла: ${src}`);
  const ext = path.extname(src).toLowerCase() === '.png' ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${fs.readFileSync(src).toString('base64')}`;
}

/**
 * Проверяет карусель.
 * Возвращает {verdict:'ok'|'reject'|'unknown', ok:bool, reason:null|'infra'|'input', kind, problems:[], raw}.
 * ok:true  — модель ответила, вердикт её, ему можно верить.
 * ok:false — проверка не состоялась (verdict всегда 'unknown'). Это НЕ «годится» и НЕ «брак»:
 *            вызывающий даёт нейтральный исход и пометку. Различать через checkFailed(), НЕ регуляркой.
 */
// СВОИХ ТРЁХ СПИСКОВ ШАБЛОНОВ ЗДЕСЬ БОЛЬШЕ НЕТ (09.08). Они жили только в этом файле, поэтому
// новый шаблон приходилось описывать и здесь, и в сборщиках, и рано или поздно где-то забывали.
// Все три признака теперь поля контракта templates.cjs:
//   stylized    — шаблон ПО ЗАМЫСЛУ перерисовывает человека в персонажа (фея, аниме, силуэт с
//                 лесом внутри): «другое лицо» тут не брак, браком остаётся потеря узнаваемости.
//                 04.08: без этой оговорки 4 заказа улетели в ложный брак по 12-30 ₽;
//   multiPerson — второй человек в кадре часть замысла («парень по типажу»), иначе валидатор
//                 честно ругался «на последнем фото другой человек» (03.08, два поста подряд);
//   studioLook  — модель показывают в студии, а исходник это уличное селфи: сравниваем «та же
//                 девушка», а не «то же лицо» (03.08: «Твой лучший размер» забракован у трёх
//                 моделей из четырёх, все три при просмотре оказались чистыми).
// Для ЕЩЁ НЕ ОПИСАННОГО шаблона контракт сам угадывает эти признаки по названию, поэтому
// поведение валидатора на новых шаблонах сайта не изменилось.
const TPL = require('./templates.cjs');

// ЗАПРОС ЧЕРЕЗ ОБЩИЙ КЭШ (14.08). Один и тот же вопрос оплачивается ровно один раз: ключ
// собирается из модели, промпта и СОДЕРЖИМОГО картинок. Разбор — в llmcache.cjs.
// Сбои не кэшируются: «не ответила» это не вердикт.
async function validateCarouselЗапрос(sources, opts = {}) {
  if (!sources || sources.length < 2) return badInput('too_few', 'меньше двух картинок — сравнивать нечего');

  // ПЕРВЫЙ ЭШЕЛОН: ЛОКАЛЬНАЯ ПРОВЕРКА, СТОИТ НОЛЬ (07.08).
  // Урок инцидента: весь гейт качества висел на платном vision, и когда на балансе OpenRouter
  // кончились деньги (HTTP 402), проверка перестала работать ЦЕЛИКОМ. Теперь дефекты, которые
  // видны арифметикой по пикселям — не 4 кадра, не тот размер, дубль кадра, чёрный или пустой
  // кадр, пропавшая надпись — ловятся локально, без сети и без денег (localcheck.cjs).
  // Эшелон работает В ОДНУ СТОРОНУ: он может ЗАБРАКОВАТЬ, но «годится» вместо vision не выдаёт,
  // потому что подмену лица и битые буквы по пикселям не увидеть. Заодно экономит деньги: на
  // явно битой карусели платный запрос уже не делается.
  // Видео пропускаем: там кадры вынуты из ролика, у них другой размер и надписей на них нет.
  let local = null;
  if (process.env.LOCAL_CHECK_OFF !== '1' && !opts.video) {
    try {
      const LC = require('./localcheck.cjs');
      local = await LC.localCheck(sources, {
        expect: opts.expect !== undefined ? opts.expect
          : (process.env.LC_EXPECT ? Number(process.env.LC_EXPECT) || null : 4),
      });
      if (local.verdict === 'reject') {
        // Это НАСТОЯЩИЙ вердикт о контенте (ok:true): проверка состоялась и нашла дефект.
        return { verdict: 'reject', ok: true, reason: null, by: 'local', local, problems: local.problems.slice(0, 6) };
      }
    } catch (e) {
      local = { verdict: 'unknown', problems: [`локальная проверка сломалась: ${String(e.message).slice(0, 80)}`] };
    }
  }
  // Локальный результат прикладываем ко ЛЮБОМУ исходу: по нему видно, что бесплатный эшелон
  // отработал, даже когда платный лёг.
  const withLocal = (r) => (local ? { ...r, local } : r);

  if (!KEY) return withLocal(infra('no_key', 'нет OPENROUTER_API_KEY — проверка не выполнена'));

  let images;
  try { images = await Promise.all(sources.map(toDataUrl)); }
  catch (e) { return withLocal(infra('fetch_images', `картинки не загрузились: ${e.message}`)); }

  // УВЕЛИЧЕНИЕ ВЕРХНЕЙ ТРЕТИ. Слабый призрачный слой (дымка волос поверх заголовка) на полной
  // картинке съедается ресайзом до размера, который видит модель, и она отвечает «артефактов нет».
  // Тот же фрагмент крупно — дефект становится очевиден. Кропаем середину картинки-плашки:
  // именно там лежит слой, и именно этот случай мы пропустили у Дарьи 03.08.
  const zooms = [];
  try {
    const bin = require('ffmpeg-static');
    const { execFileSync } = require('node:child_process');
    for (const [i, src] of sources.entries()) {
      if (i === 0 || i === sources.length - 1) continue;      // крайние — это фото девушки, там слоя не бывает
      const local = /^https?:/i.test(src) ? `/tmp/vz_${i}_${Date.now()}.jpg` : src;
      if (local !== src) {
        const rr = await fetch(src, { signal: AbortSignal.timeout(60000) });
        fs.writeFileSync(local, Buffer.from(await rr.arrayBuffer()));
      }
      const out = `/tmp/vz_top_${i}_${Date.now()}.jpg`;
      execFileSync(bin, ['-y', '-i', local, '-vf', 'crop=iw:ih/3:0:0,scale=1400:-2', '-q:v', '2', out], { stdio: 'ignore' });
      if (fs.existsSync(out) && fs.statSync(out).size) zooms.push(out);
      // НИЖНЯЯ треть тоже: битый английский на инфографике Дарьи #46 («Handilist of Pregection»)
      // сидел внизу слева, а лупа смотрела только верх — и пропустила.
      const outB = `/tmp/vz_bot_${i}_${Date.now()}.jpg`;
      execFileSync(bin, ['-y', '-i', local, '-vf', 'crop=iw:ih/3:0:2*ih/3,scale=1400:-2', '-q:v', '2', outB], { stdio: 'ignore' });
      if (fs.existsSync(outB) && fs.statSync(outB).size) zooms.push(outB);
    }
  } catch { /* увеличение не вышло — проверяем по полным картинкам */ }

  // РЕЖИМ «ОБЛОЖКА ИЗ ЖИВОГО ФОТО» (06.08). Кадр 1 это реальный снимок владельца, а арты рисует
  // движок: лицо на стилизованном ч/б всегда чуть другое, и строгая сверка бракует ГОДНЫЕ примеры
  // (Анжела, первый же пост). Здесь расхождение лица это замечание, а не брак; остальные проверки
  // (битый текст, артефакты, дубли кадров, коллаж, текст на лице) работают в полную силу.
  const coverRef = opts.coverRef === true || process.env.COVER_REF === '1';
  const multi = TPL.isMultiPerson(opts.template);
  const studio = TPL.isStudioLook(opts.template);
  const stylized = TPL.isStylized(opts.template);
  const studioHint = studio
    ? `\nЭТОТ ШАБЛОН СТУДИЙНЫЙ («${opts.template}»): исходник — обычное селфи на улице или дома,
а на плашке та же девушка снята в студии, с другим светом, ракурсом и ретушью. Из-за этого лицо
выглядит иначе — это НОРМА, а не подмена. По пункту same_person отвечай на вопрос: это одна и та же
девушка (тип внешности, цвет и длина волос, общий образ)? Мелкие расхождения черт из-за студийной
обработки браком НЕ считай.`
    : '';
  const hint = multi
    ? `\nЭТОТ ШАБЛОН ПРО ДВОИХ («${opts.template}»): девушке подбирают парня по типажу, поэтому на
последних кадрах РЯДОМ С НЕЙ появляется мужчина или пара — это ЗАМЫСЕЛ, а не подмена.
По пункту same_person отвечай только про ДЕВУШКУ: она на всех кадрах одна и та же? Появление
второго человека само по себе НЕ брак.`
    : stylized
    ? `\nЭТОТ ШАБЛОН СТИЛИЗОВАННЫЙ («${opts.template}»): последнее фото — намеренно нарисованный персонаж
(фея/аниме/3D и т.п.). Это НЕ подмена человека. По пункту same_person отвечай на вопрос:
УЗНАЁТСЯ ли в персонаже та же девушка (цвет и длина волос, форма лица, общий типаж)?
Узнаётся — true. Нарисован кто-то совсем посторонний — false.`
    : '';
  const content = [{ type: 'text', text: `Проверь карусель из ${images.length} фото по порядку.${hint}${studioHint}` }];
  images.forEach((url) => content.push({ type: 'image_url', image_url: { url } }));
  if (zooms.length) {
    content.push({ type: 'text', text: 'ДОПОЛНИТЕЛЬНО: увеличенная ВЕРХНЯЯ ТРЕТЬ плашек. Здесь хорошо '
      + 'видно призрачный слой — дымку волос или кожи поверх фона и заголовков. Нашёл дымку или '
      + 'полупрозрачные пряди — artifacts_ok=false. Чистый ровный фон — всё в порядке.' });
    for (const z of zooms) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(z).toString('base64')}` } });
    }
  }

  let txt = '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'neironka-poster' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 700, temperature: 0,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    // 402 «нужна оплата», 429 «лимит», 5xx — это про НАШ доступ к сервису, а не про картинки.
    // Тело ответа тащим в problems: 07.08 причину сбоя пришлось выяснять руками, потому что в
    // логе стоял голый код без объяснения.
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return withLocal(infra(`http_${r.status}`, `vision HTTP ${r.status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`));
    }
    const j = await r.json();
    // openrouter умеет отдать 200 с ошибкой внутри тела (кончились деньги, модель недоступна).
    // Без этой ветки такой ответ доезжал до разбора JSON и превращался в «вердикт не разобран»,
    // то есть в БРАК. Это ровно тот же ложный вердикт, из-за которого встала публикация.
    if (j && j.error) {
      return withLocal(infra('body_error', `vision вернул ошибку: ${String(j.error.message || j.error).slice(0, 120)}`));
    }
    txt = j.choices?.[0]?.message?.content || '';
  } catch (e) { return withLocal(infra('no_answer', `vision не ответил: ${String(e.message).slice(0, 80)}`)); }

  // ПУСТОЙ ОТВЕТ ЭТО СБОЙ, А НЕ БРАК. Раньше пустая строка не находила JSON и падала в ветку
  // «вердикт не разобран — считаем браком»: сервис молчал, а виноватыми оказывались картинки.
  if (!txt.trim()) return withLocal(infra('empty_answer', 'vision вернул пустой ответ'));

  // Разбор: модель могла обернуть JSON в ```json … ``` или добавить текст вокруг.
  // Здесь модель РЕАЛЬНО ответила, просто не по форме — вот это остаётся браком по принципу
  // строгости (сомнение = брак), и право на такой вердикт у неё есть.
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return withLocal({ verdict: 'reject', ok: true, reason: null, problems: ['вердикт не разобран — считаем браком'], raw: txt.slice(0, 200) });
  let v;
  try { v = JSON.parse(m[0]); } catch { return withLocal({ verdict: 'reject', ok: true, reason: null, problems: ['вердикт не разобран — считаем браком'], raw: txt.slice(0, 200) }); }

  const problems = Array.isArray(v.problems) ? v.problems : [];
  const fails = [];
  if (v.same_person === false) {
    if (coverRef) problems.unshift('замечание: лицо на арте отличается от обложки (живое фото + стилизация)');
    else fails.push('ЛИЦО НЕ СОВПАДАЕТ (на «после» другой человек)');
  }
  if (v.text_ok === false) fails.push('битый текст на плашке');
  if (v.artifacts_ok === false) fails.push('артефакты изображения');
  if (v.numbers_ok === false) fails.push('противоречивые цифры');
  // ФИНАЛ ИЗ АРТА ЭТО НЕ ДУБЛЬ (07.08, стандарт начальника: «меняй 2 фото под 4 кадр»).
  // Кадр 4 у нас СОЗНАТЕЛЬНО делается из кадра 2: другой зум, поворот, центр, плюс фирменный
  // блок. Валидатор видел два похожих снимка и рубил пост в брак (девочки 36, 37, 40, 43).
  // Поэтому при frame4Art сходство кадров 2 и 4 считаем нормой и оставляем только замечание,
  // а настоящие дубли (одинаковые кадры 1 и 2, или 3 и 4) по-прежнему брак.
  const frame4Art = opts.frame4Art === true || process.env.FRAME4_ART === '1';
  if (v.frames_distinct === false) {
    const only24 = /кадры?\s*2\s*и\s*4|2\s*и\s*4\s*практически/i.test((v.problems || []).join(' '));
    if (frame4Art && only24) problems.unshift('замечание: кадр 4 это кадр 2 в другом кадрировании — так и задумано');
    else fails.push('ДУБЛИ КАДРОВ (два слайда — один и тот же снимок)');
  }
  if (v.no_collage === false) fails.push('КОЛЛАЖ внутри кадра');
  if (v.text_placement_ok === false) fails.push('ТЕКСТ НА ЛИЦЕ (хук съехал с нижней зоны)');
  // Низкая уверенность = не пропускаем: цена ошибки выше цены перегенерации.
  if (typeof v.confidence === 'number' && v.confidence < 0.6) fails.push(`низкая уверенность (${v.confidence})`);

  return withLocal({
    verdict: fails.length ? 'reject' : 'ok',
    ok: true, reason: null,   // модель ответила по форме: вердикт ниже её, ему можно верить
    problems: [...fails, ...problems].slice(0, 6),
    confidence: v.confidence ?? null,
    checks: { same_person: v.same_person, text_ok: v.text_ok, artifacts_ok: v.artifacts_ok,
      numbers_ok: v.numbers_ok, frames_distinct: v.frames_distinct, no_collage: v.no_collage,
      text_placement_ok: v.text_placement_ok },
  });
}

/**
 * Проверка ВИДЕО. Раньше валидировались только карусели, и ролики уходили в ленту вообще без
 * присмотра — а брак у них свой: чёрный или пустой первый кадр (в ленте это выглядит как
 * сломанный пост), обрезанные субтитры, каша вместо изображения.
 * Берём три кадра — начало, середину и конец — и смотрим их тем же валидатором.
 */
async function validateVideo(file, opts = {}) {
  if (!fs.existsSync(file)) return badInput('no_file', 'файла нет');
  let frames = [];
  try {
    const bin = require('ffmpeg-static');
    const { execFileSync } = require('node:child_process');
    const dir = `/tmp/vfr_${Date.now()}`;
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, at] of ['0.5', '50%', '90%'].entries()) {
      // Проценты считаем от длительности: у роликов она разная.
      let ss = at;
      if (at.endsWith('%')) {
        let dur = 0;
        try { execFileSync(bin, ['-i', file], { stdio: 'pipe' }); }
        catch (e) {
          const m = String(e.stderr).match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
          if (m) dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        }
        ss = String(Math.max(0.5, dur * (parseFloat(at) / 100)));
      }
      const out = `${dir}/${i + 1}.jpg`;
      try { execFileSync(bin, ['-y', '-ss', ss, '-i', file, '-frames:v', '1', '-q:v', '3', out], { stdio: 'ignore' }); } catch {}
      if (fs.existsSync(out) && fs.statSync(out).size > 5000) frames.push(out);
    }
  } catch { /* не смогли достать кадры — решает вызывающий */ }
  // Кадры не извлеклись — это наш ffmpeg, а не качество ролика. Нейтральный исход, не брак.
  if (frames.length < 2) return infra('no_frames', 'не удалось достать кадры из видео');
  return validateCarousel(frames, { ...opts, video: true });
}

module.exports = { validateCarousel, validateVideo, checkFailed, isInfra };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let sources = args.filter((a) => !a.startsWith('--'));
    let postId = null;
    // Опции проверки: для поста из базы собираются из его meta, для файлов с командной строки
    // шаблон можно передать переменной TEMPLATE (иначе правила шаблона не применятся).
    let cliOpts = process.env.TEMPLATE ? { template: process.env.TEMPLATE } : {};

    if (args.includes('--post')) {
      postId = args[args.indexOf('--post') + 1];
      const { Client } = require('pg');
      const db = new Client({
        connectionString: process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
        ssl: { rejectUnauthorized: false },
      });
      await db.connect();
      const r = await db.query(`SELECT meta->'image_urls' u, meta->>'persona' p, meta->>'template' t,
             coalesce(meta->>'cover_from_owner','') = 'true' cover_ref,
             coalesce(meta->>'frame4_art','') = 'true' frame4_art
        FROM posts WHERE id=$1`, [postId]);
      await db.end();
      if (!r.rows[0]?.u) { console.log('ИТОГ: у поста нет image_urls'); process.exit(1); }
      sources = r.rows[0].u;
      // ШАБЛОН ИЗ БАЗЫ НАДО ЕЩЁ И ПЕРЕДАТЬ (09.08). Он читался из meta, печатался в шапку и на этом
      // терялся: validateCarousel звался БЕЗ опций, то есть opts.template был undefined. Контракт
      // получал пустую строку, честно кричал «ШАБЛОН НЕ ОПИСАН» и уходил в безопасный режим, а
      // значит правила конкретного шаблона (студийность, двое в кадре, стилизация) к проверке не
      // применялись вовсе. Снаружи это выглядело как «валидатор не знает наших шаблонов».
      cliOpts = {
        template: r.rows[0].t || '',
        persona: r.rows[0].p || '',
        coverRef: r.rows[0].cover_ref,
        frame4Art: r.rows[0].frame4_art,
      };
      console.log(`ПРОВЕРКА: ${r.rows[0].p} · ${r.rows[0].t} (${sources.length} фото)`);
    }

    const res = await validateCarousel(sources, cliOpts);
    const icon = res.verdict === 'ok' ? '✅' : res.verdict === 'reject' ? '⛔' : '❓';
    console.log(`${icon} ВЕРДИКТ: ${res.verdict}${res.confidence != null ? ` (уверенность ${res.confidence})` : ''}`);
    if (checkFailed(res)) console.log(`   ПРОВЕРКА НЕ СОСТОЯЛАСЬ (${res.reason || 'unknown'}/${res.kind || '?'}) — это НЕ брак картинок`);
    if (res.checks) console.log(`   лицо:${res.checks.same_person} текст:${res.checks.text_ok} артефакты:${res.checks.artifacts_ok} цифры:${res.checks.numbers_ok}`);
    if (res.problems?.length) res.problems.forEach((p) => console.log(`   • ${p}`));
    // Код возврата тоже различает случаи: 0 годится, 1 брак от модели, 2 проверка не состоялась.
    // Раньше и брак, и сбой давали 1, и любая обёртка читала сбой как брак — тот же инцидент 07.08.
    process.exit(res.verdict === 'ok' ? 0 : checkFailed(res) ? 2 : 1);
  })();
}

const { спросить: _спросить } = require('./llmcache.cjs');
async function validateCarousel(...дов) {
  const карт = (() => { try { return дов[0]; } catch { return []; } })();
  return _спросить({
    ключ: {
      model: MODEL,
      // В КЛЮЧ ВХОДЯТ И НАСТРОЙКИ ЗАПРОСА (14.08, поймано аудитом). Второй довод меняет ПРОМПТ:
      // у validateCarousel это {template, coverRef, frame4Art}, у card_qa — gridWarn. Пока их в
      // ключе не было, один и тот же набор картинок отдавал вердикт, посчитанный под ЧУЖИЕ флаги:
      // сборщик спрашивал с coverRef, а публикатор получал его ответ без своих. Ложный отказ так
      // залипал навсегда.
      prompt: 'validateCarousel|' + (() => { try { return JSON.stringify(дов.slice(1)); } catch { return ''; } })(),
      images: Array.isArray(карт) ? карт : [карт],
    },
    запрос: () => validateCarouselЗапрос(...дов),
    годен: (о) => o_годен(о),
    чей: 'validatepost',
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
