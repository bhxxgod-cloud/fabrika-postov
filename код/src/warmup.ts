import type { Page } from 'playwright-core';
import type { PlatformDriver } from './drivers/types.js';
import { CaptchaError } from './drivers/types.js';
import { query } from './db/index.js';
import { COMMENT_START_DAY } from './scheduler.js';

// Движок прогрева. Имитирует живого человека И формирует интерес-профиль аккаунта
// (смотрит нишевый русскоязычный ИИ-контент -> алгоритм кладёт аккаунт в нужный пул).
// Поведение задаётся профилем площадки (driver.warmup); главный сигнал у каждой свой.

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const chance = (p: number) => Math.random() < p;

async function log(accountId: string, action: string, meta?: unknown) {
  await query(
    `INSERT INTO warmup_log (account_id, action, meta) VALUES ($1, $2, $3)`,
    [accountId, action, meta ? JSON.stringify(meta) : null],
  ).catch(() => {});
}

// Кликнуть первый ВИДИМЫЙ кандидат из списка селекторов (UI на языке прокси).
async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 4000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// Печать посимвольно — машинная скорость палит бота.
async function humanType(page: Page, selector: string, text: string) {
  const box = page.locator(selector).first();
  if (!(await box.isVisible().catch(() => false))) return;
  await box.click().catch(() => {});
  await box.pressSequentially(text, { delay: randInt(40, 90) }).catch(() => {});
}

// Детект капчи -> сразу CaptchaError (аккаунт на паузу, бот НЕ решает).
async function assertNoCaptcha(page: Page, driver: PlatformDriver) {
  for (const sel of driver.warmup.selectors.captcha ?? []) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      throw new CaptchaError(`${driver.platform}: капча в прогреве`);
    }
  }
}

export interface WarmupAccount {
  id: string;
  warmup_comments: boolean;
  warmupDay?: number; // день прогрева — до COMMENT_START_DAY свои комменты не пишем
}

// Сводка одной сессии прогрева — показываем в панели.
export interface WarmupSummary {
  watched: number;
  liked: number;
  followed: number;
  commented: number;
  commentLiked: number;
  bytesMB?: number; // сколько трафика съела сессия (для метровых прокси)
}

// Настройка сессии через CDP: (1) СЧЁТЧИК ТРАФИКА — суммируем реально скачанные байты,
// (2) ТРОТТЛИНГ — TikTok по адаптивному битрейту отдаёт видео в низком качестве (экономия).
// Троттлинг выключается WARMUP_DATA_SAVER=false, скорость — WARMUP_KBPS (по умолч. 700).
async function setupSession(page: Page): Promise<{ bytes: () => number }> {
  let total = 0;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    // Считаем скачанный трафик (байты по проводу, включая заголовки).
    (cdp as any).on('Network.loadingFinished', (e: any) => {
      total += Number(e?.encodedDataLength) || 0;
    });
    if (process.env.WARMUP_DATA_SAVER !== 'false') {
      // Минимум трафика: 400 kbps хватает низкому качеству видео, боту картинка не важна.
      const kbps = Number(process.env.WARMUP_KBPS) || 400;
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: Math.floor((kbps * 1024) / 8),
        uploadThroughput: Math.floor((300 * 1024) / 8),
        latency: 30,
      });
    }
  } catch {
    // не критично — просто без экономии/замера
  }
  return { bytes: () => total };
}

// Человеческое досматривание: не равномерно, а распределением —
// ~40% быстрый скип, ~45% обычный просмотр, ~15% залипание.
function humanDwell(w: PlatformDriver['warmup']): number {
  const r = Math.random();
  if (r < 0.4) return randInt(Math.floor(w.dwellMs[0] * 0.3), w.dwellMs[0]);
  if (r < 0.85) return randInt(w.dwellMs[0], w.dwellMs[1]);
  return randInt(w.dwellMs[1], Math.floor(w.dwellMs[1] * 1.9));
}

