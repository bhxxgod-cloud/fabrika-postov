import type { Page } from 'playwright-core';
import type { PlatformDriver, PublishInput, PublishResult } from './types.js';

// YouTube Shorts. Флоу веб-загрузки: studio.youtube.com -> Создать -> Загрузить видео
// -> setInputFiles байтами -> название/описание -> «Не для детей» -> опубликовать.
// Главный сигнал — время просмотра, как у TikTok.

async function isLoggedOut(page: Page): Promise<boolean> {
  if (/accounts\.google\.com|\/signin/.test(page.url())) return true;
  for (const sel of ['a[href*="ServiceLogin"]', 'text=/Войти|Sign in/i']) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function publish(_page: Page, _input: PublishInput): Promise<PublishResult> {
  throw new Error('YouTube: реализовать загрузку через studio.youtube.com (аналогично TikTok-драйверу).');
}

export const youtubeDriver: PlatformDriver = {
  platform: 'youtube',
  isLoggedOut,
  publish,
  warmup: {
    feedUrl: 'https://www.youtube.com/shorts',
    primarySignal: 'watch_time',
    screensPerSession: [4, 8],
    dwellMs: [5000, 30000],
    likeChance: 0.15,
    followChance: 0.25,
    commentChance: 0.2,
    nicheQueries: ['нейросети', 'ai инструменты', 'обработка фото нейросетью'],
    selectors: {
      like: ['button[aria-label*="Нрав" i]', 'button[aria-label*="like" i]'],
      follow: ['button[aria-label*="Подпис" i]', 'button:has-text("Subscribe")'],
      commentOpen: ['#comments', 'ytd-comment-simplebox-renderer'],
      commentContext: ['#comments', 'body'],
      commentBox: ['#contenteditable-root', 'div[contenteditable="true"]'],
      commentSubmit: ['#submit-button button', 'button:has-text("Комментировать")'],
      captcha: ['div[class*="captcha"]', 'iframe[src*="recaptcha"]'],
    },
  },
};
