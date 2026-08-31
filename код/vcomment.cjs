// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
// Зрячий ответ В ВЕТКУ на рилсе. КЛЮЧ: ставим рилс на ПАУЗУ (клик по видео) — тогда лента не листается сама,
// целевой рилс держится. Потом открываем комменты и отвечаем спрашивающим. Скрин каждого шага — я проверяю ветку.
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const SLUG = process.argv[2]; const URL = process.argv[3]; const N = Number(process.argv[4] || 3);
// ЖЁСТКИЙ WATCHDOG (Main, крит-баг): процесс НЕ должен висеть. karter висел 46 мин на stopLocal в GoLogin-шторме →
// окно занимало слот, hammer не брал следующий акк. Кап на ВЕСЬ прогон — по истечении принудительный выход,
// окно догасит closelocal ЛОГГЕРА. KEEP_OPEN держим живым намеренно (не трогаем).
// Глобальные ссылки на активную облачную сессию — чтобы ЗАКРЫТЬ её при аварийном выходе (аудит 28.07:
// HARD-EXIT и SIGTERM убивали процесс, профиль оставался running и жёг оплаченные часы).
global.__CLOUD = { pid: null, tok: null };
global.__GL = null; // локальная Orbita — её тоже надо гасить, иначе окно-орфан и куки НЕ зальются в профиль
async function closeCloudSession(why) {
  const { pid, tok } = global.__CLOUD || {};
  if (!pid || !tok) return;
  try { await Promise.race([fetch('https://api.gologin.com/browser/' + pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]); console.log(`  ⏹ облачная сессия закрыта (${why})`); } catch {}
}
// ЕДИНОЕ аварийное закрытие: локальная Orbita (stopLocal+killBrowser) И облачная сессия. Защита от двойного
// сигнала. uncaught/unhandled тоже ловим — иначе Node валит процесс, оставляя окно и оплачиваемую сессию.
let __closing = false;
async function closeAll(why, code = 0) {
  if (__closing) return; __closing = true;
  const gl = global.__GL;
  if (gl) { try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch {} }
  await closeCloudSession(why);
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { closeAll(sig); });
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e && e.message); closeAll('uncaught', 1); });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e && e.message); closeAll('unhandled', 1); });
if (process.env.KEEP_OPEN !== '1') setTimeout(() => { console.log('⏱ HARD-EXIT watchdog — процесс не завершился вовремя, выхожу'); closeAll('hard-exit'); }, Number(process.env.HARD_EXIT_MS || 600000)).unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));
// БЕЗ длинного тире (—) — палит бота. Только запятая/короткое тире.
// БЕЗ рода: у части акков женские авы, поэтому НИКАКИХ «сделал/сделала, нашёл/нашла, собрал/собрала» —
// только императив/настоящее время/существительные, чтобы фраза не выдавала пол автора.
const BRAND = [
  'нейронка про, в яндексе вбей, там бесплатный шаблон',
  'в яндексе набери нейронка про, готовый промпт бесплатно',
  'это делается в нейронка про, найди в яндексе, бесплатно',
  'нейронка про поищи в яндексе, там всё готовое и бесплатно',
  'загляни в нейронка про (через яндекс), шаблон уже готов, бесплатно',
  'делаю через нейронка про) в яндексе найдёшь, бесплатно',
  'делаю это в нейронка про, реально бесплатно, вбей в яндексе',
  'у меня через нейронка про, там без впн и бесплатно, яндекс в помощь',
  'пользуюсь нейронка про, всё бесплатно и по-русски, в яндексе она',
  'нейронка про 🙌 в яндексе, бесплатно',
  'в яндексе: нейронка про, там шаблон)',
  'нейронка про, бесплатный промпт, яндекс',
  'через нейронка про, ищи в яндексе',
  'нейронка про в яндексе, всё там есть',
  'бесплатно всё в нейронка про, без впн, в яндексе набери',
  'нейронка про, всё на русском и бесплатно, вбей в яндекс',
  'там готовый промпт в нейронка про, бесплатно, через яндекс зайди',
  'шаблон уже готовый в нейронка про, ничего платить не надо, яндекс',
  'в нейронка про лежит готовый пресет, бесплатно, поищи в яндексе',
  'бери готовый промпт в нейронка про, бесплатно, в яндексе найди',
  'нейронка про, там всё готово под это, бесплатно, вбей в яндексе',
  'тоже это ищу) оказалось нейронка про, в яндексе, бесплатно',
  'это нейронка про делает, в яндексе находится, бесплатная',
  'ответ такой: нейронка про, бесплатно, просто в яндексе вбить',
  'если ещё актуально, нейронка про, яндекс, всё бесплатно',
  'отвечаю: через нейронка про, бесплатно, ищи в яндексе)',
  'глянь нейронка про, в яндексе первая, там бесплатно',
  'это нейронка про, набери в яндексе, всё готовое',
  'нейронка про попробуй, в яндексе ищи, денег не просит',
  'заходи в нейронка про через яндекс, там шаблон лежит',
  'ответ простой, нейронка про, в яндексе есть, бесплатно',
  'держи, нейронка про называется, в яндексе бесплатно',
  'в нейронка про всё есть, найди в яндексе, free',
  'нейронка про, вбиваешь в яндекс и готово, без оплаты',
  'нейронка про, в яндексе открой, платить не надо',
  'попробуй нейронка про, яндекс в помощь, всё бесплатно',
  'это через нейронка про, набери в яндексе, бесплатная',
  'нейронка про тебе нужна, в яндексе сверху, без денег',
  'нейронка про, ищи в яндексе, там и промпт и шаблон бесплатно',
  'лови нейронка про, вбей в яндекс, готовое и free',
  'нейронка про сайт, в яндексе находится, всё бесплатно',
  'через нейронка про делается, в яндексе поищи, бесплатно',
  'нейронка про, в яндекс введи, там всё под это заточено',
  'смотри нейронка про, яндекс открой и всё, бесплатно',
  'в яндексе нейронка про набери, там готовые пресеты бесплатно',
  'нейронка про, заходишь через яндекс, платить не просит',
  'это нейронка про, в яндексе ищется, всё на русском бесплатно',
  'нейронка про глянь, в яндексе первым делом, free и без впн',
  'бери нейронка про, в яндексе есть, ничего не стоит',
  'нейронка про, набери в яндексе, там прям готовое всё',
  'отвечаю коротко, нейронка про, яндекс, бесплатно',
  'нейронка про поищи в яндексе, там без регистрации бесплатно',
  'нейронка про, в яндексе набираешь и всё, free',
  'через яндекс нейронка про, там всё бесплатно и готово',
  'о, это нейронка про делает, в яндексе бесплатно',
  'нейронка про 🔥 в яндексе, ничего не стоит',
  'легко, нейронка про, в яндекс вбей',
  'нейронка про, там прям кнопка, в яндексе найди, бесплатно',
  'вот прям в нейронка про, яндекс открой, всё бесплатно',
  'нужна нейронка про, в яндексе набери, платить не надо',
  'через нейронка про, в яндексе секунда, всё готово бесплатно',
  'нейронка про 👌 яндекс, бесплатно и по-русски',
  'ток нейронка про, в яндексе, остальное платное',
  'нейронка про юзай, в яндексе есть, денег не берёт',
  'это всё нейронка про, вбей в яндекс, free',
  'нейронка про, набираешь в яндексе, готовый шаблон бесплатно',
  'нейронка про поможет, яндекс в помощь, бесплатная совсем',
  'бесплатно только в нейронка про, ищи в яндексе',
  'нейронка про, в поиске яндекса, всё уже собрано бесплатно',
  'зайди нейронка про, яндекс, там без оплаты всё',
  'нейронка про, вбиваешь яндекс, открывается бесплатно',
  'просто нейронка про, в яндексе, готовое и free',
  'нейронка про топчик, в яндексе бесплатно берёшь',
  'нейронка про, яндекс открой, там шаблоны бесплатно',
  'ответ: нейронка про, через яндекс, ничего не платишь',
  'бери в нейронка про, в яндексе первая ссылка, бесплатно',
  'нейронка про, в яндексе набери, дальше всё бесплатно',
  'нейронка про сделает, вбей в яндекс, платно не будет',
  'кинь в яндекс нейронка про, там готовое бесплатно',
  'нейронка про, в яндексе секунду, и всё бесплатно',
  'тут нейронка про нужна, в яндексе вбей, бесплатная',
  'в яндексе есть нейронка про, там бесплатно всё',
  'нейронка про, вбей в яндексе, дальше разберёшься, бесплатно',
  'на нейронка про сделано, в яндексе найдёшь, бесплатно',
  'нейронка про если что, в яндексе, всё без оплаты',
  'попробуй через яндекс, нейронка про, бесплатная',
  'нейронка про смотри, в яндексе набрать, там готовое',
  'нейронка про, оно в яндексе, платить не придётся',
  'юзай нейронка про, яндекс открой, всё бесплатно лежит',
  'там нейронка про называется, в яндексе, бесплатно',
  'ищи нейронка про в яндексе, там всё под это',
  'нейронка про, через яндекс зайти, бесплатно и по-русски',
  'подскажу, нейронка про, вбей в яндексе, бесплатно',
  'нейронка про открой через яндекс, там уже всё собрано',
  'нейронка про, набери в яндексе, ничего платить не нужно',
  'вот нейронка про, в яндексе поищи, всё бесплатное',
  'нейронка про, минута в яндексе и готово, без денег',
];
// БРЕНДОВЫЙ ТОП-ЛЕВЕЛ коммент (обращение ко ВСЕМ, не ответ конкретному) — тексты ОТДЕЛЬНЫЕ от ответов, без тире, без пола.
const BRAND_TOP = [
  'делаю такое в нейронка про, бесплатно, готовый шаблон, в яндексе найдёте',
  'юзаю нейронка про, там всё бесплатно и по-русски, в яндексе есть',
  'у меня это через нейронка про собрано, бесплатно, вбейте в яндекс',
  'собираю всё в нейронка про, бесплатно и без впн, в яндексе набрать',
  'это в нейронка про делается, бесплатно, готовые шаблоны, поищите в яндексе',
  'сижу в нейронка про, там готовые шаблоны бесплатно, в яндексе найдёте',
  'через нейронка про всё делаю, бесплатно, в яндексе вбейте, там готовое',
  'кайфую от нейронка про, всё бесплатно, в яндексе находится',
  'сижу на нейронка про, готовые шаблоны бесплатно, вбейте в яндекс',
  'нейронка про топ, делаю там всё без оплаты, в яндексе есть',
  'держу всё на нейронка про, бесплатно и по-русски, яндекс в помощь',
  'юзаю нейронка про под это, бесплатно, в яндексе набрать',
  'всё через нейронка про гоню, там бесплатно, поищите в яндексе',
  'нейронка про мой вариант, бесплатно, в яндексе открывается',
  'делаю в нейронка про, платить не надо, в яндексе готовое',
  'нейронка про советую, бесплатно всё, в яндексе найдёте',
  'нейронка про использую, всё бесплатно, в яндексе набрать',
  'у меня всё на нейронка про, бесплатно, поищите в яндексе',
  'нейронка про выручает, бесплатно, в яндексе находится',
  'собираю через нейронка про, платить не надо, яндекс в помощь',
  'нейронка про для этого беру, бесплатно, вбейте в яндекс',
  'торчу в нейронка про, готовое и бесплатно, в яндексе есть',
  'нейронка про топ для такого, бесплатно, в яндексе',
  'гоняю в нейронка про, без оплаты, поищите в яндексе',
  'нейронка про рекомендую, всё бесплатно, в яндексе найдёте',
  'через нейронка про удобно, бесплатно, в яндексе открывается',
  'нейронка про мне зашла, всё бесплатно, в яндексе найдёте',
  'работаю в нейронка про, платить не надо, вбейте в яндекс',
  'нейронка про пользуюсь давно, бесплатно, в яндексе есть',
  'нейронка про закрывает всё, бесплатно, поищите в яндексе',
  'нейронка про мой инструмент, без оплаты, в яндексе открывается',
  'нейронка про спасает, там готовое и бесплатно, яндекс в помощь',
  'нейронка про выбираю, всё бесплатно, в яндексе набрать',
  'нейронка про держу под рукой, бесплатно и по-русски, в яндексе найдёте',
];
// ГЕНДЕРНЫЕ пулы: добавляются к нейтральным ТОЛЬКО если у акка проставлен accounts.gender (male/female).
// Ник акка виден рядом с комментом, поэтому «сама делала» с ника Graham = палево. Без пола → только нейтральные.
const BRAND_M = [ // мужской род (ответы)
  'сам через нейронка про делал) в яндексе найдёшь, бесплатно',
  'тоже искал, оказалось нейронка про, в яндексе, бесплатно',
  'это нейронка про делает, я в яндексе нашёл, бесплатная',
  'нашёл ответ: нейронка про, бесплатно, просто в яндексе вбить',
  'сам пользуюсь нейронка про, в яндексе найдёшь, бесплатно',
  'я через нейронка про делал, вбей в яндекс, бесплатно',
  'сам сидел искал, нейронка про, в яндексе, бесплатно',
  'делал в нейронка про, в яндексе поищи, платить не надо',
  'я в нейронка про собрал, в яндексе найдёшь, бесплатно',
  'сам недавно нашёл, нейронка про, яндекс, всё бесплатно',
];
const BRAND_F = [ // женский род (ответы)
  'сама через нейронка про делала) в яндексе найдёшь, бесплатно',
  'тоже искала, оказалось нейронка про, в яндексе, бесплатно',
  'это нейронка про делает, я в яндексе нашла, бесплатная',
  'нашла ответ: нейронка про, бесплатно, просто в яндексе вбить',
  'сама пользуюсь нейронка про, в яндексе найдёшь, бесплатно',
  'я через нейронка про делала, вбей в яндекс, бесплатно',
  'сама сидела искала, нейронка про, в яндексе, бесплатно',
  'делала в нейронка про, в яндексе поищи, платить не надо',
  'я в нейронка про собрала, в яндексе найдёшь, бесплатно',
  'сама недавно нашла, нейронка про, яндекс, всё бесплатно',
];
const BRAND_TOP_M = [ // мужской род (топ-левел отзыв)
  'сам всё делал в нейронка про, бесплатно, в яндексе найдёте',
  'я нашёл нейронка про, там бесплатно, вбейте в яндекс',
  'сам сижу в нейронка про, платить не надо, в яндексе есть',
  'делал через нейронка про, бесплатно, поищите в яндексе',
  'сам проверял, нейронка про бесплатная, в яндексе открывается',
];
const BRAND_TOP_F = [ // женский род (топ-левел отзыв)
  'сама всё делала в нейронка про, бесплатно, в яндексе найдёте',
  'я нашла нейронка про, там бесплатно, вбейте в яндекс',
  'сама сижу в нейронка про, платить не надо, в яндексе есть',
  'делала через нейронка про, бесплатно, поищите в яндексе',
  'сама проверяла, нейронка про бесплатная, в яндексе открывается',
];
// === ПУЛ №2: ТГ-БОТ @gener7_bot (владелец, 24.07). Выбор site/bot на запуске (env DEST=bot). @-хендл НЕ варьируется
// (varyBrand его не трогает — он меняет только «нейронка про»). Нейтральные (без пола) + гендерные. Без «бесплатно», без тире.
const BOT = [ // нейтральные ответы (тг-бот)
  'бесплатно в тг боте @gener7_bot, кидаешь фото и готово',
  'через тг бота @gener7_bot, бесплатно и без впн',
  'это тг бот @gener7_bot, в телеге, бесплатно',
  'юзай @gener7_bot в телеграме, там бесплатно',
  'ответ: бот @gener7_bot в тг, всё сам делает',
  'делается в @gener7_bot, тг бот, бесплатно',
  'бот в телеге @gener7_bot, бесплатно, по-русски',
  'кидай фото в @gener7_bot, тг бот, готово бесплатно',
  'всё через @gener7_bot, это тг бот, бесплатный',
  'заходи в @gener7_bot, бот в телеграме, бесплатно',
  'проще в тг: бот @gener7_bot, бесплатно всё',
  'бот @gener7_bot в телеге делает, платить не надо',
  'через @gener7_bot, тг бот, готовое и бесплатно',
  'попробуй @gener7_bot в тг, там бесплатно',
  'это @gener7_bot, телеграм бот, бесплатно и просто',
];
const BOT_TOP = [ // топ-левел бренд тг-бота (15 вариаций владельца 25.07): бесплатный бот + бесплатные генерации + готовый шаблон
  'Бесплатный рабочий бот @gener7_bot, там бесплатные генерации и готовый шаблон',
  '@gener7_bot в тг, бесплатные генерации и готовый шаблон, реально работает',
  'юзаю @gener7_bot, бесплатно генерит, шаблон уже готовый внутри',
  '@gener7_bot бот бесплатный, генерации не платные, шаблон готовый есть',
  'в тг бот @gener7_bot, бесплатные генерации, готовый шаблон, всё пашет',
  '@gener7_bot, там бесплатно генерит по готовому шаблону',
  'рабочий бот @gener7_bot в телеге, бесплатные генерации и шаблон готовый',
  '@gener7_bot, бесплатные генерации и готовый пресет, реально рабочий',
  'через @gener7_bot, бесплатно, генерации и готовый шаблон в боте',
  'бот @gener7_bot бесплатный, генерит по готовому шаблону, в тг',
  '@gener7_bot в тг, бесплатные генерации, шаблон готовый, всё бесплатно',
  'держи @gener7_bot, там бесплатные генерации и готовый шаблон',
  '@gener7_bot рабочий бот, генерит бесплатно, шаблон уже внутри',
  'в телеге @gener7_bot, бесплатно генерит и готовый шаблон, топ',
  '@gener7_bot, бесплатные генерации, готовый шаблон, ничего не платишь',
];
const BOT_M = [ // мужской род (ответы, тг-бот)
  'сам через @gener7_bot делал, тг бот, бесплатно',
  'нашёл ответ: бот @gener7_bot в телеге, бесплатно',
  'я в @gener7_bot собрал, тг бот, бесплатно',
  'сам юзаю @gener7_bot, бот в телеграме, бесплатно',
  'делал в @gener7_bot, тг бот, платить не надо',
];
const BOT_F = [ // женский род (ответы, тг-бот)
  'сама через @gener7_bot делала, тг бот, бесплатно',
  'нашла ответ: бот @gener7_bot в телеге, бесплатно',
  'я в @gener7_bot собрала, тг бот, бесплатно',
  'сама юзаю @gener7_bot, бот в телеграме, бесплатно',
  'делала в @gener7_bot, тг бот, платить не надо',
];
const BOT_TOP_M = [ // мужской род (топ-левел, тг-бот)
  'сам всё делал в @gener7_bot, тг бот, бесплатно',
  'я нашёл @gener7_bot, бот в телеге, бесплатно',
  'сам сижу в @gener7_bot, платить не надо, тг бот',
];
const BOT_TOP_F = [ // женский род (топ-левел, тг-бот)
  'сама всё делала в @gener7_bot, тг бот, бесплатно',
  'я нашла @gener7_bot, бот в телеге, бесплатно',
  'сама сижу в @gener7_bot, платить не надо, тг бот',
];
// ГАРД ЗАПРЕТНЫХ СЛОВ (правило владельца): такие слова в комментах не публикуем никогда.
const BANNED_WORDS = [/даром/i];
const hasBanned = (t) => BANNED_WORDS.some((r) => r.test(String(t || '')));
const noDash = s => String(s).replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');
// Ротация НАПИСАНИЯ бренд-токена (владелец): ломаем exact-match подпись «нейронка про» — главный флаг IG для
// бренда/ссылки. Латиница/точка/склонение читаются человеком как тот же бренд, но не совпадают байт-в-байт →
// 4× эффективная вариативность фраз + резко меньше share-restrict (не матчится как известный линк-паттерн).
// 09.08 (правка начальника): один из десяти комментов пишет бренд БЕЗ кавычек и в виде домена,
// «нейронка.про». Человек читает это как адрес и идёт искать сам, а exact-match подпись «нейронка
// про» при этом не набирается: чем реже повторяется одно написание, тем меньше поводов у IG
// считать нас сеткой. Домен занимает 1 позицию из 10, остальные девять это старая ротация.
const BRAND_SPELL = ['neironka pro', 'нейронка.про', 'neironka. pro', 'нейронка про',
  'neironka pro', 'нейронка про', 'neironka. pro', 'нейронка про', 'neironka pro', 'нейронка.про'];
