// ОТБРАКОВКА КАРТОЧКИ (КАДР 2) И ЛОКАЦИЙ (КАДРЫ 3 И 4). ГЕЙТ ПЕРЕД СБОРКОЙ РИЛСОВ.
//
// ЗАЧЕМ (отдел качества, 10.08, 30 постов отсмотрено глазами):
//   · карточка кадра 2 обрезана снизу или со сломанной вёрсткой: 47 процентов постов;
//   · мусорный текст в карточке (опечатки, дубли пунктов, абракадабра): 40 процентов;
//   · хотя бы один брак карточки: 67 процентов;
//   · локация кадров 3 и 4 из чёрного списка (метро, транспорт, ванная, салон) либо шаблонная
//     Москва-Сити: 77 процентов.
// Кадр 2 читают глазами как ДОКУМЕНТ, именно он выдаёт брак. Поэтому гейт стоит до сборки рилсов:
// в утренний залив пост с битой карточкой попасть не должен.
//
// ДВА ЭШЕЛОНА, как в localcheck.cjs.
//  1. ЧИСЛЕННЫЙ, бесплатный: поле снизу у документа. Карточка это документ с ровным фоном, у него
//     есть поля сверху, по бокам и снизу. Считаем «чернила» относительно тона фона и меряем, на
//     сколько строк от нижнего края документ не доходит до края кадра. Порог взят ЗАМЕРОМ на 30
//     постах отдела качества, а не из головы (см. блок про калибровку ниже).
//  2. МОДЕЛЬ ЗРЕНИЯ через OpenRouter (ключ из окружения либо ~/.openrouter_key, либо /tmp/orkey.txt,
//     как в validatepost.cjs, ключ в код и в лог не попадает). Она решает то, что арифметикой не
//     решается: читается ли текст, срезан ли нижний блок, есть ли опечатки и бессмысленные слова,
//     цела ли вёрстка и НЕТ ЛИ ГРАФИЧЕСКОГО МУСОРА (наезд блоков, размазанные и продублированные
//     миниатюры, пустые ячейки). Заодно тем же запросом называет локации кадров 3 и 4, чтобы не
//     платить второй раз за отдельную проверку локаций.
//
// ПРИНЦИП: «не смог проверить» это НЕ «брак». Нет ключа, HTTP 402, таймаут это ok:false и
// verdict 'unknown', пост в брак по такому исходу не уходит (урок 07.08, когда девять годных
// постов улетели в rejected из-за пустого баланса).
//
// ЗАПУСК:
//   node card_qa.cjs --post <uuid>            одна карточка, подробно
//   node card_qa.cjs --ids a,b,c [--json]     несколько постов
//   node card_qa.cjs --backlog [--write]      весь склад; --write кэширует вердикт в meta.qa
//   node card_qa.cjs --grid-scan              бесплатный замер сетки по складу, только диагностика
//   node card_qa.cjs --recheck-cover [--write] дописать вердикт обложки в готовый кэш, без оплаты
//   node card_qa.cjs --file <путь.jpg> [--no-vision]   одна картинка с диска
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const W = 1080, H = 1350;                        // формат карусели из STANDARD-POSTS.md

// ═══ ЧИСЛЕННЫЙ ЭШЕЛОН ═══════════════════════════════════════════════════════════════════════════
//
// ЗАМЕР. Метрика: тон фона это мода яркости по кадру (у карточки фон занимает больше всего
// площади). «Чернила» в строке это доля пикселей, отличающихся от фона сильнее CARD_INK_D. Поле
// снизу это число подряд идущих строк от нижнего края, где чернил меньше CARD_INK_F.
// Подход и осторожность взяты из localcheck.cjs (там пороги полос BAR_SD=0.8, BAR_DARK=4,
// BAR_LIGHT=254 тоже подобраны замером на складе, а не на глаз).
//
// ЧТО НАМЕРЕНО на 30 постах отдела качества (ground truth: дефект C из отчёта 10.08):
//   · все 14 постов с браком карточки: поле снизу 0…4 строки;
//   · чистые карточки: 0…15 строк, из них пять штук 9…15 (340d22bb 12, 75727d56 15, c7070eb9 10,
//     e56bd5c5 10, fce27225 9), остальные тоже 0…4.
// Отсюда честный вывод, и он важнее красивого порога: РАЗРЫВА НЕТ. Поле снизу больше 6 строк
// встречается ТОЛЬКО у чистых карточек, значит эта метрика умеет говорить «поле есть, снизу точно
// не срезано» и НЕ умеет сама браковать: у части чистых карточек нижний ряд фотографий по замыслу
// доходит до края кадра (лучший пост 566883fb: поле 0, чернил в последней строке 94 процента).
// Поэтому численный эшелон работает В ОДНУ СТОРОНУ: поле есть значит вопрос обрезки закрыт
// бесплатно, поля нет значит решает модель зрения по увеличенному низу карточки.
// Собственный отказ численный эшелон выдаёт только на явной пустышке: кадр почти чёрный или залит
// одним тоном, то есть карточки на нём нет вообще.
const CARD_INK_D = Number(process.env.CARD_INK_D || 28);   // насколько пиксель должен отличаться от фона
const CARD_INK_F = Number(process.env.CARD_INK_F || 0.012);// доля строки, которую считаем содержимым
const CARD_BOT_OK = Number(process.env.CARD_BOT_OK || 6);  // поле снизу от 6 строк: обрезки нет
const CARD_BLACK = 12;                                     // средняя яркость ниже: кадр пустой
const CARD_FLAT = 6;                                       // дисперсия ниже: кадр залит одним тоном

function grayFull(file) {
  const px = execFileSync(FF, ['-nostdin', '-loglevel', 'error', '-y', '-i', file,
    '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1 << 26 });
  if (px.length < W * H) throw new Error(`ffmpeg не отдал пиксели: ${file}`);
  return px;
}

function bgTone(px) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < px.length; i++) hist[px[i]]++;
  let best = 0, bi = 0;
  for (let v = 0; v < 256; v++) if (hist[v] > best) { best = hist[v]; bi = v; }
  return bi;
}

