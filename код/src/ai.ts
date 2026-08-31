import Anthropic from '@anthropic-ai/sdk';

// Генерация контента. Текст — через OpenRouter (много моделей одним ключом) с
// фолбэком на Anthropic напрямую. Картинки/видео — через внутренний API neironka.pro.

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
// Модели OpenRouter: несколько через запятую в OPENROUTER_MODELS
// (напр. "anthropic/claude-sonnet-5, openai/gpt-5.5, google/gemini-2.5-flash").
// Модель привязана к АККАУНТУ (по ключу): один акк = всегда одна модель (стабильный
// голос персоны), разные акки раскидываются по списку (сеть разнообразна = антибан-плюс).
// Без ключа — случайный выбор. Без списка — безопасный дефолт.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function pickModel(key?: string): string {
  const raw = process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return 'openai/gpt-4o-mini';
  const idx = key ? hashStr(key) % list.length : Math.floor(Math.random() * list.length);
  return list[idx];
}

// Единый вызов LLM: приоритет OpenRouter → Anthropic → пусто.
// modelKey — стабильный ключ аккаунта, чтобы один акк всегда использовал одну модель.
async function llm(system: string, user: string, maxTokens: number, modelKey?: string): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      // База API настраиваемая: openrouter.ai по умолчанию, либо свой OpenAI-совместимый
      // эндпоинт (напр. neironka.pro) через LLM_BASE_URL.
      const base = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'neironka-poster',
        },
        body: JSON.stringify({
          model: pickModel(modelKey),
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch {
      /* падаем на Anthropic */
    }
  }
  if (anthropic) {
    const msg = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = msg.content[0];
    return block && block.type === 'text' ? block.text.trim() : '';
  }
  return '';
}

// VISION: отправляем скриншот + запрос, получаем ответ (JSON-строкой). Для «зрячего» логина —
// модель смотрит на экран и говорит, ЧТО и куда сделать. Приоритет OpenRouter(gpt-4o) → Anthropic.
export async function visionAct(pngBase64: string, system: string, user: string, maxTokens = 400): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const base = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'neironka-poster' },
        body: JSON.stringify({
          model: process.env.VISION_MODEL || 'openai/gpt-4o',
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: [
              { type: 'text', text: user },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
            ] },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch { /* падаем на Anthropic */ }
  }
  if (anthropic) {
    try {
      const msg = await anthropic.messages.create({
        model: process.env.VISION_MODEL_ANTHROPIC || ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
          { type: 'text', text: user },
        ] }],
      });
      const block = msg.content[0];
      return block && block.type === 'text' ? block.text.trim() : '';
    } catch { return ''; }
  }
  return '';
}

export interface Persona {
  slug?: string; // стабильный ключ аккаунта — фиксирует модель за аккаунтом
  persona?: string;
  system_prompt?: string;
  gender?: string;
  tone?: string;
}

// Подпись поста от лица персоны. Очеловечивание: без длинных тире, без клише,
// ровно один вопрос в конце, 1–4 строки, ссылка НЕ в теле (уходит в первый коммент).
export async function generateCaption(persona: Persona, brief: string): Promise<string> {
  const sys = [
    persona.system_prompt || 'Ты ведёшь живой аккаунт про нейросети на русском.',
    `Тон: ${persona.tone || 'дружелюбный'}. Род глаголов: ${persona.gender === 'male' ? 'мужской (сделал)' : 'женский (сделала)'}.`,
    'Пиши как живой человек: без длинных тире, без повторяющихся клише, ровно один вопрос в конце.',
    '1–4 строки. Ссылку в текст НЕ вставляй. Без «подпишись/лайк если».',
  ].join(' ');
  const text = await llm(sys, `Тема поста: ${brief}. Напиши подпись.`, 300, persona.slug);
  return text || brief;
}

// Короткий коммент в прогреве (3–8 слов). Политика/трагедии/реклама -> 'SKIP'.
export async function generateWarmupComment(originalText: string): Promise<string> {
  if (!originalText.trim()) return 'SKIP';
  const text = await llm(
    'Ты пишешь живой короткий комментарий (3–8 слов) на языке поста, без ссылок, хэштегов и брендов. ' +
      'Если пост про политику, трагедии, насилие или это реклама — ответь ровно словом SKIP.',
    `Пост: "${originalText.slice(0, 500)}". Комментарий:`,
    40,
  );
  const t = (text || 'SKIP').trim();
  return t.length > 60 ? 'SKIP' : t;
}

