// ОФОРМЛЕНИЕ АККА: аватар + человеческое отображаемое имя + био БЕЗ ссылок. Идёт СРАЗУ после первого входа,
// ДО прогрева/комментинга, В ТОЙ ЖЕ локальной сессии (см. PLAN-dressup.md). Локально (Orbita на маке), 0 облачных
// часов GoLogin. Ник (@username) НЕ меняем по умолчанию (спорно + меняет логин-креденшл).
//
// usage:  node dressup.cjs "<slug>"
// env:    DRESS_NAME="Лена"        отображаемое имя (иначе генерим человеческое из пула)
//         DRESS_BIO="..."          био (иначе из пула, БЕЗ ссылок; SKIP_BIO=1 — не трогать)
//         AVATAR_PATH=/path.jpg     готовый файл авы (иначе тянем ИИ-лицо this-person-does-not-exist по полу)
//         AVATAR_URL=https://...    скачать аву по ссылке (напр. generateAvatar из панели)
//         SKIP_AVATAR=1             не менять аву (напр. уже стоит)
//         GL_CLOUD=1                поднять через облако GoLogin (по умолчанию ЛОКАЛЬНО, часы кончились)
//         KEEP_OPEN=1              не закрывать окно (для отладки/цепочки с прогревом)
//
// ПРАВИЛА (см. vcomment.cjs): НИКОГДА не убивать профиль pkill/kill -9 (акк вылогинится); закрывать только
// gl.stopLocal()/killBrowser своего профиля. Процесс ОБЯЗАН завершиться (SDK держит хендлы → иначе виснет).
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const SHOT = process.env.SHOT_DIR || '/tmp';
const SLUG = process.argv[2];
const LOCAL = process.env.GL_CLOUD !== '1'; // по умолчанию локально (0 облачных часов)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ПОЛ: «female» СОДЕРЖИТ «male» — регулярка /male/ ловила женщин как мужчин (баг 28.07, всем ставились
// мужские имена и лица). Проверяем строго.
function isMale(g) { const s = String(g || '').trim().toLowerCase(); return s === 'm' || s === 'male' || s === 'муж' || s === 'мужской'; }
// --- ИМЕНА: широкий пул + варианты написания (не однотипно: «Лена», «лена», «Лена К.», «Ленчик») ---
const RU_NAMES = ['Лена', 'Настя', 'Оля', 'Маша', 'Вика', 'Даша', 'Соня', 'Полина', 'Катя', 'Аня', 'Юля', 'Кристина',
  'Алина', 'Ника', 'Марина', 'Кира', 'Саша', 'Женя', 'Таня', 'Ира', 'Света', 'Лиза', 'Варя', 'Милана', 'Ксюша',
  'Диана', 'Карина', 'Влада', 'Арина', 'Ульяна', 'Рита', 'Яна', 'Инна', 'Люда', 'Надя', 'Вера', 'Тася', 'Злата'];
const RU_NAMES_M = ['Макс', 'Кирилл', 'Денис', 'Антон', 'Рома', 'Илья', 'Артём', 'Егор', 'Саша', 'Дима', 'Костя',
  'Паша', 'Влад', 'Никита', 'Стас', 'Гоша', 'Тимур', 'Марк', 'Лёша', 'Серёга', 'Ваня', 'Миша', 'Женя', 'Слава', 'Боря'];
const LAST_LETTER = ['К.', 'М.', 'С.', 'Л.', 'Р.', 'Т.', 'В.', 'Н.'];
const NAME_EMOJI = ['✨', '🌷', '🎨', '🌙', '🖤', '☕️', '🪐', '🌿', '📷', '🫧'];
// ЛАТИНИЦА и НЕ-русские имена (решение владельца 28.07: имя НЕ обязано быть настоящим и русским).
const LAT_F = ['Maria', 'Masha', 'Lena', 'Kate', 'Sofia', 'Alina', 'Nika', 'Mila', 'Vera', 'Dasha', 'Anya', 'Polina',
  'Emma', 'Mia', 'Aria', 'Lia', 'Noa', 'Ava', 'Zoe', 'Ella', 'Nora', 'Iva', 'Sasha', 'Alice', 'Eva', 'Amina', 'Leyla', 'Dilara'];
const LAT_M = ['Max', 'Mark', 'Denis', 'Anton', 'Leo', 'Adam', 'Alex', 'Ivan', 'Nick', 'Dan', 'Timur', 'Amir', 'Erik', 'Kirill'];
const SYMBOLS = ['.', '·', '✿', '~', '—', '×'];
const EMOJI_ONLY = ['♡', '🖤', '✨', '🌙', '🫧', '🍒', '🤍', '🕊', '🌷', '☁️', '🐈', '🍓', '💫', '🦋'];
// Формы записи имени: специально РАЗНЫЕ (у живых людей от «.» и «♡» до «Maria K.»). Бренда в имени НЕТ.
function humanName(gender) {
  const male = isMale(gender);
  const ru = pick(male ? RU_NAMES_M : RU_NAMES);
  const lat = pick(male ? LAT_M : LAT_F);
  const r = Math.random();
  let out;
  if (r < 0.18) out = ru;                                            // Маша
  else if (r < 0.34) out = lat;                                      // Maria
  else if (r < 0.44) out = lat.toLowerCase();                        // maria
  else if (r < 0.52) out = ru.toLowerCase();                         // маша
  else if (r < 0.60) out = pick(EMOJI_ONLY);                         // ♡  (только эмодзи)
  else if (r < 0.66) out = pick(SYMBOLS);                            // .  (одна точка)
  else if (r < 0.72) out = (male ? ru : ru)[0];                      // М  (одна буква)
  else if (r < 0.77) out = lat[0];                                   // M
  else if (r < 0.83) out = `${lat} ${pick(LAST_LETTER)}`;             // Maria K.
  else if (r < 0.88) out = `${ru} ${pick(NAME_EMOJI)}`;               // Маша ✨
  else if (r < 0.92) out = `${lat.toLowerCase()} ${pick(EMOJI_ONLY)}`; // maria ♡
  else if (r < 0.96) out = lat.split('').join('.').toLowerCase();      // m.a.r.i.a
  else out = `${ru} ${pick(['·', '|'])} ${pick(['мск', 'спб', 'кзн', 'екб', 'нск', '18', '21', '00'])}`;
  return out.trim().slice(0, 28);
}
// --- БИО: собираем комбинаторно (тысячи вариантов), а не из 9 фраз. БЕЗ ссылок и промо. ---
// Падежи: у каждого зачина СВОЙ список окончаний, иначе выходит «играюсь с визуал» (проверено 28.07).
const BIO_PHRASE = [
  () => `тут про ${pick(['нейросети', 'картинки', 'ии-арт', 'визуал', 'фото', 'эстетику', 'красивое'])}`,
  () => `делаю ${pick(['картинки', 'визуал', 'арты', 'всякое через ии'])}`,
  () => `залипаю в ${pick(['нейросети', 'картинки', 'ии-арт'])}`,
  () => `снимаю ${pick(['фото', 'всякое', 'моменты'])}`,
  () => `собираю ${pick(['красивое', 'идеи', 'вдохновение', 'референсы'])}`,
  () => `изучаю ${pick(['нейросети', 'промпты', 'ии', 'фотографию'])}`,
  () => `кайфую от ${pick(['картинок', 'визуала', 'нейросетей', 'красивых кадров'])}`,
  () => `играюсь с ${pick(['нейросетями', 'промптами', 'ии'])}`,
];
const BIO_TOPIC = ['нейросети', 'картинки', 'ии-арт', 'визуал', 'фото', 'эстетика', 'идеи'];
const BIO_TAIL = ['по вечерам', 'вместо сна', 'когда есть время', 'между делом', 'каждый день', 'иногда', '', '', ''];
const BIO_SOLO = ['ловлю моменты', 'тут красиво', 'без фильтров', 'по настроению', 'фото и мысли', 'жизнь как есть',
  'делюсь тем что нравится', 'коллекция вдохновения', 'просто вайб', 'учусь новому', 'котики и картинки',
  'смотрю, пробую, повторяю', 'мой маленький архив', 'сохраняю красивое'];
