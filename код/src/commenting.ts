import type { Page, Locator } from 'playwright-core';
import type { PlatformDriver } from './drivers/types.js';
import { CaptchaError, SessionError } from './drivers/types.js';
import { query } from './db/index.js';
import { generateSeedComment, generateContextualReply } from './ai.js';

// Ферма комментов: под ЧУЖИМИ постами по нишевым хэштегам пишем нативный коммент
// от лица персоны, тонко упоминая neironka. Всё best-effort, ошибки не роняют воркер
// (кроме капчи/разлогина). Ротация ролей и лимиты — на уровне воркера.

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));

async function humanType(page: Page, sel: string, text: string): Promise<boolean> {
  const box = page.locator(sel).first();
  if (!(await box.isVisible().catch(() => false))) return false;
  await box.click().catch(() => {});
  await box.pressSequentially(text, { delay: randInt(40, 90) }).catch(() => {});
  // Убедимся, что текст реально попал в поле (иначе не считаем коммент отправленным).
  const val = await box.inputValue().catch(() => box.innerText().catch(() => ''));
  return Boolean(val && val.trim().length >= 3);
}
async function clickFirst(page: Page, sels: string[]): Promise<boolean> {
  for (const s of sels) {
    const l = page.locator(s).first();
    if (await l.isVisible().catch(() => false)) { await l.click({ timeout: 4000 }).catch(() => {}); return true; }
  }
  return false;
}

export interface SeedConfig { hashtags: string[]; role?: 'mention' | 'ask' | 'answer'; }
export interface SeedResult { posted: boolean; url?: string; text?: string; }

// Кнопка «Ответить» у коммента — на многих языках (интерфейс акка может быть любым).
const REPLY_BTN_RX = /^(Ответить|Відповісти|Reply|Antworten|Yanıtla|Cevapla|Responder|Répondre|Rispondi|Antwoorden|Odpowiedz|Válaszol|Balas|Membalas|Trả lời|Απάντηση|Atbildēt|Atsakyti|Vastaa|Svara|Svar|Odpovědět|Відповідь|رد|الرد|ردّ|回复|回覆|返信|답글|답장|ตอบกลับ|जवाब दें|उत्तर दें|جواب دیں|پاسخ|উত্তর|Trả lời|Cavab|הגב|Phản hồi)$/i;

// Слова-ДЕЙСТВИЯ под комментом (кнопки/меты) — их вырезаем, чтобы найти уровень с реальным текстом коммента.
// Мультиязык: Ответить/лайк/перевод/«показать N ответов»/«N нравится»/дата-меты.
const ACTION_RX = /\b(Ответить|Відповісти|Reply|Antworten|Yanıtla|Cevapla|Responder|Répondre|Rispondi|Antwoorden|Beğen|Beğenme|Like|J.?aime|Нравится|Подобається|Gefällt|Çevirisine bak|See translation|Voir la traduction|Übersetzung ansehen|Показать перевод|Показати переклад|Ver traducción|yanıt(ın|ları)?\s*(tümünü)?\s*(gör|görüntüle)?|Показать (все )?ответ\w*|View( all)? repl\w*|Voir( les)? réponse\w*|Weitere Antworten|beğenme|отметк\w*)\b/gi;

// Вопрос-комменты, на которые есть смысл отвечать (человек реально спрашивает «как/промт»).
const DEMAND_RX = /промт|промпт|prompt|как (ты|вы|это|её|его|такое|сдела|повтор|получ|назыв)|чем (сдела|это)|где (сдела|брал)|какой (нейрос|ии|прилож)|как(ая|ое) (нейрос|прилож)|что за (нейрос|прилож|ии|прога|фильтр)|как называется|подскаж|скинь|поделит|туториал|туторил|tutorial|how (did|do) you|which (app|ai)\b|what (app|ai)\b/i;

// Комменты-реклама/спам/офтоп — на них НЕ отвечаем (даже если есть слово-вопрос).
const AD_RX = /https?:\/\/|t\.me\/|www\.|@[a-z0-9_.]{4,}|в директ|в лс|пиши в лс|в шапке|ссылк[аиуе]|подпис|мой канал|мой тг|моём тг|курс|обучени|марафон|скидк|промокод|реклам|зараб|доход|инвест|кэшбэк|розыгрыш/i;

// Похоже ли на промпт (чтобы вытащить его из чужих комментов и валидировать).
// Длинный осмысленный текст с признаками промпта И без ссылок/рекламы.
function looksLikePrompt(t: string): boolean {
  if (t.length < 60 || t.length > 1400) return false;
  const low = t.toLowerCase();
  if (/https?:\/\/|t\.me\/|@[a-z0-9_.]{3,}|подпис|реклам|мой канал|телеграм|переходи|в шапке|в профиле|ссылк|➡|👉 http/i.test(low)) return false;
  const sig = ['prompt', 'промпт', 'промт', 'cinematic', 'portrait', 'realistic', 'photo', 'lighting', 'background', 'shot on', '35mm', '85mm', '--ar', 'aspect', 'ultra', 'detailed', 'style', 'wearing', 'standing', 'sitting', 'pose', 'фотореал', 'освещени', 'ракурс', 'кадр', 'крупный план', 'сгенерир', 'создай', 'на фоне', 'в стиле'];
  const hits = sig.filter((s) => low.includes(s)).length;
  return hits >= 2 || (t.length > 170 && hits >= 1);
}