/** Численные метрики карточки. Ноль запросов в сеть, ноль денег. */
function cardMetrics(file) {
  const px = grayFull(file);
  const bg = bgTone(px);
  const rowInk = (y) => {
    let n = 0;
    for (let x = 0; x < W; x++) if (Math.abs(px[y * W + x] - bg) > CARD_INK_D) n++;
    return n / W;
  };
  const colInk = (x) => {
    let n = 0;
    for (let y = 0; y < H; y++) if (Math.abs(px[y * W + x] - bg) > CARD_INK_D) n++;
    return n / H;
  };
  let bot = 0, top = 0, left = 0, right = 0;
  while (bot < H && rowInk(H - 1 - bot) <= CARD_INK_F) bot++;
  while (top < H && rowInk(top) <= CARD_INK_F) top++;
  while (left < W && colInk(left) <= CARD_INK_F) left++;
  while (right < W && colInk(W - 1 - right) <= CARD_INK_F) right++;
  let s = 0, s2 = 0;
  for (let i = 0; i < px.length; i++) { s += px[i]; s2 += px[i] * px[i]; }
  const mean = s / px.length;
  const std = Math.sqrt(Math.max(0, s2 / px.length - mean * mean));
  const g = gridScore(px);
  return {
    bg, bot, top, left, right,
    ink_last: +rowInk(H - 1).toFixed(3),
    mean: +mean.toFixed(1), std: +std.toFixed(1),
    hmax: g.hmax, hmax_y: g.hy, vmax: g.vmax, vmax_x: g.vx, hlines: g.hlines,
  };
}

// ═══ РЕГУЛЯРНОСТЬ СЕТКИ (11.08, брак поста нов223) ══════════════════════════════════════════════
//
// ЗАЧЕМ. Начальник открыл пост нов223 и увидел то, чего прошлая версия детектора не ловила:
// «2 фото МУСОР баг». Мусор там не текстовый, а ГРАФИЧЕСКИЙ. Я открыл кадр 2 глазами (пост
// 2cc3c7d1): большая фотография в левой верхней ячейке размазана и вылезла за свою рамку серой
// кашей, волосы модели налезли поверх ряда «РЕКОМЕНДУЕМЫЙ ОТТЕНОК» и закрыли первую подпись,
// заголовок «БРОВИ» перекрыт до «ОВИ», сетка в верхней половине распалась. Ни обрезка снизу, ни
// проверка текста такое не видят: слова целые, поле снизу тут не при чём.
//
// ЧТО МЕРЯЕМ ДАРОМ. Карточка это СЕТКА, значит у неё есть разделители: линия темнее того, что лежит
// по обе стороны от неё, идущая через всю ширину (или всю высоту). Это верно и когда рядом фон, и
// когда рядом фотография, поэтому признак не зависит от содержимого ячеек. Когда блок наехал на
// соседа или фото размазано поверх сетки, разделитель РВЁТСЯ, и его непрерывность падает.
// hmax это доля ширины кадра, которую проходит самый длинный горизонтальный разделитель.
//
// ЗАМЕР и ЧЕСТНЫЙ ВЫВОД (это важнее самой метрики).
// Первый вариант считал только ТЁМНЫЕ разделители и на 31 карточке дал красивую картину: брак
// 0.409…0.520 (cc3d33bb, 9677541a, 34cce8a1, нов223, fc11fc27), чистые 0.843…1.000 (лучшие посты
// 566883fb 1.000, e56bd5c5 1.000, d01c49a5 0.920). Разрыв выглядел железным.
// НО прогон по всему складу нашёл 11 карточек, и я открыл их глазами. Четыре действительно битые, а
// у остальных сетка ЦЕЛАЯ: a2fe750b и e7d6f872 (beauty-guide) и fb532633, 3f4193cc
// (makeup-colortype) разделяют блоки СВЕТЛЫМ зазором, а не тёмной линейкой, и у них слева стоит
// одна большая фотография, из-за которой ни одна линия не проходит всю ширину. То есть метрика
// мерила ВАРИАНТ ВЁРСТКИ, а не поломку. Тоновая правка (считать линию и светлее соседей тоже)
// вылечила только колортайп: fb532633 стал 0.990, а a2fe750b остался 0.458 при целой сетке.
// ВЫВОД: непрерывность разделителей НЕ ИМЕЕТ ПРАВА быть самостоятельным вердиктом, она зависит от
// раскладки карточки. Поэтому число работает только как НАВОДКА: ниже CARD_HMAX_WARN модели зрения
// задаётся прямой адресный вопрос про наезд блоков и размазанные миниатюры (по замеру именно эта
// наводка заставила модель увидеть брак нов223: без неё она отвечала graphics_ok=true).
// Судит графику модель, и её находки проверяемы: она называет место и что именно поехало.
const CARD_HMAX_WARN = Number(process.env.CARD_HMAX_WARN || 0.90);
const LINE_D = Number(process.env.CARD_LINE_D || 6);   // насколько разделитель темнее соседей
const LINE_G = Number(process.env.CARD_LINE_G || 3);   // на сколько пикселей смотрим в сторону

// Линией считаем строку, которая отличается от соседей в ЛЮБУЮ сторону: у части шаблонов блоки
// разделены светлым зазором, а не тёмной линейкой (замер: makeup-colortype).
function gridScore(px) {
  let hmax = 0, hy = 0, hlines = 0, prev = -99;
  for (let y = LINE_G + 2; y < H - LINE_G - 2; y++) {
    let n = 0;
    const up = (y - LINE_G) * W, dn = (y + LINE_G) * W, row = y * W;
    for (let x = 0; x < W; x++) {
      const v = px[row + x], a = px[up + x], b = px[dn + x];
      if ((v + LINE_D < a && v + LINE_D < b) || (v > a + LINE_D && v > b + LINE_D)) n++;
    }
    const f = n / W;
    if (f > hmax) { hmax = f; hy = y; }
    if (f >= 0.9) { if (y - prev > 8) hlines++; prev = y; }
  }
  let vmax = 0, vx = 0;
  for (let x = LINE_G + 2; x < W - LINE_G - 2; x++) {
    let n = 0;
    for (let y = 0; y < H; y++) {
      const v = px[y * W + x];
      if (v + LINE_D < px[y * W + x - LINE_G] && v + LINE_D < px[y * W + x + LINE_G]) n++;
    }
    const f = n / H;
    if (f > vmax) { vmax = f; vx = x; }
  }
  return { hmax: +hmax.toFixed(3), hy, vmax: +vmax.toFixed(3), vx, hlines };
}

/**
 * Численный вердикт по карточке.
 *  'empty'      кадра нет: пустышка или заливка (это настоящий брак, платить за него не надо);
 *  'margin_ok'  поле снизу есть, обрезка снизу исключена бесплатно;
 *  'check'      поля снизу нет, вопрос обрезки решает модель зрения.
 * Поле gridWarn говорит, что разделители сетки рваные: модели зрения зададут прямой адресный вопрос
 * про наезд блоков. Само по себе это НЕ вердикт, см. разбор ложных срабатываний выше.
 */
