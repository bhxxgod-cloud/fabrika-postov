// ОТПРАВКА ГОТОВЫХ МАТЕРИАЛОВ В ТГ-ГРУППУ (решение владельца 02.08: хочу видеть готовое у себя).
// Шлём с НОМЕРОМ и понятной подписью, чтобы в группе можно было сослаться на «Дарья #3», а не
// пересматривать всё подряд. Номер сквозной на модель и хранится в журнале рядом со скриптом:
// перезапуск скрипта не сбрасывает нумерацию и не плодит вторых «первых».
//
// ДЕДУП ПО СОДЕРЖИМОМУ (06.08, разбор инцидента: в группу улетела пачка одинаковых карточек).
// Раньше ключом дедупа была ПЕРЕДАННАЯ строка --key, и обойти его получалось не злым умыслом,
// а случайно: один чат звал `--key post:<id>`, другой `--key <id>:v2`, третий не передавал ключ
// вовсе и ключ собирался из путей файлов. Один и тот же пост уходил столько раз, сколько
// вариантов ключа придумали вызывающие скрипты. Теперь ключ считается по САМИМ КАДРАМ
// (перцептивный dHash из coverguard.cjs), поэтому те же картинки под любым --key не пройдут.
// id поста (--key) остаётся вторым, независимым ключом: пост не уйдёт дважды и в том случае,
// если кадры пересобрали (другой кроп, перегон в jpeg, дописанный текст).
//
// Запуск:
//   node tgsend.cjs <файл> --persona "Дарья" [--type ролик|фотопост] [--note "текст"]
//   node tgsend.cjs --carousel <файл1> <файл2> <файл3> --persona "Полина" --key <id поста>
//   node tgsend.cjs ... --force "обложка заменена"    осознанный повтор, причина обязательна
'use strict';

// СЛУЖЕБНЫЕ И ТЕСТОВЫЕ ОТПРАВКИ В ГРУППУ ЗАПРЕЩЕНЫ ПО УМОЛЧАНИЮ (06.08: тест дедупа заслал в
// группу владельца карточки «TEST DEDUP» и «OTHER FRAME», приказ «перестань слать уведы о тестах»).
// Любая карточка, где persona/type/note выглядят тестом или службой, требует TG_ALLOW_TEST=1.
function looksLikeTest(args) {
  const blob = args.join(' ').toLowerCase();
  return /(тест|test|служеб|dedup|проверк|debug|dry)/i.test(blob);
}
if (looksLikeTest(process.argv.slice(2)) && !/^(1|true|yes)$/i.test(String(process.env.TG_ALLOW_TEST || ''))) {
  console.log('ИТОГ: ✗ похоже на тестовую/служебную отправку — в группу владельца нельзя (TG_ALLOW_TEST=1 если это осознанно)');
  process.exit(3);
}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// КЛЮЧИ СНАЧАЛА ИЗ ~/.neironka, /tmp ТОЛЬКО ЗАПАСНОЙ (29.08). Раньше читали один /tmp, а он
// вычищается системой: ключи пропали, и отправка молча падала с «нет токена или чата» — при том
// что ключи на месте, просто в другом каталоге. Постоянное жильё ключей — ~/.neironka.
const домКлючей = require('node:os').homedir() + '/.neironka/';
const ключ = (имя, запас) => (safeRead(домКлючей + имя) || safeRead(запас)).trim();
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || ключ('tgtok', '/tmp/.tgtok')).trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID || ключ('tgchat', '/tmp/.tgchat')).trim();
// Журнал отправок 05.08 переехал из /tmp в папку проекта: /tmp сгорает при ребуте, и история
// терялась.
const STATE = path.join(__dirname, 'tg_journal.json');
const OLD_STATE = '/tmp/tg_counters.json';
// Замок на журнал: залпы (genref_par, salvo28, sendready) шлют из нескольких процессов, и без
// замка двое читают журнал одновременно, оба видят «не слали» и оба отправляют.
const LOCK = STATE + '.lock';