// Набрать текст в поле коммента и отправить (мы уже на странице поста).
// Подпись поля коммента на разных языках — «Оставить комментарий / Add a comment / Yorum ekle…».
const COMMENT_PH_RX = /komment|коммент|add a comment|yorum|comentar|comment[ae]|commentaire|commento|reageren|komentar|留言|评论|コメント|댓글|تعليق|dodaj komentarz|añad|напиш/i;

// Раскрыть комменты на реелах (там textarea появляется лениво после клика по зоне/иконке комментов).
async function expandComments(page: Page): Promise<void> {
  for (const s of ['svg[aria-label*="omment" i]', 'svg[aria-label*="ommentar" i]', 'svg[aria-label*="orum" i]', 'svg[aria-label*="عليق"]', 'a[href$="/comments/"]']) {
    const l = page.locator(s).first();
    if (await l.isVisible().catch(() => false)) { await l.click({ timeout: 3000 }).catch(() => {}); return; }
  }
}
// Поле коммента СТРУКТУРНО (язык-независимо): <form textarea> в article/dialog/main. Это надёжнее текста/
// placeholder — структура не переводится. Polling до ~5с + раскрытие на реелах. Текстовые селекторы — фолбэк.
async function findBox(page: Page, w: PlatformDriver['warmup']): Promise<Locator | null> {
  // Кандидаты в ПОРЯДКЕ приоритета. Сначала поле ВНУТРИ формы (коммент-бокс всегда в <form>) — так не
  // схватим поиск в навбаре ([role=textbox] без формы). Поле — textarea ИЛИ contenteditable/role=textbox
  // (IG рендерит по-разному). Берём первый ВИДИМЫЙ. Это устойчивее привязки к одному тегу.
  const CANDS = [
    'main form textarea', 'form textarea',
    'div[role="dialog"] form textarea', 'article form textarea',
    'form div[contenteditable="true"]', 'form [role="textbox"]',
    'main form [contenteditable="true"]',
    'textarea', 'div[contenteditable="true"][role="textbox"]', '[role="textbox"]', 'div[contenteditable="true"]',
  ];
  const pick = async (): Promise<Locator | null> => {
    for (const sel of CANDS) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) && (await loc.isVisible().catch(() => false))) return loc;
    }
    // по подписи/роли (мультиязычно), если структурно не нашли
    for (const c of [page.getByPlaceholder(COMMENT_PH_RX).first(), page.getByRole('textbox', { name: COMMENT_PH_RX }).first()]) {
      if ((await c.count().catch(() => 0)) && (await c.isVisible().catch(() => false))) return c;
    }
    return null;
  };
  // Поле коммента — ВВЕРХУ страницы. IG вырезает его из DOM, когда уехал вниз в «More posts» —
  // поэтому ВСЕГДА сначала прыгаем в самый верх и ищем оттуда, пуллим до ~5с (ленивый рендер).
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    const found = await pick();
    if (found) return found;
    if (i === 0) await expandComments(page);
    await page.waitForTimeout(1300);
  }
  return null;
}
// Диагностика: что за поля/плашки есть на странице (в лог, когда поле не нашли — чтобы точно знать вёрстку).
async function dumpFields(page: Page): Promise<string> {
  return page.evaluate(() => {
    const q = (s: string) => Array.from(document.querySelectorAll(s));
    const ta = q('textarea').map((e) => `textarea[ph=${(e as HTMLTextAreaElement).placeholder}|al=${e.getAttribute('aria-label')}]`);
    const ce = q('[contenteditable="true"]').map((e) => `ce[role=${e.getAttribute('role')}|al=${e.getAttribute('aria-label')}]`);
    const ph = q('[placeholder]').map((e) => `ph=${e.getAttribute('placeholder')}`);
    return [...ta, ...ce, ...ph].slice(0, 12).join(' ; ') || 'НЕТ полей/плашек';
  }).catch(() => 'dump failed');
}
// verifyAppear=false — для ВЛОЖЕННЫХ ответов (reply на коммент): IG сворачивает их под «Показать ответы»
// сразу после отправки, в тексте страницы их НЕ видно — строгая проверка давала ложное «не ушло», бот
// перепощивал (9 ответов вместо 3). Для вложенных успех = поле очистилось; строгая проверка — топ-левелу.
async function submitInBox(page: Page, w: PlatformDriver['warmup'], text: string, verifyAppear = true): Promise<boolean> {
  let box = await findBox(page, w);
  if (!box) { // поле выгрузилось (страница уехала вниз в «другие посты») — возвращаемся наверх, где textarea
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(700);
    box = await findBox(page, w);
  }
  if (!box) {
    // Часто (реел) «Yorum ekle…/Add a comment» — это кликабельная ПЛАШКА, а не готовое поле.
    // Кликаем по самой надписи, чтобы раскрылся ввод, и ищем снова.
    const ph = page.getByText(COMMENT_PH_RX).first();
    if (await ph.count().catch(() => 0)) {
      await ph.scrollIntoViewIfNeeded().catch(() => {});
      await ph.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(randInt(700, 1200));
      box = await findBox(page, w);
    }
  }
  if (!box) { // ещё нет — жмём иконку «Комментировать»
    await clickFirst(page, w.selectors.commentOpen ?? []);
    await page.waitForTimeout(randInt(900, 1400));
    box = await findBox(page, w);
  }
  if (!box) { console.warn(`[reply] поле НЕ найдено. Что на странице: ${await dumpFields(page)}`); return false; }
  await box.scrollIntoViewIfNeeded().catch(() => {}); // Playwright подводит поле сам
  await box.click({ timeout: 6000 }).catch(() => {});
  // АТОМАРНЫЙ ввод через fill(): кладёт весь текст РАЗОМ и шлёт input-событие (React видит). Посимвольный
  // pressSequentially на медленном IG-инпуте ПЕРЕМЕШИВАЛ буквы (курсор сбрасывался между нажатиями) — длинный
  // брендовый коммент уходил кашей и IG его отклонял. Проверяем, что легло верно; иначе ретрай/медленный ввод.
  let typed = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    await box.fill('').catch(() => {});
    if (attempt < 2) await box.fill(text).catch(() => {});
    else { await box.click({ timeout: 4000 }).catch(() => {}); await box.pressSequentially(text, { delay: randInt(120, 190) }).catch(() => {}); }
    await page.waitForTimeout(randInt(200, 450));
    typed = (await box.inputValue().catch(() => box.innerText().catch(() => ''))).trim();
    if (typed === text.trim() || typed.includes(text.trim())) break; // текст лёг корректно
    console.warn(`[reply] ввод неточный (попытка ${attempt + 1}): "${typed.slice(0, 25)}" ≠ "${text.slice(0, 25)}"`);
  }
  if (!typed || typed.trim().length < 3) return false; // текст не попал в поле
  await page.waitForTimeout(randInt(400, 900));
  // ОТПРАВКА: Enter в поле — надёжно на ЛЮБОМ языке. (Кнопка «Paylaş» в турецком = «Поделиться», не
  // отправка коммента — клик по ней ничего не слал!) Кнопка публикации — только фолбэк, если Enter не сработал.
  await box.press('Enter').catch(() => {});
  // ПОЛЛИМ очистку поля до ~4с. Enter отправляет АСИНХРОННО — поле очищается не сразу. Раньше проверяли
  // один раз и жали фолбэк-кнопку, пока Enter ещё «летел» → коммент уходил ДВАЖДЫ. Ждём, пока очистится.
  let leftover = '';
  for (let k = 0; k < 5; k++) {
    await page.waitForTimeout(randInt(700, 1000));
    leftover = await box.inputValue().catch(() => box.innerText().catch(() => ''));
    if (!leftover || leftover.trim().length < 3) break; // Enter сработал — поле пустое, фолбэк НЕ нужен
  }
  if (leftover && leftover.trim().length >= 3) {
    // Enter не сработал за ~4с — ТОЛЬКО теперь фолбэк-кнопка (структурно, в той же форме).
    const form = box.locator('xpath=ancestor::form[1]');
    const btn = form.locator('button[type="submit"], div[role="button"]').last();
    if (await btn.count().catch(() => 0)) await btn.click({ timeout: 3000 }).catch(() => {});
    else await clickFirst(page, w.selectors.commentSubmit ?? []);
    await page.waitForTimeout(randInt(1500, 2300));
    leftover = await box.inputValue().catch(() => box.innerText().catch(() => ''));
  }
  const cleared = !leftover || leftover.trim().length < 3;
  if (!cleared) return false; // текст остался в поле — точно не ушло
  if (!verifyAppear) return true; // вложенный ответ: свёрнут IG, на странице не виден — очистка = успех
  // ЧЕСТНАЯ проверка: поле очистилось — подтверждаем, что коммент РЕАЛЬНО появился на странице
  // (IG мог тихо отклонить/зафильтровать промо, особенно на креаторских постах).
  const probe = probeOf(text);
  if (probe.length < 6) return true; // нечего надёжно проверить — доверяем очистке
  // Коммент рендерится не мгновенно — пробуем найти его на странице до ~5с, прежде чем признать провал.
  // ВАЖНО: текст страницы нормализуем ТАК ЖЕ, как пробу (убираем эмодзи/пунктуацию, схлопываем пробелы) —
  // иначе «все работает топ 🔥 делал» на странице не совпадёт с пробой «все работает топ делал» из-за 🔥.
  let appeared = false;
  for (let k = 0; k < 3 && !appeared; k++) {
    await page.waitForTimeout(randInt(900, 1500));
    appeared = await page.evaluate((s) => document.body.innerText.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').includes(s), probe).catch(() => false);
  }
  if (!appeared) console.warn(`[reply] поле очистилось, но коммент НЕ появился за ~5с — IG отклонил/зафильтровал: "${probe}"`);
  return appeared;
}

