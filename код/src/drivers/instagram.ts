import type { Page } from 'playwright-core';
import type { PlatformDriver, PublishInput, PublishResult } from './types.js';

// Instagram Reels. Это тоже Meta — флоу близок к Threads. Веб-загрузка через
// «Создать» -> Reel -> setInputFiles -> подпись -> публикация. Главный сигнал —
// скролл ленты + сторис + редкие лайки.

async function isLoggedOut(page: Page): Promise<boolean> {
  // ШАГ 0: кука sessionid — САМЫЙ надёжный признак живой сессии (IG ставит её только после ПОЛНОГО
  // входа, включая 2FA). Если она есть — акк ЗАЛОГИНЕН, что бы ни висело поверх. Без этой проверки
  // любое поле пароля над живой сессией (IG просит подтвердить пароль на чек-поинте, модалка
  // «введите пароль ещё раз») давало ложный SessionError → акк метился dead → релогин-долбёж.
  try {
    const cookies = await page.context().cookies(['https://www.instagram.com', 'https://i.instagram.com']);
    const sid = cookies.find((c) => c.name === 'sessionid');
    if (sid && sid.value && sid.value.length > 10) return false;
  } catch { /* не смогли прочитать куки — падаем на признаки ниже */ }
  // Только ЖЕЛЕЗНЫЕ признаки разлогина: редирект на /accounts/login ИЛИ видимое поле ПАРОЛЯ.
  // Раньше проверялись username-инпут и текст «Log in» — IG держит их и на залогиненных
  // страницах (в скрытых формах/футере) -> ложные «сессия мертва» на живых аккаунтах.
  if (/\/accounts\/login/.test(page.url())) return true;
  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) return true;
  return false;
}

async function publish(_page: Page, _input: PublishInput): Promise<PublishResult> {
  throw new Error('Instagram: реализовать загрузку Reel (флоу близок к Threads — это Meta).');
}

export const instagramDriver: PlatformDriver = {
  platform: 'instagram',
  isLoggedOut,
  publish,
  warmup: {
    feedUrl: 'https://www.instagram.com/',
    primarySignal: 'scroll',
    screensPerSession: [5, 9],
    dwellMs: [2000, 8000],
    likeChance: 0.15,
    followChance: 0.15,
    commentChance: 0.15,
    nicheQueries: ['нейросети', 'ai art', 'обработка фото'],
    selectors: {
      like: ['svg[aria-label="Нравится"]', 'svg[aria-label="Like"]'],
      follow: ['button:has-text("Подписаться")', 'button:has-text("Follow")'],
      commentOpen: ['svg[aria-label="Комментировать"]', 'svg[aria-label="Comment"]'],
      commentContext: ['div[role="dialog"]', 'body'],
      commentBox: ['textarea', 'form textarea', 'div[contenteditable="true"][role="textbox"]', 'div[aria-label][contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]', 'div[contenteditable="true"]'],
      commentSubmit: ['div[role="button"]:has-text("Опубликовать")', 'button:has-text("Post")', 'div[role="button"]:has-text("Yayınla")', 'div[role="button"]:has-text("Posten")', 'div[role="button"]:has-text("Gönder")'],
      // Сетка постов на странице хэштега (/explore/tags/<tag>/) — для комментинг-фермы.
      postThumb: ['article a[href*="/p/"]', 'a[href*="/reel/"]', 'a[href*="/p/"]'],
      captcha: ['div[class*="captcha"]'],
    },
  },
};