function cardNumeric(file) {
  const m = cardMetrics(file);
  const out = (state, why) => ({ state, why, m, gridWarn: m.hmax < CARD_HMAX_WARN });
  if (m.mean < CARD_BLACK) return out('empty', `карточка почти чёрная (яркость ${m.mean})`);
  if (m.std < CARD_FLAT) return out('empty', `карточка залита одним тоном (дисперсия ${m.std})`);
  if (m.bot >= CARD_BOT_OK) return out('margin_ok', `поле снизу ${m.bot} px`);
  return out('check', `поля снизу нет (${m.bot} px при пороге ${CARD_BOT_OK})`);
}

// ═══ ЧЁРНЫЙ СПИСОК ЛОКАЦИЙ ══════════════════════════════════════════════════════════════════════
//
// Приказ начальника и отчёт качества: «некрасивое метро», «обоссанная ванна», шаблонная
// Москва-Сити на каждом втором посту. Локации кадров 3 и 4 у постов фабрики лежат текстом в
// meta.loc3 и meta.loc4, значит чёрный список проверяется БЕСПЛАТНО по тексту. Слова собраны по
// фактическому словарю склада (25 разных локаций на 160 постах), а не придуманы.
//
// ВАЖНО ПРО ТОЧНОСТЬ СЛОВ (проверено на калибровке). Первая версия ловила «транспорт» по слову
// «машин» и забраковала ЛУЧШИЙ пост 566883fb: у него локация «на узкой улице в центре Москвы днём,
// машины в пробке» это улица, а не салон машины. Поэтому чёрный список ловит только нахождение
// ВНУТРИ транспорта, а не машины в кадре. По той же причине убрана «плитка»: она встречается и на
// кухне.
const LOC_BAD = [
  { re: /метро|эскалатор|турникет|на платформе/i, tag: 'метро' },
  { re: /такси|в салоне авто|в салоне машины|в машине|за рулём|в автобусе|в троллейбусе|в трамвае|салоне трамвая|в вагоне|в электричке|в поезде|заднем сиденье|в купе/i, tag: 'транспорт' },
  { re: /в ванной|ванная|ванной комнате|душев|санузл/i, tag: 'ванная' },
  { re: /салон[еа]? красоты|парикмахер|барбершоп|у стилиста|кресл[еа] стилиста/i, tag: 'салон' },
  { re: /москва-сити|москва сити|небоскрёб|бизнес-центр/i, tag: 'москва-сити' },
];
/** Разбор локации по тексту. Возвращает список ярлыков чёрного списка. */
function locTags(text) {
  if (!text) return [];
  const out = [];
  for (const r of LOC_BAD) if (r.re.test(text)) out.push(r.tag);
  return out;
}
// Ярлыки, которые может вернуть модель зрения, если текста локации у поста нет (старые посты).
const VIS_BAD = new Set(['метро', 'транспорт', 'ванная', 'салон', 'москва-сити']);

// ═══ МОДЕЛЬ ЗРЕНИЯ ══════════════════════════════════════════════════════════════════════════════
const KEY = process.env.OPENROUTER_API_KEY || (() => {
  for (const f of [path.join(os.homedir(), '.openrouter_key'), '/tmp/orkey.txt']) {
    try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch { /* нет файла, идём дальше */ }
  }
  return '';
})();
const MODEL = process.env.CARD_QA_MODEL || 'anthropic/claude-sonnet-4.5';