// «Проба» текста — первые слова ПОДРЯД (для сверки «этот коммент уже на странице?»). ВАЖНО: НЕ выкидываем
// короткие слова («в», «и», «на») — иначе проба «все топ делал нейронке» не совпадёт с «все топ делал В
// нейронке» на странице (короткое «в» есть в тексте, но нет в пробе) → ложное «коммент не ушёл».
function probeOf(text: string): string {
  const norm = text.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  // берём столько первых слов, чтобы набрать хотя бы ~14 символов (но не меньше 4 слов) — контиг-фрагмент.
  let out: string[] = [];
  for (const w of norm) { out.push(w); if (out.length >= 4 && out.join(' ').length >= 14) break; if (out.length >= 7) break; }
  return out.join(' ');
}
// Уже есть такой коммент на странице? (идемпотентность — не дублируем при повторе/failover).
// Текст страницы нормализуем как пробу (эмодзи/пунктуация не должны ломать сравнение).
async function alreadyOnPage(page: Page, text: string): Promise<boolean> {
  const probe = probeOf(text);
  if (probe.length < 6) return false;
  return page.evaluate((s) => document.body.innerText.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').includes(s), probe).catch(() => false);
}
// Кликнуть «Ответить» ПОД НАШИМ же комментом (по пробе бренд-текста), чтобы кинуть промпт ВЕТКОЙ
// (бот отвечает сам себе). Ищем в DOM свежий свой коммент (внизу списка), поднимаемся к контейнеру,
// наводим мышь (кнопка «Ответить» часто монтируется на hover) и жмём. Всё внутри evaluate — мгновенно.
async function clickOwnReply(page: Page): Promise<boolean> {
  // Наш свежий бренд-коммент = последний с названием бренда «нейронк* про». ВАЖНО: кнопка «Ответить» у
  // свежего коммента монтируется только на РЕАЛЬНЫЙ hover — evaluate(dispatchEvent(mouseover)) её НЕ будит
  // (React слушает свои события). Поэтому наводим настоящей мышью Playwright, потом ищем «Ответить» в блоке
  // коммента (ancestor 3-6, где РОВНО одна кнопка = наш коммент, не чужой) и жмём. Проверено вживую.
  const mine = page.getByText(/нейронк\w*\s*про/i).last();
  if (!(await mine.count().catch(() => 0))) return false;
  await mine.scrollIntoViewIfNeeded().catch(() => {});
  await mine.hover().catch(() => {}); // настоящий hover — будит кнопку «Ответить»
  await page.waitForTimeout(randInt(800, 1300));
  for (let lvl = 3; lvl <= 6; lvl++) {
    const cand = mine.locator(`xpath=ancestor::*[self::li or self::div][${lvl}]`).getByText(REPLY_BTN_RX);
    if ((await cand.count().catch(() => 0)) === 1) { // одна «Ответить» в блоке = наш коммент
      await cand.first().hover().catch(() => {});
      await cand.first().click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(randInt(700, 1100));
      return true;
    }
  }
  return false;
}
// Отправить ВЕТКУ (после клика «Ответить»): поле в reply-режиме с «@ник ». КЛЮЧЕВОЕ: fill() ЗАМЕНЯЕТ
// mention-токен «@ник» на простой текст → IG теряет привязку к ветке и постит ТОП-ЛЕВЕЛОМ с @тегом (юзер
// это и видел). Поэтому НЕ чистим: ставим курсор в конец и ДОПИСЫВАЕМ текст посимвольно — токен @ника
// сохраняется, коммент уходит ВЕТКОЙ. Успех = поле очистилось.
async function submitReply(page: Page, text: string): Promise<boolean> {
  const box = page.locator('form textarea, form div[contenteditable="true"], [role="textbox"]').first();
  if (!(await box.count().catch(() => 0))) return false;
  await box.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(randInt(300, 600));
  const mention = (await box.inputValue().catch(() => box.innerText().catch(() => ''))).trim(); // «@ник»
  if (mention) {
    // reply-режим активен (@ник стоит) — дописываем ПОСЛЕ него, не трогая токен (иначе ветка слетает)
    await box.press('End').catch(() => {});
    await box.pressSequentially(' ' + text, { delay: randInt(30, 60) }).catch(() => {});
  } else {
    await box.fill(text).catch(() => {}); // @ника нет (контекст не активировался) — обычный ввод
  }
  await page.waitForTimeout(randInt(250, 450));
  const typed = (await box.inputValue().catch(() => box.innerText().catch(() => ''))).trim();
  if (!typed.includes(text.slice(0, 12))) return false; // текст не лёг
  await box.press('Enter').catch(() => {});
  let leftover = '';
  for (let k = 0; k < 5; k++) {
    await page.waitForTimeout(randInt(700, 1000));
    leftover = (await box.inputValue().catch(() => box.innerText().catch(() => ''))).trim();
    if (leftover.length < 3) break;
  }
  return leftover.length < 3;
}

// Переключить комменты на «Самые свежие» (Most recent / Newest) — свежие спрашивающие оказываются сверху,
// им и отвечаем (у них выше шанс увидеть уведомление). Best-effort, мультиязык: прямая ссылка ИЛИ дропдаун.
async function sortMostRecent(page: Page): Promise<boolean> {
  const RECENT_RX = /most recent|newest|new(est)? comments|самые новые|сначала новые|спочатку нов|en yeni|neueste|más recientes|plus récents|最新|最近/i;
  const SORT_RX = /sort by|top comments|all comments|сортиров|популярные|интересные|top yorumlar|en ilgili|beliebteste|популярні|meilleurs commentaires/i;
  const clickIf = async (rx: RegExp): Promise<boolean> => {
    const el = page.getByText(rx).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) { await el.click({ timeout: 3000 }).catch(() => {}); return true; }
    return false;
  };
  if (await clickIf(RECENT_RX)) { await page.waitForTimeout(randInt(1200, 1800)); return true; } // прямая кнопка
  if (await clickIf(SORT_RX)) { // дропдаун сортировки → открыть → выбрать «свежие»
    await page.waitForTimeout(randInt(700, 1100));
    if (await clickIf(RECENT_RX)) { await page.waitForTimeout(randInt(1200, 1800)); return true; }
  }
  return false;
}