// Полная персона по краткому брифу (или рандомная) — для генерации персон в панели.
export async function generatePersona(brief: string): Promise<Record<string, string>> {
  const sys =
    'Придумай персону для живого аккаунта про нейросети на русском. Верни СТРОГО JSON без пояснений: ' +
    '{"display_name","gender"("female"|"male"),"tone","system_prompt","hashtag"}. ' +
    'system_prompt — 2-3 предложения от второго лица, задающие голос/образ/рубрики.';
  const raw = await llm(sys, brief || 'случайная нишевая персона про нейросети', 500);
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return {};
  }
}

// Картинка через RenderGrid (nano-banana). Асинхронно: generate -> поллинг creations.
// Ключ rg_live_… в NANO_BANANA_API_KEY. Видео пока не генерим.
const RENDERGRID_BASE = 'https://api.rendergrid.io/api/public/v1';
function mediaKey(): string | null {
  return process.env.NANO_BANANA_API_KEY || process.env.NEIRONKA_MEDIA_API_KEY || null;
}
export async function generateMedia(kind: 'image' | 'video', prompt: string, aspectRatio = '1:1'): Promise<string | null> {
  const key = mediaKey();
  if (!key || kind !== 'image') return null;
  try {
    const gen = await fetch(`${RENDERGRID_BASE}/images/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'nano-banana-2', prompt, aspect_ratio: aspectRatio }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!gen.ok) return null;
    const g = (await gen.json()) as { id?: string };
    if (!g.id) return null;
    for (let i = 0; i < 20; i++) {                       // ждём до ~80с
      await new Promise((r) => setTimeout(r, 4000));
      const p = await fetch(`${RENDERGRID_BASE}/creations/${g.id}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!p || !p.ok) continue;
      const d = (await p.json()) as { status?: string; result_urls?: string[] };
      if (d.status === 'completed' && d.result_urls?.length) return d.result_urls[0];
      if (d.status === 'failed' || d.status === 'error') return null;
    }
    return null;
  } catch {
    return null;
  }
}

// Аватары для акков: НЕ только лица — коты, эмблемы клубов, пейзажи, аниме и т.п.,
// чтобы профили выглядели как живые люди, а не штамповка.
// Правдоподобные ЛИЧНЫЕ аватарки, как у живых юзеров: селфи людей, питомцы, аниме.
// Упор на «снято на телефон»: естественно, чуть несовершенно, без студийного глянца —
// именно это отличает живой акк от стоковой картинки/бренда.
const REAL = 'shot on iphone, natural candid, slightly imperfect, authentic, everyday, no studio look, realistic';
const AVATAR_PROMPTS = [
  `candid smartphone selfie of a young russian woman, casual, cozy room, ${REAL}`,
  `candid smartphone selfie of a young russian man in a hoodie, natural indoor light, ${REAL}`,
  `mirror selfie of a stylish young woman, casual outfit, phone in hand, ${REAL}`,
  `casual outdoor selfie of a young man, park in autumn, ${REAL}`,
  `young woman laughing, close-up candid portrait, warm light, ${REAL}`,
  `close-up of a fluffy tabby cat on a couch, cozy home, ${REAL}`,
  `happy corgi dog close-up, tongue out, outdoors, ${REAL}`,
  `small fluffy pomeranian puppy portrait, soft background, ${REAL}`,
  'anime style avatar portrait of a girl with pastel hair, soft lighting, clean, high quality',
  'anime style avatar portrait of a cool boy, vibrant colors, clean, high quality',
];
export function avatarPrompt(): string {
  return AVATAR_PROMPTS[Math.floor(Math.random() * AVATAR_PROMPTS.length)];
}
export async function generateAvatar(): Promise<string | null> {
  return generateMedia('image', avatarPrompt(), '1:1');
}