// ПРОМПТ ОТКАЛИБРОВАН на 30 постах отдела качества (10.08). Две оговорки появились по замеру, без
// них модель бракует ЛУЧШИЕ посты:
//  · нижний ряд фотографий образов у шаблона beauty-guide по замыслу доходит до края кадра
//    (лучший пост 566883fb), это не обрезка. Обрезка это срезанные по высоте БУКВЫ и подписи,
//    оборванный блок без заголовка, половина строки таблицы;
//  · повтор одного и того же названия оттенка или помады в списке это «minor»: отдел качества
//    оставил такие посты (06ade668, 7441e5fb) в ЛУЧШИХ. «severe» это искажённые слова и
//    абракадабра вида «ВЕРДИСТ», «РЕКОМЕНДУЕМЬЕ ЦВЕТА», «doep charcoal», «Bocked sange».
const SYSTEM = `Ты технический контролёр инфографики для бьюти-аккаунта. Тебе показывают КАРТОЧКУ
из поста (кадр 2 карусели, формат 1080x1350). Карточка это документ на русском языке: либо
бьюти-гайд («ТВОЙ ЛУЧШИЙ ОБРАЗ», волосы, оттенки, брови, глаза, губы, палитра цветов, ряд образов),
либо разбор внешности («ОЦЕНКА ПРИВЛЕКАТЕЛЬНОСТИ», оценки по пунктам, сильные стороны, зоны роста,
рекомендации). Вторая и третья картинка, если есть, это увеличенные НИЗ и ВЕРХ той же карточки.

Твоя работа: найти БРАК рендера. Отвечай ТОЛЬКО JSON, без пояснений вокруг.

СНАЧАЛА СОБЕРИ УЛИКИ, ПОТОМ СУДИ. Главный брак этой фабрики это исковерканные мелкие подписи под
образцами: движок рисует не слова, а похожие на слова наборы букв. Живые примеры из брака:
«Bocked sange», «Cuttered for grace», «doep charcoal», «great bnown», «FEATIRED», «ВЕРДИСТ»,
«РЕКОМЕНДУЕМЬЕ ЦВЕТА». Пока подписи не выписаны по одной, такое пропускается, поэтому:

0. words: выпиши МЕЛКИЕ подписи под образцами укладок, оттенков, глаз, губ и цветов, по одной, как
   они написаны, до 30 штук. Пользуйся увеличенными картинками.
1. suspect: выпиши из words те, которые НЕ являются настоящими словами: искажения английских или
   русских слов, обрывки, бессмыслица. Настоящие бьюти-слова (Honey Blonde, Soft Waves, Smoky eye,
   Nude matte, Balayage, Ash Brown, contour) НЕ подозрительны. Живой сленг аудитории («ИИшка»,
   «нейронка», «глоуап») НЕ подозрителен. Ничего не нашёл, ставь пустой список.
2. text_readable: текст на карточке читается как нормальный текст (буквы целые, строки не
   наложены друг на друга, шрифт не поплыл)? да/нет.
3. bottom_cut: обрезан ли низ карточки. Оценивай СТРОГО так:
   • "none"   низ выглядит законченным: последний блок целиком виден, подписи под элементами на
              месте, буквы не срезаны по высоте;
   • "minor"  до края кадра доходит нижний ряд ФОТОГРАФИЙ или образцов цвета (фото людей, полоски
              оттенков) без подписей под ними, но текстовые блоки целы. ЭТО НОРМА ШАБЛОНА, не брак.
              Сюда же: у нижнего блока не видно нижней РАМКИ, но все его строки и значения читаются
              целиком. Незакрытая рамка это норма кадрирования, а не брак;
   • "severe" срезаны БУКВЫ (видна только верхняя половина строки), оборван текстовый блок,
              заголовок без содержимого, половина строки таблицы, подпись у фотографии обрезана,
              либо ряд образцов цвета или ряд карточек срезан по горизонтали примерно наполовину.
4. garbage_text: мусор в тексте.
   • "none"   список suspect пуст и повторов нет;
   • "minor"  одно и то же название оттенка, помады или пункта повторяется дважды или трижды, но
              все слова настоящие. Это допустимо, такие посты мы публикуем;
   • "severe" в suspect есть хотя бы одно исковерканное слово, либо заголовок написан с ошибкой.
5. layout_ok: вёрстка цела? Брак (значит false): блок вложен внутрь чужого блока (пункты «зоны
   роста» стоят внутри «сильных сторон»), заголовок пропал или перекрыт, элементы налезли друг на
   друга, колонки съехали, текст вылез за рамку блока. Разная высота блоков сама по себе НЕ брак.
5а. ГРАФИЧЕСКИЙ МУСОР, отдельный вопрос и главный. Смотри не на слова, а на КАРТИНКУ, ячейку за
   ячейкой. Перечисли в graphics_problems КОНКРЕТНЫЕ поломки, каждую одной фразой, и поставь
   graphics_ok=false, если нашёл хоть одну:
   • фотография вылезла за свою ячейку, размазалась серой или мутной кашей за рамкой;
   • элементы НАЕХАЛИ друг на друга: волосы, лицо или фон одной картинки лежат поверх соседнего
     ряда образцов, поверх подписи или поверх заголовка (заголовок читается частично: «ОВИ» вместо
     «БРОВИ»);
   • миниатюры внутри карточки РАЗМАЗАНЫ, не в фокусе, в артефактах, тогда как остальная карточка
     резкая;
   • одна и та же картинка стоит в РАЗНЫХ ячейках ряда (ряд укладок или оттенков из одинаковых
     миниатюр), либо в ряду образцов две соседние клетки идентичны;
   • ячейка ПУСТАЯ, залита ровным серым, чёрным или обрезана до полоски;
   • сетка сломана: рамки не сходятся, ряд поехал, ячейки разной высоты внахлёст.
   Ничего не нашёл, ставь graphics_ok=true и пустой список. Разный масштаб лица в миниатюрах и
   разный свет между ячейками это НЕ поломка.
6. loc3 и loc4: если тебе показали кадры 3 и 4 (живые фото девушки), назови локацию каждого ОДНИМ
   словом из списка: метро, транспорт, ванная, салон, москва-сити, улица, квартира, кафе, другое.
   «транспорт» это салон машины, такси, автобус, трамвай, электричка, вагон. «москва-сити» это
   узнаваемые стеклянные небоскрёбы делового центра. Кадров не показали, ставь null.
7. reason: одна короткая фраза по-русски, за что забраковал, либо "чисто".

Формат строго:
{"words":["…"],"suspect":["…"],"text_readable":bool,"bottom_cut":"none|minor|severe","garbage_text":"none|minor|severe","layout_ok":bool,"graphics_ok":bool,"graphics_problems":["…"],"loc3":"…|null","loc4":"…|null","confidence":0..1,"reason":"…"}

По обрезке сомнение решай в пользу поста: "severe" только если срез виден сразу. По исковерканным
словам наоборот: увидел хоть одно, это severe, такой пост в публикацию не идёт.`;

const failed = (reason, kind, why) => ({ verdict: 'unknown', ok: false, reason, kind, problems: [why] });

async function toDataUrl(src) {
  if (/^https?:/i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`не скачалось: HTTP ${r.status}`);
    return `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  }
  if (!fs.existsSync(src)) throw new Error(`нет файла: ${src}`);
  return `data:image/jpeg;base64,${fs.readFileSync(src).toString('base64')}`;
}

let tmpSeq = 0;
const TMP = process.env.CARD_QA_TMP || '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad';
async function materialize(src) {
  if (!/^https?:/i.test(src)) return { path: src, tmp: false };
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, `cqa_${process.pid}_${++tmpSeq}.jpg`);
  const r = await fetch(src, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`не скачалось: HTTP ${r.status}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return { path: out, tmp: true };
}

// УВЕЛИЧЕННЫЕ НИЗ И ВЕРХ КАРТОЧКИ. На полной картинке, сжатой до размера, который видит модель,
// срезанная строка и опечатка в мелкой подписи пропадают: ровно так пропустили «Handilist of
// Pregection» у Дарьи (03.08). Низ карточки это то место, где живёт обрезка, верх это заголовок.
// СРЕДНЯЯ ПОЛОСА ДОБАВЛЕНА 11.08 ПО БРАКУ нов223. На полной карточке, сжатой до размера, который
// видит модель, наезд фотографии на соседний ряд не читается: модель отвечала graphics_ok=true на
// карточке, где волосы лежат поверх ряда оттенков, а заголовок «БРОВИ» перекрыт до «ОВИ». Именно
// там, в верхней и средней трети, ячейки сетки стыкуются, и именно там видно наезд.
function zoomBands(file) {
  const out = [];
  for (const [name, crop] of [['bot', 'crop=iw:ih*0.28:0:ih*0.72'], ['top', 'crop=iw:ih*0.22:0:0'],
    ['mid', 'crop=iw:ih*0.34:0:ih*0.22']]) {
    const p = path.join(TMP, `cqa_${name}_${process.pid}_${++tmpSeq}.jpg`);
    try {
      execFileSync(FF, ['-y', '-loglevel', 'error', '-i', file, '-vf', `${crop},scale=1400:-2`, '-q:v', '2', p], { stdio: 'ignore' });
      if (fs.existsSync(p) && fs.statSync(p).size) out.push(p);
    } catch { /* увеличение не вышло, обойдёмся полной картинкой */ }
  }
  return out;
}

/**
 * Проверка карточки моделью зрения. Заодно называет локации кадров 3 и 4, если их передали.
 * Возвращает {verdict:'ok'|'reject', ok:true, fields, problems} либо {ok:false, reason:'infra'}.
 */