// Довести бота ДО ПОЛЯ КОММЕНТА самого поста. Частая беда: под постом идёт секция «More posts from …»
// (ещё публикации автора) — бот скроллит в неё и «теряет» поле (оно выше). Чиним по шагам:
//  1) поле уже в DOM? ок; 2) кликаем плашку «Add a comment/Комментировать» — она САМА скроллит вверх к полю
//  и разворачивает textarea; 3) иконка комментов (реел); 4) IG показал грид — открываем ИМЕННО наш пост
//  по коду (чужой не тронем); 5) крайний случай — перезагрузка (сбрасывает скролл из «ещё публикаций»).
async function ensurePostOpen(page: Page, w: PlatformDriver['warmup'], url: string): Promise<boolean> {
  const code = (url.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1] || '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await findBox(page, w)) return true; // поле есть — мы на посте
    // плашка «Add a comment…» → scrollIntoView возвращает нас ВВЕРХ к полю, клик разворачивает ввод
    const ph = page.getByText(COMMENT_PH_RX).first();
    if (await ph.count().catch(() => 0)) {
      await ph.scrollIntoViewIfNeeded().catch(() => {});
      await ph.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(randInt(800, 1300));
      if (await findBox(page, w)) return true;
    }
    await clickFirst(page, w.selectors.commentOpen ?? []); // иконка «Комментировать» (реел)
    await page.waitForTimeout(randInt(700, 1100));
    if (await findBox(page, w)) return true;
    // грид профиля/«ещё публикации» — открываем ИМЕННО наш пост по shortcode
    if (code) {
      const thumb = page.locator(`a[href*="/${code}"]`).first();
      if (await thumb.count().catch(() => 0)) {
        await thumb.scrollIntoViewIfNeeded().catch(() => {});
        await thumb.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(randInt(1800, 2600));
        continue;
      }
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}); // крайний случай
    await page.waitForTimeout(randInt(2200, 3200));
  }
  return Boolean(await findBox(page, w));
}