// Ник + короткое описание для TikTok-акка: казуально, по-русски, как у обычного живого
// юзера. БЕЗ рекламы/ссылок — промо идёт в комментах, а не в профиле.
const AI_PREFIX = ['neiro', 'ai', 'neuro', 'gpt', 'prompt'];
const LAT_NAMES = ['lena', 'max', 'nastya', 'kirill', 'olya', 'denis', 'masha', 'anton', 'vika', 'roma', 'dasha', 'ilya', 'sofia', 'artem', 'polina', 'egor'];
const RU_NAMES = ['Лена', 'Макс', 'Настя', 'Кирилл', 'Оля', 'Денис', 'Маша', 'Антон', 'Вика', 'Рома', 'Даша', 'Илья', 'Соня', 'Артём', 'Полина', 'Егор'];
const RU_SUFFIX = ['✦ нейронки', 'про ИИ', '· нейросети', '✦ ai-штуки', 'и нейронки', '', '', ''];
const BIO_FALLBACK = ['тестирую нейронки, залипаю 🤖', 'делаю всякое через ИИ ✨', 'нейросети = моя новая зависимость', 'генерю картинки вместо сна', 'ии-энтузиаст, котовед 🐱', 'промпчу по вечерам', 'показываю что умеют нейронки'];
function pickRand<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }
function fallbackHandle(): string {
  const sep = Math.random() < 0.6 ? '_' : '';
  // либо neiro_lena, либо lena_ai, либо ai_vibes23
  const pat = Math.floor(Math.random() * 3);
  const pre = pickRand(AI_PREFIX), nm = pickRand(LAT_NAMES), d = Math.floor(Math.random() * 90 + 10);
  const h = pat === 0 ? `${pre}${sep}${nm}` : pat === 1 ? `${nm}${sep}${pre}` : `${pre}${sep}vibes${d}`;
  return h.slice(0, 18);
}

// Промо-коммент под чужим постом: НАТИВНО, как живой человек, тонко упоминает neironka.
// role: 'mention' — сам упомянул; 'ask' — задал вопрос (для связки Q&A); 'answer' — ответил.
const SEED_FALLBACK: Record<string, string[]> = {
  mention: ['я такое в нейронке делаю, там всё в куче 🙌', 'через нейронку про генерю, удобно и по-русски', 'делала в neironka, без впн работает'],
  ask: ['а чем такое делают? 👀', 'кто знает чем генерят подскажите', 'это какая прога?'],
  answer: ['я в нейронке про делаю', 'нейронкой одной, там всё вместе', 'neironka, там без впн'],
};
export async function generateSeedComment(context: string, role: 'mention' | 'ask' | 'answer' = 'mention'): Promise<string> {
  const styles: Record<string, string> = {
    mention: 'ненавязчиво упомяни, что делаешь такое в сервисе «нейронка про» (neironka.pro) — как будто вспомнил между делом, БЕЗ прямой рекламы и ссылок',
    ask: 'задай короткий живой вопрос, чем это сделано (НЕ упоминай никакие сервисы)',
    answer: 'ответь, что делаешь такое в «нейронка про» (neironka.pro), коротко и по-человечески',
  };
  const system = 'Ты пишешь живые казуальные комментарии под видео/постами на русском, как обычный юзер. Коротко (до 60 символов), можно 1 эмодзи. НЕ спамно, без ссылок и капса. Только сам текст.';
  const user = `Пост: "${String(context || '').slice(0, 200)}". Напиши комментарий: ${styles[role]}. Только текст комментария.`;
  const raw = await llm(system, user, 60).catch(() => '');
  const text = raw.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0].slice(0, 90);
  if (text && text.length >= 3 && !/https?:/i.test(text)) return text;
  const pool = SEED_FALLBACK[role] || SEED_FALLBACK.mention;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Ответ из радара — ОТ ЛИЦА сервиса нейронка про (свой открытый бренд-акк). Честно:
// сначала польза по сути поста, потом «это удобно собрать в нейронка про». Не спам,
// без агрессии. Возвращает N живых вариантов на выбор (юзер сам выбирает и постит).
const RADAR_REPLY_FALLBACK = [
  'похоже на gemini (nano banana), она есть в нейронке про, без впн',
  'такое удобно в нейронке про, там все модели вместе',
  'мы такое в нейронке про делаем, загугли нейронка про',
  'лицо лучше держит gemini 2.5 flash, собираем в нейронке про',
];
// ВАРИАЦИИ брендового коммента — чтобы не постить один и тот же текст (палево + IG банит повторы).
// Питч без суффикса «промпт ниже» (он добавляется отдельно, если есть промпт). Грамматика — «нейронке про».
// ВАЖНО: НИКАКОГО длинного тире (—/–) — палит бота. Только короткое (-) или запятая. См. правило в памяти.
const BRAND_VARIANTS = [
  'найдите нейронка про в яндексе, там есть шаблон бесплатный)',
  'я это бесплатно сделал в нейронка про (в яндекс вбейте), там готовый пример',
  'оч красиво получилось, бесплатно в нейронка про, в яндексе нашла',
  'бесплатно собрала в нейронка про, в яндексе забей, там шаблон уже готовый',
  'делала так же, нейронка про, всё бесплатно, гуглишь и там пример под это',
  'вбей в яндексе нейронка про, там бесплатно и шаблон готовый лежит)',
  'сделал за пару минут в нейронка про, бесплатно, в яндексе найдёшь образец',
  'тоже искала, нейронка про, бесплатно, в яндексе вбей, там всё собрано',
  'у меня так же вышло, бесплатно в нейронка про, ищи в яндексе, готовый шаблон',
  'легко и бесплатно в нейронка про, набери в яндексе, там пример уже есть',
];
// Случайный вариант брендового питча. В пул кладём и текст юзера из настроек (если задан) — крутится наравне.
export function pickBrandBase(configText?: string | null): string {
  const cfg = String(configText || '').trim();
  const pool = cfg ? [cfg, ...BRAND_VARIANTS] : BRAND_VARIANTS;
  return humanizeComment(pool[Math.floor(Math.random() * pool.length)]); // чистим тире и на бренде тоже
}
// Убрать «палево бота»: длинное тире, официоз. Оставить короткий живой текст.
function humanizeComment(t: string): string {
  return t
    .replace(/\s*[—–]\s*/g, ', ') // длинное/среднее тире -> запятая (по тире палят бота)
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '')
    .trim();
}
export async function generateRadarReply(caption: string, n = 4): Promise<string[]> {
  const system =
    'Ты отвечаешь ОТ ЛИЦА сервиса «нейронка про» — агрегатор нейросетей в РФ (все модели в одном ' +
    'месте, по-русски, без впн, картой РФ). Под постом, где спрашивают «как/чем сделано / промт». ' +
    'Дай КОРОТКИЙ полезный ответ + ненавязчиво про нейронку про. Пиши как обычный человек с телефона: ' +
    'одно короткое предложение, маленькими буквами, БЕЗ длинного тире «—» (по нему палят бота), без ' +
    'официоза и перечислений через двоеточие. Название — русскими словами «нейронка про» (НЕ латиницей, ' +
    'НЕ ссылкой — в инсте ссылки режут). Можно «загугли нейронка про». До 90 символов, максимум 1 эмодзи.';
  const user =
    `Пост: "${String(caption || '').slice(0, 300)}". Дай ${n} РАЗНЫХ коротких варианта (разные по тону). ` +
    'Каждый с новой строки, без нумерации, без тире.';
  const raw = await llm(system, user, 400).catch(() => '');
  const variants = raw
    .split('\n')
    .map((l) => humanizeComment(l.replace(/^\s*[-•\d.)]+\s*/, '')))
    .filter((l) =>
      l.length >= 8 && l.length <= 160 &&
      /[а-яё]/i.test(l) &&                              // наш коммент по-русски (отсекает англ. мусор/рассуждения LLM)
      !/^(check|note|here|sure|okay|итак|вот|вариант|ответ)\b/i.test(l) &&
      !/https?:\/\/(?!neironka)/i.test(l));
  const out = variants.slice(0, n);
  // Добиваем фолбэком, если модель дала мало.
  for (const f of RADAR_REPLY_FALLBACK) {
    if (out.length >= n) break;
    if (!out.includes(f)) out.push(f);
  }
  return out.length ? out : RADAR_REPLY_FALLBACK.slice(0, n);
}