// ЗАПРОС ЧЕРЕЗ ОБЩИЙ КЭШ (14.08). Один и тот же вопрос оплачивается ровно один раз: ключ
// собирается из модели, промпта и СОДЕРЖИМОГО картинок. Разбор — в llmcache.cjs.
// Сбои не кэшируются: «не ответила» это не вердикт.
async function visionCardЗапрос(cardFile, frames34 = [], opts = {}) {
  if (!KEY) return failed('infra', 'no_key', 'нет ключа OpenRouter, проверка не выполнена');
  const zooms = zoomBands(cardFile);
  let content;
  try {
    content = [{ type: 'text', text: 'Проверь карточку. Первая картинка это карточка целиком, '
      + 'дальше увеличенные низ, верх и середина той же карточки'
      + (frames34.length ? ', затем кадры 3 и 4 поста (живые фото) для определения локаций.' : '.')
      // ПОДСКАЗКА ОТ ЗАМЕРА, А НЕ ПОДСКАЗКА ОТВЕТА. Числом видно, что разделители сетки рваные,
      // но ГДЕ и почему, число не знает. Модель смотрит адресно, вердикт всё равно её.
      + (opts.gridWarn ? ' ВАЖНО: замер показал, что разделительные линии сетки на этой карточке '
        + 'рваные. Особенно внимательно проверь, не налезают ли фотографии, волосы или фон на '
        + 'соседние ряды, подписи и заголовки, и не размазана ли какая-то картинка за своей рамкой.' : '') }];
    content.push({ type: 'image_url', image_url: { url: await toDataUrl(cardFile) } });
    for (const z of zooms) content.push({ type: 'image_url', image_url: { url: await toDataUrl(z) } });
    for (const f of frames34) content.push({ type: 'image_url', image_url: { url: await toDataUrl(f) } });
  } catch (e) {
    return failed('infra', 'fetch_images', `картинки не загрузились: ${String(e.message).slice(0, 90)}`);
  } finally {
    zooms.forEach((z) => { try { fs.unlinkSync(z); } catch {} });
  }

  let txt = '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'neironka-poster' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, temperature: 0,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return failed('infra', `http_${r.status}`, `vision HTTP ${r.status}: ${body.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    const j = await r.json();
    if (j && j.error) return failed('infra', 'body_error', `vision вернул ошибку: ${String(j.error.message || j.error).slice(0, 110)}`);
    txt = j.choices?.[0]?.message?.content || '';
  } catch (e) { return failed('infra', 'no_answer', `vision не ответил: ${String(e.message).slice(0, 90)}`); }
  if (!txt.trim()) return failed('infra', 'empty_answer', 'vision вернул пустой ответ');

  const m = txt.match(/\{[\s\S]*\}/);
  let v = null;
  if (m) { try { v = JSON.parse(m[0]); } catch { v = null; } }
  // Ответ не по форме это ответ модели, а не сбой сервиса. По принципу строгости считаем браком.
  if (!v) return { verdict: 'reject', ok: true, fields: null, problems: ['вердикт карточки не разобран, считаем браком'], raw: txt.slice(0, 160) };

  const problems = [];
  if (v.text_readable === false) problems.push('текст карточки не читается');
  // ЧИСЛЕННЫЙ ЗАМЕР СИЛЬНЕЕ МНЕНИЯ. Если поле снизу измерено (bot от CARD_BOT_OK строк), документ
  // физически кончается ВНУТРИ кадра, и обрезки снизу нет, что бы модель ни написала. Без этой
  // оговорки калибровка забраковала лучший пост e56bd5c5 (поле 10 px): модели показалось, что блок
  // «РЕКОМЕНДАЦИИ» неполный, хотя он просто последний.
  if (v.bottom_cut === 'severe' && !opts.marginOk) problems.push(`карточка обрезана снизу: ${v.reason || 'срезан нижний блок'}`);
  if (v.garbage_text === 'severe') problems.push(`мусорный текст в карточке: ${v.reason || 'искажённые слова'}`);
  if (v.layout_ok === false) problems.push(`сломана вёрстка карточки: ${v.reason || 'блоки съехали'}`);
  // ГРАФИЧЕСКИЙ МУСОР (приказ 11.08 по посту нов223). Причина пишется списком конкретных поломок,
  // а не общим словом: по такому вердикту видно, что именно чинить в фабрике.
  if (v.graphics_ok === false) {
    const list = (Array.isArray(v.graphics_problems) ? v.graphics_problems : []).filter(Boolean);
    problems.push(`графический мусор в карточке: ${list.join('; ').slice(0, 160) || v.reason || 'блоки и миниатюры поехали'}`);
  }
  return { verdict: problems.length ? 'reject' : 'ok', ok: true, fields: v, problems };
}

// ═══ ПРОВЕРКА ПОСТА ЦЕЛИКОМ ═════════════════════════════════════════════════════════════════════
// Шаблоны, у которых кадр 2 это КАРТОЧКА-документ. У тренда сердечек кадр 2 это чёрно-белый арт,
// проверять его как документ бессмысленно и вредно.
// СПИСКА ШАБЛОНОВ ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО: тип шаблона знает только контракт templates.cjs.
// Жил тут регэксп /face-report|beauty-guide|makeup-colortype|colortype|guide|report/i, и он врал
// в обе стороны (сверено с контрактом 12.08):
//   · ЛОВИЛ ЛИШНЕЕ по подстрокам «guide» и «report» — любой будущий img-style-guide или
//     img-trend-report молча признавался карточным и уезжал на платную проверку как
//     документ-инфографика, хотя карточки в нём нет;
//   · ТЕРЯЛ СВОИХ: у img-nose-verdict, img-haircut-match и img-magazine-cover в контракте
//     kind:'card' и frame2:'card', но в имени нет ни одного слова из списка — карточка на кадре 2
//     у них НЕ проверялась вовсе, пост уходил с отметкой «кадр 2 это арт, а не карточка».
// Новый шаблон описывают в templates.cjs, а не дописывают сюда.
const { isCard: isCardTemplate } = require('./templates.cjs');

