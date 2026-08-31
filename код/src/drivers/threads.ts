import type { Page, Locator } from 'playwright-core';
import type { PlatformDriver, PublishInput, PublishResult } from './types.js';
import { SessionError } from './types.js';

// Драйвер Threads — боевой флоу постера Никиты, адаптированный под наш интерфейс
// (публикует через переданную воркером page). Ключ антибана — ПОВЕДЕНИЕ:
// движение мыши по дуге, клик не в центр, посимвольная печать с паузами «на чтение».
// Ссылка идёт НЕ в тело поста, а вторым постом цепочки (алгоритм режет ссылочные посты).

const NAV_TIMEOUT = 45_000;
const STEP_TIMEOUT = 20_000;

const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Мультиязычные селекторы — UI на языке страны прокси (RU/EN/PL, добавляй свой).
const SEL = {
  composerOpen: [
    'a:has-text("Nowy wątek")', 'div[role="button"]:has-text("New thread")',
    'div[role="button"]:has-text("Новый тред")', 'div[role="button"]:has-text("Что нового")',
    'svg[aria-label="Create"]', 'svg[aria-label="Создать"]', 'a[href="/intent/post"]',
  ],
  textbox: '[role="textbox"], textarea, div[contenteditable="true"]',
  fileInput: 'input[type="file"]',
  addToThread: ['div[role="button"]:has-text("Add to thread")', 'div[role="button"]:has-text("Добавить в тред")'],
  postButton: [
    '[role="dialog"] div[role="button"]:has-text("Opublikuj")',
    '[role="dialog"] div[role="button"]:has-text("Post")',
    'div[role="button"]:has-text("Опубликовать")', 'button:has-text("Post")',
  ],
  successToast: 'text=/Opublikowano|Опубликовано|Posted|Wysłano/i',
  loggedOut: ['input[name="username"]', 'a[href="/login"]', 'text=/Войти|Log in|Sign up|Zaloguj/i'],
};

// Курсор к элементу по дуге + клик в среднюю треть + задержка down/up (не робо-клик).
async function humanClick(page: Page, loc: Locator) {
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error('no box');
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: rand(8, 22) });
    await pause(rand(90, 380));
    await page.mouse.down();
    await pause(rand(40, 110));
    await page.mouse.up();
  } catch {
    await loc.click({ timeout: STEP_TIMEOUT });
  }
}

// Печать посимвольно, рваный ритм, редкие «раздумья».
async function humanType(page: Page, loc: Locator, text: string) {
  await humanClick(page, loc);
  await pause(rand(250, 750));
  for (const ch of text) {
    await page.keyboard.type(ch);
    await pause(rand(35, 130));
    if (Math.random() < 0.05) await pause(rand(300, 1100));
  }
}

async function humanScroll(page: Page) {
  await page.mouse.wheel(0, rand(300, 900));
}

async function humanClickFirst(page: Page, sels: string[], what: string) {
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 4000 });
      await humanClick(page, loc);
      return;
    } catch {
      /* следующий кандидат */
    }
  }
  throw new Error(`Threads: не нашёл элемент — ${what}`);
}