// Почитать комменты как человек: открыть, поскроллить, «почитать», закрыть. Дёшево по трафику.
async function readComments(page: Page, driver: PlatformDriver): Promise<void> {
  const w = driver.warmup;
  if (!(await clickFirstVisible(page, w.selectors.commentOpen ?? []))) return;
  await page.waitForTimeout(randInt(1500, 4000)); // читаем верхние
  for (let k = 0; k < randInt(1, 3); k++) {
    await page.mouse.wheel(0, randInt(300, 700)).catch(() => {});
    await page.waitForTimeout(randInt(900, 2200));
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(randInt(500, 1200));
}

// Одна сессия «жизни в ленте». Всё best-effort: не нашли кнопку — просто листаем дальше
// (сам заход в ленту уже сигнал живости). Ошибки не роняем, кроме капчи/разлогина.
export async function runWarmupSession(
  page: Page,
  driver: PlatformDriver,
  account: WarmupAccount,
): Promise<WarmupSummary> {
  const w = driver.warmup;
  const s: WarmupSummary = { watched: 0, liked: 0, followed: 0, commented: 0, commentLiked: 0 };

  const net = await setupSession(page); // счётчик трафика + низкое качество видео
  await page.goto(w.feedUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(randInt(2000, 4000));
  await assertNoCaptcha(page, driver);

  // ЭКОНОМНЫЙ прогрев (по умолчанию вкл): меньше экранов, без тяжёлых действий (подписки/комменты) —
  // только просмотры + редкий лайк. Мягче к GoLogin/прокси (меньше запросов), держит акк тёплым. Полный
  // режим — WARMUP_ECON=0.
  const econ = process.env.WARMUP_ECON !== '0';
  const screens = econ ? randInt(2, 4) : randInt(w.screensPerSession[0], w.screensPerSession[1]);
  let commented = false;

  for (let i = 0; i < screens; i++) {
    // Ключевой сигнал: «досматривание» — человеческое распределение (не равномерно).
    const dwell = humanDwell(w);
    await page.waitForTimeout(dwell);
    s.watched++;
    await log(account.id, 'watch', { dwell, signal: w.primarySignal });

    // Редкий лайк ролика (реальные люди лайкают ~1 из 20). Не на «быстро проскипанных».
    let didLike = false;
    if (dwell > w.dwellMs[0] && chance(w.likeChance)) {
      if (await clickFirstVisible(page, w.selectors.like ?? [])) {
        s.liked++; didLike = true;
        await log(account.id, 'like');
        await page.waitForTimeout(randInt(600, 1500));
      }
    }

    // Подписка на автора: после досмотра/лайка (зашло — подписался). Максимум 2 за сессию. В эконом-режиме — нет.
    if (!econ && s.followed < 2 && (didLike || dwell > w.dwellMs[1]) && chance(0.12)) {
      if (await clickFirstVisible(page, w.selectors.follow ?? [])) {
        s.followed++;
        await log(account.id, 'follow');
        await page.waitForTimeout(randInt(700, 1600));
      }
    }

    // Иногда ПОЧИТАТЬ комменты (открыть, поскроллить, закрыть) — по-человечески, дёшево.
    if (chance(0.15)) await readComments(page, driver);

    // Изредка лайкнуть ЧУЖОЙ коммент (мягкая активность, не более 2 за сессию).
    if (s.commentLiked < 2 && chance(0.18)) {
      if (await tryLikeComment(page, driver)) {
        s.commentLiked++;
        await log(account.id, 'comment_like');
      }
    }

    // Свои комменты — только если включены, НЕ раньше COMMENT_START_DAY (фаза: сначала
    // только смотрим/лайкаем), максимум один за сессию.
    if (!econ && account.warmup_comments && (account.warmupDay ?? 99) >= COMMENT_START_DAY && !commented && chance(w.commentChance)) {
      commented = await tryComment(page, driver, account);
      if (commented) s.commented++;
    }

    // Редкая микро-пауза — человек отвлёкся (телефон, сообщение).
    if (chance(0.08)) await page.waitForTimeout(randInt(3000, 9000));

    // Изредка вернуться на предыдущий ролик (пере-смотр) — так делают живые люди.
    if (chance(0.05)) {
      await page.mouse.wheel(0, -randInt(400, 800)).catch(() => {});
      await page.waitForTimeout(randInt(1500, 3500));
      await page.mouse.wheel(0, randInt(400, 900)).catch(() => {});
    }

    // Скролл к следующему: варьируем жест (колесо / стрелка) и величину.
    if (chance(0.7)) await page.mouse.wheel(0, randInt(500, 1300)).catch(() => {});
    else await page.keyboard.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(randInt(700, 2200));
    await assertNoCaptcha(page, driver);
  }

  // Ещё одна подписка под конец, если в цикле не подписался (реальные люди подписываются). Не в эконом-режиме.
  if (!econ && s.followed < 2 && chance(w.followChance)) {
    if (await clickFirstVisible(page, w.selectors.follow ?? [])) {
      s.followed++;
      await log(account.id, 'follow');
    }
  }

  s.bytesMB = Math.round((net.bytes() / 1048576) * 10) / 10; // МБ за сессию (1 знак)

  // Отметить время в БД (не в памяти — деплой не должен сбивать ритм) + сводку.
  await query(`UPDATE accounts SET warmup_at = now() WHERE id = $1`, [account.id]);
  await log(account.id, 'session', s);
  return s;
}

// Лайкнуть один чужой коммент: открыть комменты -> лайкнуть сердечко у коммента -> закрыть.
async function tryLikeComment(page: Page, driver: PlatformDriver): Promise<boolean> {
  const w = driver.warmup;
  if (!(await clickFirstVisible(page, w.selectors.commentOpen ?? []))) return false;
  await page.waitForTimeout(randInt(900, 1800));
  const liked = await clickFirstVisible(page, w.selectors.commentLike ?? []);
  await page.waitForTimeout(randInt(500, 1200));
  await page.keyboard.press('Escape').catch(() => {});
  return liked;
}

async function tryComment(page: Page, driver: PlatformDriver, account: WarmupAccount): Promise<boolean> {
  const w = driver.warmup;
  if (!(await clickFirstVisible(page, w.selectors.commentOpen ?? []))) return false;
  await page.waitForTimeout(randInt(800, 1800));

  // Текст оригинала читаем прямо из диалога -> короткий осмысленный ответ 3–8 слов.
  const original = await page
    .locator(w.selectors.commentContext?.[0] ?? 'body')
    .first()
    .innerText()
    .catch(() => '');
  const text = await composeComment(original);
  if (text === 'SKIP' || !text) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }

  const boxSel = (w.selectors.commentBox ?? [])[0];
  if (boxSel) await humanType(page, boxSel, text);
  await clickFirstVisible(page, w.selectors.commentSubmit ?? []);
  await log(account.id, 'comment', { text });
  await page.waitForTimeout(randInt(1000, 2500));
  return true;
}

// Осмысленный короткий коммент на языке поста. На политику/трагедии/рекламу -> SKIP.
// Реальная генерация подключается из ai.ts; здесь безопасный заглушечный дефолт.
async function composeComment(originalText: string): Promise<string> {
  const { generateWarmupComment } = await import('./ai.js').catch(() => ({
    generateWarmupComment: async () => 'SKIP',
  }));
  return generateWarmupComment(originalText).catch(() => 'SKIP');
}
