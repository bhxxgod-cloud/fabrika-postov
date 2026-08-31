import type { Page } from 'playwright-core';
import type { PlatformDriver, PublishInput, PublishResult } from './types.js';
import { SessionError, CaptchaError } from './types.js';

// Драйвер TikTok — веб-аплоадер TikTok Studio (десктоп-веб).
// ВНИМАНИЕ: селекторы TikTok хешированы и меняются — их нужно ПРОВЕРИТЬ на живой
// залогиненной сессии и держать актуальными. Здесь — устойчивые якоря (input[type=file],
// data-e2e, contenteditable, текстовые) с мультиязычными вариантами (RU/KK/EN).

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';

const SEL = {
  fileInput: ['input[type="file"]'],
  captionBox: ['div[contenteditable="true"]', 'div[data-e2e="caption-editor"] div[contenteditable="true"]'],
  postButton: [
    'button[data-e2e="post_video_button"]',
    'button:has-text("Опубликовать")',
    'button:has-text("Post")',
    'button:has-text("Жариялау")',
  ],
  success: [
    'text=/Ваше видео загружа|Видео опубликовано|Your video is being uploaded|Manage your posts|posted/i',
    'div[class*="modal"]:has-text("posts")',
  ],
  loggedOut: [
    'input[name="username"]',
    'a[href*="/login"]',
    'text=/Войти|Log in|Sign up|Кіру/i',
  ],
  captcha: [
    'div[class*="captcha"]',
    'div[id*="captcha"]',
    '#captcha-verify-container',
    'text=/Подтвердите, что вы человек|Verify to continue|drag the slider/i',
  ],
};

async function isLoggedOut(page: Page): Promise<boolean> {
  if (/\/login/.test(page.url())) return true;
  for (const sel of SEL.loggedOut) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function assertNoCaptcha(page: Page) {
  for (const sel of SEL.captcha) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      throw new CaptchaError('TikTok: капча на загрузке — нужен человек');
    }
  }
}

// Скачиваем медиа по ссылке (лежит на neironka.pro) в байты — setInputFiles байтами
// работает и с удалённым CDP-браузером, файл на диске не нужен.
async function fetchMedia(url: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не скачать медиа (${res.status}): ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const name = url.split('/').pop()?.split('?')[0] || 'video.mp4';
  return { name, mimeType: res.headers.get('content-type') || 'video/mp4', buffer };
}

async function firstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function publish(page: Page, input: PublishInput): Promise<PublishResult> {
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(2500);
  if (await isLoggedOut(page)) throw new SessionError('TikTok: сессия мертва (логин-скрин)');
  await assertNoCaptcha(page);

  // Байты уже уникализированы воркером — грузим их; иначе качаем по ссылке.
  const media = input.media ?? (input.mediaUrl ? await fetchMedia(input.mediaUrl) : null);
  if (!media) throw new Error('TikTok: нужно видео (файл или ссылка)');

  // Отдаём файл в скрытый input (по drop-зоне не кликаем — она лишь оверлей).
  const fileInput = page.locator(SEL.fileInput[0]).first();
  await fileInput.setInputFiles({ name: media.name, mimeType: media.mimeType, buffer: media.buffer });

  // grabli: кнопка Опубликовать НЕ активна сразу — идёт загрузка + транскод + превью.
  // Ждём именно ВКЛючения кнопки (не по таймеру).
  const postBtn = await waitForEnabledPostButton(page);
  await assertNoCaptcha(page);

  // Подпись — в contenteditable, посимвольно (хэштеги-попапы могут воровать фокус).
  const caption = await firstVisible(page, SEL.captionBox);
  if (caption && input.caption) {
    await caption.click().catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await caption.pressSequentially(input.caption, { delay: 55 }).catch(() => {});
    await page.waitForTimeout(1200); // дать попапу хэштега закрыться
  }

  // grabli #5: начинаем ЖДАТЬ баннер успеха ДО клика (живёт секунды).
  const successWait = Promise.race(
    SEL.success.map((sel) =>
      page.locator(sel).first().waitFor({ state: 'visible', timeout: 120_000 }).then(() => true).catch(() => false),
    ),
  );
  // Редирект на страницу управления постами — тоже сигнал успеха.
  const urlWait = page
    .waitForURL(/\/content|\/tiktokstudio\/content|\/upload\?.*success/i, { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);

  // grabli #7: перед кликом фиксируем — ретраи после него ЗАПРЕЩЕНЫ (TikTok плодит дубли
  // и «repeated upload retry» — это ещё и бан-сигнал).
  let submitted = false;
  try {
    submitted = true;
    await postBtn.click({ timeout: 8000 });
  } catch (err) {
    if (submitted) return { maybePublished: true };
    throw err;
  }

  const ok = (await Promise.race([successWait, urlWait])) as boolean;
  if (!ok) return { maybePublished: true }; // клик прошёл, подтверждение не поймали — проверить руками
  return { externalUrl: page.url() };
}

async function waitForEnabledPostButton(page: Page) {
  const deadline = Date.now() + 120_000; // видео грузится/транскодится — ждём до 2 мин
  for (;;) {
    for (const sel of SEL.postButton) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        const disabled =
          (await btn.getAttribute('disabled').catch(() => null)) !== null ||
          (await btn.getAttribute('aria-disabled').catch(() => null)) === 'true';
        if (!disabled) return btn;
      }
    }
    await assertNoCaptcha(page);
    if (Date.now() > deadline) throw new Error('TikTok: кнопка Опубликовать не активировалась (транскод завис?)');
    await page.waitForTimeout(2000);
  }
}

