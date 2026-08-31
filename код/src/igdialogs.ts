// === Единый «строй» всплывашек Instagram ===
// Порядок реальных экранов после входа: 2FA → «сохранить данные входа» → куки → уведомления.
// Всё отклоняем. Акк считаем ГОТОВЫМ только когда видна лента И на экране не висит модалка.
//
// Почему структурно, а не по тексту: GoLogin даёт профилям случайную локаль, и текстовые регекспы
// молча промахиваются на PL/AR/ID/HI/JA/KO/ZH/VI/TH → всплывашка остаётся, коммент не ставится,
// а наверх уходит ложное «не нашёл поле» (трактуется как блок поста). Поэтому:
//   1) язык пиннится к EN (см. gologin.ts connect → ig_lang + Accept-Language),
//   2) текстовый матч EN — первый приоритет,
//   3) СТРУКТУРНЫЙ фолбэк: у модалок IG кнопка-отказ идёт ПОСЛЕДНЕЙ (проверено вживую на
//      «Turn on notifications»: [Turn On, Not Now] → жать надо последнюю).
// Escape модалки IG НЕ закрывает (проверено) — не используем.
import type { Page } from 'playwright-core';

// Отказ от необязательных кук — ОТДЕЛЬНО от «разрешить все». Раньше они лежали в одной альтернации
// и .first() по DOM-порядку жал «Allow all» (IG рендерит его раньше) — то есть мы соглашались на всё.
const COOKIES_DECLINE = /^\s*(Decline optional cookies|Only allow essential cookies|Отклонить необязательные|Optionale Cookies ablehnen|Rechazar cookies opcionales|Refuser les cookies facultatifs)/i;
const COOKIES_ALLOW = /^\s*(Allow all cookies|Accept all|Разрешить все|Alle Cookies erlauben)/i;
// «Не сейчас» — единственно допустимый ответ на «сохранить вход?» и «включить уведомления?».
// ⚠️ «Turn on / Включить» СЮДА НИКОГДА не добавлять — раньше это включало пуши вместо отказа.
const NOT_NOW = /^\s*(Not now|Not Now|Cancel|Dismiss|Skip|Не сейчас|Отмена|Пропустить|Jetzt nicht|Später|Şimdi değil|Ahora no|Plus tard|Agora não|Nu niet|Non ora)\s*$/i;

async function clickByText(page: Page, rx: RegExp, timeoutMs = 2500): Promise<boolean> {
  try {
    const b = page.getByRole('button', { name: rx }).first();
    if (!(await b.isVisible({ timeout: timeoutMs }).catch(() => false))) return false;
    await b.click({ timeout: 4000 });
    return true; // важно: true только если клик РЕАЛЬНО прошёл (старый clickAny врал по одной видимости)
  } catch { return false; }
}

/** Есть ли сейчас модалка на экране. */
export async function hasDialog(page: Page): Promise<boolean> {
  return await page.locator('[role="dialog"], [role="alertdialog"]').first().isVisible().catch(() => false);
}

// Модалка, которую трогать НЕЛЬЗЯ: логин/2FA/чек-поинт — там «последняя кнопка» может быть вредной.
async function isSensitiveDialog(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!d) return false;
    if (d.querySelector('input[type="password"], input[name="verificationCode"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]')) return true;
    const t = (d.textContent || '').toLowerCase();
    return /verification|two-factor|confirm you'?re human|challenge|checkpoint|подтверд|код/.test(t);
  }).catch(() => true); // не смогли понять — считаем опасной, не жмём вслепую
}

/**
 * Структурный фолбэк: жмём ПОСЛЕДНЮЮ кнопку модалки (у IG это отказ: «Not Now», «Decline…»).
 * Не трогаем чувствительные модалки (логин/2FA/капча). Возвращает текст нажатой кнопки.
 */
async function clickLastDialogButton(page: Page): Promise<string | null> {
  if (await isSensitiveDialog(page)) return null;
  return await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!d) return null;
    const bs = Array.from(d.querySelectorAll('button,[role="button"]'))
      .filter((b) => (b as HTMLElement).innerText && (b as HTMLElement).innerText.trim());
    const last = bs[bs.length - 1] as HTMLElement | undefined;
    if (!last) return null;
    const label = last.innerText.trim().slice(0, 40);
    last.click();
    return label;
  }).catch(() => null);
}

/**
 * Прогнать «строй» всплывашек. Возвращает список того, что реально закрыли (для логов/диагностики).
 * Безопасно звать сколько угодно раз — если всплывашек нет, вернёт [].
 */
export async function dismissAll(page: Page, rounds = 3): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < rounds; i++) {
    let acted = false;
    // 1) КУКИ — строго сначала «отклонить необязательные», и только если его нет — «разрешить все»
    //    (баннер перекрывает форму/ленту, без него дальше ничего не кликается).
    if (await clickByText(page, COOKIES_DECLINE)) { done.push('cookies:decline'); acted = true; }
    else if (await clickByText(page, COOKIES_ALLOW, 1200)) { done.push('cookies:allow(fallback)'); acted = true; }
    // 2) «Сохранить данные входа?» и 3) «Включить уведомления?» — оба отвечают «Не сейчас».
    if (await clickByText(page, NOT_NOW)) { done.push('not-now'); acted = true; }
    // 4) Структурный фолбэк — модалка есть, но текст незнакомый (чужая локаль).
    if (!acted && await hasDialog(page)) {
      const label = await clickLastDialogButton(page);
      if (label) { done.push(`dialog:last("${label}")`); acted = true; }
    }
    if (!acted) break;                 // чисто — выходим
    await page.waitForTimeout(900);    // даём модалке закрыться, следующая может всплыть сразу
  }
  return done;
}

/** Видна ли лента (структурно, без текста): посты-<article> или домашняя навигация. */
export async function feedVisible(page: Page): Promise<boolean> {
  const arts = await page.evaluate(() => document.querySelectorAll('article').length).catch(() => 0);
  if (arts > 0) return true;
  return await page.locator('svg[aria-label="Home"], a[href="/"], [role="menuitem"]').first().isVisible().catch(() => false);
}

/**
 * ГОТОВ К РАБОТЕ = лента видна И на экране НЕТ модалки.
 * Именно этот критерий (а не просто «есть кука») означает, что комментинг сможет работать.
 */
export async function readyForWork(page: Page): Promise<{ ok: boolean; why: string; dismissed: string[] }> {
  const dismissed = await dismissAll(page);
  if (await hasDialog(page)) return { ok: false, why: 'на экране осталась модалка', dismissed };
  if (!(await feedVisible(page))) return { ok: false, why: 'лента не видна', dismissed };
  return { ok: true, why: 'лента видна, экран чистый', dismissed };
}
