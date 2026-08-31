/**
 * tiktok-poster.ts
 * ------------------------------------------------------------------------------------------------
 * Порт нашего боевого автопостера Threads-через-GoLogin на TikTok.
 *
 * Философия (не меняем её, она нас спасала):
 *   - человек ОДИН раз руками логинится в аккаунт в десктопном GoLogin,
 *   - пароли мы нигде не храним — сессия живёт в куках профиля,
 *   - бэкенд подключается к ОБЛАЧНОМУ браузеру GoLogin по CDP и водит веб-морду как человек,
 *   - единственный секрет в env — GOLOGIN_API_TOKEN, profileId это просто строка из БД.
 *
 * Этот файл — ТОЛЬКО постер + сессия + connect. Никакого шедулера/вармапа/БД здесь нет
 * (как в гайде мы разносили ответственность по файлам). Всё, что специфично для инфраструктуры
 * (БД, заливка скриншотов, логгер), инжектируется параметрами — модуль framework-agnostic.
 *
 * КОНТРАКТ ИДЕМПОТЕНТНОСТИ (важно!): модуль НЕ защищает сам от двойной публикации между вызовами.
 *   postSubmitted гасит ретраи ВНУТРИ одного вызова, но не между вызовами. Вызывающий ОБЯЗАН
 *   держать эксклюзивную аренду поста (SELECT ... FOR UPDATE SKIP LOCKED + locked_at) — как в гайде.
 *   Два воркера, взявшие одну строку (баг аренды / clock skew), зальют видео дважды -> дубль -> бан.
 *
 * TikTok != Threads. Отличия, которые кусаются, помечены комментариями "TT-DIFF" по месту.
 * ------------------------------------------------------------------------------------------------
 */

import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Locator, Frame } from 'playwright-core';

/* ================================================================================================
 * СХЕМЫ ДЛЯ ВНЕШНИХ ЗАВИСИМОСТЕЙ (инжектируем, не импортируем)
 * ============================================================================================== */

/** Минимальный логгер. Подсунь свой (pino/console/что угодно). */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Заливщик скриншотов. Принимает JPEG-байты и имя, возвращает URL, который мы кладём рядом
 * с ошибкой поста (гайдовый DEBUG-инвариант: скриншот на каждый провал).
 * ВАЖНО: имя файла тоже прогоняй мимо redactToken на своей стороне — токен нигде не должен утечь.
 */
export type ScreenshotSink = (jpeg: Buffer, name: string) => Promise<string>;

/**
 * Опциональный резолвер страны прокси профиля (для гео-префлайта).
 * Возвращает ISO-код страны egress-IP профиля ('KZ', 'BY', 'RU', ...) или null если неизвестно.
 * TT-DIFF: на TikTok это НЕ косметика — с российского egress-IP заливка ЗАБЛОКИРОВАНА с 2022г.
 * Просмотр работает, а upload — нет. Поэтому если резолвер вернул 'RU' — мы даже не пытаемся.
 */
export type ProxyCountryResolver = (profileId: string) => Promise<string | null>;

/** Общие зависимости постера. */
export interface PosterDeps {
  /** GOLOGIN_API_TOKEN — единственный секрет. */
  token: string;
  logger: Logger;
  /** Куда заливать скриншоты провалов. Если не задан — скриншоты просто не сохраняем. */
  uploadScreenshot?: ScreenshotSink;
  /** Опциональный гео-префлайт (см. ProxyCountryResolver). */
  resolveProxyCountry?: ProxyCountryResolver;
  /** Подмена времени для тестов. */
  now?: () => number;
}

/* ================================================================================================
 * ОШИБКИ
 * ------------------------------------------------------------------------------------------------
 * КОНТРАКТ РЕТРАЯ (общий для воркера):
 *   - retryable=false   -> НЕ ретраить (SessionError/CaptchaError/GeoBlockedError, и PublishError
 *                          после клика Post). Ставить пост/аккаунт на паузу, звать человека.
 *   - pauseAccount=true -> увести аккаунт в paused и НЕ перевыдавать профиль часами
 *                          (иначе воркер будет молотить один и тот же челлендж = эскалация бана).
 * ============================================================================================== */

/**
 * Сессия умерла (разлогинило server-side). Ловим её отдельно, чтобы воркер увёл аккаунт в dead
 * и дёрнул алерт владельцу — пусть перелогинится руками в десктопном GoLogin.
 * TT-DIFF/анти-бан: НЕ ретраить. Иначе воркер (гайд: до 3 попыток pre-click) будет молотить
 * логин-стену подряд — ровно тот паттерн, что превращает soft-челлендж в hard-бан.
 */