// ═══ ОБЛОЖКА: РАБОТА СОСЕДНЕГО МОДУЛЯ cover_qa.cjs ══════════════════════════════════════════════
// Отдел качества на первый кадр писал другой агент. К моменту прогона у него готово ДВА источника,
// и оба используются, начиная с самого дешёвого:
//   1. ГОТОВЫЙ СПИСОК id постов с плохой обложкой в отчёте КАЧЕСТВО-ОБЛОЖЕК-11.08.md (раздел
//      «Готовые посты»). Все 160 постов склада там уже проверены и брак перепроверен вторым
//      запросом, значит платить второй раз не за что: пост в списке это брак, пост не в списке это
//      проверенная годная обложка. Путь к отчёту меняется через COVER_BAD_MD;
//   2. если отчёта нет, зовём сам модуль (функция «проверить» отдаёт {годится, причины}).
// Модуля и отчёта нет вовсе: обложку не судим, из-за отсутствия соседа пост не бракуется.
function coverQa() {
  try { return require('./cover_qa.cjs') || null; } catch { return null; }
}
const COVER_MD = process.env.COVER_BAD_MD || '/Users/qq/Desktop/КАЧЕСТВО-ОБЛОЖЕК-11.08.md';
let COVER_IDS;                       // Map id -> причина, читается один раз за процесс
function coverListFromMd() {
  if (COVER_IDS !== undefined) return COVER_IDS;
  COVER_IDS = null;
  try {
    const txt = fs.readFileSync(COVER_MD, 'utf8');
    const from = txt.indexOf('## Готовые посты');
    if (from < 0) return COVER_IDS;
    const tail = txt.slice(from);
    const map = new Map();
    for (const line of tail.split('\n')) {
      const m = line.match(/^\|\s*([0-9a-f]{8}-[0-9a-f-]{27})\s*\|(.*)$/i);
      if (!m) continue;
      const cols = m[2].split('|').map((s) => s.trim());
      map.set(m[1].toLowerCase(), (cols[cols.length - 2] || 'брак обложки').slice(0, 90));
    }
    if (map.size) COVER_IDS = map;
  } catch { /* отчёта нет, пойдём в модуль */ }
  return COVER_IDS;
}
async function coverBad(post) {
  const list = coverListFromMd();
  if (list) {
    const why = list.get(String(post.id).toLowerCase());
    return why ? `плохая обложка (cover_qa): ${why}` : null;
  }
  const mod = coverQa();
  if (!mod || !post.urls || !post.urls[0]) return null;
  try {
    if (typeof mod.проверить === 'function') {
      const r = await mod.проверить(post.urls[0]);
      // «непроверено» это не брак: сосед живёт по тому же правилу, что и мы.
      if (r && r.годится === false && r.непроверено !== true) {
        return `плохая обложка (cover_qa): ${(r.причины || []).join('; ').slice(0, 90)}`;
      }
    }
  } catch { /* сосед сломался, из-за него пост не бракуем */ }
  return null;
}

/**
 * Полная проверка поста перед сборкой рилса.
 * post = {id, template, urls:[4], loc3, loc4}
 * Возвращает {clean, reasons:[], card:{…}, loc:{…}, checked:bool, at}.
 * checked=false значит проверка не состоялась (нет ключа, сеть, оплата): это НЕ брак,
 * решение о таком посте принимает вызывающий (в magosreels такие посты в пул не идут).
 */
async function postQa(post, opts = {}) {
  const reasons = [];
  const res = { id: post.id, at: new Date().toISOString(), model: MODEL, clean: false, checked: true, reasons,
    card: null, loc: null, cover: null };

  // 1. ЛОКАЦИИ ПО ТЕКСТУ. Бесплатно и надёжно: фабрика сама записала, что заказывала.
  const t3 = locTags(post.loc3), t4 = locTags(post.loc4);
  res.loc = { loc3: post.loc3 || null, loc4: post.loc4 || null, tags3: t3, tags4: t4, by: (post.loc3 || post.loc4) ? 'text' : null };
  // МОСКВА-СИТИ НА КАДРЕ 3 ЭТО ЗАМЕЧАНИЕ, А НЕ БРАК (11.08). Внутри конвейера было прямое
  // противоречие, и оно стоило денег: promptkit держит Сити в городском пуле как ОБЯЗАТЕЛЬНУЮ
  // локацию (приказ начальника), генерит по ней кадр 3, а этот гейт за ту же локацию бракует УЖЕ
  // ОПЛАЧЕННЫЙ пост. Замер по складу: из 29 проверенных постов 17 забраковано, и «москва-сити»
  // самая частая причина. Разводим по кадрам:
  //   · кадр 4 со Сити остаётся браком: там наша плашка тонет в подсветке, это и было исходным
  //     запретом («фон кажется сильно аишным, плашка утонула»);
  //   · кадр 3 со Сити пропускаем и пишем замечание: доля Сити ограничена ротором пула (не больше
  //     15 процентов на локацию), то есть лента не превращается в пять башен подряд.
  const t3брак = t3.filter((t) => t !== 'москва-сити');
  const t3замечание = t3.filter((t) => t === 'москва-сити');
  if (t3брак.length) reasons.push(`кадр 3 в чёрном списке локаций: ${t3брак.join(', ')}`);
  if (t4.length) reasons.push(`кадр 4 в чёрном списке локаций: ${t4.join(', ')}`);
  if (t3замечание.length) res.notes = [...(res.notes || []), 'кадр 3 у Москва-Сити: допустимо, доля ограничена ротором'];

  // 2. КАРТОЧКА. Только для шаблонов, у которых кадр 2 это документ.
  // ЭКОНОМИЯ: пост, уже забракованный по локации, в пул не пойдёт всё равно, и платить за его
  // карточку смысла нет. На складе по локации отсекается примерно три поста из четырёх, значит
  // платный эшелон работает по одной четверти склада. CARD_QA_ALWAYS=1 отключает эту экономию
  // (нужно для калибровки, где вердикт карточки требуется у каждого поста).
  const urls = post.urls || [];
  const fastFail = reasons.length > 0 && process.env.CARD_QA_ALWAYS !== '1' && opts.always !== true;
  if (fastFail) {
    res.card = { skip: 'пост уже забракован по локации, карточку не проверяем и не платим' };
  } else if (!isCardTemplate(post.template)) {
    res.card = { skip: `шаблон ${post.template}: кадр 2 это арт, а не карточка` };
  } else if (urls.length < 2) {
    res.card = { skip: 'нет кадра 2' };
    reasons.push('нет кадра 2');
  } else {
    let f2 = null, f34 = [];
    try {
      f2 = await materialize(urls[1]);
      const num = cardNumeric(f2.path);
      res.card = { numeric: num.state, why: num.why, metrics: num.m };
      if (num.state === 'empty') {
        // Брак виден арифметикой: карточки на кадре нет вовсе. Платить за подтверждение не надо.
        reasons.push(num.why);
      } else if (opts.numericOnly || process.env.CARD_QA_VISION === '0') {
        // ЧИСЛЕННЫЙ ПРОГОН БЕЗ ДЕНЕГ. Карточка при этом НЕ проверена: обрезку, мусор в тексте и
        // графическую кашу видит только модель. Поэтому честно ставим checked=false, иначе такой
        // пост выглядел бы «чистым» и уезжал в пул с непроверенной карточкой.
        res.checked = false;
        reasons.push('карточка не проверена: платный эшелон выключен, есть только численный замер');
      } else {
        // Локации по тексту уже известны, значит кадры 3 и 4 модели не показываем и не платим за них.
        const needLoc = !post.loc3 && !post.loc4 && urls.length >= 4;
        if (needLoc) for (const u of [urls[2], urls[3]]) f34.push(await materialize(u));
        // ДВА ПРОХОДА. Замер на 30 постах отдела качества: между двумя одинаковыми прогонами модель
        // меняет решение на пограничных карточках. Но не все находки равны, и это тоже замер:
        //   · ИСКОВЕРКАННОЕ СЛОВО и ГРАФИЧЕСКАЯ ПОЛОМКА это проверяемые улики: модель называет само
        //     слово («Bocked sange») или само место («волосы поверх ряда оттенков»), их можно открыть
        //     глазами и убедиться. Хватает ОДНОГО прохода, объединяем находки;
        //   · ОБРЕЗКА СНИЗУ это мнение о кадрировании, и именно оно скачет: на 514fe1eb, cce7eddd,
        //     c7070eb9, e56bd5c5 и d01c49a5 вердикт менялся между прогонами, а глазами у всех пяти
        //     нижний блок читается целиком. Поэтому обрезка держится только при СОГЛАСИИ ВСЕХ
        //     проходов. Приказ «сомнение по обрезке в пользу поста» здесь и живёт.
        const passes = Math.max(1, Number(process.env.CARD_QA_PASSES || 2));
        let v = null, okPasses = 0, cutVotes = 0;
        const isCut = (p) => /обрезана снизу/.test(p);
        for (let k = 0; k < passes; k++) {
          const one = await visionCard(f2.path, f34.map((x) => x.path),
            { marginOk: num.state === 'margin_ok', gridWarn: num.gridWarn });
          if (!one.ok) { if (!v) v = one; continue; }              // сбой прохода: держим первый исход
          okPasses++;
          if (one.problems.some(isCut)) cutVotes++;
          if (!v || !v.ok) v = { ...one, problems: [...one.problems] };
          else for (const p of one.problems) if (!v.problems.includes(p)) v.problems.push(p);
          if (one.fields) v.fields = { ...(v.fields || {}), ...one.fields,
            suspect: [...new Set([...(v.fields?.suspect || []), ...(one.fields.suspect || [])])] };
        }
        if (v && v.ok) {
          if (okPasses > 1 && cutVotes < okPasses) {
            v.problems = v.problems.filter((p) => !isCut(p));      // проходы не сошлись, обрезку снимаем
            v.cut_votes = `${cutVotes} из ${okPasses}`;
          }
          v.verdict = v.problems.length ? 'reject' : 'ok';
        }
        res.card.vision = v.ok ? { ...v.fields, verdict: v.verdict, passes } : { unknown: v.problems[0] };
        if (!v.ok) { res.checked = false; reasons.push(`карточка не проверена: ${v.problems[0]}`); }
        else {
          for (const p of v.problems) reasons.push(p);
          if (needLoc && v.fields) {
            const g3 = String(v.fields.loc3 || '').toLowerCase(), g4 = String(v.fields.loc4 || '').toLowerCase();
            res.loc = { ...res.loc, by: 'vision', vis3: g3 || null, vis4: g4 || null };
            // Кадр 3 у Сити не браковать, см. разбор выше: генератор держит Сити обязательной,
            // и брак здесь означал бы выброс уже оплаченного поста.
            if (VIS_BAD.has(g3) && g3 !== 'москва-сити') reasons.push(`кадр 3 в чёрном списке локаций: ${g3}`);
            if (VIS_BAD.has(g4)) reasons.push(`кадр 4 в чёрном списке локаций: ${g4}`);
          }
        }
      }
    } catch (e) {
      res.checked = false;
      res.card = { ...(res.card || {}), error: String(e.message).slice(0, 120) };
      reasons.push(`карточка не проверена: ${String(e.message).slice(0, 90)}`);
    } finally {
      [f2, ...f34].forEach((x) => { if (x && x.tmp) { try { fs.unlinkSync(x.path); } catch {} } });
    }
  }

  // 3. ОБЛОЖКА от соседнего модуля, если он уже написан.
  const cov = await coverBad(post);
  res.cover = cov ? { bad: true, why: cov } : { bad: false, by: coverListFromMd() ? 'список cover_qa' : (coverQa() ? 'модуль cover_qa' : 'нет данных') };
  if (cov) reasons.push(cov);

  res.clean = res.checked && reasons.length === 0;
  return res;
}