export interface EngagementResult { askerReplies: number; brandPosted: boolean; promptPosted: boolean; prompt: string | null; reason?: string; qa: { u: string; q: string; a: string }[]; }

// Полный сценарий с личного акка нейронки на найденном посту:
//  1) ответить до maxAskers свежим спрашивавшим («промпт/как?») — им придёт уведомление;
//  2) вытащить из комментов чистый промпт (валидируем: без ссылок/рекламы);
//  3) свой брендовый коммент («делал в нейронка про … промпт ниже»);
//  4) ответить на СВОЙ коммент веткой с промптом (если нашли и не палит рекламу).
// Всё best-effort — что не вышло, просто не делаем; ошибки (капча/разлогин) пробрасываем.
// Атомарная БРОНЬ человека (post_code+username) перед ответом: параллельные акки не отвечают одному
// и тому же дважды, даже видя разную сортировку комментов. Правило: НИЧЕЙ — бронируем и отвечаем;
// свой (заранее назначенный, pending) — отвечаем; занят другим акком — пропускаем молча.
async function claimTarget(postCode: string, username: string, accountId: string): Promise<boolean> {
  try {
    const { rows } = await query<{ username: string }>(
      `INSERT INTO radar_reply_targets (post_code, username, assigned_account_id, status)
       VALUES ($1,$2,$3,'done')
       ON CONFLICT (post_code, username) DO UPDATE SET assigned_account_id=$3, status='done'
         WHERE radar_reply_targets.status='pending'
           AND (radar_reply_targets.assigned_account_id=$3 OR radar_reply_targets.assigned_account_id IS NULL)
       RETURNING username`, [postCode, username, accountId]);
    return rows.length > 0;
  } catch { return false; }
}

// Возраст коммента в МИНУТАХ по ближайшему <time datetime>: от кнопки «Ответить» идём вверх и в
// первом же предке с time-элементом читаем дату. null = времени рядом нет (не смогли определить).
// Нужно, чтобы отвечать СВЕЖИМ (IG в вебе НЕ даёт сортировку «сначала новые» — берём по факту даты).
async function commentAgeMin(btn: Locator): Promise<number | null> {
  return btn.evaluate((b) => {
    let el: Element | null = b as Element;
    for (let i = 0; i < 12 && el; i++) {
      const t = el.querySelector('time[datetime]');
      if (t) {
        const ms = Date.parse(t.getAttribute('datetime') || '');
        if (!Number.isNaN(ms)) return Math.max(0, Math.round((Date.now() - ms) / 60000));
      }
      el = el.parentElement;
    }
    return null;
  }).catch(() => null);
}

// Автор коммента по кнопке «Ответить»: идём вверх по предкам до блока коммента и берём первую
// профиль-ссылку (это ник автора). Пусто = не поняли, кто автор (лучше пропустить, чем задублить).
async function authorOfComment(btn: Locator): Promise<string> {
  return (await btn.evaluate((b) => {
    const SKIP = new Set(['explore', 'reels', 'reel', 'direct', 'p', 'stories', 'accounts']);
    let el: Element | null = b as Element;
    for (let i = 0; i < 8 && el; i++) {
      for (const a of Array.from(el.querySelectorAll('a[href^="/"]'))) {
        const m = (a.getAttribute('href') || '').match(/^\/([^/?]+)\/?$/);
        if (m && !SKIP.has(m[1])) return m[1].toLowerCase();
      }
      el = el.parentElement;
    }
    return '';
  }).catch(() => '')) as string;
}