// ПОРОГ ПОХОЖЕСТИ КАДРОВ. Измерен не на глаз, а на боевых обложках (covers.json, 115 штук,
// 6555 пар, 06.08): та же картинка после ресайза и убитого jpeg даёт 0 бит расхождения, смена
// кропа 12-13 бит, а РАЗНЫЕ фотки не сходятся ближе 80 бит (ниже 80 сидят только настоящие
// повторы, которые ловит гейт обложек). 48 стоит в этом провале.
const NEAR_BITS = Number(process.env.TG_NEAR_BITS || 48);
// Похожесть считаем только для наборов от ДВУХ кадров. Проверено на служебной карточке:
// два заведомо РАЗНЫХ плоских кадра (фон + надпись) отстоят всего на 20 бит, то есть по одной
// малодетальной картинке легко забраковать честную новую карточку. Когда кадров несколько,
// близкими должны оказаться ВСЕ, и случайного совпадения уже не выходит.
const NEAR_MIN_FRAMES = 2;
// АНТИ-ЛАВИНА. Сегодня (06.08) в группу владельца улетела пачка одинаковых карточек подряд, и
// владелец был недоволен: пачкой он их не разбирает. Точное число карточек в той пачке не
// считали, поэтому порог назначен по смыслу: 5 карточек за 10 минут это темп, при котором их
// ещё смотрят по одной. Дальше отправка ЖДЁТ окна, а не сыпет.
const FLOOD_MAX = 5;
const FLOOD_WIN_MS = 10 * 60 * 1000;
// Ждём не бесконечно: висящий полчаса дочерний процесс выглядит как зависший конвейер.
const FLOOD_WAIT_CAP_MS = 15 * 60 * 1000;
// Бронь под отправку, которую никто не закрыл (процесс убили в момент запроса к Telegram).
// Считаем такую бронь ОТПРАВЛЕННОЙ: карточка, скорее всего, дошла, а повтор владелец видит
// как спам. Если реально не дошло, есть честный путь: --force "причина".
const PENDING_STALE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function loadState() {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch {
    // первая миграция: подхватываем старый журнал из /tmp, чтобы не потерять счётчики
    try { s = JSON.parse(fs.readFileSync(OLD_STATE, 'utf8')); } catch { s = null; }
  }
  if (!s || typeof s !== 'object') s = {};
  if (!s.counters || typeof s.counters !== 'object') s.counters = {};
  if (!s.sent || typeof s.sent !== 'object') s.sent = {};
  if (!Array.isArray(s.flood)) s.flood = [];
  return s;
}
// Пишем через временный файл: обрыв на середине записи оставлял битый json, а битый журнал
// читается как «ничего не слали» и открывает дорогу повторам.
function saveState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE);
}

async function withLock(fn) {
  const deadline = Date.now() + 60000;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); break; }
    catch {
      // чужой замок старше двух минут = процесс умер, снимаем, иначе конвейер встанет навсегда
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120000) { fs.unlinkSync(LOCK); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('журнал ТГ занят другим процессом больше минуты');
      await sleep(300);
    }
  }
  try { return await fn(); }
  finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(LOCK); } catch {} }
}

// ОТПЕЧАТОК КАДРА. Берём тот же dHash, что гейт обложек: он не меняется от перегона в jpeg и
// от смены яркости, то есть узнаёт кадр, скачанный из R2 второй раз в другую папку.
// Если ffmpeg не смог (видео с битым первым кадром, чужой формат), падаем на md5 байтов:
// он строже (ловит только байт-в-байт), но лучше строгого дедупа, чем никакого.
function framePrint(file) {
  try {
    const { hashImage } = require('./coverguard.cjs');
    const h = hashImage(file);
    if (h && /^[0-9a-f]{16,}$/.test(h)) return h;
  } catch {}
  return 'md5:' + crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}
// Ключ набора: один хэш на всю карусель, чтобы сравнение было одним поиском по журналу.
const printKeyOf = (frames) => 'frames:' + crypto.createHash('sha1').update(frames.join('|')).digest('hex').slice(0, 20);