// Прочитать профиль (ник/аватар/био) — best-effort. Селекторы TikTok меняются:
// проверь на живой сессии. Ошибки не роняют — вернём то, что нашли, или null.
async function getProfileInfo(page: Page): Promise<{ nick?: string; avatarUrl?: string; bio?: string } | null> {
  try {
    await page.goto('https://www.tiktok.com/tiktokstudio/profile', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const pickText = async (sels: string[]) => {
      for (const s of sels) {
        const t = (await page.locator(s).first().textContent().catch(() => null))?.trim();
        if (t) return t;
      }
      return undefined;
    };
    const nick = await pickText(['[data-e2e="user-title"]', '[data-e2e="user-subtitle"]', 'h1[data-e2e]', 'h1']);
    const bio = await pickText(['[data-e2e="user-bio"]', 'h2[data-e2e="user-bio"]']);
    let avatarUrl: string | undefined;
    for (const s of ['[data-e2e="user-avatar"] img', 'img[class*="Avatar" i]', 'span[shape="circle"] img', 'img[alt*="avatar" i]']) {
      const src = await page.locator(s).first().getAttribute('src').catch(() => null);
      if (src && /^https?:/.test(src)) { avatarUrl = src; break; }
    }
    if (!nick && !avatarUrl && !bio) return null;
    return { nick, avatarUrl, bio };
  } catch {
    return null;
  }
}

export const tiktokDriver: PlatformDriver = {
  platform: 'tiktok',
  isLoggedOut,
  getProfileInfo,
  publish,
  warmup: {
    feedUrl: 'https://www.tiktok.com/foryou',
    primarySignal: 'watch_time', // главный сигнal TikTok — досматриваемость, не лайки
    screensPerSession: [12, 26], // думскролл: 12–26 роликов за сессию (как живой юзер)
    dwellMs: [5000, 30000], // «смотрим» ролик 5–30с, варьируя
    likeChance: 0.15,
    followChance: 0.5,
    commentChance: 0.25,
    nicheQueries: ['нейросети', 'искусственный интеллект', 'обработка фото', 'ии'],
    selectors: {
      like: ['button[aria-label*="like" i]', 'span[data-e2e="like-icon"]', 'button[aria-label*="Нрав" i]'],
      follow: ['button:has-text("Подписаться")', 'button:has-text("Follow")', 'button[data-e2e="feed-follow"]'],
      commentOpen: ['span[data-e2e="comment-icon"]', 'button[aria-label*="comment" i]'],
      commentLike: ['span[data-e2e="comment-like-icon"]', 'div[data-e2e="comment-like-count"] svg', 'div[class*="DivCommentItem"] span[role="button"]'],
      commentContext: ['div[data-e2e="comment-list"]', 'div[class*="DivCommentContentContainer"]', 'body'],
      commentBox: ['div[contenteditable="true"][data-e2e="comment-input"]', 'div[contenteditable="true"]'],
      commentSubmit: ['div[data-e2e="comment-post"]', 'button:has-text("Опубликовать")', 'button:has-text("Post")'],
      captcha: SEL.captcha,
    },
  },
};