export async function runRadarEngagement(
  page: Page, driver: PlatformDriver,
  opts: { url: string; askerTexts: string[]; brandBase: string; maxAskers: number; onStep?: (s: string) => void; doAskers?: boolean; doBrand?: boolean; fallbackPrompt?: string | null; brandMode?: 'prompt' | 'plain'; claim?: { postCode: string; accountId: string }; maxAgeMin?: number },
): Promise<EngagementResult> {
  const w = driver.warmup;
  const step = opts.onStep || (() => {});
  const doAskers = opts.doAskers !== false; // по умолчанию делаем обе роли (один акк — всё)
  const doBrand = opts.doBrand !== false;
  // brandMode: 'prompt' — брендовый коммент + промпт веткой; 'plain' — ТОЛЬКО брендовый коммент
  // (для креаторских постов, где промпт креатор раздаёт в лс — мы просто отмечаемся «сделали в нейронка про»).
  const brandMode = opts.brandMode || 'prompt';
  const res: EngagementResult = { askerReplies: 0, brandPosted: false, promptPosted: false, prompt: null, qa: [] };
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(randInt(1500, 2600));
  for (const s of w.selectors.captcha ?? []) {
    if (await page.locator(s).first().isVisible().catch(() => false)) throw new CaptchaError('IG: капча при ответе из радара');
  }
  if (await driver.isLoggedOut(page)) throw new SessionError('IG: сессия мертва (ответ из радара)');
  if (!(w.selectors.commentBox ?? []).length) return res;
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); // в начало — поле коммента там (реел/пост)
  // Гарантируем, что открыт САМ пост (а не грид профиля — IG так делает при переходе на /p/CODE).
  if (!(await ensurePostOpen(page, w, opts.url))) {
    res.reason = 'не нашёл поле коммента (капча/чек-поинт/приватный/удалён?)';
    console.warn(`[reply] ${res.reason}: ${opts.url} | текущий url=${page.url()}`);
    return res; // поля коммента нет — честно ничего не постим
  }

  // Промпт (только для brandMode='prompt'): готовый из комментов ИЛИ наш сгенерённый. ВАЛИДИРУЕМ —
  // мусор/обрезки не постим (юзер видел «…outfit stan» в ленте).
  if (brandMode === 'prompt') {
    const artText = await page.evaluate(() => ((document.querySelector('main') as HTMLElement | null) || document.body)?.innerText || '').catch(() => '');
    let best = '';
    for (const l of artText.split('\n').map((x) => x.trim())) if (looksLikePrompt(l) && l.length > best.length) best = l;
    const fb = String(opts.fallbackPrompt || '').trim();
    res.prompt = best || (fb.length >= 15 ? fb : null);
  }

  // 1) БРЕНДОВЫЙ КОММЕНТ — первым. ИДЕМПОТЕНТНО: если наш коммент уже на странице (повторный
  //    запуск / failover / двойной клик «Отправить») — НЕ дублируем, считаем поставленным.
  if (doBrand) {
    // СТАРАЯ СТРАТЕГИЯ «промпт веткой под свой коммент» (бот отвечал сам себе) УДАЛЕНА по решению владельца
    // 2026-07-21: бренд = строго ОДИН топ-левел коммент с акка, без ответа самому себе, без текста промпта.
    const brandText = opts.brandBase;
    if (await alreadyOnPage(page, opts.brandBase)) {
      step('брендовый уже стоит — не дублирую');
      res.brandPosted = true;
    } else {
      step('пишу брендовый коммент…');
      res.brandPosted = await submitInBox(page, w, brandText);
    }
  }

  // 3) ОТВЕТЫ СПРАШИВАВШИМ — после бренда, можно скроллить (бренд уже стоит).
  if (doAskers && opts.maxAskers > 0) {
    step(`отвечаю спрашивавшим (до ${opts.maxAskers})…`);
    const sorted = await sortMostRecent(page); // свежие спрашивающие сверху — им и отвечаем (если контрол есть)
    console.log(`[reply] сортировка «самые свежие»: ${sorted ? 'включил' : 'контрола нет (оставил как есть)'}`);
    // Подгружаем БОЛЬШЕ комментов: комменты на IG живут в ОТДЕЛЬНОМ скролл-контейнере панели (не window!),
    // поэтому window.scrollBy их не подгружал — бот видел мало кнопок и не доходил до свежих «Промт».
    // Находим контейнер комментов по overflow (предок reply-кнопки) и скроллим ИМЕННО его, до 8 раз.
    const scrollComments = (): Promise<boolean> => page.evaluate(() => {
      const rrx = /^(Ответить|Reply|Antworten|Yanıtla|Cevapla|Responder|Répondre|Rispondi)$/i;
      const btn = Array.from(document.querySelectorAll('div[role="button"], button, a, span'))
        .find((e) => rrx.test((e.textContent || '').trim()));
      let el: Element | null = btn || null;
      while (el && el.parentElement) {
        const s = getComputedStyle(el as Element);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 40) {
          (el as HTMLElement).scrollTop += 900; return true; // проскроллили контейнер комментов
        }
        el = el.parentElement;
      }
      window.scrollBy(0, 900); return false; // фолбэк — обычный скролл
    }).catch(() => false);
    // Дежурство (maxAgeMin задан): грузим ГЛУБЖЕ (свежие комменты у IG часто не в топе — надо докрутить,
    // чтобы они попали в выборку, из которой берём <2ч). Обычные радар-ответы — как раньше (8).
    const scrollRounds = opts.maxAgeMin != null ? 16 : 8;
    for (let i = 0; i < scrollRounds; i++) {
      const atMorePosts = await page.evaluate(() => {
        const rx = /^(more posts from|ещё публикации|другие публикации|weitere beiträge|daha fazla gönderi)/i;
        const el = Array.from(document.querySelectorAll('span, div, h1, h2, h3'))
          .find((e) => rx.test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 60);
        return el ? el.getBoundingClientRect().top < window.innerHeight : false;
      }).catch(() => false);
      if (atMorePosts) break;
      await scrollComments();
      await page.waitForTimeout(randInt(600, 900));
    }
    const replyBtn = page.getByText(REPLY_BTN_RX);
    const n = Math.min(await replyBtn.count().catch(() => 0), opts.maxAgeMin != null ? 70 : 40); // дежурство сканит глубже
    let matched = 0;
    const said = new Set<string>(); // не отвечаем ДВАЖДЫ одинаковым текстом (юзер видел «2 одинаковых»)
    // Ответ на конкретный коммент: клик «Ответить» → генерим ПОД его текст → валидируем (не дубль, не бренд).
    const replyToBtn = async (btn: Locator, rawText: string, uname = ''): Promise<boolean> => {
      if (!(await btn.isVisible().catch(() => false))) return false;
      let text = '';
      try { text = await generateContextualReply(rawText); } catch { /* noop */ }
      if (!text || text.trim().length < 8) text = opts.askerTexts[res.askerReplies % Math.max(1, opts.askerTexts.length)] || '';
      text = text.trim();
      const key = probeOf(text);
      if (!text || text.length < 8 || said.has(key) || probeOf(opts.brandBase) === key) return false; // невалидно/дубль
      said.add(key); // дедуп на ПОПЫТКЕ, не на успехе — один текст не постим дважды даже при ложном «не ушло»
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(randInt(500, 900));
      // ВЕТКОЙ под коммент человека: submitReply сохраняет «@ник» (якорь ветки) и не скроллит/не чистит —
      // иначе ответ слетал бы в топ-левел. IG сворачивает ветку, строгую проверку появления не делаем.
      if (await submitReply(page, text)) {
        res.askerReplies++;
        // Пара «вопрос → наш ответ» для отчёта в ТГ (владелец видит, кому и что написали).
        res.qa.push({ u: uname, q: rawText.replace(ACTION_RX, ' ').replace(/\s+/g, ' ').trim().slice(0, 150), a: text.slice(0, 200) });
        step(`ответил ${res.askerReplies} чел…`);
        return true;
      }
      return false;
    };
    // Отвечаем ТОЛЬКО живым людям с РЕАЛЬНЫМ вопросом («как/где/чем/какая нейросеть/промпт?»).
    // НЕ отвечаем на триггер-слова («фон», «промт», «+»), которыми люди просят креатора скинуть промпт
    // в лс — это не вопрос к нам, и 6 комментов в пустоту не нужны. Свои комменты узнаём по «нейронк* про».
    const OWN_RX = /нейронк\w*\s*про|neironka/i;
    // НАШ ник — чтобы бот НЕ отвечал сам себе (@свой_ник) и не лез в ответы, адресованные нам. Берём из автора
    // нашего же бренд-коммента (ссылка на профиль перед текстом «нейронк про»).
    const ownUser = (await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('span, div')).filter((e) => /нейронк\w*\s*про/i.test(e.textContent || '') && (e.textContent || '').length < 250);
      const node = nodes[nodes.length - 1];
      let el: Element | null = node || null;
      for (let i = 0; i < 8 && el && el.parentElement; i++) {
        el = el.parentElement;
        const a = (el as Element).querySelector('a[href^="/"]');
        const m = a ? (a.getAttribute('href') || '').match(/^\/([^/]+)\/?$/) : null;
        if (m && !['explore', 'reels', 'reel', 'direct', 'p', 'stories'].includes(m[1])) return m[1];
      }
      return '';
    }).catch(() => '')).toLowerCase();
    if (ownUser) console.log(`[reply] наш ник: @${ownUser} — себе отвечать не будем`);
    // ФИЛЬТР СВЕЖЕСТИ: отвечаем только комментам не старше maxAgeMin (дежурство: 2ч). IG в вебе НЕ даёт
    // «сначала новые», поэтому судим по <time>. Защита: если у поста нет коммент-таймстемпов (только дата
    // поста ≤3 <time>) — фильтр НЕ включаем (иначе ответили бы никому). Так же это даёт КАТЧ-АП после сбоя:
    // восстановились → ответили всем, кто спросил за последние maxAgeMin.
    const useAge = opts.maxAgeMin != null
      && (await page.locator('time[datetime]').count().catch(() => 0)) > 3;
    if (opts.maxAgeMin != null && !useAge) console.warn('[reply] таймстемпы комментов не читаются — отвечаю без фильтра свежести');
    let skippedTrigger = 0, skippedOld = 0;
    for (let i = 0; i < n && res.askerReplies < opts.maxAskers; i++) {
      const btn = replyBtn.nth(i);
      // Текст коммента над кнопкой «Ответить». Предок [2] часто = СТРОКА ДЕЙСТВИЙ («Ответить · перевод ·
      // нравится») БЕЗ текста коммента, а сам коммент — на [3]. Поэтому берём уровень с МАКСИМУМОМ текста
      // ПОСЛЕ вырезания слов-действий (это и есть коммент человека). Раньше брали первый в диапазоне → ловили
      // строку кнопок и пропускали «Промт» → «1 вопрос из 40».
      let rawText = ''; let bestClean = 0;
      for (const lvl of [2, 3, 4]) {
        const t = (await btn.locator(`xpath=ancestor::*[self::li or self::div][${lvl}]`).first().innerText().catch(() => '')).trim();
        if (!t || t.length > 500) continue; // слишком большой = несколько комментов, мимо
        const clean = t.replace(ACTION_RX, ' ').replace(/\s+/g, ' ').trim(); // убираем «Ответить/Beğen/перевод…»
        if (clean.length > bestClean) { bestClean = clean.length; rawText = t; }
      }
      const ct = rawText.toLowerCase();
      if (AD_RX.test(ct) || OWN_RX.test(ct)) continue; // реклама/офтоп/наши же комменты — мимо
      if (ownUser && ct.includes('@' + ownUser)) continue; // ответ, адресованный НАМ (@наш_ник) — не лезем
      if (ownUser && ct.startsWith(ownUser + ' ')) continue; // коммент ОТ нас (автор = наш ник) — не отвечаем себе
      if (!DEMAND_RX.test(ct)) { skippedTrigger++; continue; } // не вопрос (триггер к креатору) — НЕ отвечаем
      // СВЕЖЕСТЬ: старые комменты (напр. месяц назад) НЕ трогаем — отвечаем только тем, кто спросил недавно.
      if (useAge) {
        const ageMin = await commentAgeMin(btn);
        if (ageMin == null || ageMin > opts.maxAgeMin!) { skippedOld++; continue; }
      }
      matched++;
      // БРОНЬ перед ответом (мульти-акк/дежурство): не поняли автора или он уже занят/отвечен — мимо.
      let uname = '';
      if (opts.claim) {
        uname = await authorOfComment(btn);
        if (!uname) { console.log('[reply] бронь: не определил автора коммента — пропускаю (без риска дубля)'); continue; }
        if (!(await claimTarget(opts.claim.postCode, uname, opts.claim.accountId))) continue; // занят другим акком / уже отвечен
      }
      await replyToBtn(btn, rawText, uname);
    }
    console.log(`[reply] спрашивавшие: кнопок «Ответить» ${n}, реальных вопросов ${matched}, не-вопросов пропущено ${skippedTrigger}, старых (>${opts.maxAgeMin ?? '∞'}м) пропущено ${skippedOld}, ответил ${res.askerReplies}`);
  }
  // Точная причина, если НИЧЕГО не поставили: поле было (мы прошли ensurePostOpen), значит коммент
  // не ушёл — IG отклонил/чек-поинт/фильтр. (Если поля не было — reason уже стоит из ensurePostOpen.)
  if (!res.brandPosted && res.askerReplies === 0 && !res.reason) {
    const boxNow = await findBox(page, w);
    res.reason = boxNow
      ? 'поле есть, но коммент НЕ ушёл (IG отклонил/чек-поинт/шэдоу-фильтр акка?)'
      : 'поле коммента не найдено (капча/приватный/удалён?)';
    console.warn(`[reply] итог-провал: ${res.reason} | ${opts.url}`);
  }
  return res;
}