export class SessionError extends Error {
  readonly kind = 'SessionError' as const;
  /** Воркер: НЕ ретраить этот пост в рамках текущей аренды. */
  readonly retryable = false as const;
  /** Воркер: увести аккаунт в status=paused/dead и не перевыдавать профиль. */
  readonly pauseAccount = true as const;
  constructor(message: string, readonly profileId?: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * TT-DIFF: капчу мы НЕ решаем. Никогда. Ни своими руками, ни сторонними солверами
 * (это против ToS, стоит денег, ломается на ротации челленджа и само по себе — вектор бана).
 * Детектим DOM капчи и бросаем это, чтобы поставить аккаунт на паузу и позвать человека —
 * ровно тот же паттерн, что SessionError.
 * КРИТИЧНО (анти-бан): retryable=false. Три подряд облако-запуска в один и тот же живой челлендж
 * = документированный триггер эскалации ('repeated challenge'). Воркер обязан выставить cooldown.
 */
export class CaptchaError extends Error {
  readonly kind = 'CaptchaError' as const;
  readonly retryable = false as const;
  readonly pauseAccount = true as const;
  constructor(message: string, readonly profileId?: string) {
    super(message);
    this.name = 'CaptchaError';
  }
}

/**
 * TT-DIFF: жёсткий гео-блокер. С RU egress-IP заливка невозможна в принципе.
 * Отдельная ошибка, чтобы не путать с падением заливки — это конфиг прокси, а не баг флоу.
 * Ретрай бессмысленен, пока не сменят прокси — retryable=false, но НЕ pauseAccount:
 * чинится сменой прокси профиля, а не человеком у телефона.
 */
export class GeoBlockedError extends Error {
  readonly kind = 'GeoBlockedError' as const;
  readonly retryable = false as const;
  readonly pauseAccount = false as const;
  constructor(message: string, readonly profileId?: string) {
    super(message);
    this.name = 'GeoBlockedError';
  }
}

/**
 * Ошибка публикации. Ключевое поле — maybePublished: если мы уже кликнули Post и что-то упало
 * ПОСЛЕ клика, пост МОГ уйти. Ретраить нельзя (GOTCHA7 — дубли + на TikTok это ещё и триггер
 * бана "repeated upload retry attempts"). Помечаем и зовём человека проверить руками.
 * retryable = !maybePublished: падение ДО клика (например, Post так и не стал enabled) —
 * чистый pre-click фейл, его воркеру ретраить МОЖНО.
 */
export class PublishError extends Error {
  readonly kind = 'PublishError' as const;
  readonly retryable: boolean;
  constructor(
    message: string,
    readonly maybePublished: boolean,
    readonly screenshotUrl?: string,
    readonly profileId?: string,
  ) {
    super(message);
    this.name = 'PublishError';
    this.retryable = !maybePublished;
  }
}

/* ================================================================================================
 * ТОКЕН В URL/ЗАГОЛОВКАХ — вычищаем из любых логов (GOTCHA9)
 * ============================================================================================== */

/**
 * Токен лежит и в wss connect-URL (token=...), и в REST-заголовке (Authorization: Bearer ...).
 * На TikTok ошибок (челленджи, таймауты) будет больше, чем на Threads, значит и поверхностей
 * для утечки токена больше. Всегда прогоняем текст ошибки через это перед логом/скриншотом/стеком.
 */
export function redactToken(text: string): string {
  return String(text)
    .replace(/token=[^&\s"']+/gi, 'token=***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

/** Обёртка: превращает любой throw в безопасную для лога строку. */
function safeErr(e: unknown): string {
  const raw = e instanceof Error ? (e.stack ?? e.message) : String(e);
  return redactToken(raw);
}

/* ================================================================================================
 * ДЕТЕРМИНИРОВАННЫЙ ПЕР-АККАУНТНЫЙ RNG (анти-бан: разные тайминги у разных аккаунтов)
 * ------------------------------------------------------------------------------------------------
 * TT-DIFF/анти-бан: если КАЖДЫЙ аккаунт тянет паузы из одного Math.random()-диапазона, у всех
 * аккаунтов получается ОДИНАКОВЫЙ временной почерк -> кросс-аккаунтный коррелят поверх бот-сигнала.
 * Сидим RNG от profileId -> у каждого профиля своя (но стабильная) огибающая задержек.
 * ============================================================================================== */

export type Rng = () => number;

/** Маленький детерминированный PRNG (mulberry32 поверх FNV-1a от строки). */
export function makeRng(seed: string): Rng {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Пауза [min, min+span) мс, размазанная пер-аккаунтным RNG. */
async function humanPause(page: Page, rng: Rng, min: number, span: number): Promise<void> {
  await page.waitForTimeout(min + Math.floor(rng() * span));
}

/* ================================================================================================
 * CONNECT: облачный браузер GoLogin по CDP
 * ============================================================================================== */

const GOLOGIN_CDP_HOST = 'cloudbrowser.gologin.com';
const GOLOGIN_API = 'https://api.gologin.com';

/**
 * Строим wss:// URL к облачному браузеру.
 * GOTCHA1: схема ДОЛЖНА быть wss://, а НЕ https://.
 *   https:// заставляет Playwright сходить на /json/version для discovery ws-эндпоинта,
 *   а у GoLogin /connect на этот путь отдаёт 404 -> коннект падает.
 *   wss:// открывает WebSocket напрямую, без discovery. Проверено вечером боли на Threads.
 */
export function cloudConnectUrl(profileId: string, token: string): string {
  const t = encodeURIComponent(token);
  const p = encodeURIComponent(profileId);
  return `wss://${GOLOGIN_CDP_HOST}/connect?token=${t}&profile=${p}`;
}

export interface Connection {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Подключаемся к облачному профилю и достаём готовые {browser, context, page}.
 *
 * Нюансы:
 *   - у облачного профиля УЖЕ есть живой контекст, поэтому берём contexts()[0]/pages()[0],
 *     а не плодим новые (гайдовый паттерн).
 *   - browser.close() лишь ОТКЛЮЧАЕТ CDP-клиента; сама облачная сессия умирает по idle сама.
 *     Хочешь убить принудительно — stopCloudSession() ниже (DELETE /browser/{id}/web).
 *   - таймаут обязателен: облако бывает медленным на холодном старте.
 *   - при ошибке коннекта в тексте может оказаться токен — чистим redactToken.
 */
export async function connect(
  profileId: string,
  deps: Pick<PosterDeps, 'token' | 'logger'>,
  opts: { timeoutMs?: number } = {},
): Promise<Connection> {
  const url = cloudConnectUrl(profileId, deps.token);
  const timeout = opts.timeoutMs ?? 60_000;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(url, { timeout });
  } catch (e) {
    // НИКОГДА не пробрасываем сырую ошибку — в url зашит token=...
    throw new Error(`CDP connect failed for profile ${profileId}: ${safeErr(e)}`);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  deps.logger.info('cloud browser connected', { profileId });
  return { browser, context, page };
}

/** Принудительно гасим облачную сессию (не обязательно — она и сама умрёт по idle). */
export async function stopCloudSession(profileId: string, token: string): Promise<void> {
  await fetch(`${GOLOGIN_API}/browser/${encodeURIComponent(profileId)}/web`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => void 0); // best-effort, глушим — это уборка
}

/** Аккуратно рвём CDP-коннект. Ошибки закрытия не важны. */
async function disconnect(browser: Browser | undefined, logger: Logger): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch (e) {
    logger.warn('browser.close() failed (ignored)', { err: safeErr(e) });
  }
}

/* ================================================================================================
 * SELECTORS: один объект, мультиязычно, "первый видимый кандидат"
 * ------------------------------------------------------------------------------------------------
 * TT-DIFF: GoLogin выводит язык UI из страны прокси. У нас русскоязычная аудитория и практичный
 * не-RU egress — Казахстан (Беларусь как гео-цель для TikTok = ловушка, там TikTok ограничен).
 * Значит UI прилетит на RU / KK / EN — держим все три + очевидные локали.
 *
 * TT-DIFF: минифицированные классы (tiktok-select-selector, btn-cancel, DraftEditor-*,
 * resolution-label-text) РОТИРУЮТСЯ и A/B-тестятся. Якоримся на data-e2e / role / текст,
 * а классы держим как fallback. ВСЁ это надо проверить живьём в залогиненной сессии перед
 * продом (read_page/DevTools) — это стартовые догадки, не истина.
 * ============================================================================================== */

export const SELECTORS = {
  /**
   * Видимая зона/кнопка выбора видео. Кликать её для ЗАЛИВКИ на облаке бессмысленно (откроет
   * OS-пикер, который не автоматизируется), но по ней делаем лёгкий HOVER — чтобы у сессии был
   * реальный жест/траектория курсора перед setInputFiles (анти-бан "no human gesture").
   */
  uploadAffordance: [
    '[data-e2e="upload-btn"]',
    'button:has-text(/Select video|Upload video|Выбрать видео|Загрузить видео|Бейне таңдау/i)',
    'label:has-text(/Select video|Upload|Выбрать видео|Загрузить/i)',
    "xpath=//div[contains(@class,'upload') and .//input[@type='file']]",
  ],

  /** Скрытый <input type=file>. Самый стабильный якорь. Кликать зону НЕ надо — сразу в input. */
  fileInput: [
    'input[type=file][accept*="video"]',
    'input[accept*="mp4"]',
    'input[type=file]',
    '[data-e2e="upload-btn"] input[type=file]',
    '[data-e2e="upload-input"] input[type=file]',
    "xpath=//input[@type='file']",
  ],

  /** Редактор описания. TT-DIFF: это contenteditable DraftJS, а НЕ textarea. fill() ненадёжен. */
  captionEditor: [
    '[data-e2e="caption-input"] div[contenteditable="true"]',
    'div[data-e2e="upload-caption"] [contenteditable="true"]',
    '[data-e2e="video-caption"] div[contenteditable="true"]',
    '.public-DraftEditor-content',
    '.DraftEditor-root [contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    "xpath=//div[@contenteditable='true']",
  ],

  /** Выпадашка приватности. TT-DIFF: кастомный (не нативный) select, часто role=combobox. */
  privacyDropdown: [
    '[data-e2e="privacy-selector"]',
    'div.tiktok-select-selector',
    'div[role="combobox"]',
    "xpath=//div[contains(@class,'tiktok-select-selector')]",
    "xpath=//div[contains(text(),'Who can view this video')]/following::div[@role='combobox'][1]",
    'text=/Who can view this video|Кто может посмотреть|Кім көре алады/i',
  ],

  /** Опции приватности — мультиязычно. */
  privacyOptions: {
    // PUBLIC — "Everyone" в новом UI (старое "Public").
    PUBLIC: [
      '[data-e2e="privacy-option-public"]',
      "xpath=//div[@role='option'][normalize-space()='Everyone']",
      'li:has-text("Everyone")',
      'text=/^(Everyone|Все|Public|Барлығы)$/i',
    ],
    // FRIENDS — "Friends" (кого взаимно фолловишь).
    FRIENDS: [
      '[data-e2e="privacy-option-friends"]',
      "xpath=//div[@role='option'][normalize-space()='Friends']",
      'li:has-text("Friends")',
      'text=/^(Friends|Друзья|Достар)$/i',
    ],
    // SELF_ONLY — "Only you"/"Only me" (приватно).
    SELF_ONLY: [
      '[data-e2e="privacy-option-private"]',
      "xpath=//div[@role='option'][normalize-space()='Only you']",
      'li:has-text("Only you")',
      'li:has-text("Only me")',
      'text=/^(Only you|Only me|Только я|Тек өзім)$/i',
    ],
  } as Record<Privacy, string[]>,

  /**
   * Кнопка Post. data-e2e — самый живучий хук.
   * TT-DIFF/fix: текст/xpath-fallback'и СКОУПИМ внутрь формы/диалога — на студийной хроме бывают
   * посторонние кнопки с тем же лейблом ('Post' в сайдбаре/навбаре). data-e2e не скоупим (он и так
   * уникален), а вот has-text — обязательно.
   */
  postButton: [
    'button[data-e2e="post_video_button"]',
    '[data-e2e="publish-button"]',
    "xpath=//button[@data-e2e='post_video_button']",
    "xpath=//div[@role='dialog']//button[.//div[normalize-space()='Post']]",
    'form button:has-text(/^(Post|Опубликовать|Post now|Жариялау)$/i)',
    '[role="dialog"] button:has-text(/^(Post|Опубликовать|Post now|Жариялау)$/i)',
  ],

  /**
   * Сигнал успеха. TT-DIFF/fix: подтверждаем публикацию ТОЛЬКО коротким пост-сабмитным сигналом
   * (тост "видео загружено" ИЛИ редирект на /tiktokstudio/content), и НИКОГДА по стоячему UI
   * студии (GOTCHA4). Убраны широкие кандидаты, которые ЖИВУТ на странице ДО клика и давали
   * ложный успех: 'a[href*="/video/"]', голый 'Posted', кнопки 'View profile/Manage posts',
   * диалог 'Manage your posts'. Редирект проверяется отдельно (см. waitForSuccess по page.url()).
   */
  successBanner: [
    '[data-e2e="upload-success"]',
    'text=/Your video has been uploaded|Your video is being uploaded/i',
    'text=/Ваше видео загружено|Видео публикуется|Видео загружается/i',
    'text=/Видеоңыз жүктелді|Бейне жүктелуде/i',
    "xpath=//div[contains(text(),'Your video has been uploaded')]",
  ],

  /**
   * Прогресс/обработка. Наличие прогресса/cancel = ещё грузим. Появление resolution-label /
   * превью = обработка закончена и можно жать Post (но всё равно ждём enabled самой кнопки).
   * TT-DIFF/fix: убрали голый 'text=/%/' (ловил '%' в подписи) и голый 'video' (ловил чужие
   * <video> в хроме студии) — скоупим в контейнеры прогресса/превью.
   */
  uploadProgress: [
    '[data-e2e="upload-progress"]',
    'div.btn-cancel',
    "xpath=//div[contains(@class,'btn-cancel')]",
    "xpath=//*[contains(@class,'progress')]//*[contains(normalize-space(.),'%')]",
  ],
  processingDone: [
    '.resolution-label-text',
    "xpath=//div[contains(@class,'resolution-label-text')]",
    '[data-e2e="video-preview"] video',
    '[data-e2e="video-preview"]',
  ],

  /**
   * Возможный второй confirm-модал ("Are you sure you want to post?") на части когорт.
   * TT-DIFF/fix: якоримся на диалог с текстом "sure/уверены" и НЕ на тост успеха. Успех у нас теперь
   * тост/редирект (не role=dialog), так что пересечения с успехом быть не должно.
   */
  confirmModal: [
    '[role="dialog"]:has-text(/Are you sure|Уверены|Сенімдісіз/i) button:has-text(/^(Post|Post now|Confirm|Опубликовать|Подтвердить|Yes|Иә)$/i)',
    '[role="dialog"] button[data-e2e="post-confirm"]',
    "xpath=//div[@role='dialog'][.//text()[contains(.,'sure') or contains(.,'верены')]]//button",
  ],

  /** Маркеры логаута (DEEP-проверка). TT-DIFF: свои, отличные от Threads. */
  loggedOut: [
    '[data-e2e="top-login-button"]',
    'a[href*="/login"]',
    'div[class*="login-modal"]',
    'text=/Log in to TikTok|Log in|Sign up/i',
    'text=/Войти|Вход|Зарегистрироваться|Авторизуйтесь/i',
    'text=/Кіру|Тіркелу/i', // KK — язык страны прокси (гайдовая заметка про язык прокси-страны)
  ],

  /**
   * Капча — только ДЕТЕКТ, никогда не решаем. Rotate/slider/3D-object челленджи.
   */
  captcha: [
    '#captcha-verify-container',
    '[class*="captcha_verify"]',
    'div[class*="cap-flex"]',
    '[data-e2e="captcha"]',
    'iframe[src*="captcha"]',
    'text=/Verify to continue|Подтвердите, что вы не робот|Пройдите проверку/i',
  ],
} as const;

/* ================================================================================================
 * ХЕЛПЕРЫ ЛОКАТОРОВ: "первый видимый кандидат"
 * ============================================================================================== */

/** Нормализуем строку-кандидат в валидный для Playwright селектор (// -> xpath=). */
function toSelector(candidate: string): string {
  return candidate.startsWith('//') ? `xpath=${candidate}` : candidate;
}

/** Все локаторы-кандидаты в top-документе. */
function locators(page: Page, candidates: readonly string[]): Locator[] {
  return candidates.map((c) => page.locator(toSelector(c)));
}

/**
 * Возвращает первый ВИДИМЫЙ локатор из списка кандидатов (или null).
 * Именно "видимый", т.к. на странице бывают дубли одинаковых элементов, скрытые в неактивных
 * табах/вариантах A/B.
 */
async function firstVisible(
  page: Page,
  candidates: readonly string[],
  timeoutMs = 8_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  const locs = locators(page, candidates);
  while (Date.now() < deadline) {
    for (const loc of locs) {
      const first = loc.first();
      try {
        if (await first.isVisible()) return first;
      } catch {
        /* локатор мог отвалиться на ре-рендере DraftJS — просто пробуем следующий */
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

/** Есть ли ХОТЯ БЫ один видимый кандидат прямо сейчас (без ожидания). */
async function anyVisibleNow(page: Page, candidates: readonly string[]): Promise<boolean> {
  for (const loc of locators(page, candidates)) {
    try {
      if (await loc.first().isVisible()) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Файл-инпут особый: он может быть display:none / 0x0. setInputFiles работает на скрытых
 * инпутах — поэтому ждём состояние 'attached', а НЕ 'visible'.
 * TT-DIFF-defense: если в top-документе инпута нет — на всякий случай ищем внутри iframe
 * (новый /tiktokstudio/upload iframe НЕ использует, но если TikTok отыграет назад/A-B — подстелемся).
 */
async function findFileInput(page: Page, timeoutMs = 15_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const cand of SELECTORS.fileInput) {
      const loc = page.locator(toSelector(cand)).first();
      if ((await loc.count()) > 0) return loc; // attached достаточно
    }
    // fallback: обшариваем все iframe (защита от возврата старого creator-center с iframe)
    for (const frame of page.frames() as Frame[]) {
      if (frame === page.mainFrame()) continue;
      for (const cand of SELECTORS.fileInput) {
        try {
          const loc = frame.locator(toSelector(cand)).first();
          if ((await loc.count()) > 0) return loc;
        } catch {
          /* ignore */
        }
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error('file input not found (top document nor iframes)');
}

/**
 * "Человеческий" клик: подводим курсор к элементу с парой промежуточных точек и микро-паузой,
 * потом кликаем. Даёт непустую траекторию мыши (TikTok 2026 сильно взвешивает pointer-энтропию).
 * Best-effort: если boundingBox недоступен — просто кликаем.
 */
async function humanClick(page: Page, locator: Locator, rng: Rng): Promise<void> {
  try {
    const box = await locator.boundingBox();
    if (box) {
      const tx = box.x + box.width * (0.3 + rng() * 0.4);
      const ty = box.y + box.height * (0.3 + rng() * 0.4);
      await page.mouse.move(tx - 60 + rng() * 40, ty - 40 + rng() * 30, { steps: 3 });
      await page.mouse.move(tx, ty, { steps: 4 + Math.floor(rng() * 4) });
      await humanPause(page, rng, 60, 160);
    }
  } catch {
    /* best-effort humanization */
  }
  await locator.click();
}

/* ================================================================================================
 * СЕССИЯ: логаут-детект и двухуровневая проверка живости
 * ============================================================================================== */

/**
 * DEEP-часть: смотрим DOM на маркеры логаута.
 * Мультиязычно (RU/EN/KK), потому что язык UI задаёт страна прокси.
 */
export async function isLoggedOut(page: Page): Promise<boolean> {
  return anyVisibleNow(page, SELECTORS.loggedOut);
}

/** Детект капчи (только детект!). */
async function hasCaptcha(page: Page): Promise<boolean> {
  return anyVisibleNow(page, SELECTORS.captcha);
}

export type Liveness = 'live' | 'dead' | 'unknown';

/**
 * FAST-проверка (дёшево, по REST): есть ли непросроченная кука sessionid.
 *
 * GOTCHA3: кука ВРЁТ. sessionid остаётся на месте даже после того, как платформа отозвала
 * сессию server-side. Поэтому FAST годится максимум для "зелёной лампочки" в панели и НИКОГДА
 * не переводит dead->live. Повышение dead->live — только через checkSessionDeep.
 * И наоборот: FAST 'dead' тоже НЕ авторитетен (GOTCHA2 — кука могла не досинкнуться, если профиль
 * держат открытым в десктопе) — воркер обязан подтвердить dead через DEEP, прежде чем действовать.
 */
export async function checkSessionFast(
  profileId: string,
  deps: Pick<PosterDeps, 'token' | 'logger' | 'now'>,
): Promise<Liveness> {
  try {
    const res = await fetch(`${GOLOGIN_API}/browser/${encodeURIComponent(profileId)}/cookies`, {
      headers: { Authorization: `Bearer ${deps.token}` },
    });
    if (!res.ok) {
      deps.logger.warn('cookies REST non-ok', { profileId, status: res.status });
      return 'unknown';
    }
    const cookies = (await res.json()) as Array<{
      name: string;
      domain?: string;
      expirationDate?: number;
      value?: string;
    }>;
    const now = deps.now?.() ?? Date.now();
    const sid = cookies.find(
      (c) =>
        c.name === 'sessionid' &&
        // fix: без домена НЕ считаем куку тиктоковской (иначе ложная "зелёная лампа" по чужой куке).
        !!c.domain &&
        c.domain.includes('tiktok') &&
        !!c.value &&
        // expirationDate у GoLogin в СЕКУНДАХ; нет поля -> считаем сессионной/живой
        (c.expirationDate == null || c.expirationDate * 1000 > now),
    );
    // Только "похоже живая" — это НЕ основание поднимать dead->live (см. GOTCHA3).
    return sid ? 'live' : 'dead';
  } catch (e) {
    deps.logger.warn('checkSessionFast failed', { profileId, err: safeErr(e) });
    return 'unknown';
  }
}

/**
 * DEEP-проверка (правда): облако-запуск, открываем TikTok, читаем DOM.
 * Только она имеет право повышать dead->live (иначе будем циклиться на вранье куки).
 */
export async function checkSessionDeep(
  profileId: string,
  deps: Pick<PosterDeps, 'token' | 'logger'>,
): Promise<Liveness> {
  let browser: Browser | undefined;
  try {
    const conn = await connect(profileId, deps, { timeoutMs: 60_000 });
    browser = conn.browser;
    const { page } = conn;
    // TT-DIFF: открываем сразу студийную главную/upload — логаут на TikTok часто = редирект/логин-стена.
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    // fix: даём логин-стене/редиректу/модалке ДОСЕСТЬ, прежде чем судить о живости.
    // Логаут-маркеры часто дорисовываются с задержкой -> иначе ложный 'live' (тот самый
    // stale-signal-капкан, ради которого и придумана двухуровневая проверка).
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => void 0);
    const loggedOutLoc = await firstVisible(page, SELECTORS.loggedOut, 5_000);

    if (await hasCaptcha(page)) {
      // Капча в момент liveness-проверки = аккаунт под челленджем. Это не "dead" в смысле логина,
      // но постить нельзя — отдаём unknown и пусть человек глянет (алерт кинет вызывающий).
      deps.logger.warn('captcha during deep check', { profileId });
      return 'unknown';
    }
    return loggedOutLoc ? 'dead' : 'live';
  } catch (e) {
    deps.logger.warn('checkSessionDeep failed', { profileId, err: safeErr(e) });
    return 'unknown';
  } finally {
    await disconnect(browser, deps.logger);
  }
}

/* ================================================================================================
 * ПУБЛИКАЦИЯ ВИДЕО
 * ============================================================================================== */

export type Privacy = 'PUBLIC' | 'FRIENDS' | 'SELF_ONLY';

export interface PublishVideoInput {
  profileId: string;
  /** Байты видео. Принимаем оба имени ради совместимости с вызывающими. */
  videoBytes?: Buffer | Uint8Array;
  videoBuffer?: Buffer | Uint8Array;
  /** Имя файла для setInputFiles (косметика, но TikTok иногда смотрит на расширение). */
  fileName?: string;
  /** MIME. По умолчанию video/mp4 — держим MP4/H.264/AAC 1080x1920 (см. заметки). */
  mimeType?: string;
  caption: string;
  /** TT-DIFF: у приватности часто НЕТ дефолта — выставляем всегда явно, иначе Post не активируется. */
  privacy?: Privacy;
  /**
   * Необязательный ключ идемпотентности для трассировки (например, posts.id). Модуль его НЕ
   * проверяет против реального состояния аккаунта (для этого нужна БД/лента постов у вызывающего) —
   * только логирует. Реальную защиту от дубля даёт эксклюзивная аренда поста на стороне воркера.
   */
  idempotencyKey?: string;
}

export interface PublishVideoResult {
  ok: true;
  profileId: string;
  /** Как подтвердили успех: баннер или редирект на /content. */
  confirmedBy: 'banner' | 'redirect';
}

/**
 * Практический потолок Playwright по remote-CDP: ~50MB. Playwright base64-кодирует ВЕСЬ буфер
 * в одно CDP-сообщение, и на облачном (не co-located) браузере большие буферы рвут транспорт.
 * Microsoft #34192 закрыт "not planned" — в 2026 не починено. Поэтому предупреждаем/режем заранее:
 * держи транскод <= ~45MB (TikTok всё равно перекодирует у себя), либо грузи >50MB через puppeteer-core.
 */
const REMOTE_CDP_UPLOAD_SOFT_LIMIT = 45 * 1024 * 1024;

/**
 * Полный флоу заливки. Читай инварианты в комментах по месту — это и есть учебник.
 */
export async function publishVideo(
  input: PublishVideoInput,
  deps: PosterDeps,
): Promise<PublishVideoResult> {
  const { profileId } = input;
  const logger = deps.logger;
  const rng = makeRng(profileId); // пер-аккаунтная огибающая таймингов (анти-бан)
  const privacy: Privacy = input.privacy ?? 'PUBLIC';
  const bytesSrc = input.videoBytes ?? input.videoBuffer;
  if (!bytesSrc) throw new Error('publishVideo: videoBytes/videoBuffer is required');
  const buffer = Buffer.isBuffer(bytesSrc) ? bytesSrc : Buffer.from(bytesSrc);
  const fileName = input.fileName ?? 'video.mp4';
  const mimeType = input.mimeType ?? 'video/mp4';

  // --- Префлайт 0: размер (см. REMOTE_CDP_UPLOAD_SOFT_LIMIT) -------------------------------------
  if (buffer.byteLength > REMOTE_CDP_UPLOAD_SOFT_LIMIT) {
    // Не глушим тихо — это скорее всего упадёт на setInputFiles. Пусть вызывающий транскодит.
    logger.warn('video exceeds remote-CDP soft limit (~45MB) — upload may fail over cloud CDP', {
      profileId,
      bytes: buffer.byteLength,
    });
  }

  // --- Префлайт 1: гео (TT-DIFF, жёсткий блокер) ------------------------------------------------
  // С RU egress-IP заливка на TikTok заблокирована с 2022г. Даже не пытаемся — экономим ретраи
  // (а лишние попытки заливки на TikTok = ещё и триггер бана).
  if (deps.resolveProxyCountry) {
    const country = await deps.resolveProxyCountry(profileId).catch(() => null);
    if (country && country.toUpperCase() === 'RU') {
      throw new GeoBlockedError(
        `profile ${profileId} egresses from RU — TikTok blocks uploads from Russian IPs`,
        profileId,
      );
    }
  }

  let browser: Browser | undefined;
  // GOTCHA7: как только кликнули Post — ретраить нельзя. Флаг ставим ДО клика.
  let postSubmitted = false;

  // Скриншот провала (best-effort) + вернуть URL.
  const shot = async (pg: Page | undefined, tag: string): Promise<string | undefined> => {
    if (!pg || !deps.uploadScreenshot) return undefined;
    try {
      const jpeg = await pg.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      const name = redactToken(`tt-${profileId}-${tag}-${Date.now()}.jpg`);
      return await deps.uploadScreenshot(Buffer.from(jpeg), name);
    } catch (e) {
      logger.warn('screenshot failed', { profileId, tag, err: safeErr(e) });
      return undefined;
    }
  };

  let page: Page | undefined;
  try {
    const conn = await connect(profileId, deps, { timeoutMs: 60_000 });
    browser = conn.browser;
    page = conn.page;
    logger.info('publishVideo start', { profileId, idempotencyKey: input.idempotencyKey });

    // --- Шаг 0: "тёплый" вход (анти-бан) -------------------------------------------------------
    // TT-DIFF/анти-бан: не заходим ХОЛОДНО сразу на /upload — это бот-почерк ("аккаунт, который
    // только заливает"). Сначала студийная главная + короткий dwell/скролл, потом уже upload.
    // Всё best-effort: не удалось прогреться — не падаем, идём на upload.
    try {
      await page.goto('https://www.tiktok.com/tiktokstudio', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await humanPause(page, rng, 1_200, 2_400);
      await page.mouse.wheel(0, 300 + Math.floor(rng() * 500)).catch(() => void 0);
      await humanPause(page, rng, 600, 1_400);
    } catch (e) {
      logger.warn('warm entry skipped', { profileId, err: safeErr(e) });
    }

    // --- Шаг 1: идём на канонический upload ----------------------------------------------------
    // TT-DIFF: канон 2026 — /tiktokstudio/upload (TikTok Studio). Легаси /upload и
    // /creator-center/upload редиректят сюда. И тут НЕТ iframe (в отличие от старого creator-center) —
    // работаем в top-документе (fallback в iframe оставили в findFileInput на всякий случай).
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await humanPause(page, rng, 1_200, 1_800); // человеческая пауза перед действиями

    // --- Шаг 2: гварды логаут / капча ----------------------------------------------------------
    if (await isLoggedOut(page)) {
      throw new SessionError(`profile ${profileId} is logged out on TikTok`, profileId);
    }
    if (await hasCaptcha(page)) {
      // Капча = человек-в-цикле. Не решаем, ставим на паузу.
      throw new CaptchaError(`captcha challenge on upload page for ${profileId}`, profileId);
    }

    // --- Шаг 3: заливаем байты в скрытый input -------------------------------------------------
    // TT-DIFF: видимая drag&drop-зона — просто оверлей; кликать её на облачном браузере бессмысленно
    // (OS-пикер не автоматизируется). Но лёгкий HOVER по ней делаем — чтобы у сессии был реальный
    // жест/траектория перед files-set (анти-бан "no human gesture"). Байты пишем в скрытый input.
    const affordance = await firstVisible(page, SELECTORS.uploadAffordance, 4_000);
    if (affordance) {
      try {
        await affordance.hover();
        await humanPause(page, rng, 300, 700); // имитируем задержку "человек тянется к файлу"
      } catch {
        /* hover best-effort */
      }
    }
    const fileInput = await findFileInput(page, 20_000);
    await fileInput.setInputFiles(
      { name: fileName, mimeType, buffer },
      // Явный длинный таймаут: base64 многомегабайтного буфера по WebSocket — это долго.
      { timeout: 120_000 },
    );
    logger.info('video bytes set on file input', { profileId, bytes: buffer.byteLength });

    // --- Шаг 4: ждём server-side обработку ------------------------------------------------------
    // Две фазы: (1) UPLOAD — идёт прогресс/cancel; (2) PROCESSING/ENCODE — TikTok транскодит,
    // появляется превью/resolution-label. Не спим фиксировано — ждём готовности превью.
    // Ещё раз ловим капчу — она любит выскакивать вокруг заливки.
    if (await hasCaptcha(page)) {
      throw new CaptchaError(`captcha during processing for ${profileId}`, profileId);
    }
    await waitForProcessing(page, logger, profileId, 180_000);

    // --- Шаг 5: заполняем описание (char-by-char) ----------------------------------------------
    await fillCaption(page, input.caption, logger, profileId, rng);

    // --- Шаг 6: приватность (всегда явно!) -----------------------------------------------------
    // TT-DIFF: у приватности часто нет дефолта — без явного выбора Post остаётся disabled.
    await setPrivacy(page, privacy, logger, profileId, rng);

    // --- Шаг 7: ждём, пока Post реально станет enabled ------------------------------------------
    // TT-DIFF: кнопка disabled, пока не докрутится upload+processing И не провалидируются поля
    // (включая приватность). Ждём именно enabled, не просто visible/attached.
    const postBtn = await waitForPostEnabled(page, logger, profileId, 60_000);

    // --- Шаг 8: ГЛАВНАЯ дисциплина TikTok -------------------------------------------------------
    // GOTCHA5: баннер успеха живёт 5-7с. Регистрируем ожидание успеха ДО клика (поллинг-петля).
    // fix (ложный успех): ПЕРЕД взводом убеждаемся, что ни один сигнал успеха НЕ виден уже сейчас.
    // Если виден — это стоячий UI/остаток, а не наша публикация: падаем ДО клика (retryable).
    if (await anyVisibleNow(page, SELECTORS.successBanner)) {
      throw new Error('success signal already visible BEFORE Post click — refusing to false-confirm');
    }
    const successPromise = waitForSuccess(page, 90_000);
    // fix (dangling rejection): вешаем no-op обработчик, чтобы отвал по таймауту после раннего
    // throw на клике не всплыл unhandledRejection'ом. Реальный результат всё равно ждём ниже.
    void successPromise.catch(() => void 0);

    // GOTCHA7: ставим флаг ДО клика — после клика ретраев нет ни при каких падениях.
    postSubmitted = true;
    await shot(page, 'before-post'); // скрин до публикации (гайдовый DEBUG: до+после полезны)
    await humanClick(page, postBtn, rng);
    logger.info('Post clicked', { profileId });

    // Часть когорт показывает второй confirm-модал ("Are you sure?") — подтверждаем, если он есть.
    // Гонимся: если раньше выскочит сигнал успеха — модала нет, идём дальше.
    await maybeConfirm(page, logger, profileId, rng);

    // --- Шаг 9: ждём реальный сигнал успеха ----------------------------------------------------
    // GOTCHA4: закрытие композера != публикация. Верим только баннеру/редиректу.
    const confirmedBy = await successPromise;
    await shot(page, 'after-post');
    logger.info('publish confirmed', { profileId, confirmedBy });
    return { ok: true, profileId, confirmedBy };
  } catch (e) {
    // Пробрасываем "чистые" доменные ошибки как есть (у них своя обработка выше по стеку).
    if (e instanceof SessionError || e instanceof CaptchaError || e instanceof GeoBlockedError) {
      await shot(page, e.kind.toLowerCase());
      throw e;
    }
    // Всё остальное — ошибка публикации. Ключевой момент: если postSubmitted, пост МОГ уйти.
    const screenshotUrl = await shot(page, postSubmitted ? 'maybe-published' : 'failed');
    const msg = redactToken(e instanceof Error ? e.message : String(e));
    throw new PublishError(
      postSubmitted
        ? `publish failed AFTER Post click (maybe published — verify by hand, NO retry): ${msg}`
        : `publish failed before Post click: ${msg}`,
      postSubmitted,
      screenshotUrl,
      profileId,
    );
  } finally {
    await disconnect(browser, logger);
  }
}

/* ================================================================================================
 * Внутренние шаги публикации
 * ============================================================================================== */

/**
 * Ждём завершения upload+processing. Готовность = появилось превью/resolution-label
 * И пропал индикатор прогресса. Не спим фиксировано.
 */
async function waitForProcessing(
  page: Page,
  logger: Logger,
  profileId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await anyVisibleNow(page, SELECTORS.processingDone);
    const stillUploading = await anyVisibleNow(page, SELECTORS.uploadProgress);
    if (done && !stillUploading) {
      logger.info('processing done, preview ready', { profileId });
      return;
    }
    if (await hasCaptcha(page)) {
      throw new CaptchaError(`captcha during processing for ${profileId}`, profileId);
    }
    await page.waitForTimeout(800);
  }
  // Не фейлим жёстко: возможно, маркер превью сменил класс. Дальше всё равно ждём enabled Post —
  // именно enabled-кнопка и есть настоящий гейт готовности.
  logger.warn('processing wait timed out on markers, will rely on Post-enabled gate', { profileId });
}

/**
 * Печатает caption по токенам с человеческой каденцией и гашением #/@ попапов.
 * TT-DIFF #2: '#' и '@' открывают автокомплит, который КРАДЁТ фокус и перехватывает Enter/стрелки.
 *   Enter вставит подсказку вместо переноса строки. Поэтому: печатаем токен, ждём попап, гасим Escape.
 */
async function typeTokens(page: Page, editor: Locator, caption: string, rng: Rng): Promise<void> {
  const tokens = caption.match(/\s+|[#@][^\s#@]+|[^\s#@]+/g) ?? [];
  for (const tok of tokens) {
    await editor.pressSequentially(tok, { delay: 40 + Math.floor(rng() * 50) });
    if (tok[0] === '#' || tok[0] === '@') {
      // Дать попапу проявиться, затем убить его Escape, чтобы он не сожрал следующий Enter/пробел.
      await humanPause(page, rng, 300, 250);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100 + Math.floor(rng() * 80));
    }
  }
}

/**
 * Заполняем DraftJS-описание.
 * TT-DIFF #1: fill() на DraftJS часто НЕ работает (внутренний стейт остаётся пустым) — печатаем
 *   посимвольно pressSequentially (заодно это анти-бан "печатаем как человек", delay 40-90мс).
 * fix (host-agnostic очистка): чистим НЕ через process.platform-модификатор (клавиши уходят
 *   в ЛИНУКСОВЫЙ облачный Chromium, а не в наш хост!), а через editor.selectText() -> Delete —
 *   без предположений об ОС.
 * fix (анти-бан fallback): если ввод не лёг — НЕ вставляем fill() (машинная вставка = бот-почерк
 *   ровно там, где мы и так подозрительны), а ПЕРЕпечатываем pressSequentially. Не лёг и после —
 *   честно падаем ДО клика (пропущенный пост безопаснее машинной вставки).
 * fix (капча): проверяем hasCaptcha до и после печати — челлендж любит выскакивать по ходу ввода.
 */
async function fillCaption(
  page: Page,
  caption: string,
  logger: Logger,
  profileId: string,
  rng: Rng,
): Promise<void> {
  const editor = await firstVisible(page, SELECTORS.captionEditor, 15_000);
  if (!editor) throw new Error('caption editor not found');

  if (await hasCaptcha(page)) {
    throw new CaptchaError(`captcha before caption typing for ${profileId}`, profileId);
  }

  const clearAndType = async () => {
    await editor.click();
    await humanPause(page, rng, 150, 200);
    // Очистка без OS-модификаторов: selectText выделяет содержимое элемента напрямую.
    await editor.selectText().catch(() => void 0);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(100 + Math.floor(rng() * 80));
    await typeTokens(page, editor, caption, rng);
  };

  await clearAndType();

  // Верификация: DraftJS мог проглотить ввод. Если пусто при непустом caption — перепечатываем.
  let landed = (await editor.textContent().catch(() => '')) ?? '';
  if (caption.trim().length > 0 && landed.trim().length === 0) {
    logger.warn('caption did not land via typing, RE-TYPING (no machine paste)', { profileId });
    await clearAndType();
    landed = (await editor.textContent().catch(() => '')) ?? '';
    if (caption.trim().length > 0 && landed.trim().length === 0) {
      throw new Error('caption failed to land in DraftJS editor (typed twice)');
    }
  }

  if (await hasCaptcha(page)) {
    throw new CaptchaError(`captcha after caption typing for ${profileId}`, profileId);
  }
  logger.info('caption filled', { profileId, len: landed.length });
}

/**
 * Явно выставляем приватность: кликаем дропдаун -> кликаем нужную опцию.
 * TT-DIFF: без явного выбора Post не активируется. fix: НЕ проглатываем отсутствие дропдауна
 * тихим warn — это ровно та причина, по которой Post остаётся disabled. Падаем ДО клика (retryable).
 */
async function setPrivacy(
  page: Page,
  privacy: Privacy,
  logger: Logger,
  profileId: string,
  rng: Rng,
): Promise<void> {
  const dropdown = await firstVisible(page, SELECTORS.privacyDropdown, 10_000);
  if (!dropdown) {
    throw new Error('privacy dropdown not found — Post would stay disabled, failing pre-click');
  }
  await humanClick(page, dropdown, rng);
  await humanPause(page, rng, 300, 300);

  const option = await firstVisible(page, SELECTORS.privacyOptions[privacy], 8_000);
  if (!option) throw new Error(`privacy option "${privacy}" not found`);
  await humanClick(page, option, rng);
  await humanPause(page, rng, 250, 250);
  logger.info('privacy set', { profileId, privacy });
}

/**
 * Ждём, пока кнопка Post станет enabled (не просто visible).
 * Скоупим внутрь диалога/формы через сами селекторы, чтобы не поймать чужую одноимённую кнопку.
 * fix: если так и не стала enabled к таймауту — БРОСАЕМ (а не возвращаем disabled-локатор).
 *   Возврат disabled-кнопки приводил к клику по неактивной кнопке, ~30с actionability-таймауту
 *   ПОСЛЕ postSubmitted=true и ложному maybePublished. Теперь это чистый pre-click фейл (retryable).
 */
async function waitForPostEnabled(
  page: Page,
  logger: Logger,
  profileId: string,
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = await firstVisible(page, SELECTORS.postButton, 2_000);
    if (btn) {
      try {
        // enabled = не disabled, не aria-disabled и (эвристика) без disabled-класса.
        const disabled = await btn.isDisabled().catch(() => true);
        const ariaDisabled = (await btn.getAttribute('aria-disabled').catch(() => null)) === 'true';
        const cls = (await btn.getAttribute('class').catch(() => '')) ?? '';
        const classDisabled = /disabl/i.test(cls);
        if (!disabled && !ariaDisabled && !classDisabled) {
          logger.info('Post button enabled', { profileId });
          return btn;
        }
      } catch {
        /* ре-рендер — пробуем ещё */
      }
    }
    if (await hasCaptcha(page)) {
      throw new CaptchaError(`captcha while waiting Post-enabled for ${profileId}`, profileId);
    }
    await page.waitForTimeout(700);
  }
  // Ничего не отдаём "на удачу": на этом месте пост НЕ отправлен, это честный pre-click фейл.
  throw new Error('Post button never became enabled');
}

/**
 * Ожидание успеха — поллинг-петля (НЕ Promise.any на waitFor).
 * Почему поллинг: waitFor({state:'visible'}) резолвится МГНОВЕННО на уже-видимом элементе (ложный
 * успех), а его проигравшие ветки продолжают жить после browser.close() -> dangling rejection.
 * Петля же (а) ловит короткоживущий баннер 5-7с (шаг 400мс), (б) не оставляет висящих waiter'ов,
 * (в) видит редирект по смене page.url(). Запускать ДО клика (GOTCHA5), сигналы — только
 * пост-сабмитные (successBanner сужен), редирект — реальная смена URL на /content.
 */
async function waitForSuccess(page: Page, timeoutMs: number): Promise<'banner' | 'redirect'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Редирект на страницу управления контентом = публикация ушла.
    let url = '';
    try {
      url = page.url();
    } catch {
      /* страница могла закрыться — выйдем по таймауту ниже */
    }
    if (/tiktokstudio\/content/i.test(url)) return 'redirect';
    if (await anyVisibleNow(page, SELECTORS.successBanner)) return 'banner';
    await page.waitForTimeout(400);
  }
  throw new Error('no success banner nor redirect within timeout');
}

/**
 * На части когорт после Post выскакивает второй confirm-модал ("Are you sure you want to post?"),
 * и на этих когортах РЕАЛЬНАЯ публикация происходит именно на этом клике.
 * fix: (1) окно ожидания шире (до ~8с) — медленно дорисованный модал раньше пропускался;
 *      (2) гонимся с сигналом успеха — как только виден успех/редирект, модала нет, выходим;
 *      (3) ошибку клика НЕ проглатываем молча — логируем (иначе "застрявший" пост без следа).
 */
async function maybeConfirm(page: Page, logger: Logger, profileId: string, rng: Rng): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    // Успех уже виден (баннер/редирект)? Значит второго подтверждения не требуется.
    let url = '';
    try {
      url = page.url();
    } catch {
      return;
    }
    if (/tiktokstudio\/content/i.test(url)) return;
    if (await anyVisibleNow(page, SELECTORS.successBanner)) return;

    const confirm = await firstVisible(page, SELECTORS.confirmModal, 500);
    if (confirm) {
      logger.info('secondary confirm modal detected, confirming', { profileId });
      try {
        await humanClick(page, confirm, rng);
      } catch (e) {
        // НЕ молчим: на этих когортах это и есть настоящий сабмит.
        logger.warn('confirm-modal click failed', { profileId, err: safeErr(e) });
      }
      return;
    }
    await page.waitForTimeout(400);
  }
}