// Ответ ПОД КОНКРЕТНЫЙ коммент — ПО ТИПУ вопроса:
//  • просит промпт      -> «промпт можно собрать в нейронке про»
//  • спрашивает где/чем -> «делал в нейронке про»
//  • иначе              -> ненавязчиво про нейронку (обычно это покрывает брендовый коммент)
export async function generateContextualReply(commentText: string): Promise<string> {
  const low = String(commentText || '').toLowerCase();
  const wantsPrompt = /промт|промпт|prompt|скинь.{0,8}промт|дай.{0,8}промт/.test(low);
  const wantsWhere = /где (сдела|дела|брал|наход)|чем (сдела|дела|это)|как (ты|вы|это|её|его|такое|сдела|повтор|получ|дела)|какой (нейрос|ии|прилож|прог)|что за (нейрос|ии|прилож|прог|прога)|каким прилож|в каком прилож|нейросет|прилож/.test(low);
  let intent: string; let fallback: string;
  if (wantsPrompt) {
    intent = 'человек просит ПРОМПТ — скажи, что промпт удобно собрать и прогнать в «нейронке про» (все модели в одном месте, по-русски, без впн)';
    fallback = 'промпт удобно собрать в нейронке про, найдёшь её в яндексе';
  } else if (wantsWhere) {
    intent = 'человек спрашивает ГДЕ/ЧЕМ это сделано — ответь, что делал это в «нейронке про» (агрегатор нейросетей в РФ, без впн, оплата картой РФ)';
    fallback = 'делал в нейронке про, забей в яндексе нейронка про';
  } else {
    intent = 'ответь по сути его коммента и ненавязчиво упомяни, что делаешь такое в «нейронке про»';
    fallback = 'мы такое в нейронке про делаем, загугли нейронка про';
  }
  // КАЖДЫЙ ответ обязан содержать: (1) «нейронка про» и (2) КУДА идти — «найдёшь в яндексе/гугле»
  // (человек должен понять, куда писать название; ссылки IG режет и они палевные).
  const system =
    'Ты отвечаешь ОТ ЛИЦА сервиса «нейронка про» под ИИ-фото на КОНКРЕТНЫЙ коммент. ' + intent + '. ' +
    'ОБЯЗАТЕЛЬНО: назови сервис русскими словами «нейронка про» (НЕ ссылкой) И скажи, что найти его можно ' +
    'в яндексе или гугле (варьируй: «забей в яндексе», «найдёшь в гугле», «загугли» и т.п.). ' +
    'Коротко: 1 предложение до 110 символов, по-человечески с телефона, маленькими буквами, БЕЗ длинного ' +
    'тире. Только текст ответа.';
  const user = `Коммент человека: "${String(commentText || '').replace(/\s+/g, ' ').slice(0, 220)}". Ответь ему:`;
  const raw = await llm(system, user, 110).catch(() => '');
  let t = humanizeComment(raw.split('\n')[0].replace(/^\s*[-•]\s*/, '')).slice(0, 150);
  // Ответ ОБЯЗАН: упоминать бренд, быть законченным И вести в поиск. Нет бренда/куцый → фолбэк.
  if (t.length < 15 || !/нейронк/i.test(t)) return fallback;
  // Бренд есть, а «куда идти» модель забыла — дописываем сами (варьируем, чтобы не под копирку).
  if (!/яндекс|гугл|google|поиск/i.test(t)) {
    const tails = [', найдёшь в яндексе', ', забей в яндексе', ', есть в гугле', ', загугли нейронка про'];
    t = t.replace(/[.!\s]+$/, '') + tails[Math.floor(Math.random() * tails.length)];
  }
  return t;
}