module.exports = { postQa, visionCard, cardNumeric, cardMetrics, locTags, isCardTemplate,
  LOC_BAD, CARD_BOT_OK, CARD_INK_D, CARD_INK_F };

// ═══ CLI ════════════════════════════════════════════════════════════════════════════════════════
function db() {
  const { Client } = require('pg');
  return new Client({
    connectionString: process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
  });
}
const SEL = `id, meta->>'template' template, meta->>'persona' persona,
             meta->>'loc3' loc3, meta->>'loc4' loc4, meta->'image_urls' urls`;

/** Кэш вердикта в meta.qa: утром не проверяем заново и второй раз не платим. */
async function saveQa(c, id, qa) {
  await c.query(`UPDATE posts SET meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('qa', $2::jsonb) WHERE id=$1`,
    [id, JSON.stringify({ v: 1, ...qa })]);
}

async function runList(rows, { write, concurrency = 4, c = null }) {
  const out = new Array(rows.length);
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const k = i++;
      const row = rows[k];
      let qa;
      try { qa = await postQa({ id: row.id, template: row.template, urls: row.urls || [], loc3: row.loc3, loc4: row.loc4 }); }
      catch (e) { qa = { id: row.id, clean: false, checked: false, reasons: [`сбой проверки: ${String(e.message).slice(0, 80)}`] }; }
      out[k] = { row, qa };
      const icon = qa.clean ? '✅' : qa.checked ? '⛔' : '❓';
      console.log(`${icon} ${row.id.slice(0, 8)} ${String(row.persona).padEnd(9)} ${String(row.template).slice(0, 18).padEnd(18)} `
        + (qa.clean ? 'чисто' : qa.reasons.join('; ').slice(0, 130)));
      if (write && c) await saveQa(c, row.id, qa).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const has = (f) => args.includes(f);
    const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

    if (has('--file')) {
      const f = val('--file');
      const num = cardNumeric(f);
      console.log(`ЧИСЛЕННО: ${num.state} (${num.why})`);
      console.log('  ' + JSON.stringify(num.m));
      if (!has('--no-vision')) {
        const v = await visionCard(f);
        console.log(`ЗРЕНИЕ: ${v.ok ? v.verdict : 'не проверено'} ${JSON.stringify(v.fields || v.problems)}`);
      }
      process.exit(0);
    }

    const c = db(); c.on('error', () => {}); await c.connect();
    const BACKLOG = `SELECT ${SEL} FROM posts
       WHERE status IN ('backlog','approved') AND published_at IS NULL
         AND jsonb_array_length(meta->'image_urls') = 4 ORDER BY created_at DESC`;

    if (has('--post') || has('--ids')) {
      const ids = (val('--post') || val('--ids')).split(',').map((x) => x.trim()).filter(Boolean);
      const r = await c.query(`SELECT ${SEL} FROM posts WHERE ` + ids.map((x, k) => `id::text LIKE $${k + 1}`).join(' OR '),
        ids.map((x) => x + '%'));
      const res = await runList(r.rows, { write: has('--write'), c, concurrency: Number(process.env.CQA_CONC || 4) });
      if (has('--json')) console.log(JSON.stringify(res.map(({ row, qa }) => ({ id: row.id, ...qa })), null, 1));
      await c.end(); process.exit(0);
    }

    // ДОБАВИТЬ ВЕРДИКТ ОБЛОЖКИ В УЖЕ ПОСЧИТАННЫЙ КЭШ. Нужен, когда список плохих обложек от соседа
    // появился ПОЗЖЕ нашего прогона: карточку и локации переспрашивать не надо, платить второй раз
    // не за что, дописываем только строку про обложку.
    if (has('--recheck-cover')) {
      const r = await c.query(`SELECT id, meta->'qa' qa FROM posts WHERE meta ? 'qa'`);
      let touched = 0;
      for (const row of r.rows) {
        const qa = row.qa || {};
        const cov = await coverBad({ id: row.id, urls: [] });
        const had = (qa.reasons || []).some((x) => /обложк/i.test(x));
        if (!cov || had) continue;
        qa.reasons = [...(qa.reasons || []), cov];
        qa.cover = { bad: true, why: cov };
        qa.clean = false;
        if (has('--write')) await saveQa(c, row.id, qa);
        touched++;
        console.log(`⛔ ${row.id.slice(0, 8)} ${cov}`);
      }
      console.log(`\nдописано вердиктов обложки: ${touched}${has('--write') ? '' : ' (без --write ничего не сохранено)'}`);
      await c.end(); process.exit(0);
    }

    // ДИАГНОСТИКА СЕТКИ ПО ВСЕМУ СКЛАДУ, БЕСПЛАТНО. Ничего не бракует и в базу не пишет: печатает
    // замер непрерывности разделителей, чтобы видеть, у каких карточек стоит спрашивать модель про
    // наезд блоков. Почему это не вердикт, разобрано в шапке (ложные срабатывания на вариантах
    // вёрстки, проверено глазами).
    if (has('--grid-scan')) {
      const r = await c.query(BACKLOG);
      const card = r.rows.filter((x) => isCardTemplate(x.template) && (x.urls || []).length >= 2);
      console.log(`карточных постов: ${card.length} из ${r.rows.length}, замер сетки (платных запросов ноль)\n`);
      const out = [];
      let i = 0;
      const worker = async () => {
        while (i < card.length) {
          const row = card[i++];
          let f = null;
          try {
            f = await materialize(row.urls[1]);
            const num = cardNumeric(f.path);
            out.push({ row, num });
          } catch (e) { console.log(`❓ ${row.id.slice(0, 8)} ${String(e.message).slice(0, 70)}`); }
          finally { if (f && f.tmp) { try { fs.unlinkSync(f.path); } catch {} } }
        }
      };
      await Promise.all(Array.from({ length: Number(process.env.CQA_CONC || 4) }, worker));
      out.sort((a, b) => a.num.m.hmax - b.num.m.hmax);
      out.forEach(({ row, num }) => console.log(`${num.m.hmax < CARD_HMAX_WARN ? '⚠' : ' '} `
        + `${row.id.slice(0, 8)} ${String(row.persona).padEnd(9)} ${String(row.template).slice(0, 18).padEnd(18)} `
        + `сетка=${num.m.hmax} целых линий=${num.m.hlines} поле снизу=${num.m.bot}`));
      console.log(`\nв зоне подозрения (сетка ниже ${CARD_HMAX_WARN}): `
        + `${out.filter((x) => x.num.m.hmax < CARD_HMAX_WARN).length} из ${out.length}. `
        + 'Вердикт по графике ставит модель зрения в обычном прогоне --backlog');
      await c.end(); process.exit(0);
    }

    if (has('--backlog')) {
      const r = await c.query(BACKLOG);
      console.log(`СКЛАД: ${r.rows.length} постов (backlog/approved, не опубликованы, 4 кадра)\n`);
      const res = (await runList(r.rows, { write: has('--write'), c, concurrency: Number(process.env.CQA_CONC || 4) })).filter(Boolean);
      const clean = res.filter((x) => x.qa.clean);
      const unknown = res.filter((x) => !x.qa.checked);
      const bad = res.filter((x) => x.qa.checked && !x.qa.clean);
      console.log(`\nИТОГ: ✅ чистых ${clean.length} · ⛔ брак ${bad.length} · ❓ не проверились ${unknown.length}`);
      const by = {};
      bad.forEach(({ qa }) => qa.reasons.forEach((p) => {
        const k = p.replace(/:.*$/, '').replace(/\d+/g, 'N');
        by[k] = (by[k] || 0) + 1;
      }));
      console.log('\nПРИЧИНЫ БРАКА:');
      Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)} × ${k}`));
      if (has('--write')) console.log('\nвердикты закэшированы в meta.qa (статусы не менялись, ничего не удалено)');
      await c.end(); process.exit(0);
    }

    console.log('нужен один из ключей: --post <id> | --ids a,b | --backlog [--write] | --file <путь>');
    await c.end(); process.exit(1);
  })().catch((e) => { console.error('СБОЙ:', e.message); process.exit(1); });
}

const { спросить: _спросить } = require('./llmcache.cjs');
async function visionCard(...дов) {
  const карт = (() => { try { return [дов[0], ...(дов[1]||[])]; } catch { return []; } })();
  return _спросить({
    ключ: {
      model: MODEL,
      // В КЛЮЧ ВХОДЯТ И НАСТРОЙКИ ЗАПРОСА (14.08, поймано аудитом). Второй довод меняет ПРОМПТ:
      // у validateCarousel это {template, coverRef, frame4Art}, у card_qa — gridWarn. Пока их в
      // ключе не было, один и тот же набор картинок отдавал вердикт, посчитанный под ЧУЖИЕ флаги:
      // сборщик спрашивал с coverRef, а публикатор получал его ответ без своих. Ложный отказ так
      // залипал навсегда.
      prompt: 'visionCard|' + (() => { try { return JSON.stringify(дов.slice(1)); } catch { return ''; } })(),
      images: Array.isArray(карт) ? карт : [карт],
    },
    запрос: () => visionCardЗапрос(...дов),
    годен: (о) => o_годен(о),
    чей: 'card_qa',
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
