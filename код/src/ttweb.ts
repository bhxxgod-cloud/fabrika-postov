// ttweb.ts — ЦИФРЫ TIKTOK ИЗ ВЕБА, БЕЗ ТЕЛЕФОНОВ.
//
// ЗАЧЕМ. Просмотры и подписчиков по нашим аккаунтам TikTok до сих пор снимали
// с экрана платы (tapfarm/src/flows/collect-stats.mjs). Это дорого и неточно:
//
//   • холодный старт приложения стоит 17-20 МБ платного мобильного трафика на
//     аккаунт, то есть около 240 МБ за один обход двенадцати аккаунтов;
//   • обход занимает 15-25 минут занятости плат, которые в это время не постят;
//   • плата читает то, что нарисовано человеку, а нарисовано округлённое:
//     «1,2 тыс.» вместо 1021. Для ряда по дням округление на источнике убивает
//     ровно ту динамику, ради которой ряд и собирают;
//   • на плате с несколькими аккаунтами виден только активный, остальные
//     пропускаются каждый проход.
//
// Веб даёт те же цифры точнее, бесплатно и с любого адреса. Замер живьём
// 25.08.2026: обход всех ников занял 22 секунды и 2.25 МБ сжатого трафика.
//
// ГДЕ ЛЕЖИТ ЧТО (проверено запросами, а не по памяти):
//
//   1. Подписчики, сумма лайков, число видео — страница профиля
//      tiktok.com/@ник, блок __UNIVERSAL_DATA_FOR_REHYDRATION__,
//      путь __DEFAULT_SCOPE__ → webapp.user-detail → userInfo → stats.
//
//   2. ПРОСМОТРОВ ОТДЕЛЬНЫХ ПОСТОВ НА СТРАНИЦЕ ПРОФИЛЯ НЕТ. Это ловушка, на
//      которой легко потерять день: в браузере они видны, потому что их
//      подгружает подписанный запрос уже после отрисовки. В простом ответе
//      сервера itemList пустой, а слова playCount нет ни разу.
//
//   3. Просмотры постов — страница ЭМБЕДА tiktok.com/embed/@ник, блок
//      __FRONTITY_CONNECT_STATE__, массив videoList. Отдаёт ровно 10 последних
//      постов, курсора и признака hasMore там нет. Вторая ловушка: playCount
//      лежит на ВЕРХНЕМ уровне элемента, а не в item.stats.playCount, и
//      привычный разбор через stats вернёт пустоту по всем постам.
//
//   4. Дата поста НЕ нужна отдельным запросом: она зашита в id. Старшие 32
//      бита это время создания в секундах. Проверено: 7677982032542141717 это
//      25.08.2026 17:51 МСК.
//
// ЧЕГО ЗДЕСЬ НЕТ. Лайков и комментариев по отдельному посту (в эмбеде только
// просмотры; полная статистика поста лежит на его собственной странице и
// добирается по запросу, а не веером на каждый обход). Доли РФ-зрителей,
// источников трафика и санкций: это видно только внутри приложения, и путь
// через плату остаётся единственным.

/** Один пост в выдаче эмбеда. views всегда есть, иначе пост не берём. */
export type ТТПост = { id: string; views: number; postedAt: string };

/** Снимок аккаунта. null в поле значит «не прочитали», а не ноль. */
export type ТТСнимок = {
  nick: string;
  exists: boolean;
  followers: number | null;
  likesTotal: number | null;
  videoCount: number | null;
  posts: ТТПост[];
  /** Сумма просмотров ВИДИМЫХ постов (до 10), а не пожизненный итог аккаунта. */
  viewsVisible: number | null;
  error?: string;
};