const varyBrand = (s, i) => {
  const v = BRAND_SPELL[((i % BRAND_SPELL.length) + BRAND_SPELL.length) % BRAND_SPELL.length];
  return String(s)
    // склонённая «в нейронке про» — ТОЛЬКО там, где уже есть предлог «в» (иначе двойной предлог/кривизна).
    // Без \b: в JS \b не работает с кириллицей, иначе ветка не срабатывала. «в нейронка про» встречается только целенаправленно.
    .replace(/в нейронка про/gi, (i % 3 === 2) ? 'в нейронке про' : 'в ' + v)
    .replace(/нейронка про/gi, v);
};
async function ask(b64, sys, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-4o', max_tokens: 300, messages: [{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }] }), signal: AbortSignal.timeout(45000) }).then(r => r.json()).catch(() => null);
  const t = res && res.choices && res.choices[0] && res.choices[0].message.content || '';
  try { return JSON.parse((t.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { return {}; }
}
const FIND_SYS = `Instagram reel comment panel screenshot. Find a GENUINE ASKER — a short comment that ASKS how to do it / for the prompt / the ChatGPT bot, like just "промт","промпт","чат","чат гпт","gpt","бот","как?","how?","prompt?". Return their exact @handle (the username shown above their comment). SKIP any comment that ANSWERS or mentions "нейронк","бесплатно","в яндексе","шаблон", a website/link (those are ours or competitors, not askers). Reply ONLY JSON {"found":true|false,"user":"exact_handle_without_@","reply_x":<0..1>,"reply_y":<0..1>}. reply_x,reply_y = center of that comment's "Ответить"/"Répondre"/"Reply" link. {"found":false} if no genuine asker visible.`;
// ЗРЯЧАЯ проверка reply-режима ПЕРЕД публикацией: коммент уйдёт в ВЕТКУ или отдельным? Смотрим на плашку над полем ввода.
const REPLY_CHECK_SYS = `You look at a screenshot of the Instagram comment box at the bottom of the panel. Decide if the comment being typed will post as a NESTED REPLY to a specific person or as a NEW TOP-LEVEL comment. It is a REPLY only if there is a small label/pill DIRECTLY ABOVE the text input that says "Replying to <username>" or "Ответ пользователю <username>" (a cancel ✕ is usually next to it). If there is NO such label above the input (just a plain "Add a comment…"/"Добавьте комментарий…" box), it is a TOP-LEVEL comment. Reply ONLY JSON {"reply": true|false, "user": "<username after Replying to, or empty>"}.`;
async function visionReply(page) {
  try { const shot = ((await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)))).toString('base64');
    return (await ask(shot, REPLY_CHECK_SYS, 'Is the comment box in reply-to-someone mode (label above input) or a plain top-level box?')) || {};
  } catch { return {}; }
}
(async () => {
  if (!SLUG || !URL) { console.log('usage: <slug> <url> [n]'); return; }
  const CODE = (URL.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1] || URL;
  // Публичный DB-прокси Railway флапает (режет коннект) → грузим стартовые данные с ретраями.
  // Держим соединение открытым МИНИМУМ (только эти запросы), т.к. через долгий коннект к GoLogin idle-соединение всё равно умрёт.
  async function loadDb() {
    let last;
    for (let k = 0; k < 5; k++) {
      const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
      try {
        await c.connect();
        const a = (await c.query(`SELECT id, gologin_profile_id, gender, ig_login, ig_password, ig_email, ig_email_password, totp_secret FROM accounts WHERE slug=$1 AND platform='comments'`, [SLUG])).rows[0];
        const gt = (await c.query(`SELECT g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0].gologin_token;
        await c.query(`CREATE TABLE IF NOT EXISTS post_answered (code text, username text, ts timestamptz DEFAULT now(), PRIMARY KEY(code, username))`).catch(() => {});
        const answered = new Set((await c.query(`SELECT username FROM post_answered WHERE code=$1`, [CODE]).catch(() => ({ rows: [] }))).rows.map(r => r.username));
        // НАШИ акки-боты (по их IG-логинам) — чтобы НЕ отвечать самим себе/друг другу (палево фермы).
        const ours = new Set((await c.query(`SELECT lower(ig_login) u FROM accounts WHERE platform='comments' AND ig_login IS NOT NULL AND ig_login<>''`).catch(() => ({ rows: [] }))).rows.map(r => r.u));
        await c.end();
        return { a, gt, answered, ours };
      } catch (e) { last = e; await c.end().catch(() => {}); console.log('db try' + k + ': ' + e.code); await sleep(2500); }
    }
    throw last;
  }
  const { a, gt, answered, ours } = await loadDb();
  if (process.env.GL_LOCAL !== '1') global.__CLOUD = { pid: a && a.gologin_profile_id, tok: gt }; // только облако (локалку гасит __GL)
  const OURS = ours || new Set();
  // ПРАВИЛО ВЛАДЕЛЬЦА (24.07): облачная сессия НЕ должна жить/висеть дольше лимита и красть часы GoLogin. Через
  // MAX_SESSION_MS принудительно ЗАКРЫВАЕМ сессию (DELETE /web) и выходим — даже если main-поток застрял на чём-то.
  // unref: не держит event-loop. Отдельно от HARD_EXIT (тот exit без закрытия). SCAN-режим не трогаем (там нет постинга).
  if (process.env.SCAN !== '1' && a && a.gologin_profile_id && gt) {
    const MAX_SESSION_MS = Number(process.env.MAX_SESSION_MS) || 4 * 60 * 1000;
    setTimeout(() => {
      console.log(`⏱ сессия достигла ${Math.round(MAX_SESSION_MS / 60000)}мин — ПРИНУДИТЕЛЬНО закрываю облачную сессию (не крадём часы)`);
      fetch(`https://api.gologin.com/browser/${a.gologin_profile_id}/web`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + gt }, signal: AbortSignal.timeout(10000) }).catch(() => {}).finally(() => process.exit(1));
    }, MAX_SESSION_MS).unref();
  }
  // ПУЛЫ ФРАЗ под пол акка: нейтральные всегда + гендерные, если пол задан (иначе рассинхрон «ник Graham + сама делала»).
  const GEN = String((a && a.gender) || '').toLowerCase();
  // DEST — куда ведём: 'bot' (тг-бот @gener7_bot) или 'site' (нейронка про, дефолт). Выбор владельца на запуске.
  const DEST = String(process.env.POOL_DEST || 'site').toLowerCase() === 'bot' ? 'bot' : 'site';
  const RPOOL = DEST === 'bot' ? BOT : BRAND, RPOOL_M = DEST === 'bot' ? BOT_M : BRAND_M, RPOOL_F = DEST === 'bot' ? BOT_F : BRAND_F;
  const TPOOL = DEST === 'bot' ? BOT_TOP : BRAND_TOP, TPOOL_M = DEST === 'bot' ? BOT_TOP_M : BRAND_TOP_M, TPOOL_F = DEST === 'bot' ? BOT_TOP_F : BRAND_TOP_F;
  const POOL = [...RPOOL, ...(GEN === 'male' ? RPOOL_M : GEN === 'female' ? RPOOL_F : [])];
  const POOL_TOP = [...TPOOL, ...(GEN === 'male' ? TPOOL_M : GEN === 'female' ? TPOOL_F : [])];
  console.log(`НАЗНАЧЕНИЕ: ${DEST === 'bot' ? 'ТГ-БОТ @gener7_bot' : 'сайт нейронка про'} | пол акка: ${GEN || '(нейтральные)'} | фраз: ответы ${POOL.length}, отзывы ${POOL_TOP.length}`);
  // Автопометка «акк в блоке у автора этого поста» (страница недоступна именно ему) — чтобы панель не предлагала его.
  async function recordBlock() {
    if (!a || !a.id) return;
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try {
      await cc.connect();
      await cc.query(`INSERT INTO post_account_blocks(code,account_id,blocked,checked_at) VALUES($1,$2,true,now()) ON CONFLICT(code,account_id) DO UPDATE SET blocked=true, checked_at=now()`, [CODE, a.id]);
      console.log('  🚫 акк помечен в блоке у автора поста', CODE);
    } catch (e) { console.log('  (не записал блок:', (e.message || '').slice(0, 40) + ')'); } finally { await cc.end().catch(() => {}); }
  }
  // ПОСТ-ЛЕВЕЛ блок: автор ОГРАНИЧИЛ/ОТКЛЮЧИЛ комменты («Комментарии к этой публикации ограничены») — постить нельзя
  // НИКОМУ (нет поля ввода). Пишем в post_restricted → supervisor выкидывает пост из очереди (не гоним туда 60 акков).
  async function recordPostRestricted() {
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try {
      await cc.connect();
      await cc.query(`CREATE TABLE IF NOT EXISTS post_restricted (code text PRIMARY KEY, ts timestamptz DEFAULT now())`).catch(() => {});
      await cc.query(`INSERT INTO post_restricted(code) VALUES($1) ON CONFLICT(code) DO UPDATE SET ts=now()`, [CODE]).catch(() => {});
      console.log('  ⛔ пост', CODE, 'в post_restricted (комменты ограничены автором) — выкинут из очереди');
    } catch (e) { console.log('  (не записал restricted:', (e.message || '').slice(0, 40) + ')'); } finally { await cc.end().catch(() => {}); }
  }
  // КАПЧА = акк спалён (IG требует «подтвердите что вы человек»). Капчу НЕ решаем. Помечаем акк мёртвым (dead+challenge)
  // → авто-выпадает из пула (supervisor берёт только live+login_ok) + пишем в captcha_dead (список на снос).
  async function recordCaptcha() {
    if (!a || !a.id) return;
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try {
      await cc.connect();
      // status='paused' ОБЯЗАТЕЛЕН: без него прод maybeReplaceBlocked (требует paused) не снесёт/не заменит спалённый
      // капчей акк, а maybeRelogin будет впустую жечь попытки входа. С paused+challenge — авто-снос и замена из очереди.
      await cc.query(`UPDATE accounts SET session_status='dead', ig_status='challenge', status='paused', commenting_at=NULL WHERE id=$1`, [a.id]);
      await cc.query(`CREATE TABLE IF NOT EXISTS captcha_dead (slug text PRIMARY KEY, ig_login text, ts timestamptz DEFAULT now())`).catch(() => {});
      await cc.query(`INSERT INTO captcha_dead(slug,ig_login) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET ts=now()`, [SLUG, a.ig_login || null]).catch(() => {});
      console.log(`  ☠ КАПЧА у ${SLUG} → акк помечен мёртвым (dead+challenge), выведен из пула, в список на снос`);
    } catch (e) { console.log('  (не записал капчу:', (e.message || '').slice(0, 40) + ')'); } finally { await cc.end().catch(() => {}); }
  }
  // Живой статус для дашборда: что акк комментит СЕЙЧАС + счётчик комментов за день.
  async function dbExec(sql, params) {
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try { await cc.connect(); await cc.query(sql, params); } catch {} finally { await cc.end().catch(() => {}); }
  }
  // === Task B: PRODUCER спроса → duty_campaign (контракт с ДЕЖУРСТВОМ) ===
  // SCAN измерил N лидов на посту → заводим/обновляем кампанию спроса. Consumer (широкий commenter) читает
  // open-кампании по priority DESC и сам применяет frontload/per_day. Полоса lane='demand' (спрос, пишет ПОСТИНГ)
  // отделена от lane='duty' (горячий пост дежурства). budget = min(N, CAP). Гейт CAMPAIGN_PRODUCER=1.
  // Fail-safe: если колонки lane ещё нет (миграция schema.sql:569 не накатана) — НЕ пишем, чтобы дефолт 'duty'
  // не утащил спрос-строку в чужую полосу. По конфликту растим budget/priority (GREATEST), НЕ трогаем
  // status/per_day/window_days (не воскрешаем закрытую кампанию, не перетираем тюнинг consumer'а).
  async function upsertDemandCampaign(nLeads, nUnansweredFresh) {
    const CAP = Number(process.env.BUDGET_CAP || 250);
    const budget = Math.max(1, Math.min(nLeads | 0, CAP));
    const perDay = Number(process.env.PER_DAY_BASE || 40);
    const windowD = Number(process.env.WINDOW_DAYS || 5);
    const bots = Number(process.env.CAMPAIGN_BOTS || 3);
    const priority = 100 + Math.min(nLeads | 0, 400); // больше спроса → выше в очереди consumer'а
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try {
      await cc.connect();
      const hasLane = (await cc.query(`SELECT 1 FROM information_schema.columns WHERE table_name='duty_campaign' AND column_name='lane'`)).rowCount > 0;
      if (!hasLane) { console.log('  ⚠ duty_campaign.lane не мигрирован (schema.sql-деплой ждёт) → кампанию НЕ завожу'); return; }
      const note = `demand: N=${nLeads}, fresh_unans=${nUnansweredFresh}`;
      await cc.query(
        `INSERT INTO duty_campaign (code, url, budget, per_day, window_days, bots, priority, status, lane, note, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open','demand',$8, now())
         ON CONFLICT (code) DO UPDATE SET
           url = EXCLUDED.url,
           budget = GREATEST(duty_campaign.budget, EXCLUDED.budget),
           priority = GREATEST(duty_campaign.priority, EXCLUDED.priority),
           lane = 'demand',
           note = EXCLUDED.note`,
        [CODE, URL, budget, perDay, windowD, bots, priority, note]);
      console.log(`  📣 КАМПАНИЯ спроса upsert: code=${CODE} budget=${budget} per_day=${perDay} priority=${priority} lane=demand (N=${nLeads}, свежих неотв=${nUnansweredFresh})`);
    } catch (e) { console.log('  (кампанию спроса не завёл:', (e.message || '').slice(0, 60) + ')'); }
    finally { await cc.end().catch(() => {}); }
  }
  // IG-ОГРАНИЧЕНИЕ «Вы не можете делиться ссылками» (модалка «Мы установили ограничение для вашего аккаунта»):
  // наш бренд «нейронка про/яндекс» IG считает ссылкой → коммент НЕ публикуется, а композер может очиститься →
  // ЛОЖНЫЙ успех. Ограничение временное (~месяц), но пока активно акк для бренда бесполезен → карантин.
  const SHARE_RX = /установили ограничение|не можете делиться ссылк|can.?t share links|restricted from sharing|ограничение для вашего аккаунт/i;
  const shareRestricted = () => page.getByText(SHARE_RX).first().isVisible().catch(() => false);
  async function recordShareRestrict() {
    if (!a || !a.id) return;
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try {
      await cc.connect();
      await cc.query(`UPDATE accounts SET ig_status='restricted', commenting_at=NULL WHERE id=$1`, [a.id]);
      await cc.query(`CREATE TABLE IF NOT EXISTS share_restricted (slug text PRIMARY KEY, ig_login text, ts timestamptz DEFAULT now())`).catch(() => {});
      await cc.query(`INSERT INTO share_restricted(slug,ig_login) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET ts=now()`, [SLUG, a.ig_login || null]).catch(() => {});
      console.log(`  🔗⛔ ${SLUG}: IG-ограничение «нельзя делиться ссылками» → карантин (ig_status=restricted, из пула вон)`);
    } catch (e) { console.log('  (не записал share-restrict:', (e.message || '').slice(0, 40) + ')'); } finally { await cc.end().catch(() => {}); }
  }
  const setCommenting = (on) => a && a.id ? dbExec(on
    ? `UPDATE accounts SET commenting_post=$2, commenting_at=now() WHERE id=$1`
    : `UPDATE accounts SET commenting_at=NULL WHERE id=$1`, on ? [a.id, CODE] : [a.id]) : Promise.resolve();
  const bumpComment = () => a && a.id ? dbExec(
    `UPDATE accounts SET comments_today=(CASE WHEN comments_day=current_date THEN comments_today ELSE 0 END)+1,
       comments_day=current_date, last_commented_at=now(), commenting_post=$2, commenting_at=now() WHERE id=$1`, [a.id, CODE]) : Promise.resolve();
  console.log(`уже отвечено по посту (др. аккам): ${answered.size} чел | наших ботов в скипе: ${OURS.size}`);
  const newAnswered = []; // кому ответили в этом прогоне — запишем в БД одним заходом в конце
  await setCommenting(true).catch(() => {}); // дашборд: акк «онлайн, комментит <пост>»
  // СЕМАФОР СЛОТОВ GoLogin (Main): комментинг потребляет пул 'commenting' cap=7 из общих 15. Берём слот ПЕРЕД connect,
  // освобождаем в finally. claim возвращает uuid слота (или NULL если пул полон → ждём). Fail-safe: нет функции → идём без.
  async function claimSlot() {
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try { await cc.connect(); const r = await cc.query(`SELECT claim_gologin_slot('commenting', $1, 7, 15) AS id`, [SLUG]); return r.rows[0] ? r.rows[0].id : null; }
    catch { return 'NOFUNC'; } finally { await cc.end().catch(() => {}); }
  }
  async function releaseSlot(id) {
    if (!id || id === 'NOFUNC') return;
    const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
    try { await cc.connect(); await cc.query(`SELECT release_gologin_slot($1::uuid)`, [id]); } catch {} finally { await cc.end().catch(() => {}); }
  }
  let slotId = null;
  if (process.env.GL_LOCAL !== '1' && process.env.SLOT_OFF !== '1') { // локалка не жрёт облачный пул
    for (let s = 0; s < 6 && !slotId; s++) {
      slotId = await claimSlot();
      if (slotId === 'NOFUNC') { console.log('  (семафор слотов недоступен — иду без него)'); break; }
      if (!slotId) { console.log(`  ⏳ пул 'commenting' полон (${s + 1}/6) — жду слот 15с`); await sleep(15000); }
    }
    if (!slotId) { console.log('  ⏸ слот не получен (лимит пула, НЕ мёртвый профиль) → пропуск акка'); await setCommenting(false).catch(() => {}); return; }
  }
  // GL_LOCAL=1 → браузер поднимается ЛОКАЛЬНО (Orbita на этой машине) через СВОЙ прокси профиля; иначе облако GoLogin.
  let b, glLocal = null;
  if (process.env.GL_LOCAL === '1') {
    try {
      const { default: GoLogin } = await import('gologin');
      // resolution 1280×900 — окно совпадает с калибровкой координат панели (иначе окно 2560 → клики мимо).
      // uploadCookiesToServer: inline-логин (и обычная сессия) СОХРАНЯЕТСЯ в облачный профиль при stopLocal({posting:true}).
      // Без него куки входа выбрасываются при закрытии → акк снова «разлогинен». Обязательно для ЧП-модели inline-логина.
      glLocal = global.__GL = new GoLogin({ token: gt, profile_id: a.gologin_profile_id, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 } });
      const r = await glLocal.startLocal();
      b = await chromium.connectOverCDP(r.wsUrl, { timeout: 60000 });
      console.log('локальный GoLogin: браузер поднят (' + r.wsUrl.slice(0, 30) + '…)');
    } catch (e) { console.log('локальный старт err: ' + String(e.message).slice(0, 90)); }
  } else {
    const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', gt); u.searchParams.set('profile', a.gologin_profile_id);
    for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch (e) { console.log('коннект try' + k); await sleep(k === 0 ? 22000 : 14000); } }
  }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); await closeCloudSession('no-connect'); if (glLocal) await Promise.race([glLocal.stopLocal().catch(() => {}), sleep(6000)]); await releaseSlot(slotId).catch(() => {}); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  try {
    // ЭКОНОМИЯ ТРАФИКА прокси: режем видео/аудио/медиа + КАРТИНКИ + ШРИФТЫ (главный расход байт на заходе).
    // Комментингу нужен только DOM (текст комментов + кнопки), не пиксели. KEEP_IMAGES=1 — вернуть картинки.
    const keepImg = /^(1|true|yes)$/i.test(String(process.env.KEEP_IMAGES || ''));
    // Route на CONTEXT (не page): рилс может открыть попап/новую вкладку — фильтр покрывает ВСЕ вкладки контекста.
    // ДЫРА (Main 22.07): IG-рилс тянет видео НЕ .mp4-файлом, а СЕГМЕНТАМИ MSE — .m4s / range-запросы (bytestart=/byteend=)
    // с resourceType=xhr, хост *.cdninstagram.com / *.fbcdn.net, путь /v/ или /o1/. Они проходили мимо фильтра → байты жрались.
    // НЕ режем: graphql / /api/ / /comments/ / query — это коммент-XHR, их грузим (иначе панель пустая).
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      const u = route.request().url();
      if (/graphql|\/api\/|\/comments\/|\bquery\b/i.test(u)) return route.continue().catch(() => {});
      if (t === 'media' || t === 'font' || (!keepImg && t === 'image')
        || /\.(mp4|m4v|m4a|mp3|webm|mov)(\?|$)/i.test(u) || /video|\.cdninstagram.*\.mp4/i.test(u)
        || /\.m4s(\?|$)/i.test(u) // MSE-сегменты видео
        || /(scontent|cdninstagram|fbcdn)[^ ]*\/(v|o1)\/[^ ]*\.(mp4|m4s|m4v|webm)/i.test(u) // CDN-видео по пути /v/ и /o1/
        || (/bytestart=/i.test(u) && /(cdninstagram|fbcdn|scontent)/i.test(u)) // range-видео (сегменты кусками)
      ) return route.abort().catch(() => {});
      route.continue().catch(() => {});
    }).catch(() => {});
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    // ФОРСИРУЕМ русскую локаль UI (hl=ru): GoLogin выдаёт профилю случайный язык IG (RU/EN/ES/AR…), из-за чего
    // селекторы кнопок «Ответить/Комментировать» ломались. С hl=ru интерфейс всегда русский → детерминированно.
    const goURL = URL + (URL.includes('?') ? '&' : '?') + 'hl=ru';
    await page.goto(goURL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    // Ждём РЕАЛЬНУЮ загрузку рилса (экшн-бар с иконкой комментов), а не сплэш «from Meta» — на медленных KZ-прокси
    // 4с мало и всё падало. Поллим до ~30с, при застревании на сплэше — релоадим (до 3 раз).
    // РЕЛОАД УБРАН (2026-07-21): page.goto-релоад коррелировал с капчами (graham, clarence — оба «релоад → КАПЧА»).
    // Вместо реролада ждём ДОЛЬШЕ (~30с) — сплэш обычно рассасывается сам. Не догрузился → панель не откроется →
    // безвредный nofirst (акк идёт дальше), а НЕ сожжённый капчей акк. Экономим акки > экономим секунды.
    for (let ld = 0; ld < 7; ld++) {
      await sleep(ld === 0 ? 5000 : 4500);
      const loaded = (await page.locator('svg[aria-label*="оммент" i], svg[aria-label*="omment" i], svg[aria-label*="omentar" i], svg[aria-label*="تعليق"], svg[aria-label*="コメント"], svg[aria-label*="댓글"], svg[aria-label*="评论"], svg[aria-label*="評論"], svg[aria-label*="Kommentar" i], svg[aria-label*="Yorum" i], svg[aria-label*="Commento" i], svg[aria-label*="Bình luận" i], svg[aria-label*="ความคิดเห็น"]').count().catch(() => 0)) > 0
        || (await page.getByText(/страница недоступна|isn.?t available|not be available/i).count().catch(() => 0)) > 0;
      if (loaded) break;
    }
    // КАПЧА / «подтвердите что вы человек» = акк спалён (чек-поинт IG). Капчу НЕ решаем — помечаем акк мёртвым и выходим.
    const captcha = await page.getByText(/подтвердите,? что вы человек|confirm you.?re human|введите код с изображени|enter the code from the image|подтвердите свою личность|help us confirm/i).first().isVisible().catch(() => false);
    if (captcha) { console.log('  ☠ КАПЧА на странице — акк спалён, не решаем, выходим'); await recordCaptcha(); await b.close().catch(() => {}); return; }
    // Cookie-баннер IG. Он ПЕРЕКРЫВАЕТ панель комментов, и без дисмисса заход даёт «кнопок 0» —
    // выглядит как «панель не открылась», хотя акк живой (ловили на parker80937/jaquan2035 21.07.2026).
    // Порядок строгий: сначала ОТКЛОНИТЬ необязательные (приватнее), «разрешить все» — только если отказа нет.
    // Баннер приезжает с задержкой, поэтому не один клик с таймаутом 2.5с, а несколько попыток.
    const DECLINE = /Decline optional cookies|Отклонить (дополнительные|необязательные)|Only allow essential|Отклонить все/i;
    const ALLOW = /Allow all cookies|Разрешить все файлы cookie|Accept all/i;
    const dismissCookies = async () => {
      for (let i = 0; i < 4; i++) {
        const onConsent = /\/consent\//i.test(page.url()); // ПОЛНАЯ страница согласия (не маленький баннер)
        for (const rx of [DECLINE, ALLOW]) {
          const btn = page.getByRole('button', { name: rx }).first();
          if (await btn.isVisible().catch(() => false)) {
            // реальный клик МЫШЬЮ по центру: полностраничный /consent/ синтетический .click() игнорирует (начальник 23.07, aaden завис)
            const bb = await btn.boundingBox().catch(() => null);
            if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); else await btn.click({ timeout: 4000 }).catch(() => {});
            console.log(`  🍪 куки: ${rx === DECLINE ? 'отклонили необязательные' : 'разрешили (деклайна не было)'}${onConsent ? ' [полная /consent/ страница]' : ''}`);
            if (onConsent) { for (let w = 0; w < 12; w++) { if (!/\/consent\//i.test(page.url())) break; await sleep(1000); } } // ждём УХОДА с /consent/ после submit
            else await sleep(1500);
            if (!/\/consent\//i.test(page.url())) return true;
          }
        }
        await sleep(2000);
      }
      return false;
    };
    await dismissCookies();
    // ГАУНТЛЕТ интерстишелов (начальник 23.07, aaden завис): после consent IG кидает «Turn on Notifications»/«Save info»
    // + иногда выбрасывает на ЛЕНТУ (не рил). Гасим модалки РАНО (до открытия панели) + возвращаемся на рил.
    const dismissModals = async () => {
      for (const rx of [/^\s*Not Now\s*$/i, /^\s*Не сейчас\s*$/i, /^\s*Later\s*$/i, /^\s*Позже\s*$/i, /^\s*Save Info\s*$/i]) {
        const b = page.getByRole('button', { name: rx }).first();
        if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(900); }
      }
    };
    await dismissModals();
    if (!page.url().includes(CODE)) { console.log('  ↩ выкинуло с рила → возвращаюсь на рил'); await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(3000); await dismissCookies().catch(() => {}); await dismissModals(); }
    const vp = page.viewportSize() || { width: 1280, height: 900 };
    // 1) ПАУЗА рилса — клик по центру видео (чтобы лента не листалась сама)
    await page.mouse.click(Math.round(vp.width * 0.47), Math.round(vp.height * 0.5)).catch(() => {});
    await sleep(1500);
    require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_paused.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
    // 2) открыть панель комментов. Экшн-бар рилса стабилен: значок комментов (спич-бабл со счётчиком) —
    //    2-й сверху справа, ~x=0.69 y=0.645. Клик по фиксу надёжнее зрения (оно мазало в стрелку).
    // Открыть панель комментов по СЕЛЕКТОРУ значка (экшн-бар плавает — фикс-коорд мазал в лайк). Рилс на
    // паузе → клик по значку откроет панель, не пролистнёт. Значок = SVG комментов (мультиязык aria).
    const REPLY_ANY = /^(Répondre|Ответить|Reply|Antworten|Responder|Yanıtla|Komentari|Balas|Rispondi|رد)$/i;
    // проверка: открыта ли панель (появились кнопки «Ответить» или поле ввода коммента)
    const panelOpen = async () => (await page.getByText(REPLY_ANY).count().catch(() => 0)) > 0
      || (await page.locator('textarea[aria-label], form textarea, div[contenteditable="true"]').count().catch(() => 0)) > 0;
    // ДИАГНОСТИКА: какие aria-label реально есть у SVG/кнопок в экшн-баре (чтобы знать точный селектор)
    const labels = await page.$$eval('svg[aria-label], [role="button"][aria-label], a[aria-label], button[aria-label]',
      els => Array.from(new Set(els.map(e => (e.getAttribute('aria-label') || '').trim()).filter(Boolean))).slice(0, 40)).catch(() => []);
    console.log('aria-labels на странице:', JSON.stringify(labels));
    let openedBy = 'none';
    const clickChain = [
      // a) SVG-иконка комментов по мультиязычному aria (Коммент/Comment/Comentar/Yorum/…)
      async () => {
        const sel = 'svg[aria-label*="omment" i], svg[aria-label*="omentar" i], svg[aria-label*="оммент" i], svg[aria-label*="ommenter" i], svg[aria-label*="Yorum" i], svg[aria-label*="تعليق"], svg[aria-label*="コメント"], svg[aria-label*="댓글"], svg[aria-label*="评论"], svg[aria-label*="評論"], svg[aria-label*="Kommentar" i], svg[aria-label*="Commento" i], svg[aria-label*="Bình luận" i], svg[aria-label*="ความคิดเห็น"]';
        const ic = page.locator(sel).first();
        if (!(await ic.isVisible().catch(() => false))) return false;
        const btn = ic.locator('xpath=ancestor::*[self::button or @role="button" or self::a][1]');
        await (await btn.count().catch(() => 0) ? btn.first() : ic).click({ timeout: 4000 }).catch(() => {});
        return true;
      },
      // b) ЗРЕНИЕ: находим центр иконки комментов (спич-бабл со счётчиком в правом экшн-баре)
      async () => {
        const shot = ((await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)))).toString('base64');
        const r = await ask(shot, 'Instagram reel screenshot. Find the COMMENTS icon in the right-side action bar: a speech-bubble/chat outline, usually the 2nd icon from top (below the heart/like), with a comment count number under it. Reply ONLY JSON {"x":<0..1>,"y":<0..1>} = its center. If not visible {"x":0,"y":0}.', 'Where is the comments (speech bubble) icon center?');
        if (!r || !r.x) return false;
        await page.mouse.click(Math.round(r.x * vp.width), Math.round(r.y * vp.height)).catch(() => {});
        return true;
      },
      // c) фикс-координата экшн-бара рилса (спич-бабл ~x=0.69 y=0.647) — последний резерв
      async () => { await page.mouse.click(Math.round(vp.width * 0.689), Math.round(vp.height * 0.647)).catch(() => {}); return true; },
    ];
    for (let i = 0; i < clickChain.length; i++) {
      if (await panelOpen()) { openedBy = 'already'; break; }
      const tried = await clickChain[i]();
      await sleep(3500);
      await page.getByText(REPLY_ANY).first().waitFor({ timeout: 7000 }).catch(() => {});
      if (await panelOpen()) { openedBy = ['svg', 'vision', 'coord'][i]; break; }
      if (tried) console.log(`открытие способом ${['svg', 'vision', 'coord'][i]}: панель не появилась, пробую след.`);
    }
    await sleep(1200);
    require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_opened.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
    console.log('панель комментов открыта способом:', openedBy);
    // ПОСТ-ЛЕВЕЛ БЛОК: автор ограничил/отключил комменты → нет поля ввода, постить НЕ МОЖЕТ НИКТО. Метим пост и выходим,
    // чтобы не гнать сюда 60 акков (иначе каждый ловит «reply не встал» на всех кнопках и зря жжёт время/лимиты).
    let postRestricted = await page.getByText(/Комментарии к этой публикации ограничены|Комментарии.{0,25}ограничен|коммент.{0,20}отключен|отключил.{0,12}коммент|comments on this post are limited|comments are limited|comments are turned off|limited who can comment/i).first().isVisible().catch(() => false);
    if (postRestricted) { console.log('  ⛔ КОММЕНТЫ ОГРАНИЧЕНЫ на этом посту — скип для ВСЕХ акков'); await recordPostRestricted(); }
    // DOM-цикл по вопросам внутри ОТКРЫТОЙ панели: для каждой кнопки «Ответить» смотрим текст её коммента,
    // берём короткие вопросы («промт/как»), пропускаем свои/ответы (нейронк/бесплатно/яндекс), жмём «Ответить»,
    // ПРОВЕРЯЕМ что поле в reply-режиме (@ник) и только тогда постим ВЕТКОЙ. Зрение тут не нужно — панель стабильна.
    const REPLY_RX = /^(Ответить|Répondre|Reply|Antworten|Responder|Yanıtla|Rispondi|Balas|Komentari|رد)$/i;
    // Кто «спрашивает»: не только «промт», но и «чат/гпт/gpt/бот» (люди просят ChatGPT-бота/промпт разными словами).
    // «чат»/«бот»/«гпт» — как ОТДЕЛЬНЫЕ слова (lookaround), иначе ловило бы «отвеЧАТь», «раБОТа».
    // СЕМАНТИЧЕСКИЙ детект спроса (не только «промт»): ловим «кто по смыслу просит промпт/гайд/приложение» —
    // «приложение какое?», «а можно мне такую», «как копировать запрос», «это платно?», «где скачать», «как пользоваться».
    const DEMAND = /пром|prompt|гайд|guide|инструкц|туториал|чатгпт|чат ?гпт|(?<![а-яё])чат(?![а-яё])|(?<![a-zа-яё])gpt|(?<![а-яё])гпт(?![а-яё])|(?<![а-яё])бот(?![а-яё])|нейросет|как (сдела|это|ты|вы|получ|повтор|наз|сгенер|польз|копир)|как называется|где (сдела|взя|найти|скача|это)|как(ое|ой) прил|что за (прил|прилож|сайт|нейрос|прог)|приложени|подскаж|скинь|скинеш|scriptum|копир|скопир|(?<![а-яё])запрос|можно (мне|такую|повтор|также)|сделай мне|(?<![а-яё])платн|сколько стоит/i;
    // CTA-триггеры поста: автор просит писать кодовое слово («Стиль»/«Фон»/«Взгляд»), чтобы получить промпт —
    // такие комментаторы ТОЖЕ наши целевые аскеры. Задаём per-post через env CTA_WORDS="стиль,фон" (без глоб. ложняков).
    const CTA = process.env.CTA_WORDS ? new RegExp('(?<![а-яёa-z])(' + process.env.CTA_WORDS.split(',').map((s) => s.trim()).filter(Boolean).join('|') + ')(?![а-яёa-z])', 'i') : null;
    // ДЕТЕКТ CTA-ПОСТА: автор в описании обещал промпт/туториал ЗА КОММЕНТ («с меня промпт», «пиши +», «слово ХОЧУ»,
    // «напиши в комменты»). На таком посту КАЖДЫЙ комментатор = скрытый аскер (написал коммент РАДИ промпта) → отвечаем
    // ВСЕМ (не только матчам DEMAND). Читаем видимую подпись из body (капшн виден вверху панели). CTA_POST=1 — форс.
    const CTA_CAPTION = await page.evaluate(() => (document.body.innerText || '').slice(0, 2500)).catch(() => '');
    const CTA_POST = process.env.CTA_POST === '1' ||
      /с меня (промпт|промт|туториал|гайд)|с тебя коммент|пиш[иет]{1,3} ?\+|поставь ?\+|напиш[иет]{1,3} (в коммент|слово|плюс|\+)|коммент[а-я]*[,.]? ?(и |скину|дам|получ)|отправь в коммент|слово ХОЧУ|напиши ХОЧУ|(?<![а-яё])\+ ?в коммент/i.test(CTA_CAPTION);
    if (CTA_POST) { console.log('🎯 CTA-ПОСТ (автор обещал промпт за коммент) → цель = ВСЕ комментаторы, а не только явный «промт»');
      dbExec(`UPDATE radar_posts SET is_cta=true WHERE code=$1`, [CODE]).catch(() => {}); } // персист флага (fail-safe до миграции колонки)
    // REPLY_TEST=1 — считать спросом ЛЮБОЙ коммент (тест @-ответа). CTA_POST — то же, но авто по детекту описания.
    const isDemand = (t) => process.env.REPLY_TEST === '1' || CTA_POST || DEMAND.test(t) || (CTA && CTA.test(t));
    let done = 0;
    const seen = new Set(); // ники, кому уже ответили В ЭТОМ прогоне — жёсткий дедуп (свой свежий ответ бывает свёрнут)
    const liked = new Set(); // кого уже лайкнули в этом прогоне — чтобы повторный клик не снял лайк
    const retryOf = {};      // ник -> сколько раз пытались опубликовать (после 2 отказов идём к другому человеку)
    // IG может ОТКЛОНИТЬ публикацию («Не удалось опубликовать») — это ловим ниже. 2 отказа подряд = акк ограничен → стоп.
    const FAIL_RX = /Не удалось опубликова|Не удалось размест|Повторить попытку|couldn.?t post|Unable to post|Try again|Réessayer|n.?a pas pu|No se pudo|Gönderilemedi|Riprova/i;
    let fails = 0, blocked = false;
    // Отмена reply-режима БЕЗ Escape (Escape в reel закрывает всю панель): чистим поле выделением+удалением.
    const cancelReply = async () => {
      try { const bx = page.locator('textarea, div[contenteditable="true"]').first();
        if (await bx.isVisible().catch(() => false)) { await bx.click({ timeout: 1500 }).catch(() => {}); await bx.press('Control+a').catch(() => {}); await bx.press('Backspace').catch(() => {}); await bx.press('Backspace').catch(() => {}); }
      } catch {}
    };
    // Переоткрыть панель, если закрылась (страховка на случай, если reply-режим всё же схлопнул её).
    // Перед перебором способов открытия сносим куки-баннер: он перекрывает панель, и все клики уходят «в молоко».
    const ensurePanel = async () => { if (await panelOpen()) return; await dismissCookies().catch(() => {}); await dismissModals().catch(() => {}); for (const step of clickChain) { if (await panelOpen()) break; await step().catch(() => {}); await sleep(3000); } };
    // === SCAN-режим (шаг 0): только читаем, считаем неотвеченные промпт-запросы, оцениваем свежесть. НЕ постим. ===
    const SCAN = process.env.SCAN === '1';
    // === BACKLOG-режим: пост УЖЕ отработан нами (наши комменты там есть) → добираем ТОЛЬКО неотвеченный спрос
    // (промпт/гайд) вглубь, БЕЗ бренда (он уже стоит). Скроллим глубже — спрос зарыт под нашими ответами.
    const BACKLOG = process.env.BACKLOG === '1';
    if (BACKLOG) console.log('режим БЭКЛОГ: только ответы на спрос (промпт/гайд), бренд не постим, скролл глубже');
    // Режим ПРЕ-АССАЙНА: TARGET_USERS="nick1,nick2,..." — акк отвечает ТОЛЬКО этим людям (для захода
    // несколькими акками без пересечений: каждому раздаём свой список ников).
    const TARGET = process.env.TARGET_USERS ? new Set(String(process.env.TARGET_USERS).toLowerCase().split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean)) : null;
    const scanned = []; const seenScan = new Set();
    const recH = (t) => { // «свежесть» коммента в часах из таймстампа (рус hl=ru): сейчас/с/мин/ч/д/нед/мес/г
      if (/сейчас|только что|just now|now/i.test(t)) return 0;
      // КРИТ-ФИКС 22.07: \b НЕ работает после кириллицы (JS \b = ASCII \w) — «2 дн.» / «15 ч.» не матчились,
      // recH отдавал 9999 для ВСЕХ → волновой/свежесть-фильтр резал КАЖДУЮ цель (hugh: 607 комментов, 0 кликов).
      // Вместо \b — lookahead «дальше не буква» (точка/пробел/конец — ок).
      const m = t.match(/(\d+)\s*(мин|мес|нед|сек|дн|ч|г|д|с|w|h|d|min)(?![а-яёa-z])/i);
      if (!m) return 9999; const n = +m[1], u = m[2].toLowerCase().replace('.', '');
      if (/^(сек|с|s)$/.test(u)) return n / 3600; if (/^(мин|min)$/.test(u)) return n / 60;
      if (/^(ч|h)$/.test(u)) return n; if (/^(дн|д|d)$/.test(u)) return n * 24;
      if (/^(нед|w)$/.test(u)) return n * 168; if (/^(мес)$/.test(u)) return n * 720; if (/^г$/.test(u)) return n * 8760;
      return 9999;
    };
    const MAXPASS = Number(process.env.MAXPASS || (SCAN ? 45 : (TARGET ? 80 : (BACKLOG ? 45 : 35)))); // глубина: в пре-ассайне/бэклоге глубже (люди зарыты)
    // МОДЕЛЬ B (владелец): сессия до 3-5 РАЗНЫХ людей → быстрый выход (свежий акк всё равно сгорит — выжимаем 3-5, но не
    // досиживаем до action-block). SESSION_RAND=1 → рандом 3-5; иначе N из argv.
    const SESSION_N = process.env.SESSION_RAND === '1' ? (3 + Math.floor(Math.random() * 3)) : N;
    // ЖАДНО (начальник): листаем вниз → первый НЕОТВЕЧЕННЫЙ demand-коммент → СРАЗУ отвечаем. Без волн (они заставляли акк
    // «листать и не отвечать», ждать роста окна). Опц. верхняя граница свежести FRESH_MAX ч (0 = без границы, любой неотвеченный).
    // Приоритет свежим = порядок сверху вниз (свежие в ленте выше). Старее FRESH_MAX — пропускаем.
    const FRESH_MAX = Number(process.env.FRESH_MAX || 0);
    // ВОЛНЫ ПО СУТКАМ (приказ начальника 22.07 через Main): окно свежести стартует 24ч и РАСТЁТ 24→48→72ч,
    // когда неотвеченный спрос в текущем окне ИССЯК. Волна1 = комментаторы за 24ч (0 наших ответов) — разбираем полностью,
    // волна2 = 1-2 дня, волна3 = 2-3 дня. FRESH_MAX (если задан) = жёсткий потолок без роста (обратная совместимость).
    const WAVE_START = Number(process.env.WAVE_START || 24);
    const WAVE_MAX = Number(process.env.WAVE_MAX || 72);
    const WAVE_STEP = Number(process.env.WAVE_STEP || 24);
    let waveH = FRESH_MAX > 0 ? FRESH_MAX : WAVE_START; // текущее окно свежести (растёт при исчерпании)
    const WAVE_CAP = FRESH_MAX > 0 ? FRESH_MAX : WAVE_MAX; // потолок роста
    if (!SCAN) console.log(`Модель B: сессия до ${SESSION_N} ответов, жадно (неотвеченный сверху→сразу); ВОЛНЫ окно ${waveH}ч→${WAVE_CAP}ч шаг ${WAVE_STEP}`);
    let zeroStreak = 0; // если панель не открывается несколько проходов подряд — рилс недоступен (блок автора) → быстрый выход
    let bottomStreak = 0; // скролл не добавил новых комментов N раз подряд = ДНО ленты (всё загружено) → стоп, не скроллим вхолостую
    // Автор поста — ему НЕ отвечаем (наш ответ должен идти аскерам, а не креатору). og:title обычно
    // «Имя (@username) on Instagram: …», иногда «username on Instagram: …» → берём @username, иначе первое слово.
    const POST_AUTHOR = (await page.evaluate(() => {
      const c = ((document.querySelector('meta[property="og:title"]') || {}).content || '');
      const m = c.match(/\(@([\w.]+)\)/) || c.match(/@([\w.]+)/) || c.match(/^([\w.]+)\s+on Instagram/i) || c.match(/^([\w.]+)/);
      return m ? m[1] : '';
    }).catch(() => '')).toLowerCase();
    if (POST_AUTHOR) console.log('автор поста:', POST_AUTHOR, '(ему не отвечаем)');
    // БЫСТРЫЙ ФЕЙЛОВЕР (правило «аккаунт-расходник»): если панель открылась, но за FAILFAST проходов НИ ОДНОГО
    // коммента — вероятен шб/траблы на этом посту → выходим быстро (раннер возьмёт след. пост / сменит акк).
    const T0 = Date.now();
    const FAILFAST = Number(process.env.FAILFAST || 6);
    let panelSeen = false; // панель хоть раз открылась (значит пост доступен, но комменты не идут = подозрение на шб)
    let nofirst = false;
    let demandSeen = 0; // сколько РЕАЛЬНОГО спроса встретили (даже отвеченного) — если >0, но 0 ответов, значит верх выжат → скроллим глубже
    let demandOld = 0;  // пропущенный СТАРЫЙ спрос в свежесть-фазе (диагностика: много старых, мало свежих)
    let demandReplied = 0; // скип «уже ответил кто-то» (экспандер ответов под комментом) — правило начальника 22.07
    let replyFails = 0, replyDead = false; // ПОДРЯД «reply не встал»: 5× = у акка сломан reply-режим (hugh-кейс, 10 мин впустую) → бросаем сессию

    // РАННИЙ ЧЕК ЛОГИНА. Разлогиненный акк выглядит как рабочий: пост открывается, комменты видны, кнопки
    // «Ответить» есть — но поля ввода НЕТ, и reply-режим не встаёт НИКОГДА. Раньше это выяснялось дорого:
    // 45 проходов скролла и клик по каждой цели ≈ 5 минут облачной сессии впустую (troy48629/rafael41852,
    // батч 21.07.2026). Диагностика показала active=«Зарегистрируйтесь в Instagram», boxes=[].
    // Теперь ловим за ~30с: нет композера + маркер гостя → метим сессию dead и выходим.
    if (!SCAN) {
      await ensurePanel().catch(() => {});
      // РЕАЛЬНАЯ проверка залогиненности ПО СТРАНИЦЕ, а не по куке (кука врёт: finley был live/login_ok, но IG разлогинен →
      // окно висит впустую). Суспенд → карантин; гостевой вид/кнопка «Войти» → session dead. Требование Main (grabli #3).
      const scr = await page.evaluate(() => {
        const box = document.querySelector('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]');
        const t = String(document.body.innerText || '');
        // ТОЛЬКО про АККАУНТ (не про контент/возраст): бесхитростное «заблокирован» ловило age-restricted экраны подростков → ложный suspend.
        const suspended = /приостановили ваш аккаунт|аккаунт приостановлен|account has been suspended|We suspended your account|Your account has been disabled|аккаунт отключ|мы отключили ваш аккаунт|ваш аккаунт заблокирован|account.{0,15}(disabled|deactivated)/i.test(t);
        const guestTxt = /Зарегистрируйтесь в Instagram|Sign up for Instagram|Log in to Instagram|Войдите в Instagram|Не пропускайте публикации|Войдите, чтобы|Log in to like|Log in to comment|Log in to see|чтобы поставить отметку|Have an account\?/i.test(t);
        const loginBtn = Array.from(document.querySelectorAll('button, a, div[role="button"]')).some(e => /^(Войти|Log in|Log In)$/i.test((e.innerText || '').trim()));
        return { hasBox: !!box, suspended, guestTxt, loginBtn };
      }).catch(() => ({ hasBox: true, suspended: false, guestTxt: false, loginBtn: false }));
      if (scr.suspended) {
        // suspend → карантин (релогин бесполезен), из ротации через paused. finally закроет окно (stopLocal posting).
        try { const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await cc.connect();
          await cc.query(`UPDATE accounts SET ig_status='suspended', status='paused', commenting_at=NULL WHERE slug=$1`, [SLUG]).catch(() => {}); await cc.end();
        } catch { /* noop */ }
        require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_suspended.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
        console.log('  ☠ АКК SUSPENDED — ig_status=suspended, status=paused, в замену');
        console.log('RESULT done=0 brand=0 blocked=0 nofirst=0 restricted=0 suspended=1');
        return;
      }
      if (scr.guestTxt || scr.loginBtn) {
        // ЧП-МОДЕЛЬ (Main): разлогинен → НЕ помечаем dead, НЕ бросаем. Логинимся ПРЯМО В ЭТОМ окне (креды из БД, 2FA/
        // challenge) и сразу комментим не закрывая. Воркер сам логинит и работает, не перекидывает ЛОГГЕРу.
        console.log('  🔑 АКК разлогинен (гостевой вид) → INLINE-ЛОГИН в этом же окне');
        dbExec(`CREATE TABLE IF NOT EXISTS logout_prone (slug text PRIMARY KEY, cnt int NOT NULL DEFAULT 0, ts timestamptz DEFAULT now())`).catch(() => {});
        dbExec(`INSERT INTO logout_prone(slug,cnt,ts) VALUES($1,1,now()) ON CONFLICT(slug) DO UPDATE SET cnt=logout_prone.cnt+1, ts=now()`, [SLUG]).catch(() => {}); // флаг «часто вылогинивается»
        let lr = { ok: false, reason: 'no_creds' };
        if (a.ig_login && a.ig_password) {
          const { loginInline } = require('./iglogin.cjs');
          const shotFn = async (nm) => { try { require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_login_${nm}.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)))); } catch {} };
          lr = await loginInline(page, page.context(), { ig_login: a.ig_login, ig_password: a.ig_password, ig_email: a.ig_email, ig_email_password: a.ig_email_password, totp_secret: a.totp_secret }, { log: (m) => console.log(m), shot: shotFn });
        } else console.log('  ⚠ нет ig_login/ig_password в БД — inline-логин невозможен');
        if (lr.ok) {
          console.log('  ✓ INLINE-ЛОГИН успех → возвращаюсь на пост и комментю в этом окне');
          try { const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await cc.connect();
            await cc.query(`UPDATE accounts SET session_status='live', ig_status='login_ok', status='warming', commenting_at=now() WHERE slug=$1`, [SLUG]).catch(() => {}); await cc.end();
          } catch { /* noop */ }
          await page.goto(goURL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(4000);
          await ensurePanel().catch(() => {});
          // НЕ return — падаем в цикл комментинга ниже (уже залогинены в этом окне)
        } else {
          const isSusp = lr.reason === 'suspended';
          // ПОПЫТКА НЕ СОСТОЯЛАСЬ ЭТО НЕ «СЕССИЯ МЕРТВА» (07.08). Причина входа сюда бывает про НАС,
          // а не про акк: рейт-лимит IG («попробуйте позже»), упавший прокси, оборванный CDP, таймаут
          // навигации. Раньше всё это писалось как session_status='dead', и живой акк выпадал из
          // работы до релогина. Такие причины оставляем без вердикта, только снимаем занятость.
          const isInfra = /rate|limit|попробуйте позже|try again|timeout|таймаут|proxy|net::|closed|ECONN|CDP|no_connect|error/i.test(String(lr.reason || ''));
          try { const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await cc.connect();
            if (isSusp) await cc.query(`UPDATE accounts SET ig_status='suspended', status='paused', commenting_at=NULL WHERE slug=$1`, [SLUG]).catch(() => {});
            else if (isInfra) await cc.query(`UPDATE accounts SET commenting_at=NULL WHERE slug=$1`, [SLUG]).catch(() => {}); // статус НЕ трогаем
            else await cc.query(`UPDATE accounts SET session_status='dead', commenting_at=NULL WHERE slug=$1`, [SLUG]).catch(() => {}); // ЛОГГЕР добьёт релогином
            await cc.end();
          } catch { /* noop */ }
          require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_loginfail_${lr.reason}.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
          console.log(`  ✗ INLINE-ЛОГИН не удался (${lr.reason}) → ${isSusp ? 'suspended' : isInfra ? 'сбой инфраструктуры/частоты, статус НЕ меняю' : 'session dead (ЛОГГЕР поднимет)'}`);
          console.log(`RESULT done=0 brand=0 blocked=0 nofirst=0 restricted=0 ${isSusp ? 'suspended' : 'logged_out'}=1`);
          return;
        }
      }
    }

    let lastDone = 0, lastDemandOld = 0;
    for (let pass = 0; pass < MAXPASS && (SCAN || done < SESSION_N) && !blocked && !postRestricted; pass++) {
      await ensurePanel();
      // IG-САМОЛИМИТ экранного времени («Истекло дневное ограничение времени» / «Пора закрыть приложение» / reached daily
      // limit) — это НЕ бан (память ig-daily-time-limit), а настройка аккаунта. Гасим (× / релоад) и продолжаем комментить.
      if (!SCAN) {
        const dailyLimit = await page.getByText(/Истекло дневное ограничени|дневн\w* ограничени\w* времен|reached your daily limit|daily time limit|Пора закрыть приложение|время.{0,15}Instagram/i).first().isVisible().catch(() => false);
        if (dailyLimit) {
          console.log('  ⏳ дневной лимит экранного времени (НЕ бан) → гашу и продолжаю');
          const x = page.locator('svg[aria-label="Close" i], svg[aria-label="Закрыть" i], [role="button"][aria-label*="lose" i], [role="button"][aria-label*="акрыть" i]').first();
          if (await x.isVisible().catch(() => false)) { await x.click().catch(() => {}); await sleep(1500); }
          else { await page.goto(goURL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(3500); }
          await ensurePanel().catch(() => {});
        }
      }
      // Перечитка СВЕЖИХ отвеченных раз в 2 прохода: параллельные акки на этом же посту пишут цели в БД мгновенно —
      // подтяжка не даёт двум акками ответить одному человеку (была гонка: 3 акка → один @muxtorvv.n).
      if (!SCAN && pass && pass % 2 === 0) {
        try { const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
          await cc.connect(); const fr = await cc.query(`SELECT username FROM post_answered WHERE code=$1`, [CODE]); await cc.end();
          for (const x of fr.rows) answered.add(x.username);
        } catch {}
      }
      const btns = await page.getByText(REPLY_RX).all().catch(() => []);
      if (btns.length === 0) { if (++zeroStreak >= 4) {
        // РАЗЛИЧАЕМ: реальный бан (текст «недоступно») vs сплэш/медленная загрузка. Метим блок ТОЛЬКО при реальном бане,
        // иначе живой акк зря улетает в post_account_blocks (jamir так терялся на медленном прокси).
        const unavail = (await page.getByText(/страница недоступна|isn.?t available|not be available/i).count().catch(() => 0)) > 0;
        if (unavail) { console.log('  ⛔ рилс недоступен акку (блок автора) → стоп'); await recordBlock(); }
        else { console.log('  ⚠ панель не открылась (сплэш/медленная загрузка, НЕ бан) → стоп без пометки блока'); }
        break;
      } } else { zeroStreak = 0; panelSeen = true; }
      // БАТЧ-извлечение: ник+текст для ВСЕХ кнопок ОДНИМ вызовом (не round-trip на каждую). Дедуп потом в Node (Set — мгновенно),
      // поэтому пере-скан верхушки почти бесплатный — можно идти ВГЛУБЬ на десятки проходов, до свежих неотвеченных «Промт».
      const infos = await page.getByText(REPLY_RX).evaluateAll((els) => els.map((el) => {
          let user = '', text = '', node = el;
          for (let up = 0; up < 8 && node; up++) {
            node = node.parentElement; if (!node) break;
            if (!user) { const a = node.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"]):not([href*="/explore/"]):not([href*="/reels/"])'); const m = a && (a.getAttribute('href') || '').match(/^\/([\w.][\w.]+)\/?$/); if (m) user = m[1].toLowerCase(); }
            if (!text && up >= 2) { const t = (node.innerText || '').toLowerCase(); const clean = t.replace(/ответить|répondre|responder|reply|antworten|нравится|j.?aime|me gusta|показать перевод|перевод|see translation|скрыть все ответы|hide replies|view( all)?( \d+)? repl\w*|ver( las)? \d+ respuestas|подтвержд\w*|\d+ ?(нед|нд|сем|w|min|м|ч|h|d|д|мес|hace)\b/gi, '').trim(); if (clean.length >= 3) text = t; }
            if (user && text) break;
          }
          // ФОЛБЭК НИКА: если из ссылки не достали (частый случай на рилсах) — берём ПЕРВЫЙ токен текста (ник идёт первым:
          // «vika_vasilyeva_ 2 нед промт»). Чинит ХОЛОСТЫЕ КЛИКИ: preUser заполнен → дедуп отсекает уже-отвеченных ДО
          // клика «Ответить» (без входа в reply-режим). Это главный ускоритель — было 131 холостой клик на 11 ответов.
          if (!user && text) { const um = text.match(/^\s*@?([a-z0-9._]{2,30})\b/i); if (um) user = um[1].toLowerCase(); }
          // УЖЕ ОТВЕЧЕННЫЙ КЕМ УГОДНО (правило начальника 22.07): под комментом висит экспандер «Посмотреть/Показать
          // ответы (N)» / «View replies» — значит хоть кто-то уже ответил → такого аскера НЕ трогаем. Идём вверх до
          // контейнера СВОЕГО коммента: пока внутри ровно 1 кнопка «Ответить» из els (больше = вылезли на общий список).
          let hasReplies = false, rn = el;
          for (let up = 0; up < 8 && rn; up++) {
            rn = rn.parentElement; if (!rn) break;
            let inside = 0; for (const e of els) { if (rn.contains(e) && ++inside > 1) break; }
            if (inside > 1) break;
            if (/(посмотреть|показать|смотреть|скрыть)( все)?( \d+)? ?ответ|view( all)?( \d+)? ?repl|hide( all)? ?repl|ver( las)? \d+ respuestas|voir (les )?\d+ r[ée]ponses|antworten? (anzeigen|ausblenden)/i.test(rn.innerText || '')) { hasReplies = true; break; }
          }
          return { user, text: text.slice(0, 200), hasReplies };
      })).catch(() => []);
      console.log(`проход${pass}: кнопок ${btns.length}, извлечено ${infos.length} (с ником ${infos.filter((i) => i && i.user).length}, с текстом ${infos.filter((i) => i && i.text).length})`);
      // btns ВЫРОВНЕННЫЕ с infos: btns бралось ВЫШЕ (до догрузки панели), infos — отдельным getByText позже, из-за чего
      // btns[bi] для ГЛУБОКИХ индексов = undefined → неотвеченные ВНИЗУ (на отработанном посту, где верх answered) были
      // НЕДОСТИЖИМЫ (0 постинга, `if(!rb)continue`). Берём reply-локаторы ТЕМ ЖЕ getByText сразу после infos → выравнивание.
      const rbtns = await page.getByText(REPLY_RX).all().catch(() => btns);
      let acted = false;
      for (let bi = 0; bi < infos.length; bi++) {
        if ((!SCAN && done >= SESSION_N) || blocked) break; // сессия 3-5 (Model B); SCAN не постит — не прерываемся
        const info = infos[bi] || { user: '', text: '' };
        const preUser = info.user;
        if (process.env.DBGPROM && /пром|чат|gpt|гпт|бот|нейросет/i.test(info.text || '')) console.log(`  [спрос] @${preUser || '?'} ans:${answered.has(preUser) ? 1 : 0} rep:${info.hasReplies ? 1 : 0} seen:${seen.has(preUser) ? 1 : 0} spam:${/нейронк|бесплатно|яндекс|шаблон|http/.test((info.text || '').toLowerCase()) ? 1 : 0} dem:${DEMAND.test((info.text || '').toLowerCase()) ? 1 : 0} «${(info.text || '').replace(/\s+/g, ' ').slice(0, 45)}»`);
        // Считаем ЛЮБОЙ реальный спрос (даже уже-отвеченный, даже наш — НЕТ: наш спам исключаем): если спрос на посту ЕСТЬ,
        // но верх выжат — надо не бросать (FAILFAST), а скроллить ГЛУБЖЕ за неотвеченными аскерами ниже.
        if (isDemand(info.text || '') && !/нейронк|бесплатно|яндекс|шаблон|http/.test((info.text || '').toLowerCase())) demandSeen++;
        if (!SCAN && preUser && (seen.has(preUser) || answered.has(preUser) || OURS.has(preUser))) continue; // дедуп + НЕ отвечаем нашим ботам
        if (TARGET && (!preUser || !TARGET.has(preUser.toLowerCase()))) continue; // пре-ассайн: только назначенные этому акку ники
        const txt = info.text; // текст уже получен тем же JS-вызовом выше (без доп. Playwright-команд)
        if (/нейронк|бесплатно|яндекс|шаблон|http/.test(txt)) continue; // сам коммент — наш/ответ/спам
        if (!isDemand(txt)) continue; // не вопрос и не CTA-триггер
        // ЯЗЫКОВОЙ ФИЛЬТР (начальник 23.07): отвечаем ТОЛЬКО русским. Не-русский (узб/тадж, латиница-иностранная)
        // = СКИП — не платят, карт РФ нет. Триггер «промт/prompt», «+», эмодзи нейтральны → ок. Ловим по ТЕКСТУ.
        {
          const core = String(txt).replace(/ответить|нравится|reply|like|показать перевод|see translation|\d+\s*(отметк|like)\w*/gi, ' ').replace(/[^a-zа-яё\s]/gi, ' ').replace(/\s+/g, ' ').trim();
          const UZTJ = /(?<![а-яёa-z])(oka|tashab|berin|parto|lozim|kerak|iltimos|birodar|rahmat|qara|мекнм|бнавис|парто|радной|мекунам|бинавис)(?![а-яёa-z])/i;
          const latinForeign = (core.match(/[a-z]{3,}/gi) || []).filter((w) => !/^(prompt|promt|guide|chatgpt|gpt|bot|ai|link|free)$/i.test(w));
          const hasCyr = /[а-яё]/i.test(core);
          if (core && (UZTJ.test(core) || (latinForeign.length && !hasCyr))) { console.log(`  🌐 не-русский коммент @${preUser} «${txt.replace(/\s+/g, ' ').slice(0, 30)}» → скип (не отвечаем)`); if (preUser) seen.add(preUser); continue; }
        }
        if (SCAN) { // записываем асқера (без постинга) — ник уже извлечён выше
          if (preUser && !seenScan.has(preUser)) { seenScan.add(preUser);
            scanned.push({ user: preUser, h: recH(txt), answered: answered.has(preUser), replied: !!info.hasReplies, txt: txt.replace(/\s+/g, ' ').replace(/ответить|нравится|показать перевод|\d+ отметк\w*/gi, '').trim().slice(0, 50) }); }
          continue;
        }
        // УЖЕ ОТВЕЧЕННЫЙ КЕМ УГОДНО: под комментом есть ответы (экспандер) → скип (правило начальника 22.07:
        // «не отвечаем тем кому хоть кто-то ответил уже»). В TARGET-режиме НЕ скипаем: ники назначены начальником явно
        // (кейс: наш ответ ушёл в тень → переответ другим акком, даже если под комментом видна чужая ветка).
        if (!TARGET && info.hasReplies) { demandReplied++; if (preUser) seen.add(preUser); continue; }
        // ВОЛНА: коммент СТАРШЕ текущего окна waveH — пропускаем (учитываем в demandOld → окно вырастет, если фреш иссяк).
        if (recH(txt) > waveH) { demandOld++; continue; }
        const rb = rbtns[bi] || btns[bi]; if (!rb) continue; // ВЫРОВНЕННЫЙ локатор (rbtns из того же getByText что infos) — глубокие тоже кликабельны
        await rb.scrollIntoViewIfNeeded().catch(() => {}); await sleep(400);
        // Сердечко-лайк этого коммента вычисляем ДО клика «Ответить» (DOM коммента стабилен), а жмём ПОСЛЕ подтверждения reply.
        const likeBtn = rb.locator('xpath=ancestor::*[6]').locator('svg[aria-label*="aime" i], svg[aria-label*="ike" i], svg[aria-label*="равит" i], svg[aria-label*="eğen" i]').first();
        // Клик «Ответить» РЕАЛЬНОЙ мышью по центру кнопки — синтетический .click() иногда лишь вставляет @текст, но НЕ
        // включает reply-контекст, и коммент уходит ТОП-ЛЕВЕЛОМ. Мышью надёжнее.
        const box = page.locator('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]').first();
        // ГЛАВНЫЙ ГЕЙТ (фикс топ-левела): reply-режим подтверждается ПЛАШКОЙ «Ответ пользователю @X» ИЛИ @-префиллом композера.
        const REPLYBAR = /Ответ(?:ить)? пользовател|Replying to|Respond(?:iendo|endo) a|Em resposta a|En réponse à|R[ée]p(?:onse|ondre) à|Antwort an|Rispondi a|Trả lời|رد على/i;
        let inReply = false;
        // РЕТРАЙ КЛИКА (фикс интермиттентного «reply не встаёт»): клик мимо, если панель дёрнулась / bbox устарел после
        // скролла. До 2 попыток — КАЖДЫЙ раз свежий скролл→bbox→клик мышью, затем ждём плашку/@-префилл композера.
        // Панель комментов ВИРТУАЛИЗИРОВАНА: скролл догружает новые комменты («кнопок было 15, стало 30»),
        // список переставляется, и bbox, снятый через фиксированную паузу после scrollIntoView, к моменту клика
        // уже не там → жмём кнопку СОСЕДА («НЕ ТУДА») или пустоту («reply не встал»). На батче 21.07.2026 это
        // съело 5 акков из 12. Поэтому ждём не «сколько-то мс», а РЕАЛЬНОЙ остановки: читаем bbox, пока две
        // подряд позиции не совпадут (±2px), и только тогда кликаем.
        const stableBox = async (loc, tries = 8) => {
          let prev = null;
          for (let i = 0; i < tries; i++) {
            const bb = await loc.boundingBox().catch(() => null);
            if (!bb) return null;
            if (prev && Math.abs(bb.y - prev.y) < 2 && Math.abs(bb.x - prev.x) < 2) return bb;
            prev = bb;
            await sleep(350);
          }
          return prev; // не устоялась — кликаем по последней известной, лучше чем ничего
        };
        for (let attempt = 0; attempt < 3 && !inReply; attempt++) {
          if (attempt > 0) { console.log('  ↻ reply не встал — повторный клик «Ответить»'); await cancelReply().catch(() => {}); await sleep(600); }
          await rb.scrollIntoViewIfNeeded().catch(() => {}); await sleep(450);
          const bb = await stableBox(rb);
          if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); else await rb.click({ timeout: 4000 }).catch(() => {});
          await sleep(1400);
          for (let m = 0; m < 6; m++) {
            inReply = await page.getByText(REPLYBAR).first().isVisible().catch(() => false);
            if (inReply) break;
            const bv = await page.evaluate(() => {
              const ae = document.activeElement; const aeT = ae ? (ae.value || ae.innerText || ae.textContent || '') : '';
              const box = document.querySelector('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]');
              const boxT = box ? (box.value || box.innerText || box.textContent || '') : '';
              return aeT + ' ' + boxT;
            }).catch(() => '');
            if (/@[\w.]/.test(bv)) { inReply = true; console.log('  reply-режим по @-префиллу композера'); break; }
            await sleep(700);
          }
        }
        if (!inReply) {
          if (process.env.DBGREPLY === '1') { // ДИАГНОСТИКА reply-провала: скрин + дамп композера/активного элемента
            const dbg = await page.evaluate(() => {
              const ae = document.activeElement; const aeTag = ae ? ae.tagName + (ae.getAttribute('contenteditable') ? '[ce]' : '') : 'none';
              const aeT = ae ? (ae.value || ae.innerText || ae.textContent || '').slice(0, 60) : '';
              const boxes = [...document.querySelectorAll('textarea, div[contenteditable="true"]')].map(b => (b.value || b.innerText || b.textContent || '').slice(0, 40));
              const pill = [...document.querySelectorAll('*')].map(e => e.childElementCount === 0 ? (e.innerText || '') : '').find(t => /Ответ|Replying|отмен|cancel/i.test(t)) || '';
              return { aeTag, aeT, boxes, pill };
            }).catch(() => ({}));
            console.log(`  🔎 DBG reply-fail @${preUser}: active=${dbg.aeTag} «${dbg.aeT}» boxes=${JSON.stringify(dbg.boxes)} pill=«${(dbg.pill || '').slice(0, 40)}»`);
            require('fs').writeFileSync(`${SHOT}/dbg_${SLUG}_replyfail_${done}.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
          }
          console.log(`  ⚠ reply-режим НЕ включился (2 попытки) → пропуск @${preUser}`); await cancelReply(); if (preUser) seen.add(preUser);
          if (++replyFails >= 5) { replyDead = true; break; } // 5 подряд = не флап, у акка reply-режим мёртв → быстрый выход, не жжём слот
          continue;
        }
        // Ник — из плашки (надёжно), иначе preUser из DOM.
        const barTxt = (await page.getByText(REPLYBAR).first().innerText().catch(() => '')) || '';
        const mUser = (((barTxt.match(/пользовател\S*\s+@?([\w.]+)/i) || [])[1]) || preUser || '').toLowerCase();
        if (mUser && (seen.has(mUser) || answered.has(mUser))) { console.log(`  @${mUser} уже отвечен — пропуск`); await cancelReply(); continue; }
        // Плашка ДОЛЖНА указывать на нашу цель (иначе она стала от прошлого ответа = чужой/пустой контекст).
        // На CTA-посту (все комментаторы = лиды) НЕ требуем совпадения с preUser: реальная цель плашки/композера — тоже
        // валидный неотвеченный лид, отвечаем ЕЙ (иначе клик-«Ответить» промахивается в соседа → десятки пропусков, 0 постинга).
        if (!CTA_POST && preUser && mUser && mUser !== preUser) { console.log(`  ⚠ плашка на @${mUser}, цель @${preUser} — стоп (не туда)`); await cancelReply(); continue; }
        // ЦЕЛЬ по @-ПРЕФИЛЛУ композера (клик «Ответить» вставил «@X ») — читаем ДО ввода/очистки. Языконезависимо.
        const stillReplyBar = await page.getByText(REPLYBAR).first().isVisible().catch(() => false);
        const preVal = await page.evaluate(() => {
          const ae = document.activeElement; const aeT = ae ? (ae.value || ae.innerText || ae.textContent || '') : '';
          const box = document.querySelector('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]');
          const boxT = box ? (box.value || box.innerText || box.textContent || '') : '';
          return /@[\w.]/.test(boxT) ? boxT : aeT;
        }).catch(() => '');
        const boxMention = ((String(preVal).match(/@([\w.]+)/) || [])[1] || '').toLowerCase();
        if (!boxMention) { console.log(`  ⚠ нет @-префилла в поле (@${preUser}, bar:${stillReplyBar}) — reply-режим не встал, пропуск`); await cancelReply(); if (preUser) seen.add(preUser); continue; }
        if (OURS.has(boxMention)) { console.log(`  ⚠ цель @${boxMention} — НАШ бот, себе не отвечаем, пропуск`); await cancelReply(); seen.add(boxMention); if (preUser) seen.add(preUser); continue; }
        if (POST_AUTHOR && boxMention === POST_AUTHOR) { console.log(`  ⚠ цель @${boxMention} — АВТОР поста, не отвечаем, пропуск`); await cancelReply(); seen.add(boxMention); if (preUser) seen.add(preUser); continue; }
        if (seen.has(boxMention) || answered.has(boxMention)) { console.log(`  @${boxMention} уже отвечен (дедуп по факт.цели) — пропуск`); await cancelReply(); seen.add(boxMention); continue; }
        if (!CTA_POST && preUser && boxMention !== preUser.toLowerCase()) { console.log(`  ⚠ поле отвечает @${boxMention}, а цель была @${preUser} — НЕ ТУДА (сосед), пропуск`); await cancelReply(); seen.add(boxMention); seen.add(preUser); continue; }
        if (CTA_POST && preUser && boxMention !== preUser.toLowerCase()) console.log(`  ↪ CTA: клик был @${preUser}, композер нацелен @${boxMention} — отвечаю фактической цели (тоже лид)`);
        // АТОМАРНЫЙ КЛЕЙМ цели ДО ответа (Model B): INSERT ON CONFLICT DO NOTHING RETURNING — строка вернулась = застолбил
        // ПЕРВЫМ (отвечаю); пусто = уже занят (дежурство/др.акк/этот пост параллельно) → пропуск, иду к следующему. Разводит
        // по РАЗНЫМ людям, ноль дублей. Заменяет запись «в конце прогона». При провале ответа ниже — DELETE (освобождаю).
        let claimed = true;
        try {
          const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
          await cc.connect();
          const rr = await cc.query(`INSERT INTO post_answered(code,username,ts,slug) VALUES($1,lower($2),now(),$3) ON CONFLICT(code,username) DO NOTHING RETURNING username`, [CODE, boxMention, SLUG]);
          await cc.end(); claimed = rr.rows.length > 0;
        } catch { claimed = true; } // БД-флап → считаем застолбили (fail-safe, не блокируем постинг)
        if (!claimed) { console.log(`  @${boxMention} уже застолблен (атомарный клейм) — пропуск, к следующему`); await cancelReply(); seen.add(boxMention); answered.add(boxMention); continue; }
        const releaseClaim = () => dbExec(`DELETE FROM post_answered WHERE code=$1 AND username=lower($2)`, [CODE, boxMention]).catch(() => {}); // освободить при провале
        // ДЕФОЛТ (Main): постим С @ в ветку — живые акки так постят НОРМАЛЬНО (147/150). @ убираем ТОЛЬКО как retry-fallback
        // после тоста «Couldn't post» (см. ниже) — таких акков 2-3 из 150. Глобальное стирание @ + страховка резали живых в 0.
        const seed = Math.abs([...SLUG].reduce((a, ch) => a + ch.charCodeAt(0), 0));
        let text = noDash(varyBrand(POOL[(seed + done * 7) % POOL.length], seed + done));
        // ГАРД (ревью 28.07: он был объявлен, но НЕ вызывался): перебираем пул, пока не найдём фразу без запретных слов.
        for (let k = 1; hasBanned(text) && k < POOL.length; k++) text = noDash(varyBrand(POOL[(seed + done * 7 + k) % POOL.length], seed + done + k));
        if (hasBanned(text)) { console.log('  ⛔ все фразы с запретным словом — пропускаю цель'); continue; }
        await page.keyboard.press('End').catch(() => {});
        await page.keyboard.type(' ' + text, { delay: 40 }).catch(() => {}); // С @-префиллом (ответ в ветку)
        await sleep(500);
        // НЕ гейтим по видимости плашки REPLYBAR: на РИЛАХ она часто не детектится (false negative), а reply-режим активен
        // (@-префилл boxMention подтверждён выше). Гейт `!replyStill → пропуск` резал ВСЕ ответы на реле в 0. Публикуем.
        // ЗРЯЧИЙ ГЕЙТ — опционально (VISIONGATE=1). Медленный (API на каждого), поэтому по умолчанию ВЫКЛ: DOM-фикс (лайк
        // после публикации + ре-проверка плашки) уже держит ветку. Включай зрение, если нужна доп-страховка.
        if (process.env.VISIONGATE === '1') {
          const vr = await visionReply(page);
          if (vr && vr.reply === false) { console.log(`  👁 ЗРЕНИЕ: топ-левел (нет плашки) → НЕ публикую @${preUser}, пропуск`); releaseClaim(); await cancelReply(); if (preUser) seen.add(preUser); continue; }
          console.log(`  👁 зрение: reply=${vr && vr.reply}${vr && vr.user ? ' → @' + vr.user : ''}`);
        }
        const POST_RX = /^(Опубликовать|Post|Publier|Yayınla|Publicar|Senden|Gönder|Отправить|Invia)$/i;
        // Клик по кнопке НАДЁЖНО: берём кликабельный элемент и бьём по его центру мышью.
        // (Клик по текстовому узлу через getByText не срабатывал — текст оставался в поле, коммент не уходил.)
        const clickPost = async () => {
          const cands = [
            page.getByRole('button', { name: POST_RX }),
            page.locator('div[role="button"]').filter({ hasText: POST_RX }),
            page.getByText(POST_RX),
          ];
          for (const cnd of cands) {
            const el = cnd.first();
            if (!(await el.isVisible().catch(() => false))) continue;
            const bb = await el.boundingBox().catch(() => null);
            if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); return; }
            await el.click({ timeout: 4000 }).catch(() => {});
            return;
          }
          await box.press('Enter').catch(() => {});
        };
        // ФАКТ публикации = композер ОЧИСТИЛСЯ. Отсутствие ошибки — НЕ доказательство (так мы уже ловили ложные успехи).
        const composerEmpty = async () => page.evaluate(() => {
          const b = document.querySelector('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]');
          const t = b ? (b.value || b.innerText || b.textContent || '').trim() : '';
          return t.length < 3;
        }).catch(() => false);

        // (takenByOther-SELECT убран: атомарный клейм ВЫШЕ уже застолбил цель первым — повторный SELECT нашёл бы НАШ же
        // клейм и ложно пропустил. Клейм заменил in-flight гонку-чек.)
        await clickPost(); await sleep(4200);
        // ТОСТ «Couldn't post comment» (Main): IG ОТБИЛ коммент (action-block свежего/перекомментившего акка ИЛИ спам-фильтр
        // по промо-тексту). Композер мог очиститься → ЛОЖНЫЙ успех. Ловим тост → НЕ считаем, помечаем акк action_block+paused,
        // стоп (не долбим — усугубляет бан). Успех считаем ТОЛЬКО при чистом композере БЕЗ этого тоста.
        const failToast = await page.getByText(/Couldn.?t post (comment|your comment)|Comment couldn.?t be posted|We restrict certain activity|action.?blocked|ограничили некоторые( ваши)? действия|заблокировали.{0,15}действия/i).first().isVisible().catch(() => false);
        if (failToast) {
          // FALLBACK (Main): «Couldn't post» с @ → у 2-3% акков IG режет @упоминание. РЕТРАЙ этого же ответа БЕЗ @: стираем
          // поле, печатаем текст без @ (reply-контекст ветки держится), публикуем. Если и БЕЗ @ тост → action_block+смена акка.
          console.log(`  ⚠ ТОСТ «Couldn't post» @${boxMention} с @ → retry БЕЗ @ (fallback)`);
          await page.keyboard.press('End').catch(() => {});
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
          await page.keyboard.press('Delete').catch(() => {}); await sleep(250);
          await page.keyboard.type(text, { delay: 40 }).catch(() => {}); // тот же текст, БЕЗ @
          await sleep(500);
          await clickPost(); await sleep(4200);
          const toast2 = await page.getByText(/Couldn.?t post (comment|your comment)|Comment couldn.?t be posted|We restrict certain activity|action.?blocked|ограничили некоторые( ваши)? действия|заблокировали.{0,15}действия/i).first().isVisible().catch(() => false);
          if (toast2) {
            console.log(`  ⛔ и БЕЗ @ тост @${boxMention} — акк в ACTION_BLOCK → пауза, смена акка`);
            try { const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await cc.connect();
              await cc.query(`UPDATE accounts SET ig_status='action_block', status='paused', commenting_at=NULL WHERE slug=$1`, [SLUG]).catch(() => {}); await cc.end();
            } catch { /* noop */ }
            releaseClaim(); await cancelReply().catch(() => {}); blocked = true; break; // НЕ done++, освобождаю клейм
          }
          console.log(`  ✓ retry БЕЗ @ прошёл @${boxMention} (fallback сработал)`);
          // падаем в composerEmpty-проверку ниже — успех запишется как обычно
        }
        // IG-ограничение «нельзя делиться ссылками»: ответ (в нём «нейронка про/яндекс») тоже отобьётся, а композер
        // может очиститься → ложный успех. Ловим модалку, карантиним акк и СТОПаем заход (он бесполезен ~месяц).
        if (await shareRestricted()) { console.log(`  🔗⛔ ответ @${mUser}: модалка «нельзя делиться ссылками» → карантин акка, стоп`); releaseClaim(); await recordShareRestrict(); blocked = true; break; }
        let ok = await composerEmpty();
        if (!ok) { await box.press('Enter').catch(() => {}); await sleep(3500); ok = await composerEmpty(); }   // фолбэк: Enter
        if (!ok) { await clickPost(); await sleep(3500); ok = await composerEmpty(); }                            // вторая попытка клика
        // если IG явно ругнулся — жмём «Повторить попытку»
        if (!ok && await page.getByText(FAIL_RX).first().isVisible().catch(() => false)) {
          const retry = page.getByText(/Повторить попытку|Try again|Réessayer|Riprova|Reintentar/i).first();
          if (await retry.isVisible().catch(() => false)) { await retry.click().catch(() => {}); await sleep(4500); ok = await composerEmpty(); }
        }
        if (!ok) console.log(`  ✗ композер НЕ очистился — коммент НЕ ушёл (@${mUser})`);
        require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_${done}_after.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
        if (!ok) {
          releaseClaim(); // ответ не сел → освобождаю клейм (следующий акк/проход добьёт этого человека)
          fails++;
          // «Не удалось опубликовать» часто лечится ПЕРЕЗАГРУЗКОЙ страницы. Даём цели 2 попытки, потом идём к другому
          // человеку. Цель в глобальный скип НЕ пишем — иначе живой спрашивающий останется без ответа навсегда.
          retryOf[mUser] = (retryOf[mUser] || 0) + 1;
          console.log(`  ✗ IG отклонил @${mUser} (попытка ${retryOf[mUser]}/2, отказов подряд ${fails})`);
          await cancelReply().catch(() => {});
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
          await sleep(6000);
          await ensurePanel().catch(() => {});
          if (retryOf[mUser] >= 2) { if (mUser) seen.add(mUser); console.log(`  → двух попыток хватит, перехожу к ДРУГОМУ человеку`); }
          if (fails >= 3) { // акк НЕ может постить (3 отказа публикации подряд, даже без @) → action_block + смена акка (начальник)
            blocked = true;
            try { const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await cc.connect();
              await cc.query(`UPDATE accounts SET ig_status='action_block', status='paused', commenting_at=NULL WHERE slug=$1`, [SLUG]).catch(() => {}); await cc.end();
            } catch { /* noop */ }
            console.log('  ⛔ 3 отказа публикации подряд — акк в ACTION_BLOCK → пауза, смена акка (в БД помечен, не переиспользуется)');
          }
          continue;
        }
        fails = 0;
        // ЛАЙК — только ПОСЛЕ публикации ответа (чтобы клик по сердечку не сбросил reply-контекст ДО отправки).
        if (process.env.LIKES === '1' && mUser && !liked.has(mUser) && await likeBtn.isVisible().catch(() => false)) { await likeBtn.click({ timeout: 3000 }).catch(() => {}); liked.add(mUser); await sleep(600); console.log('  ♥ лайкнул'); }
        // ЗАПИСЬ/ДЕДУП по ФАКТ. цели boxMention (@ в композере), НЕ mUser: mUser мог не извлечься из плашки (пусто) →
        // ответ уходил живому человеку, но в post_answered НЕ писался → его отвечал второй акк (дубли = след фермы,
        // «✓ ВЕТКА @» с пустым ником). boxMention тут гарантированно не пуст (гейт выше). Запись мгновенная
        // (fire-and-forget): параллельные акки видят цель занятой СРАЗУ (гонка @muxtorvv.n/@kumrah_099).
        if (boxMention) { seen.add(boxMention); answered.add(boxMention); newAnswered.push(boxMention);
          dbExec(`INSERT INTO post_answered(code,username,slug) VALUES($1,$2,$3) ON CONFLICT(code,username) DO UPDATE SET slug=EXCLUDED.slug`, [CODE, boxMention, SLUG]).catch(() => {});
        }
        console.log(`  ✓ ВЕТКА @${boxMention} | ${text.slice(0, 30)}`);
        done++; acted = true; replyFails = 0; await bumpComment().catch(() => {}); // дашборд: +1 коммент акку; reply-режим жив → сброс серии
        await sleep(1200 + Math.floor(Math.random() * 1500));
        // ФИКС «1 коммент/сессия» (начальник 23.07): на РИЛЕ после публикации IG закрывает панель, и клик-иконка её
        // НЕ переоткрывает (ensurePanel находил «кнопок 0»). Надёжно = ПЕРЕЗАГРУЗКА страницы (как на провал-пути стр.
        // 954): свежий рил → панель открывается чисто → пере-скан прохода с новыми кнопками (наши уже в дедупе).
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
        await sleep(6000);
        await ensurePanel().catch(() => {});
        break;
      }
      if (replyDead) { console.log(`  ⛔ reply-режим не встаёт ${replyFails}× подряд (акк/UI, hugh-кейс) → бросаю сессию, ротация на следующий акк`); break; }
      // Подгрузка новых комментов: IG виртуализует список. Надёжно (для любого лейаута):
      // 1) доводим ПОСЛЕДНЮЮ кнопку «Ответить» до низа, 2) JS-скроллим сам скролл-контейнер панели в самый низ.
      const before = await page.getByText(REPLY_RX).count().catch(() => 0);
      const allb = await page.getByText(REPLY_RX).all().catch(() => []);
      if (allb.length) { await allb[allb.length - 1].scrollIntoViewIfNeeded().catch(() => {}); await sleep(1200); }
      for (let s = 0; s < 3; s++) {
        await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('div'));
          const sc = els.filter(e => e.scrollHeight > e.clientHeight + 200 && /Ответить|Reply|Responder|Répondre|Rispondi|Antworten|رд|Yanıtla/i.test(e.innerText || '')).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
          if (sc) sc.scrollTop = sc.scrollHeight;
        }).catch(() => {});
        await sleep(1100);
      }
      await sleep(1200);
      const after = await page.getByText(REPLY_RX).count().catch(() => 0);
      console.log(`  ↕ скролл панели: кнопок было ${before}, стало ${after}`);
      // ДНО ЛЕНТЫ (Main/начальник): скролл не добавил новых комментов 3× подряд = всё загружено.
      if (after <= before) { if (++bottomStreak >= 3) {
        // ВОЛНА: дно ТЕКУЩЕГО окна. Квота не добита, есть пропущенный старый спрос и есть куда расти → РАСШИРЯЕМ окно
        // (24→48→72ч) и читаем СНАЧАЛА (скролл вверх): свежие уже в seen/answered, дедуп пропустит их быстро, дойдём до
        // следующего слоя суток. Так «волна2/волна3» включаются только когда предыдущая полностью разобрана.
        if (!SCAN && done < SESSION_N && demandOld > 0 && waveH < WAVE_CAP) {
          const prev = waveH; waveH = Math.min(waveH + WAVE_STEP, WAVE_CAP);
          console.log(`  🌊 окно ${prev}ч иссякло (пропущено старых ${demandOld}) → ВОЛНА расширена до ${waveH}ч, читаю сначала`);
          demandOld = 0; bottomStreak = 0;
          await page.evaluate(() => { const sc = [...document.querySelectorAll('div')].filter(e => e.scrollHeight > e.clientHeight + 200 && /Ответить|Reply|Responder|Répondre|Rispondi|Antworten|Yanıtla/i.test(e.innerText || '')).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (sc) sc.scrollTop = 0; }).catch(() => {});
          await sleep(1500); continue;
        }
        console.log(`  ⬇ ДНО ленты (${after} комментов, роста нет ${bottomStreak}×, окно ${waveH}ч выжато) — всё загружено, стоп скролла, выхожу`); break;
      } }
      else bottomStreak = 0;
      // быстрый выход: панель открыта, но за FAILFAST проходов 0 комментов → шб/траблы на посту → не тратим время
      if (!SCAN && !TARGET && done === 0 && panelSeen && pass + 1 >= FAILFAST) {
        if (demandSeen === 0) { nofirst = true; console.log(`  ⏱ 0 комментов и 0 спроса за ${pass + 1} проходов → шб/трабл, быстрый выход`); break; }
        // спрос ЕСТЬ, но всё отвечено (верх выжат) — НЕ бросаем: скроллим ГЛУБЖЕ до MAXPASS за неотвеченными аскерами ниже.
        else if (pass + 1 === FAILFAST) console.log(`  ↓ верх выжат (спрос ${demandSeen}, из них с чужими ответами ${demandReplied}) → скроллим ГЛУБЖЕ за неотвеченными (до ${MAXPASS} проходов)`);
      }
    }
    // === БРЕНДОВЫЙ ТОП-ЛЕВЕЛ коммент (BRANDTOP=1): обращение ко всем, НЕ ответ. Постим в главное поле, БЕЗ reply-режима. ===
    let brandPosted = false;
    // Бренд-топ ТОЛЬКО после >=10 ответов людям на этом посту (правило владельца: бренд рискован, заслужи наработкой).
    // Исключения: N===0 = brand-first флоу newpost_watch («комментим первыми» на свежем посту, done=0 by design);
    // BRAND_FORCE=1 = ручной обход. Одинокий промо без активности = спам-бот (топ-триггер бана), поэтому гейт строгий.
    const brandGate = process.env.BRAND_FORCE === '1' || N === 0 || done >= 10;
    if (!SCAN && !BACKLOG && process.env.BRANDTOP === '1' && !blocked && !postRestricted && brandGate) {
      await ensurePanel();
      await cancelReply(); await sleep(800); // гарантируем, что НЕ в reply-режиме (иначе уйдёт в ветку)
      // БРЕНД-ТОП на SINGLE-POST вью /p/CODE/ (начальник 23.07, скрин): на /reels/-ЛЕНТЕ панель коммента с полем НЕ
      // поднимается (0 полей). На /p/CODE/ поле ввода коммента есть у низа. Навигируем туда, если поля нет.
      if (!(await page.locator('textarea, div[contenteditable="true"]').first().isVisible().catch(() => false))) {
        await page.goto(`https://www.instagram.com/p/${CODE}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(4000); await dismissCookies().catch(() => {}); await dismissModals().catch(() => {});
      }
      // добить открытие панели кликом иконки коммента, если поле ещё не видно (до ~12с)
      for (let w = 0; w < 8; w++) {
        if (await page.locator('textarea, div[contenteditable="true"]').first().isVisible().catch(() => false)) break;
        const cb2 = page.locator('svg[aria-label="Comment" i], svg[aria-label*="omment" i], svg[aria-label*="омментир" i]').first();
        if (await cb2.isVisible().catch(() => false)) { const bb2 = await cb2.boundingBox().catch(() => null); if (bb2) await page.mouse.click(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2).catch(() => {}); else await cb2.click().catch(() => {}); }
        await sleep(1500);
      }
      const inReplyNow = await page.getByText(/Ответ(?:ить)? пользовател|Replying to|Respondiendo a/i).first().isVisible().catch(() => false);
      // Индекс по хэшу slug+CODE → фраза разная НА РАЗНЫЕ АКК И НА РАЗНЫЕ ПОСТЫ. Иначе один акк на постах одного
      // креатора ставит ОДИН И ТОТ ЖЕ текст (палево, если смотреть профиль креатора).
      const idx = Math.abs([...(SLUG + CODE)].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % POOL_TOP.length;
      let bText = noDash(varyBrand(POOL_TOP[idx], idx));
      for (let k = 1; hasBanned(bText) && k < POOL_TOP.length; k++) bText = noDash(varyBrand(POOL_TOP[(idx + k) % POOL_TOP.length], idx + k));
      if (hasBanned(bText)) { console.log('  ⛔ бренд-фраза с запретным словом — не публикую'); brandPosted = false; }
      const box = page.locator('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]').first(); // как рабочее reply-поле (.last()+form мазал на реле)
      if (!(await box.isVisible().catch(() => false))) { const cbtn = page.locator('svg[aria-label="Comment" i],svg[aria-label*="omment" i]').first(); if (await cbtn.isVisible().catch(() => false)) { await cbtn.click().catch(() => {}); await sleep(1500); } } // на реле поле у нижней части панели — доскроллим кликом иконки
      if (inReplyNow) { console.log('  ⚠ бренд: всё ещё reply-режим — пропускаю, чтобы не уйти в ветку'); }
      else if (await box.isVisible().catch(() => false)) {
        await box.click().catch(() => {}); await sleep(300);
        await box.pressSequentially(bText, { delay: 40 }).catch(() => {}); await sleep(500);
        const bt = page.getByText(/^(Опубликовать|Post|Publier|Yayınla|Publicar|Отправить|Invia|Đăng)$/i).first();
        if (await bt.isVisible().catch(() => false)) await bt.click().catch(() => {}); else await box.press('Enter').catch(() => {});
        await sleep(4200);
        require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_brand.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
        // ЛОЖНЫЙ УСПЕХ #1: модалка «нельзя делиться ссылками» → коммент НЕ ушёл, композер мог очиститься. Карантиним акк.
        if (await shareRestricted()) { console.log('  🔗⛔ бренд: модалка «нельзя делиться ссылками» — НЕ опубликован'); await recordShareRestrict(); brandPosted = false; }
        else {
          // ЛОЖНЫЙ УСПЕХ #2: отсутствие FAIL_RX ≠ публикация. Факт = композер ОЧИСТИЛСЯ (текст ушёл из поля).
          const cleared = await page.evaluate(() => { const b = document.querySelector('form textarea, textarea[aria-label], div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]'); const t = b ? (b.value || b.innerText || b.textContent || '').trim() : ''; return t.length < 4; }).catch(() => false);
          const failTxt = await page.getByText(FAIL_RX).first().isVisible().catch(() => false);
          brandPosted = cleared && !failTxt;
          console.log(brandPosted ? `  ★ БРЕНД топ-левел (оптимистично): «${bText.slice(0, 40)}…»` : `  ✗ бренд НЕ ушёл (композер не очистился${failTxt ? ', IG отклонил' : ''})`);
        }
        // ЛОЖНЫЙ УСПЕХ #3 — ТИХИЙ СНОС: композер очищается оптимистично, но IG сносит топ-левел промо свежего акка
        // через секунды (доказано vshadow: «★ БРЕНД» в логе, а анону 0 видно). Единственная правда — РЕЛОАД + поиск
        // нашего текста. BRAND_VERIFY=0 отключает (если релоад начнёт ловить капчу). Капчу при верификации ловим.
        if (brandPosted && process.env.BRAND_VERIFY !== '0') {
          await sleep(3500);
          await page.goto(goURL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(5000);
          const cap2 = await page.getByText(/подтвердите,? что вы человек|confirm you.?re human|введите код с изображени/i).first().isVisible().catch(() => false);
          if (cap2) { console.log('  ☠ КАПЧА при верификации бренда — акк спалён'); await recordCaptcha(); await b.close().catch(() => {}); return; }
          await ensurePanel().catch(() => {});
          await sleep(1800);
          const needle = noDash(bText).slice(0, 22).toLowerCase();
          const found = await page.evaluate((n) => (document.body.innerText || '').toLowerCase().includes(n), needle).catch(() => false);
          if (!found) { brandPosted = false; console.log('  ⚠ бренд ПОСЛЕ РЕЛОАДА не найден → IG ТИХО СНЁС (ложный успех предотвращён)'); }
          else console.log('  ✅ бренд ПОДТВЕРЖДЁН после релоада (реально висит)');
        }
      } else { require('fs').writeFileSync(`${SHOT}/vc_${SLUG}_brandnofield.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0)))); const boxes = await page.evaluate(() => [...document.querySelectorAll('textarea, div[contenteditable="true"]')].map(b => ({ tag: b.tagName, al: b.getAttribute('aria-label') || '', ce: b.getAttribute('contenteditable') || '', vis: b.offsetParent !== null }))).catch(() => []); console.log(`  ⚠ бренд: не нашёл поле ввода (url=${page.url().replace('https://www.instagram.com', '')}, полей на стр: ${JSON.stringify(boxes).slice(0, 200)})`); }
    }
    if (SCAN) {
      const MAXH = Number(process.env.MAXH || 24);
      const fresh = scanned.filter(s => s.h <= MAXH);
      const un = fresh.filter(s => !s.answered).sort((a, b) => a.h - b.h);
      const ans = fresh.filter(s => s.answered);
      console.log(`\n=== SCAN: промпт-запросов найдено ${scanned.length}, за ${MAXH}ч ${fresh.length} (неотвеченных ${un.length}, отвечено нами ${ans.length}) ===`);
      console.log('SCAN_JSON ' + JSON.stringify({ total: scanned.length, freshWindow: fresh.length, unanswered: un.length, answered: ans.length, top: un.slice(0, 10).map(s => ({ user: s.user, h: Math.round(s.h * 10) / 10, txt: s.txt })) }));
      // Task B: измеренный спрос → кампания спроса (гейт CAMPAIGN_PRODUCER=1; N = всего лидов на посту)
      if (process.env.CAMPAIGN_PRODUCER === '1') await upsertDemandCampaign(scanned.length, un.length).catch(() => {});
      console.log('\n--- НЕОТВЕЧЕННЫЕ, свежие сверху (топ-10) ---');
      un.slice(0, 10).forEach((s, i) => console.log(`  ${i + 1}. @${s.user}  (${s.h < 1 ? Math.round(s.h * 60) + 'м' : Math.round(s.h) + 'ч'} назад)  «${s.txt}»`));
    } else console.log('ОТВЕЧЕНО В ВЕТКУ:', done);
    // машиночитаемый итог для раннера (фейловер по постам + обучение по лимитам акка перед шб)
    console.log(`RESULT done=${done} brand=${brandPosted ? 1 : 0} blocked=${blocked ? 1 : 0} nofirst=${nofirst ? 1 : 0} restricted=${postRestricted ? 1 : 0} fails=${fails} elapsed=${Math.round((Date.now() - T0) / 1000)}`);
  } catch (e) { console.log('ОШИБКА', e.message.slice(0, 80)); }
  finally {
    // запишем отвеченных СВЕЖИМ соединением (старое закрыто) — для кросс-аккаунт дедупа
    if (newAnswered.length) {
      try { const c2 = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); await c2.connect();
        for (const u of newAnswered) await c2.query(`INSERT INTO post_answered(code,username,slug) VALUES($1,$2,$3) ON CONFLICT(code,username) DO UPDATE SET slug=EXCLUDED.slug`, [CODE, u, SLUG]).catch(() => {});
        await c2.end(); console.log('записано в БД отвеченных:', newAnswered.length);
      } catch (e) { console.log('БД-запись отвеченных не удалась:', e.message.slice(0, 40)); }
    }
    await setCommenting(false).catch(() => {}); // дашборд: акк больше не комментит (снимаем «онлайн»)
    // KEEP_OPEN=1 — НЕ закрывать сессию (профиль остаётся поднятым, акк не вылогинивается).
    // Для акков, залогиненных вручную (darrell85982): закрытие/синк может слить сессию — оставляем жить.
    if (process.env.KEEP_OPEN === '1') {
      // ВАЖНО: браузер — дочерний процесс, он умрёт вместе со скриптом. Поэтому держим процесс живым,
      // иначе профиль закроется и акк может вылогиниться. Останов — kill по /tmp/<slug>.pid.
      console.log('KEEP_OPEN=1: сессию НЕ закрываю, процесс остаётся жить (профиль открыт)');
      setInterval(() => {}, 1 << 30);
    } else {
      if (glLocal) {
        // КРИТ (Main): stopLocal ВИСНЕТ в GoLogin-шторме → процесс висел 46 мин, окно занимало слот, hammer стоял.
        // Закрытие БОУНДЕД: stopLocal максимум ~6с (best-effort синк кук), b.close ~2.5с — дальше идём. Полное
        // graceful-закрытие+синк делает closelocal ЛОГГЕРА отдельно. Процесс ОБЯЗАН умереть за секунды (см. process.exit ниже).
        try { const nn = page.getByRole('button', { name: /not now|не сейчас/i }).first(); if (await nn.isVisible().catch(() => false)) { await nn.click().catch(() => {}); } } catch {}
        await Promise.race([glLocal.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]);
        await Promise.race([b.close().catch(() => {}), sleep(2500)]);
        // ДОБИТЬ СВОЮ Orbita (Main #1: окна копились — process.exit убивал node, но Orbita оставалась орфаном). killBrowser
        // гасит ТОЛЬКО этот профиль (свой handle SDK), НЕ глобально (не pkill). Иначе 9 орфан-Orbita на 3 vcomment.
        try { if (typeof glLocal.killBrowser === 'function') glLocal.killBrowser(); } catch {}
        console.log('  окно закрыто (stopLocal + killBrowser своего профиля)');
      } else {
        await Promise.race([fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + gt } }).catch(() => {}), sleep(6000)]);
        await b.close().catch(() => {});
      }
      await releaseSlot(slotId).catch(() => {}); // освобождаем слот пула 'commenting'
    }
  }
})().catch(e => console.log('FATAL', e.message)).finally(() => {
  // Процесс ОБЯЗАН завершиться: gologin SDK держит хендлы → node сам не выходит, процесс висит и слот занят (баг karter).
  // KEEP_OPEN держим живым намеренно (профиль открыт). Иначе — принудительный выход (окно догасит closelocal ЛОГГЕРА).
  if (process.env.KEEP_OPEN !== '1') setTimeout(() => process.exit(0), 300);
});