async function isLoggedOut(page: Page): Promise<boolean> {
  if (/\/login/.test(page.url())) return true;
  for (const sel of SEL.loggedOut) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

// Скачиваем медиа по ссылке в байты — setInputFiles работает с удалённым CDP.
async function fetchMedia(url: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Threads: не скачать медиа (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  const name = `post.${mimeType.includes('png') ? 'png' : mimeType.includes('mp4') ? 'mp4' : 'jpg'}`;
  return { name, mimeType, buffer };
}

// URL опубликованного поста: свой профиль → пермалинк свежего поста.
async function captureLatestPostUrl(page: Page): Promise<string | null> {
  try {
    const href = await page.locator('a[href^="/@"]').first().getAttribute('href', { timeout: 5000 }).catch(() => null);
    if (!href) return null;
    await page.goto(`https://www.threads.net${href}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(rand(1500, 2800));
    const post = await page.locator('a[href*="/post/"]').first().getAttribute('href').catch(() => null);
    if (!post) return null;
    return post.startsWith('http') ? post : `https://www.threads.net${post}`;
  } catch {
    return null;
  }
}

async function publish(page: Page, input: PublishInput): Promise<PublishResult> {
  page.setDefaultTimeout(STEP_TIMEOUT);
  await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(rand(2200, 3500));
  if (await isLoggedOut(page)) throw new SessionError('Threads: сессия мертва (логин-скрин)');

  // Разогрев: человек не телепортируется к композеру — осмотрелся, полистал.
  await humanScroll(page);
  await pause(rand(1500, 4000));
  if (Math.random() < 0.5) {
    await humanScroll(page);
    await pause(rand(1200, 3000));
  }

  // 1) Композер + текст поста (посимвольно).
  await humanClickFirst(page, SEL.composerOpen, 'композер');
  await page.waitForTimeout(rand(900, 1800));
  const firstBox = page.locator(SEL.textbox).first();
  await firstBox.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
  await humanType(page, firstBox, input.caption);

  // 2) Медиа байтами (если есть).
  if (input.mediaUrl) {
    const m = await fetchMedia(input.mediaUrl);
    await page.locator(SEL.fileInput).first().setInputFiles({ name: m.name, mimeType: m.mimeType, buffer: m.buffer });
    await page.waitForTimeout(5000); // превью грузится
  }

  // 3) Реплай со ссылкой — вторым постом цепочки (ссылка не в теле поста).
  if (input.replyText) {
    try {
      await pause(rand(600, 1600));
      await humanClickFirst(page, SEL.addToThread, 'добавить в тред');
      await page.waitForTimeout(rand(700, 1500));
      const boxes = page.locator(SEL.textbox);
      await humanType(page, boxes.nth((await boxes.count()) - 1), input.replyText);
    } catch {
      /* реплай best-effort; основной пост важнее */
    }
  }

  // grabli #4-5: композер закрылся != опубликовано. Ждём баннер успеха, старт ДО клика
  // (баннер живёт 5-7с; медиа-пост публикуется до 20-40с → таймаут 45с, grabli #6).
  const bannerWait = page
    .locator(SEL.successToast)
    .first()
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  await pause(rand(800, 2200)); // «перечитал перед отправкой»

  // grabli #7: после клика ретрай ЗАПРЕЩЁН (дубль). Обрыв после клика → maybePublished.
  let clicked = false;
  try {
    clicked = true;
    await humanClickFirst(page, SEL.postButton, 'Опубликовать');
  } catch (e) {
    if (clicked) return { maybePublished: true };
    throw e;
  }

  const confirmed = await bannerWait;
  if (!confirmed) return { maybePublished: true }; // баннер не поймали — пост мог уйти, проверить руками

  const postUrl = await captureLatestPostUrl(page);
  return { externalUrl: postUrl ?? undefined };
}

export const threadsDriver: PlatformDriver = {
  platform: 'threads',
  isLoggedOut,
  publish,
  warmup: {
    feedUrl: 'https://www.threads.net/',
    primarySignal: 'reply_velocity',
    screensPerSession: [4, 8],
    dwellMs: [2000, 7000],
    likeChance: 0.6,   // лайк не на каждом экране
    followChance: 0.1,
    commentChance: 0.13,
    nicheQueries: ['нейросети', 'ai', 'промпты'],
    selectors: {
      like: ['svg[aria-label="Like"]', 'svg[aria-label="Нравится"]', 'svg[aria-label="Lubię to!"]'],
      follow: ['div[role="button"]:has-text("Подписаться")', 'div[role="button"]:has-text("Follow")'],
      commentOpen: ['svg[aria-label="Reply"]', 'svg[aria-label="Ответить"]', 'svg[aria-label="Komentuj"]'],
      commentContext: ['div[role="dialog"]', 'body'],
      commentBox: ['div[role="dialog"] [role="textbox"]', '[role="textbox"]', 'div[contenteditable="true"]'],
      commentSubmit: ['[role="dialog"] div[role="button"]:has-text("Опубликовать")', 'div[role="button"]:has-text("Post")'],
      captcha: ['div[class*="captcha"]'],
    },
  },
};