// Промпт под пост: смотрим о чём пост и генерим короткий промпт для похожего фото
// (как для Midjourney/Flux/Gemini). Постится веткой, если в комментах готового нет.
export async function generatePostPrompt(caption: string): Promise<string> {
  const system =
    'Ты пишешь ПРОМПТ для генерации похожего фото в нейросети (аудитория русскоязычная). ' +
    'По описанию поста придумай ЗАКОНЧЕННЫЙ промпт НА РУССКОМ из 12-30 слов: субъект, стиль, свет, ' +
    'ракурс, детали, камера. Одной строкой, БЕЗ пояснений/кавычек/обрывов на середине слова. Только сам промпт.';
  const user = `Описание поста: "${String(caption || '').slice(0, 320)}". Промпт для похожего фото:`;
  const raw = await llm(system, user, 260).catch(() => '');
  let t = raw.replace(/^["'«»\s]+|["'«»\s]+$/g, '').split('\n')[0].trim();
  if (t.length > 220) t = t.slice(0, 220).replace(/\s+\S*$/, ''); // обрезаем по границе слова, не в середине
  // Валидация: должно быть минимум 5 слов (иначе обрывок вроде «…outfit stan» — не постим).
  return t.split(/\s+/).filter(Boolean).length >= 5 && t.length >= 20 ? t : '';
}

// Профиль акка: @-хендл (латиница, тема ИИ), имя по-русски, описание. LLM даёт живой
// текст; если подвела — программный фолбэк (никогда не пусто).
export async function generateTikTokProfile(): Promise<{ handle: string; name: string; bio: string }> {
  const system =
    'Ты придумываешь профили русскоязычных TikTok-аккаунтов, увлечённых нейросетями/ИИ/' +
    'творчеством — как живые энтузиасты, НЕ бренды, без рекламы и ссылок. Только валидный JSON.';
  const user =
    'Придумай: handle (@-ник латиницей 6-16 симв, тема ИИ/нейросети, как у обычного юзера, напр. ' +
    'neiro_lena, ai_vibes, promptmania), name (имя для профиля по-русски, казуально, можно с ✦, ' +
    'напр. "Лена ✦ нейронки"), bio (до 55 симв, по-русски, интерес к ИИ/творчеству, БЕЗ рекламы и ' +
    'ссылок). Ответь строго: {"handle":"...","name":"...","bio":"..."}';
  const raw = await llm(system, user, 160, 'tt-profile-gen').catch(() => '');
  let handle = '', name = '', bio = '';
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    handle = String(j.handle || j.nick || '').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 18);
    name = String(j.name || '').slice(0, 30);
    bio = String(j.bio || '').slice(0, 80);
  } catch { /* фолбэк ниже */ }
  if (!handle) handle = fallbackHandle();
  if (!name) name = `${pickRand(RU_NAMES)} ${pickRand(RU_SUFFIX)}`.trim();
  if (!bio) bio = pickRand(BIO_FALLBACK);
  return { handle, name, bio };
}

// ЮТУБ-КАНАЛ: байтовое название Shorts по промпту из yt_settings.title_prompt и контексту ролика.
// Модель закреплена (YT_TITLE_MODEL, по умолчанию opus через OpenRouter): рассуждающие модели из общего
// списка (gemini/grok) при max_tokens=60 съедали бюджет на раздумья и отдавали обрывок вроде «Попро».
export async function generateYtTitle(prompt: string, context: string): Promise<string> {
  const user = context || 'Ролик про нейросеть по одному селфи.';
  let raw = '';
  if (process.env.OPENROUTER_API_KEY) {
    const base = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const models = (process.env.YT_TITLE_MODEL || 'anthropic/claude-opus-4.8,openai/gpt-5.4').split(',').map((m) => m.trim()).filter(Boolean);
    for (const model of models) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'neironka-poster' },
          body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }] }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
        const c = data.choices?.[0];
        const text = c?.message?.content?.trim();
        if (text && c?.finish_reason !== 'length') { raw = text; break; }
      } catch { /* следующая модель */ }
    }
  }
  if (!raw) raw = await llm(prompt, user, 400, 'yt-titles');
  const t = raw.split('\n').map((l) => l.trim()).filter((l) => l && !/:$/.test(l)).shift() || '';
  // модель часто отдаёт список и служебные хвосты, поэтому чистим строку целиком
  const clean = t.replace(/^\s*(?:\d{1,2}\s*[.):\-]|[-–—•*])\s*/, '')   // нумерация и маркеры списка
    .replace(/\s*\(\s*\d{1,3}\s*\)\s*$/, '')                          // хвост вида «(26)» — счётчик символов от модели
    .replace(/["«»'`*]/g, '')                                            // кавычки где угодно, они всё равно не нужны в заголовке
    .replace(/#\S+/g, '').replace(/—/g, ',')
    .replace(/\s+([,.!?:;])/g, '$1')                                     // пробел перед знаком после замены тире
    .replace(/\s{2,}/g, ' ').trim().slice(0, 90);
  return clean.length >= 8 ? clean : '';
}