function normEntry(v) {
  if (typeof v === 'number') return { num: v };          // старые записи журнала: только номер
  return (v && typeof v === 'object') ? v : null;
}
// post:<id> хранится ссылкой на запись с кадрами, чтобы не держать два набора хэшей.
function resolveEntry(st, key) {
  const e = normEntry(st.sent[key]);
  if (e && e.alias) return normEntry(st.sent[e.alias]);
  return e;
}
// Ищем, слали ли это раньше. Три независимых пути, любой из них закрывает отправку.
function findDup(st, { postKey, printKey, frames }) {
  if (postKey) {
    const e = resolveEntry(st, `post:${postKey}`);
    if (e) return { by: `id поста ${postKey}`, e };
  }
  const exact = resolveEntry(st, printKey);
  if (exact) return { by: 'те же кадры, отпечаток совпал', e: exact };
  // Почти те же кадры: пересобранная карусель (другой кроп, другой размер) под новым ключом.
  if (frames.length < NEAR_MIN_FRAMES) return null;
  const { hamming } = require('./coverguard.cjs');
  for (const raw of Object.values(st.sent)) {
    const e = normEntry(raw);
    if (!e || !Array.isArray(e.frames) || e.frames.length !== frames.length) continue;
    // md5-отпечатки сравнивать по Хэммингу нельзя: у случайных md5 расстояние само по себе
    // невелико и даст ложный повтор. Для них работает только точное совпадение выше.
    if (e.frames.some((h) => String(h).startsWith('md5:')) || frames.some((h) => h.startsWith('md5:'))) continue;
    let worst = 0, all = true;
    for (let i = 0; i < frames.length; i++) {
      const d = hamming(frames[i], e.frames[i]);
      if (d > NEAR_BITS) { all = false; break; }
      if (d > worst) worst = d;
    }
    if (all) return { by: `почти те же кадры, расхождение ${worst} бит из 256`, e };
  }
  return null;
}

// Сколько ждать до свободного окна. 0 = можно слать.
function floodWaitMs(st) {
  const now = Date.now();
  const win = (st.flood || []).filter((t) => now - t < FLOOD_WIN_MS).sort((a, b) => a - b);
  if (win.length < FLOOD_MAX) return 0;
  return win[win.length - FLOOD_MAX] + FLOOD_WIN_MS - now;
}

// КАЧЕСТВО. Документами приходит оригинал, но их неудобно смотреть — владелец просил фото.
// Поэтому шлём фото, но так, чтобы Telegram нечего было портить:
//   • TG даунскейлит всё, что длиннее ~1280px по большей стороне, СВОИМ алгоритмом. Наши 1080×1350
//     под это попадали. Ресайзим сами до 1280 хорошим ланцошем — TG уже не трогает размер.
//   • JPEG он перекодирует в любом случае, поэтому отдаём максимальное качество (q:v 2): чем чище
//     вход, тем меньше видно его компрессию.
// TG_AS_DOC=1 — слать документами (оригинал байт-в-байт, когда качество важнее удобства).
const AS_DOC = process.env.TG_AS_DOC === '1';
const TG_MAX_SIDE = 1280;

// Готовит картинку под Telegram. Возвращает путь (возможно, тот же самый).
function prepPhoto(file) {
  if (AS_DOC || !/\.(jpe?g|png)$/i.test(file)) return file;
  try {
    const bin = require('ffmpeg-static');
    const { execFileSync } = require('node:child_process');
    // Узнаём размер: ffmpeg пишет его в stderr, отдельный ffprobe не нужен.
    let w = 0, h = 0;
    try { execFileSync(bin, ['-i', file], { stdio: 'pipe' }); }
    catch (e) { const m = String(e.stderr).match(/,\s(\d{2,5})x(\d{2,5})[\s,]/); if (m) { w = +m[1]; h = +m[2]; } }
    if (!w || !h) return file;
    if (Math.max(w, h) <= TG_MAX_SIDE) return file;   // TG и так не тронет размер
    const out = `/tmp/tgq/${path.basename(file, path.extname(file))}_${Date.now()}.jpg`;
    fs.mkdirSync('/tmp/tgq', { recursive: true });
    const scale = w >= h ? `${TG_MAX_SIDE}:-2` : `-2:${TG_MAX_SIDE}`;
    execFileSync(bin, ['-y', '-i', file, '-vf', `scale=${scale}:flags=lanczos`, '-q:v', '2', out], { stdio: 'ignore' });
    return fs.existsSync(out) && fs.statSync(out).size ? out : file;
  } catch { return file; }
}