const БРАУЗЕР =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Сжатие обязательно, а не «приятно»: эмбед весит 281 КБ без него и 36 КБ с
// ним. На двенадцати аккаунтах это разница между 3.4 МБ и 440 КБ за обход.
const ЗАГОЛОВКИ = {
  'user-agent': БРАУЗЕР,
  'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function достать(url: string, таймаутМс = 20_000): Promise<string | null> {
  const стоп = AbortSignal.timeout(таймаутМс);
  try {
    const r = await fetch(url, { headers: ЗАГОЛОВКИ, signal: стоп, redirect: 'follow' });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** Время создания поста из его id: старшие 32 бита это секунды эпохи. */
export function времяПоста(id: string): string | null {
  try {
    const сек = Number(BigInt(id) >> 32n);
    if (!Number.isFinite(сек) || сек < 1_400_000_000 || сек > 4_000_000_000) return null;
    return new Date(сек * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * Разбор videoList из эмбеда БЕЗ полного JSON.parse.
 *
 * Блок __FRONTITY_CONNECT_STATE__ это один огромный объект, и разбирать его
 * целиком ради двух полей значит держать в памяти сотни килобайт на каждый
 * аккаунт и падать целиком, если TikTok переименует любую ветку рядом.
 * Достаём попарно «id поста и его playCount», привязываясь только к тому, что
 * нам действительно нужно.
 *
 * Оговорка в регулярном выражении: между id и playCount запрещено встречать
 * начало СЛЕДУЮЩЕГО элемента. Без этого запрета жадный разбор склеил бы id
 * одного поста с просмотрами другого, и цифры молча поехали бы на один пост.
 */
export function просмотрыИзЭмбеда(html: string): ТТПост[] {
  const посты: ТТПост[] = [];
  const видели = new Set<string>();
  const re = /\{"id":"(\d{15,25})",(?:(?!\{"id":").)*?"playCount":(\d+)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, id, pc] = m;
    if (видели.has(id)) continue;
    видели.add(id);
    const when = времяПоста(id);
    if (!when) continue;
    посты.push({ id, views: Number(pc), postedAt: when });
  }
  return посты.sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
}

/** Шапка профиля: подписчики, сумма лайков, число видео. */
export function шапкаИзПрофиля(html: string): Pick<ТТСнимок, 'followers' | 'likesTotal' | 'videoCount' | 'exists'> {
  const пусто = { followers: null, likesTotal: null, videoCount: null, exists: true };
  // Аккаунта нет: TikTok отвечает страницей с этим кодом, а не 404.
  if (/"statusCode":\s*10221/.test(html)) return { ...пусто, exists: false };

  const число = (ключ: string): number | null => {
    const m = new RegExp(`"${ключ}":\\s*(\\d+)`).exec(html);
    return m ? Number(m[1]) : null;
  };
  return {
    exists: true,
    followers: число('followerCount'),
    likesTotal: число('heartCount'),
    videoCount: число('videoCount'),
  };
}

/**
 * Снимок одного аккаунта: профиль плюс эмбед.
 *
 * Два запроса, а не один, потому что цифры физически лежат на разных
 * страницах (см. шапку файла). Профиль обязателен, эмбед может не отдаться, и
 * это НЕ повод потерять весь снимок: подписчики и сумма лайков ценны сами по
 * себе, а «просмотров не прочитали» честно приезжает как null.
 */
export async function снимокАккаунта(nick: string): Promise<ТТСнимок> {
  const ник = String(nick || '').replace(/^@/, '').trim();
  const пустой: ТТСнимок = {
    nick: ник, exists: false, followers: null, likesTotal: null,
    videoCount: null, posts: [], viewsVisible: null,
  };
  if (!/^[\w.]{2,30}$/.test(ник)) return { ...пустой, error: 'ник не похож на ник' };

  const профиль = await достать(`https://www.tiktok.com/@${encodeURIComponent(ник)}`);
  if (!профиль) return { ...пустой, error: 'страница профиля не открылась' };

  const шапка = шапкаИзПрофиля(профиль);
  if (!шапка.exists) return { ...пустой, exists: false, error: 'аккаунта не существует' };

  const эмбед = await достать(`https://www.tiktok.com/embed/@${encodeURIComponent(ник)}`);
  const posts = эмбед ? просмотрыИзЭмбеда(эмбед) : [];

  return {
    nick: ник,
    exists: true,
    followers: шапка.followers,
    likesTotal: шапка.likesTotal,
    videoCount: шапка.videoCount,
    posts,
    // Ноль постов и «не смогли прочитать» это разные вещи, и путать их нельзя:
    // первое значит «аккаунт пустой», второе «цифре верить нельзя».
    viewsVisible: эмбед ? posts.reduce((s, p) => s + p.views, 0) : null,
  };
}

/**
 * Обход пачки ников.
 *
 * Идём последовательно с небольшой паузой. Дросселя у TikTok на этих двух
 * страницах не замечено (15 запросов подряд без пауз прошли без единого 429),
 * но обход по расписанию должен выглядеть как человек, а не как молотилка:
 * заплатить секунду за аккаунт дешевле, чем поймать блокировку адреса и
 * остаться без цифр совсем.
 */
export async function обход(ники: string[], пауза = 700): Promise<ТТСнимок[]> {
  const снимки: ТТСнимок[] = [];
  for (const н of ники) {
    try {
      снимки.push(await снимокАккаунта(н));
    } catch (e) {
      // Сбой на одном нике не имеет права оборвать обход: остальные аккаунты
      // ни при чём, а пустая таблица вместо одиннадцати строк выглядит как
      // «всё сломалось» и уводит разбор не туда.
      снимки.push({
        nick: String(н), exists: false, followers: null, likesTotal: null,
        videoCount: null, posts: [], viewsVisible: null,
        error: e instanceof Error ? e.message.slice(0, 200) : 'сбой обхода',
      });
    }
    if (пауза > 0) await new Promise((r) => setTimeout(r, пауза));
  }
  return снимки;
}