const BIO_EMOJI = ['✨', '🤖', '🌙', '🐱', '📷', '🎨', '🫧', '🌿', '☕️', '', '', ''];
function humanBio() {
  const r = Math.random();
  let s;
  if (r < 0.45) { const t = pick(BIO_TAIL); s = `${pick(BIO_PHRASE)()}${t ? ' ' + t : ''}`; }
  else if (r < 0.80) s = pick(BIO_SOLO);
  else { const a = pick(BIO_TOPIC); let b = pick(BIO_TOPIC); if (b === a) b = pick(BIO_TOPIC); s = `${a}, ${b}`; } // «фото, идеи»
  const e = pick(BIO_EMOJI);
  return (e ? `${s} ${e}` : s).slice(0, 140);
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

// =====================  НИКИ (@username)  =====================
// Владелец 28.07: ник и ава — ПЕРВОЕ, что видит человек, открывая профиль. У нас 50% ников мусорные
// («английское мужское имя + 5-6 случайных цифр»: melvin15648, kaleb57609) — это след купленного акка.
// 9 стилей в ротации, СТИЛЬ ПОДБИРАЕТСЯ ПОД КАТЕГОРИЮ АВЫ (аниме-ава → аниме-ник), иначе диссонанс.
const NICK_LAT_F = ['lena', 'nastya', 'masha', 'polina', 'kate', 'alina', 'sofia', 'vika', 'dasha', 'anya', 'mila',
  'kira', 'nika', 'arina', 'ksusha', 'yana', 'liza', 'rita', 'julia', 'diana', 'karina', 'ulyana', 'varya', 'tanya'];
const NICK_LAT_M = ['max', 'mark', 'denis', 'anton', 'roma', 'ilya', 'egor', 'sasha', 'dima', 'kostya', 'vlad', 'timur', 'artem'];
const NICK_SURN_F = ['moroz', 'sokolova', 'volkova', 'zaytseva', 'orlova', 'belova', 'kotova', 'lisova', 'petrova', 'ivanova', 'smirnova'];
const NICK_SURN_M = ['moroz', 'sokolov', 'volkov', 'zaytsev', 'orlov', 'belov', 'kotov', 'lisov', 'petrov', 'ivanov', 'smirnov'];
const NICK_GEO = ['msk', 'spb', 'kzn', 'nsk', 'ekb', 'krd', 'vrn', 'sam', 'ufa', 'rnd'];
const NICK_HOBBY = ['coffee', 'nails', 'art', 'books', 'mood', 'kitty', 'sweet', 'photo', 'music', 'dance'];
const NICK_AEST = ['moonlight', 'sad.vibes', 'blvck.rose', 'soft.cloud', 'cherry.mood', 'honey.milk', 'velvet.sky',
  'night.rain', 'lost.star', 'blue.hour', 'silent.snow', 'pale.rose'];
const NICK_ANIME = ['yuki', 'sakura', 'kira', 'akatsuki', 'senpai', 'kawaii', 'tokyo', 'shinigami', 'hikari', 'ayame', 'rei', 'miku'];
const NICK_ANIME_TAIL = ['.chan', '.mood', '.exe', '.san', '.no', '_uwu', '.kun', '.desu'];
const LEET = (s) => s.replace(/a/g, () => (Math.random() < 0.6 ? '4' : 'a')).replace(/o/g, () => (Math.random() < 0.5 ? '0' : 'o')).replace(/e/g, () => (Math.random() < 0.4 ? '3' : 'e'));
const dig2 = () => String(Math.floor(Math.random() * 90) + 10);                       // 2 цифры (99, 05)
const year = () => String(Math.floor(Math.random() * 9) + 1999);                      // год рождения 1999-2007
const dob = () => String(Math.floor(Math.random() * 28) + 1).padStart(2, '0') + String(Math.floor(Math.random() * 12) + 1).padStart(2, '0'); // 2306
// 9 стилей
const NICK_STYLES = {
  A: (n, m) => `${n}.${pick(m ? NICK_SURN_M : NICK_SURN_F)}`,                                                // lena.moroz
  B: (n) => (Math.random() < 0.5 ? `_${n}${'a'.repeat(2 + Math.floor(Math.random() * 2))}_` : `${n.split('').join('.')}`), // _lenaaa_ / l.e.n.a
  V: () => `${pick(NICK_AEST)}${Math.random() < 0.4 ? '.' + dig2() : ''}`,             // moonlight.99
  G: (n) => pick([`${n}${dob()}`, `${n}_${dob()}`, `${n}.${year().slice(2)}`]),        // alina2306
  D: (n) => pick([`${n}chik`, `${n}usha`, `${n}unya`, `${n}ka`, `${n}ulya`]),          // lenchik, nastyusha
  E: (n) => pick([`${pick(NICK_HOBBY)}.${n}`, `${pick(NICK_HOBBY)}.by.${n}`]),         // coffee.lena
  ZH: (n) => pick([`${n}.${pick(NICK_GEO)}`, `${pick(NICK_GEO)}_${n}`]),               // lena.msk
  Z: (n) => LEET(n) + pick(['', '_', '.x', dig2()]),                                   // n4stya
  I: () => `${pick(NICK_ANIME)}${pick(NICK_ANIME_TAIL)}`,                              // yuki.chan
};
// Категория авы → какие стили ей идут (связка ава↔ник, решение владельца)
const CAT_STYLES = {
  anime: ['I', 'I', 'Z', 'B'],
  popculture: ['I', 'V', 'Z'],
  animals: ['E', 'D', 'A'],
  girly: ['A', 'B', 'V', 'G', 'D'],
  car: ['G', 'ZH', 'Z'],
  nature: ['V', 'ZH', 'A'],
  city: ['V', 'ZH', 'Z'],
  mood: ['V', 'B', 'A'],
};
// ИМЯ МОДЕЛИ В ОСНОВЕ НИКА. Аккаунт ведёт конкретная девочка, и ник вида @nails.by.sofia99 у
// «Анечки» ломает легенду: сам же гейт личности потом ругается «ник содержит чужое имя». Поэтому
// для модельных акков основой берём ИМЯ ПЕРСОНЫ (PERSONA_NAME), а пул случайных имён остаётся
// запасным вариантом для акков без персоны.
function humanNick(gender, avatarCat, fromName) {
  const persona = String(process.env.PERSONA_NAME || '').trim();
  if (persona) fromName = persona;
  const male = isMale(gender);
  // Если у акка уже стоит человеческое имя (Лена / Maria / маша) — берём ЕГО основой ника, так профиль цельный.
  const tr = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya' };
  let fromN = String(fromName || '').toLowerCase().replace(/[^a-zа-яё]/g, '');
  fromN = fromN.split('').map((ch) => (tr[ch] !== undefined ? tr[ch] : ch)).join('');
  const base = (fromN.length >= 3 && fromN.length <= 12) ? fromN : pick(male ? NICK_LAT_M : NICK_LAT_F);
  const styles = CAT_STYLES[avatarCat] || ['A', 'B', 'V', 'G', 'D', 'E', 'ZH', 'Z', 'I'];
  let nick = NICK_STYLES[pick(styles)](base, male);
  nick = nick.toLowerCase().replace(/[^a-z0-9._]/g, '').replace(/\.{2,}/g, '.').replace(/^[._]+|[._]+$/g, '');
  if (nick.length < 4) nick += dig2();
  return nick.slice(0, 28);
}

// Лестница вариантов, когда ник занят (а популярные ники заняты почти всегда): добавляем цифры, подчёркивания,
// удлиняем, потом берём другую основу. Порядок от «красивого» к «гарантированно свободному».
function nickVariant(base, att, gender, cat) {
  const b = String(base).replace(/[^a-z0-9._]/g, '');
  switch (att) {
    case 1: return b + dig2();                       // lena.moroz47
    case 2: return '_' + b + '_';                    // _lena.moroz_
    case 3: return b + '.' + year().slice(2);        // lena.moroz.03
    case 4: return b.replace(/\./g, '_') + dig2();   // lena_moroz19
    case 5: return humanNick(gender, cat);           // совсем другая основа
    case 6: return humanNick(gender, cat) + dig2();
    default: return humanNick(gender, cat) + '.' + dob();
  }
}
// Не выдаём один ник двум нашим аккам.
async function nickTakenInFleet(nick) {
  try {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    await c.connect();
    const r = await c.query(`SELECT 1 FROM accounts WHERE lower(coalesce(ig_login,'')) = lower($1) LIMIT 1`, [nick]);
    await c.end();
    return r.rowCount > 0;
  } catch { return false; }
}
// Мусорный ли текущий ник: «имя+4-6 цифр» (купленный акк) или наши внутренние FOL_/TT.
function isJunkNick(h) {
  const s = String(h || '').trim();
  if (!s) return true;
  if (/^(FOL|TT)[\s_]/i.test(s) || /^акк\s/i.test(s)) return true;   // наши внутренние
  if (/^[a-z]+\d{4,}$/i.test(s)) return true;                        // melvin15648
  if (/\d{4,}/.test(s)) return true;                                 // 4+ цифр подряд: case17002
  if (/^[a-z]+_[a-z]+[0-9a-z]{0,4}$/i.test(s) && /\d/.test(s)) return true; // bowen_parnin7m1 (имя_фамилия+хвост)
  if (/^[a-z]{2,}_[a-z]{4,}$/i.test(s)) return true;                  // whitmore_evangeline (англ. имя_фамилия)
  return false;
}

// === АВА №1 (основная): генерим ЖИВОЕ селфи через RenderGrid nano-banana-2 (тот же движок, что generateAvatar
// в src/ai.ts). StyleGAN-лица (this-person-does-not-exist) палятся: пластик, мутный фон, кривые уши — владелец
// забраковал 28.07. Тут собираем промпт КОМБИНАТОРНО (сцена × свет × одежда × настроение), чтобы у каждого акка
// был свой вайб, а не один шаблон. Ключ: NANO_BANANA_API_KEY / NEIRONKA_MEDIA_API (rg_live...).
// РЕШЕНИЕ ВЛАДЕЛЬЦА 28.07: ИИ-ЛИЦА НЕ СТАВИМ («видно что не настоящие» — артефакты кожи/глаз/ушей палятся).
// Ставим то, что у реальных людей и так часто на аве и что ПОДДЕЛАТЬ НЕЛЬЗЯ (нет лица → нечего распознавать):
// кот/собака, кофе в руках, вид из окна, улица вечером, цветы, вид со спины, зеркало с телефоном у лица.
// Проверено: кот на кровати неотличим от обычного фото. Лица только если AV_FACE=1.
const AV_NOFACE = [
  'amateur iphone photo of a fluffy grey cat sleeping on a bed, home, natural window light, casual phone snapshot, no people',
  'amateur iphone photo of a ginger cat sitting on a windowsill, looking outside, home, casual snapshot, no people',
  'amateur iphone photo of a small dog on a couch, cozy home, natural light, casual phone snapshot, no people',
  'amateur iphone photo, close up of hands holding a coffee cup on a cafe table, blurry background, no face visible',
  'amateur iphone photo of a coffee cup and a book on a table near a window, cozy morning, casual snapshot',
  'amateur iphone photo of an evening city street with lights, wet asphalt, slightly blurry, casual snapshot, no people',
  'amateur iphone photo of a sunset over rooftops from a balcony, casual phone snapshot, slight grain',
  'amateur iphone photo of a bouquet of tulips on a kitchen table, home, natural light, casual snapshot',
  'amateur iphone photo of a young woman from behind, back view only, standing at a window, no face visible, soft daylight',
  'amateur iphone photo of a young woman from behind walking in a park in autumn, back view, no face, casual',
  'amateur iphone mirror selfie, phone covering most of the face, ordinary apartment hallway, low light, grainy',
  'amateur iphone photo of a cozy room with plants, string lights and a bed, no people, casual home snapshot',
  'amateur iphone photo of sneakers and legs on an asphalt road from above, no face, casual snapshot',
  'amateur iphone photo of a cat paw on a laptop keyboard, home desk, casual snapshot, no people',
  'amateur iphone photo of a snowy street from a car window, winter evening, slightly blurry, no people',
];
const AV_SUBJ_F = ['young russian woman in her early 20s', 'russian girl, 19 years old', 'young woman, mid 20s, plain look',
  'ordinary russian girl next door, early 20s', 'young woman with freckles, 22 years old'];
const AV_SUBJ_M = ['young russian man in his early 20s', 'russian guy, 19 years old, plain look',
  'ordinary young man, mid 20s', 'young guy with short hair, 21 years old'];
const AV_SCENE = ['in a cozy cluttered room with plants and books', 'in a small kitchen in the morning',
  'sitting in a car, driver seat', 'at a cafe table with a coffee cup', 'in a park in autumn',
  'mirror selfie in a hallway of an ordinary apartment', 'on a balcony of a panel house',
  'in a bedroom with a warm lamp at evening', 'on a city street, blurry buildings behind',
  'at home on a sofa under a blanket', 'in a university hallway', 'near a window with rain outside'];
const AV_OUTFIT = ['oversized knit sweater', 'plain hoodie', 'simple t-shirt', 'denim jacket', 'sportswear',
  'checked shirt', 'turtleneck', 'home clothes'];
const AV_LIGHT = ['soft daylight from a window', 'warm lamp light', 'overcast dull light', 'golden hour sunlight',
  'harsh phone flash at night', 'cool grey winter light'];
const AV_MOOD = ['slight natural smile', 'neutral calm face', 'laughing candidly', 'looking slightly away from camera',
  'tired but happy expression'];
const AV_REAL = 'amateur iphone selfie, candid, realistic skin texture with pores and small imperfections, ' +
  'messy natural hair, no professional makeup, not a model, slight noise and motion blur, imperfect framing, everyday casual photo';
async function genFaceAI(pathOut, gender) {
  const key = process.env.NANO_BANANA_API_KEY || process.env.NEIRONKA_MEDIA_API || process.env.NEIRONKA_MEDIA_API_KEY;
  if (!key) return false;
  const male = isMale(gender);
  // ПО УМОЛЧАНИЮ — БЕЗ ЛИЦА (решение владельца: ИИ-лица палятся). AV_FACE=1 вернёт селфи с лицом.
  const prompt = process.env.AV_FACE === '1'
    ? `${pick(male ? AV_SUBJ_M : AV_SUBJ_F)}, ${pick(AV_SCENE)}, wearing ${pick(AV_OUTFIT)}, ${pick(AV_LIGHT)}, ${pick(AV_MOOD)}, ${AV_REAL}`
    : pick(AV_NOFACE);
  const BASE = process.env.RENDERGRID_BASE || 'https://api.rendergrid.io/api/public/v1';
  try {
    const g = await fetch(`${BASE}/images/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'nano-banana-2', prompt, aspect_ratio: '1:1' }), signal: AbortSignal.timeout(20000),
    });
    if (!g.ok) { console.log(`  (ген-ава HTTP ${g.status})`); return false; }
    const j = await g.json(); if (!j.id) return false;
    for (let k = 0; k < 22; k++) {
      await sleep(4000);
      const p = await fetch(`${BASE}/creations/${j.id}`, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!p || !p.ok) continue;
      const d = await p.json();
      if (d.status === 'completed' && d.result_urls && d.result_urls.length) {
        const im = await fetch(d.result_urls[0], { signal: AbortSignal.timeout(30000) });
        const buf = Buffer.from(await im.arrayBuffer());
        if (buf.length > 20000) {
          fs.writeFileSync(pathOut, buf);
          // ужимаем до 1080px: IG всё равно режет, а 6+ МБ грузятся долго и палят «не-телефонный» файл
          try { require('child_process').execFileSync('sips', ['-Z', '1080', pathOut, '--out', pathOut], { stdio: 'ignore', timeout: 20000 }); } catch { /* не критично */ }
          console.log(`  ава сгенерена (${prompt.slice(0, 60)}…)`);
          return true;
        }
        return false;
      }
      if (d.status === 'failed' || d.status === 'error') return false;
    }
  } catch (e) { console.log('  (ген-ава err:', String(e.message).slice(0, 40) + ')'); }
  return false;
}

// === АВА №2 (запасная): StyleGAN-лицо. Хуже (палевно), включается только если генерация недоступна.
async function getFace(pathOut, gender) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const g = isMale(gender) ? 'male' : 'female';
  for (let k = 0; k < 5; k++) {
    try {
      // etnic: под русскоязычную аудиторию берём европейские лица (AV_ETNIC=all/asian/... переопределяет).
      const et = process.env.AV_ETNIC || 'white';
      const meta = await fetch(`https://this-person-does-not-exist.com/new?time=${Date.now()}${k}&gender=${g}&etnic=${et}&age=19-25`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).then((r) => r.json());
      if (meta && meta.src) {
        const im = await fetch('https://this-person-does-not-exist.com' + meta.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
        const buf = Buffer.from(await im.arrayBuffer());
        if (buf.length > 10000) {
          fs.writeFileSync(pathOut, buf);
          // КРИТ: источник ставит ВОДЯНОЙ ЗНАК «this-person-does-not-exist.com» поперёк верха → ава-палево.
          // Срезаем центральным кропом 1024→890 по высоте (уносит верхнюю и нижнюю полосы), лицо не страдает.
          try {
            require('child_process').execFileSync('sips', ['-c', '890', '1024', pathOut, '--out', pathOut], { stdio: 'ignore', timeout: 20000 });
          } catch { console.log('  (sips-обрезка не удалась, ава с ватермаркой — НЕ ставлю)'); return false; }
          return true;
        }
      }
    } catch {}
    await sleep(2000);
  }
  return false;
}
async function downloadUrl(url, pathOut) {
  try {
    const im = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await im.arrayBuffer());
    if (buf.length > 5000) { fs.writeFileSync(pathOut, buf); return true; }
  } catch {}
  return false;
}

async function loadDb() {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try {
      await c.connect();
      // защитно доводим колонки оформления (общий schema.sql правит другой чат; ALTER идемпотентен)
      await c.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dressed_at timestamptz`).catch(() => {});
      await c.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_set boolean`).catch(() => {});
      await c.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bio_set boolean`).catch(() => {});
      await c.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nick_changed_at timestamptz`).catch(() => {});
      // Ищем ТОЛЬКО по slug: модельные акки переехали в platform='promo' (изоляция от комментинга,
      // promoisolate.cjs), и жёсткий фильтр 'comments' оставил бы их без оформления. slug уникален
      // в пределах платформы, но одинаковых slug на разных платформах у нас нет.
      const a = (await c.query(`SELECT id, gologin_profile_id, gender, ig_login, ig_login_old, ig_password, ig_email, ig_email_password, totp_secret, display_name, ig_cookies FROM accounts WHERE slug=$1 AND deleted_at IS NULL`, [SLUG])).rows[0];
      const gt = (await c.query(`SELECT g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0]?.gologin_token;
      await c.end();
      return { a, gt };
    } catch (e) { await c.end().catch(() => {}); await sleep(2500); }
  }
  throw new Error('db недоступна');
}
async function dbExec(sql, params) {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); await c.query(sql, params); } catch (e) { console.log('  (db:', String(e.message).slice(0, 50) + ')'); } finally { await c.end().catch(() => {}); }
}


// ================== ВХОД ПО ЭКРАНАМ (переписан 28.07 после наблюдений владельца) ==================
// Было: скрипт путал полную форму с one-tap-модалкой (вводил только пароль) и ВЫХОДИЛ на экране 2FA.
// Стало: цикл-автомат. На каждом шаге смотрим, ЧТО на экране, и делаем ровно одно действие.
// TOTP считаем сами из totp_secret (RFC 6238), как в chlogin/iglogin.
function totpCode(secret) {
  const crypto = require('crypto');
  const b32 = String(secret || '').replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32) { const v = A.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const bytes = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeUInt32BE(Math.floor(Date.now() / 30000), 4);
  const h = crypto.createHmac('sha1', bytes).update(ctr).digest();
  const off = h[h.length - 1] & 0xf;
  const num = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(num % 1000000).padStart(6, '0');
}

// Берём первое поле, которое РЕАЛЬНО видимо и доступно для ввода. IG держит в DOM скрытые инпуты
// (пароль, код) — печать в них «успешна» по inputValue(), но на экране поле пустое (наблюдение владельца 29.07:
// «на окне 2фа не ввёл ничего»). Один помощник на все поля, чтобы эта дыра не повторялась.
async function firstUsable(page, selector) {
  const cands = await page.locator(selector).all().catch(() => []);
  for (const f of cands) {
    if (await f.isVisible().catch(() => false) && await f.isEditable().catch(() => false)) return f;
  }
  return null;
}
async function typeVerified(field, value, label, log, page, selector) {
  for (let t = 0; t < 3; t++) {
    // React пересоздаёт узел при перерисовке → старый локатор «отсоединён», и печать уходит в никуда.
    // Если знаем селектор, берём поле ЗАНОВО на каждой попытке (криминалистика 29.07: «пароль не впечатался ×3»).
    if (t > 0 && page && selector) { const fresh = await firstUsable(page, selector); if (fresh) field = fresh; }
    await field.click({ timeout: 4000 }).catch(async () => { await field.click({ timeout: 3000, force: true }).catch(() => {}); });
    await field.fill('', { timeout: 4000 }).catch(() => {});
    await field.pressSequentially(String(value), { delay: 35, timeout: 15000 }).catch(async () => { await field.fill(String(value), { timeout: 4000 }).catch(() => {}); });
    await sleep(500);
    const got = await field.inputValue().catch(() => '');
    if (got === String(value)) return true; // строго: раньше 3 символа из 10 считались успехом → форма уходила с обрезанным логином
    if (log) log(`  ↻ ${label} не впечатался (форма перерисовалась), повтор ${t + 1}`);
    await sleep(900);
  }
  return false;
}
// Возвращает: 'ok' | 'bad_creds' | 'checkpoint' | 'fail'
async function smartLogin(page, a, slug, log, snap) {
  const user = a.ig_login || slug;
  // ЗАПРЕТ ВХОДА ПО ПАРОЛЮ (07.08, приказ начальника «входы только на куках»). Вход паролём это
  // главный убийца акков: 03.08 на нём сгорели два, а 07.08 первая же попытка получила анти-бот
  // блок. Раньше здесь не было способа сказать «только куки»: если куки не сработали, скрипт молча
  // печатал пароль. Теперь при NO_PASSWORD=1 такой акк честно помечается как «нужен вход руками».
  if (/^(1|true|yes)$/i.test(String(process.env.NO_PASSWORD || ''))) {
    const passField0 = await firstUsable(page, 'input[type="password"]');
    if (passField0) {
      log && log('  ⛔ куки не сработали, а вход паролём запрещён (NO_PASSWORD=1) — оставляю акк как need_login');
      const err = new Error('need_login: куки не подняли сессию, пароль вводить запрещено');
      err.needLogin = true;
      throw err;
    }
  }
  let submitted = 0, codeTried = 0, contTried = 0;
  for (let step = 0; step < 22; step++) {
    // ГАСИМ ОВЕРЛЕИ ПЕРЕД КАЖДЫМ ШАГОМ (аналитик п.6): под баннером клик перехватывается, Playwright 30с
    // скроллит и ретраит, ошибка съедается — это и есть «скрипт скроллит под попапом и упирается».
    try {
      for (const rx of [/Allow all cookies|Разрешить все|Accept all|Принять все/i, /^(Not now|Не сейчас|Позже|Dismiss)$/i]) {
        const b = page.getByRole('button', { name: rx }).first();
        if (await b.isVisible({ timeout: 1200 }).catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(600); }
      }
    } catch { /* нет попапов */ }
    const url = page.url();
    if (snap && step % 4 === 0) await snap(`login_s${step}`).catch(() => {});
    // 1) залогинены? (edit-страница/лента/профиль без формы)
    const onLogin = /accounts\/login|__coig_login/.test(url);
    const passField = await firstUsable(page, 'input[type="password"]');
    const hasPass = !!passField;
    // СЕЛЕКТОР ПОЛЯ КОДА. Узкий вариант НЕ ловил реальное окно two_step_verification (поле там просто «Code»),
    // из-за чего скрипт стоял на 2FA и молчал 44 секунды (наблюдение владельца 28.07). Берём широкий, как в
    // рабочем chlogin.cjs, но ЯВНО исключаем поля логина/пароля, чтобы не напечатать код не туда.
    const CODE_SEL = 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[aria-label*="код" i], input[placeholder*="code" i], input[placeholder*="код" i], input[inputmode="numeric"], input[maxlength="6"], input[maxlength="8"], input[type="tel"], input[type="text"]:not([name="username"]):not([name="email"]):not([autocomplete="username"])';
    // 2FA определяем ТОЛЬКО по URL. Признак «есть текстовое поле» ловил Website/Bio/поиск и уводил в ложную 2FA.
    const on2fa = /two_step_verification|two_factor|codeentry|challenge\/.*code/i.test(url);
    const codeField = on2fa ? await firstUsable(page, CODE_SEL) : null;
    const hasCode = !!codeField;
    // 1) ВХОД ПОДТВЕРЖДАЁМ ПЕРВЫМ ДЕЛОМ И БЕЗУСЛОВНО: если есть кука sessionid и мы не на странице логина —
    // мы внутри, точка. (Криминалистика 29.07: раньше проверка стояла за условием !hasCode и не срабатывала,
    // из-за чего скрипт печатал TOTP в строку ПОИСКА уже залогиненного аккаунта.)
    if (!onLogin && !/challenge|two_step_verification|two_factor|codeentry/i.test(url)) {
      const ck = await page.context().cookies('https://www.instagram.com').catch(() => []);
      // Подтверждаем вход ДВУМЯ способами: кука sessionid ИЛИ видимые маркеры залогиненного IG (лента/Edit profile).
      // В CDP-браузере Orbita cookies() иногда пуст — тогда акк ВОШЁЛ, а мы этого «не видели» и крутились 20 шагов
      // впустую (наблюдение 29.07: на экране Edit profile, а скрипт «вход не завершился»).
      const hasSess = ck.some((c) => c.name === 'sessionid' && c.value && c.value.length > 10);
      const loggedDom = (await page.locator('a[href="/explore/"], a[href="/reels/"], svg[aria-label="Home" i], svg[aria-label="Главная" i], button:has-text("Change photo"), textarea[name="biography"]').first().isVisible({ timeout: 1500 }).catch(() => false));
      if (hasSess || loggedDom) {
        log(`  ✓ вход подтверждён (${hasSess ? 'sessionid' : 'DOM: залогинен'})`);
        // СОХРАНЯЕМ КУКИ: вход — самая дорогая операция (жжёт попытки и провоцирует чек-поинты). Раз получилось —
        // складываем сессию в ig_cookies, чтобы следующий раз входить НЕ ПРИШЛОСЬ (архитектурный вывод 29.07).
        try {
          const useful = ck.filter((c) => /instagram/i.test(c.domain || ''));
          if (useful.length) { await dbExec(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', session_checked_at=now() WHERE id=$1`, [a.id, JSON.stringify(useful)]); log(`  💾 сессия сохранена (${useful.length} кук) — следующий вход не понадобится`); }
        } catch (e) { log('  (куки не сохранил: ' + String(e.message).slice(0, 40) + ')'); }
        return 'ok';
      }
    }
    // 2) неверные креды — дальше бессмысленно
    if (await page.getByText(/login information you entered is incorrect|incorrect password|неверн\w* парол/i).first().isVisible().catch(() => false)) {
      log('  ✗ IG: неверный логин/пароль (брак кредов)'); return 'bad_creds';
    }
    // 3) чек-поинт/лок
    if (/challenge|auth_platform\/challenge|accounts\/(suspended|disabled)/.test(url) && !hasCode && (await page.locator('input[inputmode="numeric"], input[maxlength="1"]').count().catch(() => 0)) === 0) { log('  ⛔ чек-поинт/лок'); return 'checkpoint'; }
    // 4) 2FA: вводим TOTP
    if (on2fa) {
      if (!a.totp_secret) { log('  ⛔ 2FA, но нет totp_secret'); return 'fail'; }
      if (codeTried >= 2) { log('  ⛔ 2FA: код не принят 2 раза'); return 'fail'; }
      // Ждём СВЕЖЕЕ окно TOTP: если до конца текущего <8с, код протухнет пока летит запрос, и повтор
      // с ТЕМ ЖЕ кодом IG отклоняет всегда (использованный TOTP). Аналитик 28.07, п.12.
      const left = 30 - Math.floor((Date.now() / 1000) % 30);
      if (left < 8) { log(`  ⏳ жду новое окно TOTP (${left}с)`); await sleep((left + 1) * 1000); }
      const code = totpCode(a.totp_secret);
      log(`  🔑 2FA → ввожу код ${code}`);
      // поле могло появиться позже — ищем заново, до 12с, а не «нет и ладно»
      let cf = codeField;
      for (let w = 0; w < 6 && !cf; w++) { await sleep(2000); cf = await firstUsable(page, CODE_SEL); }
      if (!cf) {
        const dump = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => `${i.type}|${i.name}|${i.getAttribute('aria-label')}|${i.placeholder}`).slice(0, 6)).catch(() => []);
        log(`  ⛔ поле кода не найдено. Инпуты на странице: ${JSON.stringify(dump)}`);
        return 'fail';
      }
      // Если код уже набран и IG проверяет — ЖДЁМ вердикт, попытку не тратим (ревью 28.07: иначе печатали
      // поверх и выжигали обе попытки, а живой акк помечался мёртвым).
      const already = await cf.inputValue().catch(() => '');
      if (String(already).replace(/\D/g, '').length >= 6) { await sleep(4000); continue; }
      // ЛЕЙАУТ «6 КЛЕТОК»: input[maxlength=1] × 6. Печатать в первую нельзя (typeVerified увидит 1 символ,
      // решит что не впечаталось и допечатает поверх → каша). Печатаем клавиатурой после клика в первую.
      const boxes = await page.locator('input[maxlength="1"]').count().catch(() => 0);
      if (boxes >= 4) {
        log(`  (лейаут ${boxes} клеток → печатаю клавиатурой)`);
        await page.locator('input[maxlength="1"]').first().click().catch(() => {});
        await page.keyboard.type(code, { delay: 70 }).catch(() => {});
      } else {
        await typeVerified(cf, code, '2FA-код', log, page, CODE_SEL);
      }
      // Проверяем ФАКТ: что реально в поле после набора. Пусто → не жмём Continue, попытку не тратим.
      const typed = await cf.inputValue().catch(() => '');
      const digits = String(typed).replace(/\D/g, '');
      log(`  в поле кода сейчас: «${typed}» (${digits.length} цифр)`);
      if (digits.length < 6) {
        const dump = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => `${i.type}|${i.name}|vis:${i.offsetParent !== null}|val:${(i.value || '').length}`).slice(0, 8)).catch(() => []);
        log(`  ⛔ код не попал в поле. Инпуты: ${JSON.stringify(dump)}`);
        await sleep(2500); continue;
      }
      codeTried++;
      const cont = page.getByRole('button', { name: /^(Continue|Confirm|Подтвердить|Продолжить|Next|Далее)$/i }).first();
      if (await cont.isVisible().catch(() => false)) await cont.click().catch(() => {});
      else await cf.press('Enter').catch(() => {});
      await sleep(9000);
      continue;
    }
    // СПИННЕР-ГЕЙТ (аналитик п.8): пока крутится загрузка, экран НЕ финальный — ждём, шаг не тратим.
    const spinning = await page.locator('button svg circle[stroke-dasharray], [role="progressbar"], button[disabled] svg').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (spinning) { await sleep(1500); continue; }
    // Кулдаун IG: повторные попытки только усугубят
    if (await page.getByText(/wait a few minutes|подождите несколько минут/i).first().isVisible({ timeout: 800 }).catch(() => false)) { log('  ⏳ IG просит подождать — стоп'); return 'fail'; }
    // 5) «Save info» / «Не сейчас» — жмём сохранить (акк станет доверенным, меньше 2FA потом)
    const save = page.getByRole('button', { name: /^\s*(Save info|Сохранить(\sинформацию)?)\s*$/i }).first();
    if (await save.isVisible().catch(() => false)) { log('  💾 Save info'); await save.click().catch(() => {}); await sleep(4000); continue; }
    // 6a) «Continue as X» (сохранённый вход). ВАЖНО: проверяем ДО пароля — на этом экране видимого поля
    // пароля нет, есть только кнопка, и правильное действие именно нажать её (наблюдение 29.07).
    if (!hasPass) {
      const contBtn = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
      if (await contBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        if (contTried >= 2) { log('  ⛔ Continue не сработал 2 раза — стоп'); return 'fail'; }
        contTried++; log(`  ▶ Continue as ${user} (сохранённый вход)`);
        await contBtn.click({ timeout: 5000 }).catch(() => {});
        await sleep(7000); continue;
      }
    }
    // 6) форма логина: заполняем ОБА поля с проверкой
    if (hasPass) {
      // ВТОРОЙ КОНТУР ЗАПРЕТА ПАРОЛЯ (07.08). Проверка на входе в smartLogin ловит только тот случай,
      // когда поле пароля видно СРАЗУ. Но hasPass пересчитывается каждый шаг: сценарий «сперва экран
      // Continue as (пароля нет) → клик → появилась форма пароля» проскакивал мимо входного гарда и
      // пароль всё равно печатался. Гард обязан стоять В ТОЧКЕ ВВОДА, иначе он декоративный.
      if (/^(1|true|yes)$/i.test(String(process.env.NO_PASSWORD || ''))) {
        log('  ⛔ форма пароля появилась в процессе, а вход паролём запрещён (NO_PASSWORD=1) — need_login');
        const err = new Error('need_login: куки не подняли сессию, пароль вводить запрещено');
        err.needLogin = true;
        throw err;
      }
      if (submitted >= 2) { log('  ⛔ 2 отправки формы без результата — стоп'); return 'fail'; }
      // Селектор как в iglogin (аналитик п.4): узкий вариант промахивался, и форма уходила С ПУСТЫМ логином.
      let hasUserField = false;
      const userField = await firstUsable(page, 'input[name="username"], input[name="email"], input[autocomplete="username"], input[aria-label*="sername" i], input[aria-label*="obile number" i], input[placeholder*="sername" i], input[placeholder*="obile" i], input[type="tel"], input[type="text"]');
      if (userField) {
        hasUserField = true;
        const uv = await userField.inputValue().catch(() => '');
        if (!uv || uv.trim().length < 3) await typeVerified(userField, user, 'логин', log);
      } else {
        // Поля логина нет. Два случая:
        //  а) ONE-TAP модалка «Continue as X» — там его и НЕ должно быть, пароля достаточно (легитимно);
        //  б) страница не догрузилась — сабмитить нельзя, иначе жжём попытку входа.
        // Отличаем по тому, показывает ли IG чей это аккаунт (ник/имя на экране).
        const txt = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
        const oneTap = new RegExp(`${String(user).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Continue as|Продолжить как`, 'i').test(txt);
        if (!oneTap) { log('  ⚠ поля логина нет и это не one-tap — жду догрузку, форму НЕ отправляю'); await sleep(2500); continue; }
        log('  (one-tap: поля логина нет по дизайну, ввожу только пароль)');
      }
      await typeVerified(passField, a.ig_password, 'пароль', log, page, 'input[type="password"]');
      await sleep(400);
      // Перед сабмитом перечитываем ОБА поля: React мог стереть логин, пока печатали пароль (аналитик п.5).
      const pNow = await passField.inputValue().catch(() => '');
      if (!pNow) { await typeVerified(passField, a.ig_password, 'пароль', log, page, 'input[type="password"]'); }
      if (hasUserField) {
        // Полная форма: логин ОБЯЗАН быть заполнен. React мог стереть его, пока печатали пароль.
        const uNow = await userField.inputValue().catch(() => '');
        if (!uNow || uNow.trim().length < 3) { log('  ⚠ логин слетел — перепечатываю'); await typeVerified(userField, user, 'логин', log); await sleep(300); }
        const uFinal = await userField.inputValue().catch(() => '');
        if (!uFinal || uFinal.trim().length < 3) { log('  ⛔ логин так и пуст — форму НЕ отправляю'); await sleep(2000); continue; }
      }
      const pFinal = await passField.inputValue().catch(() => '');
      if (!pFinal) { log('  ⛔ пароль не впечатался — форму НЕ отправляю'); await sleep(2000); continue; }
      const btn = page.locator('button[type="submit"]:not([disabled])').first();
      const btn2 = page.getByRole('button', { name: /^(Log ?in|Войти)$/i }).first();
      let clicked = false;
      for (const b of [btn, btn2]) { if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); clicked = true; break; } }
      if (!clicked) await passField.press('Enter').catch(() => {});
      submitted++;
      log(`  → форма отправлена (${user})`);
      await sleep(9000);
      continue;
    }
    // 7) «Continue as X» (one-tap без пароля)
    const cont2 = page.getByRole('button', { name: /^(Continue|Продолжить)/i }).first();
    if (await cont2.isVisible().catch(() => false)) { await cont2.click().catch(() => {}); await sleep(6000); continue; }
    // 8) сплэш/лендинг: «Log in» бывает и КНОПКОЙ, и ССЫЛКОЙ (экран «Get the full experience with the tablet app»
    // — там ссылка, и getByRole('button') её не находил: криминалистика 29.07).
    for (const loc of [page.getByRole('button', { name: /^(Log ?in|Войти)$/i }).first(),
                       page.getByRole('link', { name: /^(Log ?in|Войти)$/i }).first(),
                       page.locator('a[href*="/accounts/login"]').first()]) {
      if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) { await loc.click({ timeout: 4000 }).catch(() => {}); await sleep(4500); break; }
    }
    await sleep(2500);
  }
  log('  ⛔ вход не завершился за 22 шага');
  return 'fail';
}
// Аварийное закрытие сессии по сигналу (аудит 28.07)
global.__SESS = { gl: null, pid: null, tok: null };
async function closeSess(why) {
  const S = global.__SESS || {};
  try { if (S.gl) { await Promise.race([S.gl.stopLocal({ posting: true }).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]); if (typeof S.gl.killBrowser === 'function') S.gl.killBrowser(); } } catch {}
  try { if (S.pid && S.tok) await Promise.race([fetch('https://api.gologin.com/browser/' + S.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + S.tok } }).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]); } catch {}
  console.log(`  ⏹ сессия закрыта (${why})`);
}
let __closing = false;
const bye = async (why, code = 0) => { if (__closing) return; __closing = true; await Promise.race([closeSess(why), new Promise((r) => setTimeout(r, 7000))]); process.exit(code); };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => bye(sig));
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e && e.message); bye('uncaught', 1); });
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e && e.message); bye('unhandled', 1); });
(async () => {
  if (!SLUG) { console.log('usage: node dressup.cjs "<slug>"'); process.exit(1); }
  const shotName = SLUG.replace(/[^\w.-]+/g, '_');
  const snap = async (page, n) => { try { fs.writeFileSync(`${SHOT}/dress_${shotName}_${n}.png`, await page.screenshot({ type: 'png', timeout: 15000 })); } catch {} };

  // 🚫 FOL-акки НЕ ТРОГАЕМ (решение владельца 28.07) — это его акки, оформление к ним не применяем.
  if (/^FOL/i.test(SLUG) && process.env.ALLOW_FOL !== '1') { console.log(`СКИП ${SLUG}: FOL-акк, оформление запрещено владельцем`); process.exit(0); }
  const { a, gt } = await loadDb();
  if (!a || !a.gologin_profile_id || !gt) { console.log('НЕТ акка/профиля/токена для', SLUG); process.exit(1); }
  // 🛡 АНТИ-ПЕРЕОФОРМЛЕНИЕ (урок 28.07: FOL_3178 залочен «We locked your account» после 4 оформлений за час —
  // смена имени/авы/био подряд читается IG как угон). Оформляем акк ОДИН раз; повтор только через DRESS_FORCE=1
  // и не раньше DRESS_COOLDOWN_D дней (деф 14: у IG лимит 2 смены имени / 14 дней).
  if (a.dressed_at && process.env.DRESS_FORCE !== '1') {
    const days = (Date.now() - new Date(a.dressed_at).getTime()) / 86400000;
    const cd = Number(process.env.DRESS_COOLDOWN_D || 14);
    if (days < cd) { console.log(`СКИП ${SLUG}: уже оформлен ${Math.round(days * 24)}ч назад (кулдаун ${cd}д, DRESS_FORCE=1 — принудительно)`); process.exit(0); }
  }
  const tok = gt || process.env.GOLOGIN_API_TOKEN;
  if (!LOCAL) { global.__SESS.pid = a.gologin_profile_id; global.__SESS.tok = tok; } // облачный режим: чем гасить при аварии

  // 🎨 РЕЖИМ «ТОЛЬКО АВА» (решение владельца 02.08 после потери 4 акков за ночь).
  // Ник — это логин-креденшл, имя профиля правится с лимитом 2 раза / 14 дней; и то и другое
  // на свежем акке читается как перехват аккаунта. Ава такой нагрузки не несёт.
  // Одна переменная вместо трёх отдельных флагов: забыть выключить что-то одно больше нельзя.
  if (process.env.AVATAR_ONLY === '1') {
    // Явно заказанное имя (DRESS_NAME_WANT) режим «только ава» НЕ отменяет: мужское имя от прошлого
    // владельца на женском аккаунте нужно убрать в тот же заход, отдельного повода туда идти нет.
    if (!process.env.DRESS_NAME_WANT) process.env.SKIP_NAME = '1';
    process.env.SKIP_BIO = '1';
    process.env.DRESS_NICK = '0';
    delete process.env.DRESS_NICK_WANT;
    delete process.env.DRESS_NICK_FORCE;
    delete process.env.DRESS_NAME_FORCE;
    console.log('  🎨 режим ТОЛЬКО АВА: имя, био и ник не трогаем');
  }

  // --- Что ставим ---
  // DRESS_NAME_WANT главнее сохранённого display_name: купленные акки приходят с мужским именем
  // прошлого владельца, и «уже стоит имя» тут не аргумент — его как раз и надо заменить.
  const name = (process.env.DRESS_NAME_WANT || process.env.DRESS_NAME || a.display_name || humanName(a.gender))
    .trim().slice(0, 28);
  const bio = process.env.SKIP_BIO === '1' ? null : (process.env.DRESS_BIO || humanBio()).trim().slice(0, 140);
  let facePath = null;
  let avatarCat = null, avatarFile = null;
  if (process.env.SKIP_AVATAR !== '1') {
    facePath = `${SHOT}/face_${shotName}.jpg`;
    let got = false;
    // ПРИОРИТЕТ −1 (выше всего): ЯВНО переданное лицо. Для брендовых моделей ава = ЕЁ лицо из фабрики,
    // а не случайная картинка из общей папки. Урок 01.08: раньше папка перебивала AVATAR_PATH, и модели
    // ставили mood-фото вместо лица → «акк не выглядит как креатор». Явный путь/URL всегда первичен.
    if (process.env.AVATAR_PATH && fs.existsSync(process.env.AVATAR_PATH)) { facePath = process.env.AVATAR_PATH; got = true; console.log(`  ава ЯВНАЯ (AVATAR_PATH): ${process.env.AVATAR_PATH}`); }
    if (!got && process.env.AVATAR_URL) { got = await downloadUrl(process.env.AVATAR_URL, facePath); if (got) console.log('  ава ЯВНАЯ (AVATAR_URL)'); }
    // ПРИОРИТЕТ 0: своя папка с фото (лучший вариант — настоящие снимки владельца). Кинь картинки в
    // ~/Desktop/avatars (или AVATAR_DIR=...) — берём случайный ещё не использованный файл, отмечаем .used.
    const AVDIR = process.env.AVATAR_DIR || `${process.env.HOME}/Desktop/avatars`;
    // Папка разложена по КАТЕГОРИЯМ (anime/girly/car/nature/city/animals/mood/popculture) — категория нужна,
    // чтобы подобрать ник в тему авы. Веса под женскую аудиторию. Дедуп по БД (avatar_file уникален).
    const CAT_W = [['anime', 22], ['girly', 20], ['mood', 16], ['animals', 12], ['nature', 12], ['city', 7], ['popculture', 6], ['car', 5]];
    if (!got && fs.existsSync(AVDIR)) {
      try {
        const wsum = CAT_W.reduce((s, x) => s + x[1], 0);
        let roll = Math.random() * wsum, cat = CAT_W[0][0];
        for (const [c, w] of CAT_W) { roll -= w; if (roll <= 0) { cat = c; break; } }
        // если выпавшей категории нет/пуста — берём любую непустую
        const cats = fs.readdirSync(AVDIR).filter((d) => fs.existsSync(`${AVDIR}/${d}`) && fs.statSync(`${AVDIR}/${d}`).isDirectory());
        const has = (c) => cats.includes(c) && fs.readdirSync(`${AVDIR}/${c}`).some((f) => /\.(jpe?g|png|webp)$/i.test(f));
        if (!has(cat)) cat = cats.find(has) || null;
        if (cat) {
          const files = fs.readdirSync(`${AVDIR}/${cat}`).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith('.'));
          // какие уже заняты другими акками (дедуп через БД, чтобы одна картинка = один акк)
          let used = [];
          try {
            const cc = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000 });
            await cc.connect();
            used = (await cc.query(`SELECT avatar_file FROM accounts WHERE avatar_file IS NOT NULL`)).rows.map((x) => x.avatar_file);
            await cc.end();
          } catch { /* без дедупа переживём */ }
          const free = files.filter((f) => !used.includes(`${cat}/${f}`));
          const chosen = free.length ? pick(free) : (files.length ? pick(files) : null);
          if (chosen) {
            facePath = `${SHOT}/face_${shotName}.jpg`;
            fs.copyFileSync(`${AVDIR}/${cat}/${chosen}`, facePath);
            try { require('child_process').execFileSync('sips', ['-Z', '1080', facePath, '--out', facePath], { stdio: 'ignore', timeout: 20000 }); } catch { /* ok */ }
            avatarCat = cat; avatarFile = `${cat}/${chosen}`;
            got = true;
            console.log(`  ава из папки: ${cat}/${chosen} (свободных в категории: ${free.length})`);
          }
        }
      } catch (e) { console.log('  (папка ав:', String(e.message).slice(0, 40) + ')'); }
    }
    if (!got && process.env.AVATAR_PATH && fs.existsSync(process.env.AVATAR_PATH)) { facePath = process.env.AVATAR_PATH; got = true; }
    if (!got && process.env.AVATAR_URL) { got = await downloadUrl(process.env.AVATAR_URL, facePath); }
    // ПОРЯДОК: 1) генерация живого селфи (nano-banana-2) 2) запасной StyleGAN (AV_STYLEGAN=1 форсит запасной).
    if (!got && process.env.AV_STYLEGAN !== '1') got = await genFaceAI(facePath, a.gender);
    if (!got) got = await getFace(facePath, a.gender);
    if (!got) { console.log('  ⚠ не удалось получить аву — ставлю только имя/био'); facePath = null; }
    else console.log('  ава готова:', fs.statSync(facePath).size, 'байт');
  }
  console.log(`ОФОРМЛЯЮ ${SLUG}: имя="${name}"${bio ? ` био="${bio}"` : ' (био не трогаю)'}${facePath ? ' + ава' : ' (ава не трогаю)'} · ${LOCAL ? 'локально' : 'облако'}`);

  // --- Поднимаем браузер ---
  let b, glLocal = null;
  if (LOCAL) {
    try {
      const { default: GoLogin } = await import('gologin');
      // БЕЗ ОКОН (правило начальника 06.08: «окна открываются и мешают»). Оформление — работа
      // сетевая и по DOM, экран тут не нужен: Orbita поднимается в headless. Скрины (snap) в
      // headless снимаются как обычно, так что диагностика не теряется. Нужно окно глазами — SHOW=1.
      const extra = process.env.SHOW === '1' ? [] : ['--headless=new'];
      glLocal = global.__SESS.gl = new GoLogin({ token: tok, profile_id: a.gologin_profile_id, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 }, extra_params: extra });
      const r = await glLocal.startLocal();
      b = await chromium.connectOverCDP(r.wsUrl, { timeout: 60000 });
      console.log('локальный GoLogin: браузер поднят');
    } catch (e) { console.log('локальный старт err:', String(e.message).slice(0, 90)); }
  } else {
    const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', a.gologin_profile_id);
    for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch (e) { console.log('коннект try' + k); await sleep(k === 0 ? 22000 : 14000); } }
  }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); if (glLocal) await glLocal.stopLocal().catch(() => {}); process.exit(1); }

  const ctx = b.contexts()[0] || await b.newContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  let okName = false, okBio = false, okAvatar = false;
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    // Пиним EN-локаль — стабильные тексты кнопок/полей на edit-странице.
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});

    // ЗАМЫКАЕМ КРУГ (29.07): если у акка УЖЕ есть сохранённая сессия (ig_cookies) — вставляем её в браузер ДО входа.
    // Тогда вход не понадобится: открываем edit-страницу и мы уже внутри. Так копившийся актив реально работает,
    // а не лежит мёртвым грузом. Без этой вставки «сохранение кук» бессмысленно.
    if (a.ig_cookies) {
      try {
        const raw = typeof a.ig_cookies === 'string' ? JSON.parse(a.ig_cookies) : a.ig_cookies;
        const cks = (Array.isArray(raw) ? raw : []).filter((c) => c && c.name && c.value).map((c) => ({
          name: c.name, value: String(c.value),
          domain: c.domain || '.instagram.com', path: c.path || '/',
          httpOnly: !!c.httpOnly, secure: c.secure !== false,
          ...(c.expires && c.expires > 0 ? { expires: Math.floor(c.expires) } : {}),
        }));
        if (cks.length) { await ctx.addCookies(cks).catch(() => {}); console.log(`  🍪 подставил сохранённую сессию (${cks.length} кук) — вход может не понадобиться`); }
      } catch (e) { console.log('  (куки из БД не подставились:', String(e.message).slice(0, 40) + ')'); }
    }

    // Есть ли поля edit-формы (имя/био/фото) — значит мы на нужной странице и залогинены.
    const editReady = async () => (await page.locator('input[type="file"]').count().catch(() => 0)) ||
      (await page.getByText(/Change (profile )?photo|Изменить фото/i).count().catch(() => 0)) ||
      (await page.locator('textarea[name="biography"], input[name="fullName"]').count().catch(() => 0)) > 0;
    // Экран «сохранённый вход» (one-tap, живёт под /accounts/login/): кнопка Continue входит В СЕССИЮ без пароля.
    // НЕ логаут — куки живы. Ловим по нескольким селекторам и ждём прогрузки (free-прокси медленный).
    const clickContinue = async () => {
      for (const loc of [
        page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first(),
        page.locator('button:has-text("Continue"), div[role="button"]:has-text("Continue")').first(),
        page.getByText(/^(Continue|Продолжить)$/i).first(),
      ]) {
        if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); return true; }
      }
      return false;
    };
    const hasLoginForm = async () => page.locator('input[name="username"], input[name="password"]').first().isVisible().catch(() => false);

    // one-tap запрашивает ТОЛЬКО пароль (username помнят куки). Открываем модалку клоком по «Log in» профиля,
    // вводим пароль, жмём Log in. Самый простой и безопасный ре-логин (username не трогаем).
    const passOnlyLogin = async () => {
      if (!a.ig_password) return false;
      const passField = page.locator('input[name="password"], input[type="password"]').first();
      // модалка ещё не открыта → жмём «Log in» профиля (НЕ «Continue» — он зацикливается на мёртвых куки)
      if (!(await passField.isVisible().catch(() => false))) {
        const li = page.getByRole('button', { name: /^(Log ?in|Войти)$/i }).first();
        if (await li.isVisible().catch(() => false)) { await li.click().catch(() => {}); }
        else { const li2 = page.getByText(/^(Log ?in|Войти)$/i).first(); if (await li2.isVisible().catch(() => false)) await li2.click().catch(() => {}); }
        for (let w = 0; w < 6 && !(await passField.isVisible().catch(() => false)); w++) await sleep(1500);
      }
      const hasUser = await page.locator('input[name="username"]').first().isVisible().catch(() => false);
      if ((await passField.isVisible().catch(() => false)) && !hasUser) {
        console.log('  модалка пароля (one-tap) → ввожу пароль');
        // ВАЖНО (баг 28.07, скрин владельца: «пароль вписан, логин пуст»): это может быть НЕ one-tap-модалка,
        // а ПОЛНАЯ форма логина. Если рядом есть пустое поле логина — заполняем и его, иначе IG не пустит.
        try {
          const userField = page.locator('input[name="username"], input[autocomplete="username"], input[type="text"]:not([type="password"])').first();
          if (await userField.isVisible().catch(() => false)) {
            const uv = await userField.inputValue().catch(() => '');
            if (!uv || uv.trim().length < 3) {
              const un = a.ig_login || SLUG;
              await userField.click().catch(() => {}); await userField.fill('').catch(() => {});
              await userField.pressSequentially(un, { delay: 30 }).catch(async () => { await userField.fill(un).catch(() => {}); });
              console.log(`  + это полная форма — вписал логин ${un}`);
            }
          }
        } catch { /* нет поля логина — значит правда one-tap */ }
        await passField.click().catch(() => {}); await passField.fill('').catch(() => {});
        await passField.pressSequentially(a.ig_password, { delay: 25 }).catch(async () => { await passField.fill(a.ig_password).catch(() => {}); });
        await sleep(500); await snap(page, 'passmodal');
        const btn = page.locator('button[type="submit"]:not([disabled])').first();
        const btn2 = page.getByRole('button', { name: /^(Log ?in|Войти)$/i }).first();
        for (const s of [btn, btn2]) { if (await s.isVisible().catch(() => false)) { await s.click().catch(() => {}); break; } }
        await sleep(8000);
        return true;
      }
      return false;
    };
    const doInlineLogin = async () => {
      if (!(a.ig_login && a.ig_password)) { console.log('  ⚠ нет creds для inline-логина'); return false; }
      if (await passOnlyLogin()) return true; // one-tap пароль-модалка
      console.log('  → inline-логин (loginInline, полная форма)');
      const { loginInline } = require('./iglogin.cjs');
      // ЗАЩИТА (28.07): если ник меняли, вход по НОВОМУ может не пройти (смена не докатилась) — пробуем и СТАРЫЙ.
      const lr = await loginInline(page, ctx, { ig_login: a.ig_login, ig_password: a.ig_password, ig_email: a.ig_email, ig_email_password: a.ig_email_password, totp_secret: a.totp_secret }, { log: (m) => console.log(m), shot: async () => {} });
      if (!lr || !lr.ok) { console.log('  ❌ логин не удался:', lr && lr.reason); await snap(page, 'loginfail'); return false; }
      return true;
    };

    // Грузим edit-профиль; разбираем состояние (edit-форма / one-tap Continue / форма логина).
    // Continue (сохранённый вход) пробуем ОГРАНИЧЕННО: если куки сдохли, он зацикливается (__coig_login=1) →
    // после 2 попыток уходим в inline-логин паролем.
    // АНТИ-БАН: жёсткий лимит попыток входа. Повторные сабмиты пароля на залипшем one-tap = риск чек-поинта/бана
    // (см. память про сжигание акков). Больше LOGIN_MAX неудачных входов → бросаем, акк НЕ дёргаем.
    // ВХОД: единый автомат по экранам (smartLogin). Заменил старую связку continue/passOnly/inline —
    // она путала полную форму с one-tap (вводила только пароль) и выходила на 2FA (жалобы владельца 28.07).
    let onEdit = false;
    await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(5000);
    if (await editReady()) onEdit = true;
    if (!onEdit) {
      const res = await smartLogin(page, a, SLUG, (m) => console.log(m), async (n) => { await snap(page, n); });
      if (res === 'ok') {
        await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(5000);
        onEdit = await editReady();
      } else {
        // честно помечаем причину в БД, чтобы не долбить этот акк снова
        const st = res === 'bad_creds' ? 'bad_login' : res === 'checkpoint' ? 'challenge' : null;
        if (st) await dbExec(`UPDATE accounts SET ig_status=$2, session_status='dead' WHERE id=$1`, [a.id, st]);
        console.log(`  вход не удался (${res})`);
        // В ПАНЕЛЬ: статус + причина + СКРИН экрана, где встали (владелец смотрит с сайта, а не в логах).
        let shot = null;
        try { const b64 = await page.screenshot({ type: 'jpeg', quality: 45, timeout: 12000 }).catch(() => null); if (b64 && b64.length < 900000) shot = 'data:image/jpeg;base64,' + b64.toString('base64'); } catch {}
        const human = res === 'bad_creds' ? 'IG: неверный логин или пароль' : res === 'checkpoint' ? 'чек-поинт / аккаунт заблокирован' : 'вход не завершился (2FA или незнакомый экран)';
        await dbExec(`UPDATE accounts SET dress_status=$2, dress_error=$3, dress_step='вход', dress_shot=$4, dress_at=now() WHERE id=$1`,
          [a.id, res === 'bad_creds' ? 'bad_creds' : res === 'checkpoint' ? 'checkpoint' : '2fa_fail', human, shot]);
      }
    }
    if (!onEdit) { console.log('  ❌ не открыл страницу редактирования'); await snap(page, 'noedit'); throw new Error('no-edit-page'); }
    await snap(page, '0_before');
    // ФОТО ПРОФИЛЯ «ДО» (владелец просил сравнение): именно это видит человек, открывая акк.
    try {
      const un = a.ig_login || SLUG;
      await page.goto(`https://www.instagram.com/${un}/?hl=ru`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await sleep(5000);
      const shotB = await page.screenshot({ type: 'png', timeout: 25000 }).catch(() => null); // не роняем поток
      if (shotB) { fs.writeFileSync(`${SHOT}/PROFILE_${shotName}_BEFORE.png`, shotB); console.log(`  📸 профиль ДО: PROFILE_${shotName}_BEFORE.png`); }
    } finally {
      // ВСЕГДА возвращаемся на edit, иначе весь дальнейший поток идёт по странице профиля (баг 28.07: скрин упал
      // по таймауту → catch съел → остались на профиле → «поле био не найдено», «инпут авы не найден»).
      await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(5000);
    }

    // === 1) ОТОБРАЖАЕМОЕ ИМЯ ===
    // В НОВОМ IG (2026) поля имени на /accounts/edit/ БОЛЬШЕ НЕТ (там только Website/Bio/Threads/AI/Gender).
    // Имя живёт в Meta Accounts Center: /profiles/ → клик по профилю Instagram → «Name» → /profiles/{id}/name/ → input.
    // Проверено 28.07 (probe): input с текущим именем, сохраняется кнопкой Save/Done. Делаем ДО правки био,
    // потому что уходим со страницы edit и потом вернёмся на неё.
    if (process.env.SKIP_NAME === '1'
        || (a.display_name && !process.env.DRESS_NAME_WANT && process.env.DRESS_NAME_FORCE !== '1')) {
      console.log(`  имя не трогаю (${a.display_name ? 'уже стоит «' + a.display_name + '»' : 'SKIP_NAME=1'}) — лимит IG 2 смены/14 дней`);
      okName = !!a.display_name;
    } else try {
      await page.goto('https://accountscenter.instagram.com/profiles/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(5500);
      const igRow = page.getByText('Instagram', { exact: true }).first();
      if (await igRow.isVisible().catch(() => false)) { await igRow.click().catch(() => {}); await sleep(4500); }
      const nameRow = page.getByText(/^Name$/i).first();
      if (await nameRow.isVisible().catch(() => false)) { await nameRow.click().catch(() => {}); await sleep(4000); }
      if (/\/name\/?(\?|$)/.test(page.url())) {
        const nameInput = page.locator('input[type="text"], input:not([type="hidden"]):not([type="checkbox"])').first();
        if (await nameInput.isVisible().catch(() => false)) {
          await nameInput.click().catch(() => {});
          await nameInput.fill('').catch(() => {});
          await nameInput.pressSequentially(name, { delay: 45 }).catch(async () => { await nameInput.fill(name).catch(() => {}); });
          await sleep(600);
          const save = page.getByRole('button', { name: /^(Save|Сохранить|Done|Готово|Change name)$/i }).first();
          if (await save.isVisible().catch(() => false)) { await save.click().catch(() => {}); await sleep(4000); }
          else await nameInput.press('Enter').catch(() => {});
          await snap(page, '0b_name');
          okName = true;
          console.log('  ✓ имя изменено через Accounts Center');
        } else console.log('  ⚠ input имени не найден на /name/');
      } else console.log(`  ⚠ до страницы имени не дошёл (url=${page.url().slice(-40)})`);
      // возвращаемся на edit-профиль для био/авы
      await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(5000);
    } catch (e) { console.log('  имя err:', String(e.message).slice(0, 50)); }

    // === 2) БИО === (textarea name="biography" / aria-label Bio)
    if (bio) {
      try {
        const bioInput = page.locator('textarea[name="biography"], textarea[aria-label*="Bio" i], textarea#pepBio').first();
        if (await bioInput.isVisible().catch(() => false)) {
          await bioInput.click().catch(() => {});
          await bioInput.fill('').catch(() => {});
          await bioInput.pressSequentially(bio, { delay: 15 }).catch(async () => { await bioInput.fill(bio).catch(() => {}); });
          okBio = true;
          console.log('  ✓ био введено');
        } else console.log('  ⚠ поле био не найдено');
      } catch (e) { console.log('  био err:', String(e.message).slice(0, 50)); }
    }

    // === 3) АВАТАР === (кнопка Change photo → модалка → input[type=file]; жмём ЯВНО, посторонний file-input не трогаем)
    if (facePath) {
      try {
        const inputsBefore = await page.locator('input[type="file"]').count().catch(() => 0);
        const change = page.getByText(/^(Change photo|Change Profile Photo|Изменить фото|New photo)$/i).first();
        if (await change.isVisible().catch(() => false)) { await change.click().catch(() => {}); await sleep(2000); await snap(page, '1_photomenu'); }
        let fileInput = page.locator('input[type="file"]').last();
        const inputsAfter = await page.locator('input[type="file"]').count().catch(() => 0);
        if (inputsAfter <= inputsBefore && inputsBefore > 0) {
          const up = page.getByText(/^(Upload [Pp]hoto|Загрузить фото)$/i).first();
          if (await up.isVisible().catch(() => false)) { await up.click().catch(() => {}); await sleep(1500); }
          fileInput = page.locator('input[type="file"]').last();
        }
        if (await fileInput.count().catch(() => 0)) {
          await fileInput.setInputFiles(facePath).catch((e) => console.log('  setInputFiles:', String(e.message).slice(0, 50)));
          await sleep(4500); await snap(page, '2_avatar_up');
          for (const rx of [/^(Apply|Применить|Save|Сохранить|Done|Готово|Set as profile photo|Confirm)$/i]) {
            const btn = page.getByText(rx).first();
            if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(3000); break; }
          }
          // ЧЕСТНЫЙ ИТОГ (урок 06.08, damari1735): IG отвечает тостом «Sorry, this picture format
          // isn't supported. Please try another picture in JPEG format» — файл не принят, и на профиле
          // ОСТАЁТСЯ ава прошлого владельца (у нас так две недели висело чужое лицо). Раньше okAvatar
          // ставился безусловно, и в базу уходило avatar_set=true. Ловим отказ и не врём.
          const avaRejected = await page.locator("text=/picture format isn|format isn.t supported|формат.{0,25}не поддерж/i")
            .first().isVisible({ timeout: 2000 }).catch(() => false);
          if (avaRejected) {
            await snap(page, '2b_avatar_reject');
            console.log('  ⛔ IG не принял файл авы (просит JPEG) — ава НЕ сменилась');
          } else {
            okAvatar = true;
            console.log('  ✓ ава загружена');
          }
        } else { console.log('  ⚠ файловый инпут авы не найден'); await snap(page, 'nofileinput'); }
      } catch (e) { console.log('  ава err:', String(e.message).slice(0, 50)); }
    }

    // === 4) СОХРАНИТЬ === (кнопка Submit внизу формы имени/био)
    if (okName || okBio) {
      try {
        await sleep(1000);
        const submit = page.locator('button[type="submit"], div[role="button"]:has-text("Submit")').filter({ hasText: /Submit|Сохранить|Save/i }).first();
        const submit2 = page.getByRole('button', { name: /^(Submit|Сохранить|Save)$/i }).first();
        let clicked = false;
        for (const s of [submit2, submit]) {
          if (await s.isVisible().catch(() => false)) { await s.click().catch(() => {}); clicked = true; break; }
        }
        if (clicked) { await sleep(4000); console.log('  ✓ Submit нажат'); }
        else console.log('  ⚠ кнопка Submit не найдена (имя/био могли не сохраниться)');
      } catch (e) { console.log('  submit err:', String(e.message).slice(0, 50)); }
    }
    await sleep(2000); await snap(page, '3_after');

    // === 4) НИК (@username) — САМОЕ ВИДИМОЕ вместе с авой (приоритет владельца 28.07) ===
    // Меняем только мусорные (имя+4-6 цифр / FOL_ / TT), только если DRESS_NICK=1. Путь: Accounts Center
    // /profiles/{id}/username/. КРИТ: @username = логин → пишем ig_login АТОМАРНО, старый в ig_login_old.
    let newNick = null;
    if (process.env.DRESS_NICK === '1') {
      const cur = a.ig_login || SLUG;
      if (!isJunkNick(cur) && process.env.DRESS_NICK_FORCE !== '1') {
        console.log(`  ник «${cur}» нормальный — не трогаю (DRESS_NICK_FORCE=1 чтобы всё равно сменить)`);
      } else {
        try {
          // ЯВНЫЙ ник (DRESS_NICK_WANT) главнее генерации: у брендовой модели ник часть личности,
          // случайный из пула тут не годится (правило владельца 01.08). Тот же принцип, что AVATAR_PATH.
          let want = (process.env.DRESS_NICK_WANT || '').trim().toLowerCase().replace(/[^a-z0-9._]/g, '')
            || humanNick(a.gender, avatarCat, a.display_name);
          if (process.env.DRESS_NICK_WANT) console.log(`  ник ЯВНЫЙ (DRESS_NICK_WANT): @${want}`);
          await page.goto('https://accountscenter.instagram.com/profiles/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(5500);
          const igRow = page.getByText('Instagram', { exact: true }).first();
          if (await igRow.isVisible().catch(() => false)) { await igRow.click().catch(() => {}); await sleep(4500); }
          const unRow = page.getByText(/^Username$/i).first();
          if (await unRow.isVisible().catch(() => false)) { await unRow.click().catch(() => {}); await sleep(4000); }
          if (/\/username\/?(\?|$)/.test(page.url())) {
            const inp = page.locator('input[type="text"], input:not([type="hidden"]):not([type="checkbox"])').first();
            if (await inp.isVisible().catch(() => false)) {
              // ЗАНЯТОСТЬ: популярные ники (mashaaa, silent.snow) уже разобраны. Печатаем кандидата, читаем
              // инлайн-валидацию IG («username isn't available»), при занятости пробуем СЛЕДУЮЩИЙ вариант.
              // Важно: лимит смен IG тратится только на РЕАЛЬНОЕ сохранение, набор в поле бесплатен.
              let picked = null;
              for (let att = 0; att < 8 && !picked; att++) {
                const cand = att === 0 ? want : nickVariant(want, att, a.gender, avatarCat);
                if (await nickTakenInFleet(cand)) { console.log(`  ник ${cand} уже у нашего акка — следующий`); continue; }
                await inp.click().catch(() => {}); await inp.fill('').catch(() => {});
                await inp.pressSequentially(cand, { delay: 40 }).catch(() => {});
                await sleep(2200); // ждём инлайн-проверку IG
                const txt = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '');
                const busy = /isn.?t available|not available|已被|занято|недоступно|taken|try another/i.test(txt);
                if (busy) { console.log(`  занят: ${cand}`); continue; }
                picked = cand;
              }
              if (!picked) { console.log('  ⚠ свободный ник не подобрал за 8 попыток'); throw new Error('nick_busy'); }
              const want2 = picked;
              const done = page.getByRole('button', { name: /^(Done|Save|Сохранить|Готово|Change username)$/i }).first();
              if (await done.isEnabled().catch(() => false)) { await done.click().catch(() => {}); await sleep(5000); }
              await snap(page, '4_nick');
              // ПРОВЕРКА НЕЗАВИСИМАЯ (ревью 28.07): раньше успех считался по «нет слова error» на странице —
              // давало и ложный успех (ник в БД, которого нет в IG → акк не входит), и ложный провал.
              // Теперь заходим на профиль нового ника и смотрим, НАШ ли он (видна кнопка редактирования).
              await page.goto(`https://www.instagram.com/${want2}/`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
              await sleep(4500);
              const ok = await page.locator('a[href$="/accounts/edit/"], header button:has-text("Edit profile"), header button:has-text("Редактировать профиль")').first().isVisible().catch(() => false);
              if (!ok) console.log(`  ⚠ ник @${want2} не применился — БД НЕ трогаю (акк остаётся на @${cur})`);
              if (ok) {
                want = want2;
                newNick = want;
                // АТОМАРНО: новый ник в ig_login (это логин!), старый сохраняем для отката
                await dbExec(`UPDATE accounts SET ig_login=$2, ig_login_old=COALESCE(ig_login_old,$3), nick_changed_at=now() WHERE id=$1`, [a.id, want, cur]);
                console.log(`  ✓ НИК сменён: @${cur} → @${want} (ig_login обновлён, старый сохранён)`);
              } else console.log(`  ⚠ ник «${want}» не принят (занят?) — оставил @${cur}`);
            } else console.log('  ⚠ поле ника не найдено');
          } else console.log(`  ⚠ страница ника не открылась (url=${page.url().slice(-40)})`);
        } catch (e) { console.log('  ник err:', String(e.message).slice(0, 50)); }
      }
    }

    // ФОТО ПРОФИЛЯ «ПОСЛЕ»
    try {
      const un2 = newNick || a.ig_login || SLUG;
      await page.goto(`https://www.instagram.com/${un2}/?hl=ru`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await sleep(6000);
      const shotA = await page.screenshot({ type: 'png', timeout: 25000 }).catch(() => null);
      if (shotA) { fs.writeFileSync(`${SHOT}/PROFILE_${shotName}_AFTER.png`, shotA); console.log(`  📸 профиль ПОСЛЕ: PROFILE_${shotName}_AFTER.png`); }
    } catch { /* не критично */ }

    // === Отметка в БД (+ миниатюра авы для карточки в панели) ===
    let thumb = null;
    if (okAvatar && facePath && fs.existsSync(facePath)) {
      try {
        const t = `${SHOT}/thumb_${shotName}.jpg`;
        require('child_process').execFileSync('sips', ['-Z', '160', facePath, '--out', t], { stdio: 'ignore', timeout: 15000 });
        const b = fs.readFileSync(t);
        if (b.length < 60000) thumb = 'data:image/jpeg;base64,' + b.toString('base64');
      } catch { /* без миниатюры переживём */ }
    }
    // ДВА ЗАПРОСА (ревью 28.07): уникальный индекс на avatar_file ронял ВЕСЬ UPDATE при гонке двух прогонов,
    // из-за чего не проставлялся dressed_at → анти-переоформление не срабатывало → акк оформляли повторно → лок.
    await dbExec(
      `UPDATE accounts SET dressed_at=now(), display_name=$2,
         avatar_set=COALESCE($3, avatar_set), bio_set=COALESCE($4, bio_set),
         avatar_thumb=COALESCE($5, avatar_thumb) WHERE id=$1`,
      [a.id, name, okAvatar ? true : null, okBio ? true : null, thumb],
    );
    if (avatarFile) await dbExec(
      `UPDATE accounts SET avatar_cat=$2, avatar_file=$3 WHERE id=$1
         AND NOT EXISTS (SELECT 1 FROM accounts WHERE avatar_file=$3 AND id<>$1)`,
      [a.id, avatarCat, avatarFile],
    );
    await dbExec(`UPDATE accounts SET dress_status='ok', dress_error=NULL, dress_step=NULL, dress_at=now() WHERE id=$1`, [a.id]).catch(() => {});
    // ЗАМКНУТЬ КРУГ КУК (урок 01.08): куки сохранялись ТОЛЬКО в ветке формы-логина. Если акк вошёл по сессии
    // профиля (без формы), ig_cookies оставался пуст → постер igpost2 акк не открывал. Снимаем куки в КОНЦЕ
    // всегда, если сессия жива — независимо от того, как вошли.
    try {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) {
        await dbExec(`UPDATE accounts SET ig_cookies=$2::jsonb, session_status='live', session_checked_at=now() WHERE id=$1`, [a.id, JSON.stringify(fresh)]);
        console.log(`  💾 куки сохранены в конце (${fresh.length}) — постер сможет открыть без входа`);
      }
    } catch (e) { console.log('  (куки в конце не сохранил:', String(e.message).slice(0, 40) + ')'); }
    console.log(`ИТОГ: ${SLUG} оформлен — имя:${okName ? 'да' : 'нет'} био:${okBio ? 'да' : 'нет'} ава:${okAvatar ? 'да' : 'нет'} (скрины dress_${shotName}_*.png)`);
  } catch (e) {
    console.log('ОШИБКА:', String(e.message).slice(0, 80));
    await snap(page, 'err');
  } finally {
    if (process.env.KEEP_OPEN === '1') {
      console.log('KEEP_OPEN=1: окно НЕ закрываю (профиль открыт)');
      setInterval(() => {}, 1 << 30);
    } else if (glLocal) {
      try { const nn = page.getByRole('button', { name: /not now|не сейчас/i }).first(); if (await nn.isVisible().catch(() => false)) await nn.click().catch(() => {}); } catch {}
      await Promise.race([glLocal.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]);
      await Promise.race([b.close().catch(() => {}), sleep(2500)]);
      try { if (typeof glLocal.killBrowser === 'function') glLocal.killBrowser(); } catch {}
      console.log('  окно закрыто (stopLocal + killBrowser своего профиля)');
    } else {
      await Promise.race([fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {}), sleep(6000)]);
      await b.close().catch(() => {});
    }
  }
})().catch((e) => console.log('FATAL', e.message)).finally(() => {
  if (process.env.KEEP_OPEN !== '1') setTimeout(() => process.exit(0), 300);
});