// Ответ из радара: открыть КОНКРЕТНЫЙ пост (по URL) и оставить ОДИН коммент.
// Пишется с личного акка нейронки — текст уже согласован юзером в панели.
export async function postCommentOnUrl(page: Page, driver: PlatformDriver, url: string, text: string): Promise<boolean> {
  const w = driver.warmup;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(randInt(2500, 4500));
  for (const s of w.selectors.captcha ?? []) {
    if (await page.locator(s).first().isVisible().catch(() => false)) throw new CaptchaError('IG: капча при ответе из радара');
  }
  if (await driver.isLoggedOut(page)) throw new SessionError('IG: сессия мертва (ответ из радара)');
  const box = (w.selectors.commentBox ?? [])[0];
  if (!box) return false;
  // Поле коммента иногда скрыто — если сразу не набралось, жмём «Комментировать» и повторяем.
  let ok = await humanType(page, box, text);
  if (!ok) {
    await clickFirst(page, w.selectors.commentOpen ?? []);
    await page.waitForTimeout(randInt(800, 1500));
    ok = await humanType(page, box, text);
  }
  if (!ok) return false;
  await page.waitForTimeout(randInt(500, 1200));
  await clickFirst(page, w.selectors.commentSubmit ?? []);
  await page.waitForTimeout(randInt(1500, 3000));
  return true;
}