// Подпись поста уходит МОНОШИРИННЫМ блоком: в Telegram по такому блоку достаточно тапнуть, и он
// копируется целиком — не нужно выделять текст руками (просьба владельца 03.08). Шапка со
// «Дарья #7 · шаблон» остаётся обычной, чтобы не копировалась вместе с текстом поста.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Подпись разбираем на ТРИ части, каждая отдельным блоком для копирования (просьба владельца 03.08):
//   • ЗАГОЛОВОК — короткий цепляющий текст, его просит TikTok в поле «add a catchy title»;
//   • ОПИСАНИЕ — сам текст поста без хештегов;
//   • ХЕШТЕГИ — отдельно, их часто нужно править под площадку.
// Заголовок берём из первой строки (это хук от фабрики), чистим от многоточий и обрезаем:
// в TikTok поле короткое, длинный текст там просто не поместится.
// Заголовок для TikTok генерим ОТДЕЛЬНО, а не копируем хук с картинки: на фото уже написано
// «Спрошу у чата чёрно-белый портрет…», и повторять ту же фразу в заголовке бессмысленно —
// зритель читает одно и то же дважды (замечание владельца 03.08). Заголовок должен цеплять сам:
// интрига, вопрос, обещание результата.
function catchyTitle(hook, type) {
  const KEY = process.env.OPENROUTER_API_KEY
    || (fs.existsSync('/tmp/orkey.txt') ? fs.readFileSync('/tmp/orkey.txt', 'utf8').trim() : '');
  if (!KEY) return '';
  const sys = 'Ты пишешь цепляющие заголовки для TikTok на русском. Дай ОДИН заголовок: короткий '
    + '(до 60 знаков), разговорный, с интригой или вопросом, без кавычек и решёток. Он НЕ должен '
    + 'повторять текст, который уже написан на самом видео — скажи иначе, другими словами. '
    + 'Пиши как обычная девушка в сторис, без пафоса и рекламных слов. Ответь только заголовком.';
  try {
    const { execFileSync } = require('node:child_process');
    const body = JSON.stringify({
      model: process.env.TITLE_MODEL || 'anthropic/claude-sonnet-4.5',
      max_tokens: 60, temperature: 0.9,
      messages: [{ role: 'system', content: sys },
        { role: 'user', content: `Тема поста: ${type || 'бьюти-разбор'}.\nНа видео уже написано: «${hook}».\nДай другой заголовок.` }],
    });
    const out = execFileSync('curl', ['-s', '--max-time', '25', 'https://openrouter.ai/api/v1/chat/completions',
      '-H', `Authorization: Bearer ${KEY}`, '-H', 'Content-Type: application/json', '-d', body],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const t = JSON.parse(out).choices?.[0]?.message?.content || '';
    return String(t).replace(/^["'«»\s]+|["'«»\s]+$/g, '').split('\n')[0].slice(0, 90);
  } catch { return ''; }
}

function splitCaption(note) {
  const text = String(note || '').trim();
  if (!text) return { title: '', body: '', tags: '' };
  const lines = text.split('\n').map((s) => s.trim());
  const tags = lines.filter((l) => /^#/.test(l)).join(' ');
  const rest = lines.filter((l) => l && !/^#/.test(l));
  const title = (rest[0] || '')
    .replace(/[…\.]{2,}\s*$/, '')          // хвостовые многоточия ни к чему в заголовке
    .replace(/\s+/g, ' ')
    .slice(0, 90)
    .trim();
  const body = rest.slice(1).join('\n').trim() || rest[0] || '';
  return { title, body, tags };
}

// ФОРМУЛА ОПИСАНИЯ (владелец 04.08, по образцу вирусного поста «Любимки»):
// вторая часть НЕ кетчи, а нативная связка «даю промпт ниже + проще всего написать
// "нейронка про шаблоны" в яндекс + бесплатные попытки» и хештеги. Пул вариантов, чтобы
// текст не повторялся слово в слово на всех акках (одинаковость = маркер для шэдоубана).
// 22 вариации (05.08, начальник: «описание одинаковое тупо, придумай кучу вариаций»): разные
// по структуре, порядку слов, эмодзи и интонации. Сеются по КЛЮЧУ поста (не по номеру подряд),
// чтобы соседние посты не ловили соседние варианты.
const NATIVE_POOL = [
  'даю промпт ниже, но проще всего написать «нейронка про шаблоны» в яндекс и сделать там, ща регистрацию дают бесплатные попытки ❤️',
  'промпт оставлю ниже, хотя легче вбить «нейронка про шаблоны» в яндексе и повторить в пару кликов, за регистрацию дают попытки бесплатно ✨',
  'промпт ниже, но быстрее найти «нейронка про шаблоны» в яндексе, там всё уже готово и на старте есть бесплатные генерации 🙌',
  'кому надо, промпт ниже. а вообще проще написать «нейронка про шаблоны» в яндекс, шаблон там в один клик и попытки на старте бесплатные 💛',
  'сделала в нейронка про, ищется в яндексе за секунду. промпт кидаю ниже, но там он уже вшит в шаблон, нажала и готово 🤍',
  'если лень возиться с промптом (он ниже), просто вбей «нейронка про шаблоны» в яндекс, я делала там, первые попытки бесплатно 😌',
  'все спрашивают промпт, оставляю ниже) но честно проще зайти в нейронка про через яндекс и ткнуть готовый шаблон, попытки дают бесплатно',
  'промпт в конце поста. я сама делала в нейронка про (найдёшь в яндексе), там этот шаблон уже собран, за регу дают попытки 🫶',
  'ниже полный промпт для повторения. лайфхак: в нейронка про он уже готовым шаблоном, я через яндекс нашла, старт бесплатный 💫',
  'держите промпт (ниже), но предупреждаю, в нейронка про это делается в два тыка без всяких промптов, ищи в яндексе, попытки бесплатные',
  'промпт прикладываю ниже. если хочется быстро, набери «нейронка про шаблоны» в яндексе, шаблон готовый и попытки на старте не платные ❤️',
  'сохраняй промпт ниже, пригодится) а повторить проще всего в нейронка про, вбей в яндекс, там за регистрацию бесплатные генерации ✨',
  'фотки делала в нейронка про, шаблон там готовый. промпт всё равно оставлю ниже для тех, кто любит руками 🙌',
  'кто просил промпт, он внизу. но реально легче найти «нейронка про шаблоны» в яндексе и повторить там, начало бесплатное 💛',
  'промпт под постом. сама я ленивая, делаю в нейронка про, находится в яндексе, тыкаешь шаблон и всё, попытки дарят на старте 😅',
  'внизу промпт целиком. а если без заморочек, то нейронка про в яндексе, там этот шаблон в один клик, бесплатных попыток хватает 🤍',
  'оставила промпт ниже как обещала) но быстрее зайти в нейронка про (яндекс в помощь), шаблон уже настроен, рега даёт попытки',
  'промпт ниже, пользуйтесь. я всё делаю в нейронка про, ищется в яндексе на раз, генерации на старте бесплатные 💫',
  'скопируй промпт ниже или не мучайся и набери «нейронка про шаблоны» в яндексе, я вторым путём хожу, попытки там дают бесплатно 🔥',
  'по традиции промпт внизу. секрет: в нейронка про он уже зашит в шаблон, нашла через яндекс, за регистрацию начисляют попытки 🫶',
  'делала тут: нейронка про (вбей в яндекс). промпт тоже приложу ниже, вдруг кто в другой нейросети повторяет, старт бесплатный 😌',
  'промпт как всегда ниже) а самый короткий путь — «нейронка про шаблоны» в яндексе, там нажала кнопку и получила, попытки бесплатные',
];
function nativeLine(seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NATIVE_POOL[h % NATIVE_POOL.length];
}

function buildCaption({ persona, type, note, num, prompt, service, postKey, resend }) {
  // ШАПКА: хештег с именем модели и номер — по #полина в поиске Telegram находятся все её посты
  // (просьба владельца 03.08). Раньше имя шло обычным текстом и не искалось.
  // Осознанный повтор идёт под ТЕМ ЖЕ номером и с пометкой «замена»: иначе в группе появлялся
  // второй «Дарья #53» с теми же кадрами и было не понять, новый это пост или пересылка.
  const tag = `#${String(persona).toLowerCase().replace(/\s+/g, '')}`;
  const head = `${esc(tag)} ${num}` + (resend ? ' · замена' : '') + (type ? ` · ${esc(type)}` : '');
  if (!note) return head;
  // СЛУЖЕБНАЯ отправка: заметка как есть, без нарядов поста. Урок 04.08: технический
  // комментарий («лицо уплыло, пережимаю») прогнался через генератор заголовков и превратился
  // в бредовый «пост» — владелец увидел «почему лицо вышло живее, а поза как у манекена».
  if (service) return `${head}\n\n${esc(note)}`;
  // КАРТОЧКА (начальник 06.08): заголовок и описание РАЗДЕЛЬНО, чтобы копировать по частям.
  // Заголовок = первая строка подписи (catchy, НЕ хук с кадра), описание = остальное с
  // хештегами. Промптов в карточке нет, нативок «промпт ниже» нет.
  const lines = String(note).split('\n');
  const title = (lines[0] || '').trim();
  const rest = lines.slice(1).join('\n').trim();
  let out = head;
  if (title) out += `\n📌 заголовок\n<pre>${esc(title)}</pre>`;
  if (rest) out += `\n📝 описание\n<pre>${esc(rest)}</pre>`;
  return out;
}

// Полный промпт отдельным текстовым сообщением (лимит text 4096 против 1024 у подписи медиа).
async function sendPromptFull(prompt) {
  const p = String(prompt).trim().slice(0, 4000);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: `🧠 промпт\n<pre>${esc(p)}</pre>`, parse_mode: 'HTML' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram(prompt): ${j.description || r.status}`);
}

async function sendOne({ file, persona, type, note, num, prompt, service, postKey, resend }) {
  const isVideo = /\.(mp4|mov|m4v)$/i.test(file);
  const method = isVideo ? 'sendVideo' : (AS_DOC ? 'sendDocument' : 'sendPhoto');
  const field = isVideo ? 'video' : (AS_DOC ? 'document' : 'photo');
  const caption = buildCaption({ persona, type, note, num, prompt, service, postKey, resend });

  const form = new FormData();
  form.append('chat_id', CHAT);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  const src = prepPhoto(file);
  form.append(field, new Blob([fs.readFileSync(src)]), path.basename(src));
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`);
  return j;
}

// Карусель уходит одним альбомом: три отдельных сообщения в группе читаются как три разных поста.
async function sendAlbum({ files, persona, type, note, num, prompt, service, postKey, resend }) {
  const form = new FormData();
  form.append('chat_id', CHAT);
  // Тип у всех элементов альбома обязан совпадать: документы с фото в одной группе TG не смешивает.
  const media = files.map((f, i) => ({
    type: AS_DOC ? 'document' : 'photo',
    media: `attach://f${i}`,
    ...(i === 0 ? { caption: buildCaption({ persona, type, note, num, prompt, service, postKey, resend }), parse_mode: 'HTML' } : {}),
  }));
  form.append('media', JSON.stringify(media));
  files.forEach((f, i) => { const s = prepPhoto(f); form.append(`f${i}`, new Blob([fs.readFileSync(s)]), path.basename(s)); });
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`, { method: 'POST', body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`);
  return j;
}

(async () => {
  if (!TOKEN || !CHAT) { console.log('нет токена или чата (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'); process.exit(1); }
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  // МОДЕЛЬ ВЫЧИТЫВАЕМ ИЗ ИМЕНИ ФАЙЛА, если её не передали флагом (29.08). Посты называются
  // «сб2-очки-68-makeup-colortype-p972.mp4», то есть имя модели в них есть — а подпись в группе
  // всё равно говорила «без модели», и владелец не понимал, чьи ролики смотрит. Флаг --persona
  // по-прежнему главнее: он задан руками и знает больше, чем имя файла.
  const изИмени = () => {
    const ф = args.find((a) => !a.startsWith('--') && /\.(mp4|jpe?g|png)$/i.test(a));
    const m = ф && path.basename(ф).match(/^(?:сб\d-)?([А-Яа-яЁёA-Za-z]+)[-_]/);
    const имя = m && m[1];
    return (имя && !/^(кадр|frame|post|reel|video)$/i.test(имя)) ? имя : null;
  };
  const persona = val('--persona') || изИмени() || 'без модели';
  const type = val('--type');
  const note = val('--note');
  const service = args.includes('--service');
  // Промпт: ТОЛЬКО явный --prompt. Автоподбор по шаблону ВЫКЛЮЧЕН 06.08 (начальник: «промпт
  // не надо писать», логика описаний теперь «в нейронке готовый шаблон, за регу 50 ₽»).
  let prompt = val('--prompt');
  const carousel = args.includes('--carousel');
  // СПИСОК ФАЙЛОВ. Значение флага файлом не считаем: если в --key передали путь (а такое было),
  // старый фильтр брал этот путь ВТОРЫМ файлом, набор кадров становился «новым» и дедуп
  // обходился. Поэтому индексы значений известных флагов вычёркиваем.
  const VALUE_FLAGS = new Set(['--persona', '--type', '--note', '--prompt', '--key', '--template', '--force']);
  const taken = new Set();
  args.forEach((a, i) => { if (VALUE_FLAGS.has(a)) taken.add(i + 1); });
  // Один и тот же файл, переданный дважды, тоже не должен делать набор «новым».
  const seen = new Set();
  const files = args.filter((a, i) => !taken.has(i) && !a.startsWith('--') && fs.existsSync(a))
    .filter((f) => { let k; try { k = fs.realpathSync(f); } catch { k = f; } if (seen.has(k)) return false; seen.add(k); return true; });
  if (!files.length) { console.log('не передано ни одного существующего файла'); process.exit(1); }
  // КЛЮЧ ПРИВОДИМ К ОДНОМУ ВИДУ. Разные чаты передавали то `post:<id>`, то `<id>:v2`, и один
  // пост занимал в журнале несколько ключей, то есть уходил в группу несколько раз. Срезаем
  // приставку и суффиксы версий, а путь к файлу ключом не считаем вовсе: это и была та самая
  // «строка вместо ключа», из-за которой дедуп обходился.
  let postKey = val('--key');
  if (postKey) {
    postKey = String(postKey).trim().replace(/^post:/i, '').replace(/[:\-_]v\d+$/i, '');
    if (postKey.includes('/') || !postKey) {
      console.log(`⚠ --key «${val('--key')}» похож на путь, а не на id поста: игнорирую ключ, дедуп пойдёт по кадрам`);
      postKey = null;
    }
  }

  // --force ЧЕСТНЫЙ (06.08): раньше это был просто выключатель дедупа, и им пользовались молча,
  // отчего в группу и уходили одинаковые карточки. Теперь он требует причину прямо в команде:
  //   --force "обложка заменена"
  // Причина ложится в журнал рядом с записью, поэтому потом видно, зачем пост уходил дважды.
  const fi = args.indexOf('--force');
  let forceReason = null;
  if (fi >= 0) {
    const r = args[fi + 1];
    // причина не может быть флагом или файлом: иначе «--force --persona Дарья» проходило бы
    // как причина «--persona» и защита снова становилась выключателем
    if (!r || r.startsWith('--') || fs.existsSync(r) || r.trim().length < 5) {
      console.log('⛔ --force без причины запрещён. Надо так: --force "обложка заменена"');
      process.exit(1);
    }
    forceReason = r.trim();
  }

  // ОТПЕЧАТОК КАДРОВ считаем до всех проверок: он и есть ключ дедупа. Повторяющиеся кадры
  // внутри набора сворачиваем: два одинаковых кадра не делают карусель другим постом
  // (и наоборот, так набор [A] и [A,A] дают один и тот же отпечаток, обход закрыт).
  const framesAll = files.map(framePrint);
  const frames = framesAll.filter((h, i) => framesAll.indexOf(h) === i);
  const printKey = printKeyOf(frames);

  // Ожидание окна анти-лавины делаем ДО замка: держать замок журнала десять минут нельзя,
  // остальные процессы упрутся в таймаут.
  let waited = 0;
  for (;;) {
    const wait = floodWaitMs(loadState());
    if (wait <= 0) break;
    if (process.env.TG_FLOOD_OFF === '1') break;          // осознанный большой залп
    if (process.env.TG_NOWAIT === '1' || waited + wait > FLOOD_WAIT_CAP_MS) {
      console.log(`⛔ анти-лавина: за последние 10 минут в группу уже ушло ${FLOOD_MAX} карточек. `
        + `Ждать ${Math.ceil(wait / 60000)} мин. Пачками владелец их не смотрит; если залп нужен осознанно, TG_FLOOD_OFF=1`);
      process.exit(2);
    }
    console.log(`⏳ анти-лавина: уже ${FLOOD_MAX} карточек за 10 минут, жду ${Math.ceil(wait / 1000)} с`);
    await sleep(wait + 500);
    waited += wait + 500;
  }

  // ПОД ЗАМКОМ: проверяем дедуп и бронируем номер. Бронь пишется в журнал ДО отправки, иначе
  // два параллельных процесса успевают проверить журнал раньше, чем любой из них его обновит.
  let num = 0, resend = false, myTs = 0, prevRaw, prevAlias;
  const claim = await withLock(async () => {
    const st = loadState();
    const dup = findDup(st, { postKey, printKey, frames });
    if (dup && !forceReason) {
      const e = dup.e;
      const hang = e.pending && Date.now() - e.pending > PENDING_STALE_MS;
      // Записи бэкфилла номера не имеют: там известно только «владелец это уже видел».
      const nm = e.num ? `#${e.num}` : (e.backfill ? 'помечен бэкфиллом' : 'без номера');
      return { skip: `уже отправляли (${e.persona || persona} ${nm}${e.at ? ', ' + String(e.at).slice(0, 16) : ''}): ${dup.by}`
        + (hang ? '. Прошлая отправка не дозавершилась: если карточки в группе нет, повтори с --force "не дошло"' : '') };
    }
    const prev = dup ? dup.e : null;
    prevRaw = st.sent[printKey];                            // для честного отката, если не отправится
    prevAlias = postKey ? st.sent[`post:${postKey}`] : undefined;
    if (prev) { resend = true; num = prev.num || 0; }
    if (!num) { num = (st.counters[persona] || 0) + 1; st.counters[persona] = num; }
    myTs = Date.now();
    st.sent[printKey] = {
      num, persona, postId: postKey || null, at: new Date().toISOString(),
      files: files.map((f) => path.basename(f)), frames,
      sends: ((prev && prev.sends) || (prev ? 1 : 0)) + 1,
      // История принудительных повторов остаётся в журнале: по ней видно, сколько раз пост
      // уходил в группу и с какой причиной.
      forces: forceReason
        ? [...((prev && prev.forces) || []), { at: new Date().toISOString(), reason: forceReason, was: (prev && prev.at) || null }]
        : (prev && prev.forces) || undefined,
      pending: myTs,
    };
    if (postKey) st.sent[`post:${postKey}`] = { alias: printKey };
    st.flood = [...(st.flood || []).filter((t) => Date.now() - t < FLOOD_WIN_MS), myTs];
    saveState(st);
    return { ok: true };
  });
  if (claim.skip) { console.log(claim.skip + ', пропускаю'); return; }

  try {
    // id сообщений запоминаем: если дубль всё-таки уехал, по ним его можно найти и снести в
    // группе точечно, не перечитывая переписку глазами.
    const msgIds = [];
    const grab = (j) => { const r = j && j.result; for (const m of (Array.isArray(r) ? r : [r])) if (m && m.message_id) msgIds.push(m.message_id); };
    if (carousel && files.length > 1) grab(await sendAlbum({ files, persona, type: type || 'фотопост', note, num, prompt, service, postKey, resend }));
    else for (const f of files) grab(await sendOne({ file: f, persona, type, note, num, prompt, service, postKey, resend }));
    // Промпт отдельным сообщением: только при явном --prompt (по умолчанию промптов в ТГ нет).
    if (!service && prompt && String(prompt).trim().length > 600) await sendPromptFull(prompt);
    // Бронь закрываем: запись становится обычной «отправлено».
    await withLock(async () => {
      const st = loadState();
      const e = normEntry(st.sent[printKey]);
      if (e) { delete e.pending; e.msgIds = [...(e.msgIds || []), ...msgIds]; st.sent[printKey] = e; saveState(st); }
    });
    console.log(`✓ отправлено в ТГ: ${persona} #${num}${resend ? ` (замена, причина: ${forceReason})` : ''} (${files.length} файл(ов))`);
  } catch (e) {
    // Не отправилось: снимаем бронь и своё место в окне анти-лавины, чтобы повтор прошёл честно.
    // Номер персоны откатываем только если после нас никто его не занял.
    await withLock(async () => {
      const st = loadState();
      if (prevRaw === undefined) delete st.sent[printKey];
      else st.sent[printKey] = prevRaw;                      // возвращаем запись как была до брони
      if (postKey) {
        if (prevAlias === undefined) delete st.sent[`post:${postKey}`];
        else st.sent[`post:${postKey}`] = prevAlias;
      }
      if (!resend && st.counters[persona] === num) st.counters[persona] = num - 1;
      st.flood = (st.flood || []).filter((t) => t !== myTs);
      saveState(st);
    }).catch(() => {});
    // не глотаем: «отправил» при молчащей группе хуже, чем честная ошибка
    console.log(`⛔ не отправилось: ${e.message}`);
    process.exit(1);
  }
})();