// Один промо-коммент под чужим постом по случайному хэштегу из ниши.
export async function runSeedSession(
  page: Page,
  driver: PlatformDriver,
  account: { id: string },
  cfg: SeedConfig,
): Promise<SeedResult> {
  const w = driver.warmup;
  const tag = (cfg.hashtags[Math.floor(Math.random() * cfg.hashtags.length)] || '')
    .trim().replace(/^#/, '').replace(/\s+/g, '');
  if (!tag) return { posted: false };

  // Instagram: страница хэштега. (Для других площадок — свой feedUrl/поиск.)
  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(randInt(2500, 5000));

  for (const s of w.selectors.captcha ?? []) {
    if (await page.locator(s).first().isVisible().catch(() => false)) throw new CaptchaError('IG: капча в комментинге');
  }
  if (await driver.isLoggedOut(page)) throw new SessionError('IG: сессия мертва (комментинг)');

  // Открыть один из недавних постов (случайный из первых видимых).
  let opened = false;
  for (const s of w.selectors.postThumb ?? []) {
    const links = page.locator(s);
    const n = await links.count().catch(() => 0);
    if (n > 0) { await links.nth(randInt(0, Math.min(n - 1, 8))).click({ timeout: 5000 }).catch(() => {}); opened = true; break; }
  }
  if (!opened) return { posted: false };
  await page.waitForTimeout(randInt(2000, 4000));

  // Прочитать контекст поста -> сгенерить нативный коммент.
  const ctx = await page.locator((w.selectors.commentContext?.[0]) ?? 'body').first().innerText().catch(() => '');
  const text = await generateSeedComment(ctx, cfg.role || 'mention');

  // Написать и отправить.
  const box = (w.selectors.commentBox ?? [])[0];
  if (!box || !(await humanType(page, box, text))) return { posted: false };
  await page.waitForTimeout(randInt(500, 1200));
  await clickFirst(page, w.selectors.commentSubmit ?? []);
  await page.waitForTimeout(randInt(1500, 3000));

  const postUrl = page.url();
  await query(
    `INSERT INTO seed_comments (account_id, platform, target_url, text) VALUES ($1,$2,$3,$4)`,
    [account.id, driver.platform, postUrl, text],
  ).catch(() => {});
  return { posted: true, url: postUrl, text };
}
