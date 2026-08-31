import type { Page } from 'playwright-core';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { connect, disconnect, lockKey, setProfileProxy, parseProxy, type Session } from './gologin.js';
import { withBrowserLock } from './lock.js';
import { query, logError } from './db/index.js';
import { notifyOwner, notifyWithButtons } from './notify.js';
import { totpCode } from './totp.js';
import { visionAct } from './ai.js';
import { dismissAll, feedVisible, hasDialog } from './igdialogs.js';

// Браузерный радар: заходим искателем через GoLogin, ищем по КЛЮЧЕВЫМ ФРАЗАМ (как в поиске IG),
// читаем посты (картинка + подпись + спрос «как/чем/где сделал» в комментах) и кладём в панель.
// Комментит человек сам. 1 профиль за раз — через общий browser-lock (тариф GoLogin).

const DEMAND = ['как ты', 'как это', 'как сдела', 'чем сдела', 'чем дела', 'где сдела', 'в чём', 'в чем',
  'какая нейрос', 'какой нейрос', 'что за прил', 'какое прил', 'что за прог', 'промт', 'промпт',
  'подскаж', 'скинь', 'какое приложение', 'что использ', 'в какой', 'ссылк',
  // БОЛЬ ДОСТУПА — прямая ЦА нейронки (без впн, картой рф, все модели в одном окне):
  'впн', 'vpn', 'платн', 'бесплатн', 'регистрир', 'регистрац', 'не получ', 'не работает', 'не открыва',
  'не могу сгенер', 'не может сгенер', 'не генер', 'как зайти', 'как скачать', 'дай текст', 'скинь текст',
  'можно текст', 'можно промт', 'дай промт', 'gemini', 'gimini', 'джемини', 'chatgpt', 'чат гпт',
  // спрос под ТРЕНДОВЫМИ постами («сквозь пальцы», «бьюти-гайд»): просят повторить/объяснить тренд
  'как повторить', 'что за тренд', 'какой фильтр', 'что за фильтр', 'как обработ', 'хочу так', 'хочу такое'];
const CAP = ['нейросет', 'нейронк', 'промпт', 'промт', 'сгенер', 'нейро', 'midjourney', 'kling', 'veo',
  'chatgpt', 'оживил', 'ai ', '#ai', 'ии '];

// === РАБОЧИЕ ТРЕНДЫ === радар ищет ПО НИМ (наши 2 залетевших формата), общие фразы из панели — фолбэк.
// name — метка в панели (колонка tag; обучение оценками работает по ней же). phrases — что вбиваем в
// поиск IG. match — слова в подписи, подтверждающие что пост ИМЕННО этого тренда (буст скоринга).
// Новый тренд = добавить объект сюда.
export interface Trend { name: string; phrases: string[]; match: string[] }
export const TRENDS: Trend[] = [
  {
    // Ч/б портрет «глаз сквозь пальцы» (peace sign у лица), генерят в Nano Banana — в комментах просят промт.
    name: 'тренд: сквозь пальцы',
    phrases: ['взгляд сквозь пальцы', 'сквозь пальцы тренд', 'фото сквозь пальцы нейросеть',
      'сквозь пальцы промт'],
    match: ['сквозь пальцы', 'через пальцы', 'скозь пальцы', 'peace sign', 'finger', 'пальц'],
  },
  {
    // «Бьюти-гайд по фото»: ИИ по твоему фото делает разбор-коллаж (стрижка, цвет волос, брови, макияж).
    name: 'тренд: бьюти-гайд',
    phrases: ['бьюти гайд по фото', 'бьюти гайд нейросеть', 'бьюти гайд 2026',
      'разбор внешности нейросеть', 'подбор стрижки по фото нейросеть'],
    match: ['бьюти гайд', 'бьюти-гайд', 'beauty guide', 'разбор внешн', 'подбор стрижк', 'подбор цвета волос',
      'гайд по внешности', 'идеальный образ', 'бьюти разбор'],
  },
];

// Возвращает true ТОЛЬКО если клик реально прошёл. Раньше true отдавался по одной ВИДИМОСТИ, а сам
// click был обёрнут в .catch(()=>{}) — перехваченный оверлеем/протухший по таймауту клик был неотличим
// от успешного, и вызывающие (ввод 2FA, сабмит) не делали Enter-фолбэк, считая что кнопка нажата.
async function clickAny(page: Page, rx: RegExp): Promise<boolean> {
  for (const loc of [page.getByRole('button', { name: rx }), page.locator('div[role="button"]').filter({ hasText: rx }), page.locator('button').filter({ hasText: rx })]) {
    if (!(await loc.first().isVisible().catch(() => false))) continue;
    try { await loc.first().click({ timeout: 4000 }); return true; } catch { /* перехвачен/не кликнулся — пробуем следующий локатор */ }
  }
  return false;
}

// Вход искателя: открыть IG, дожать «продолжить как аккаунт» (пароль сохранён в профиле GoLogin),
// закрыть попап уведомлений. Возвращает true, если видим ленту/поиск.
// ШИРОКИЙ признак «залогинен в IG» — язык-независимо, по URL-ссылкам навигации + иконкам ленты/профиля.
// Узкий набор давал ложные «не вошёл» (лента ещё не дорисовалась / промежуточный экран «Сохранить вход»).
// ТОЛЬКО login-gated элементы (есть исключительно у залогиненного). Логотип a[href="/"] и т.п. НЕ включаем —
// он есть и на разлогиненной странице → давал ложный «залогинен». Финальный вердикт всё равно требует ОТСУТСТВИЯ формы логина.
export const IG_HOME_SEL = [
  'a[href="/explore/"]', 'a[href^="/direct/"]', 'a[href="/reels/"]',
  'svg[aria-label="Home"]', 'svg[aria-label*="Главная" i]', 'svg[aria-label*="Ana Sayfa" i]',
  'svg[aria-label*="New post" i]', 'svg[aria-label*="Создать" i]', '[aria-label="New post"]',
  'nav img[alt*="profile photo" i]', 'img[alt*="фото профиля" i]',
  'a[href="/explore/"] svg', 'svg[aria-label*="Direct" i]', 'svg[aria-label*="Messenger" i]',
].join(', ');
const IG_LOGIN_SEL = 'input[type="password"], input[name="username"]';
// Закрыть все промежуточные экраны, что прячут ленту сразу после входа.
// Meta ads-consent (ЕС/UK): «continue using our Products for free with ads?» — блокирует ленту ПОСЛЕ входа.
// Выбираем бесплатный вариант (дефолт) и жмём Continue. Юзер разрешил проходить (ферма, подписку не берём).
export async function isAdConsentScreen(page: Page): Promise<boolean> {
  const t = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
  return /free with ads|subscribe to use without ads|without ads, from|use for free|бесплатно с рекламой|без рекламы, от/i.test(t);
}
async function passAdConsent(page: Page): Promise<void> {
  if (!(await isAdConsentScreen(page))) return;
  await clickAny(page, /Use for free with ads|Continue with ads|Бесплатно с рекламой|Продолжить с рекламой/i).catch(() => {});
  await page.waitForTimeout(500);
  await clickAny(page, /^Continue$|Continue|Продолжить|Далее|Weiter|Devam|Continuar|Continuer/i).catch(() => {});
  await page.waitForTimeout(1800);
}
// «Строй» всплывашек. ПЕРЕПИСАНО на igdialogs.dismissAll — старая версия имела два опасных бага:
//  1) 'Turn on|Включить|Aç' стояли в ОДНОЙ альтернации с 'Not now' → clickAny брал .first() по DOM-порядку
//     и мог ВКЛЮЧИТЬ уведомления вместо отказа; там же 'Save info|Сохранить' мог СОХРАНИТЬ вход.
//  2) куки-баннер тут не обрабатывался вовсе → на пути ensureLoggedIn он оставался висеть поверх ленты.
// Теперь: приоритетный порядок (куки-отказ → «не сейчас») + структурный фолбэк по последней кнопке модалки.
export async function dismissIgInterstitials(page: Page): Promise<string[]> {
  await passAdConsent(page);
  return await dismissAll(page);
}

export async function ensureLoggedIn(page: Page): Promise<boolean> {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // Залогинен = ЕСТЬ лента-иконки И НЕТ формы логина. Требование «нет формы» ключевое: на разлогиненной
  // странице бывают элементы, похожие на ленту → без этой проверки давали ложный «залогинен».
  const isIn = async () => {
    const need = await page.locator(IG_LOGIN_SEL).first().isVisible().catch(() => false);
    if (need) return false;                              // видна форма логина = точно НЕ вошли (кука могла протухнуть)
    if (await hasIgSession(page)) return true;           // кука sessionid + нет формы = вошли (даже если сверху интерстишел)
    return await page.locator(IG_HOME_SEL).first().isVisible().catch(() => false);
  };
  // РЕТРАЙ ~8с: лента рисуется не мгновенно + бывает 1-2 промежуточных экрана «Сохранить вход» — закрываем.
  for (let i = 0; i < 5; i++) {
    if (await isIn()) return true;
    await dismissIgInterstitials(page);
    if (await isIn()) return true;
    await page.waitForTimeout(1600);
  }
  return await isIn();
}

// === Классификация экрана после ПРОВАЛА входа ===
// Проблема: ensureLoggedIn отдаёт голый false, и алерты писали «разлогинен» на ЛЮБОЙ экран — включая
// чек-поинт подтверждения номера (так «умер» Ismael99944, а алерт врал «разлогинен» → релогин-долбёж).
// Классифицируем ЧТО на экране, НЕ трогая страницу (никаких goto — не жжём акк лишними заходами).
// Порядок проверок важен: суспенд > вериф номера > прочий чек-поинт > логин-форма.
export interface IgScreenInfo { kind: 'suspended' | 'captcha' | 'challenge_phone' | 'challenge' | 'login' | 'rate_limited' | 'unknown'; label: string; note: string }
export async function classifyIgScreen(page: Page): Promise<IgScreenInfo> {
  const url = page.url();
  const body = await page.evaluate(() => (document.body.innerText || '').slice(0, 4000)).catch(() => '');
  const t = body.toLowerCase();
  const note = (body.replace(/\s+/g, ' ').trim().slice(0, 140) + ` [${url.replace('https://www.instagram.com', '')}]`).trim();
  // СУДИМ ТОЛЬКО ЭКРАН INSTAGRAM (07.08). Ниже стоят текстовые регексы, и слово «suspend» в них
  // ловится подстрокой. Заглушка провайдера прокси или хостинга «Account suspended» проходила как
  // СУСПЕНД аккаунта, а это ig_status='suspended' + status='paused', то есть прямая дорога под
  // автоснос вместе с профилем GoLogin. Не наш домен = экран не опознан, вердикта нет.
  if (url && !/^https?:\/\/([a-z0-9-]+\.)*instagram\.com/i.test(url))
    return { kind: 'unknown', label: `экран не Instagram (${url.slice(0, 60)}) — вердикт не выношу`, note };
  // ПУСТАЯ СТРАНИЦА ЭТО НЕ ВЕРДИКТ. Пустой body значит evaluate не отработал или страница не
  // догрузилась, и дальше все регексы честно не сматчатся, а функция вернёт 'unknown'. Пишем это явно,
  // чтобы вызывающие видели причину, а не думали, будто мы посмотрели и ничего не нашли.
  if (!body.trim()) return { kind: 'unknown', label: 'страница пустая (не догрузилась) — вердикт не выношу', note };
  // РЕЙТ-ЛИМИТ ОТДЕЛЬНО ОТ БАНА: «подождите несколько минут» это про частоту НАШИХ заходов, акк цел.
  // Раньше такой экран доезжал до 'unknown', а вызывающий писал session_status='dead'.
  if (/попробуйте позже|try again later|wait a few minutes|подождите несколько минут|too many requests|слишком много попыток/i.test(t))
    return { kind: 'rate_limited', label: 'РЕЙТ-ЛИМИТ («попробуйте позже») — про частоту заходов, не про акк', note };
  // URL /accounts/suspended/ — приговор, что бы ни было написано в теле. Ловим ДО текстовых проверок:
  // на этой странице IG часто рисует «Confirm you're human», и раньше это классифицировалось как
  // обычный challenge → акк висел в «нужен ручной вход», хотя вход невозможен в принципе.
  if (/\/accounts\/suspended/i.test(url)) return { kind: 'suspended', label: 'СУСПЕНД (страница /accounts/suspended)', note };
  // Капча «подтвердите, что вы человек» = акк спалён. Капчи мы НЕ решаем (запрещено и бесполезно) —
  // помечаем терминально, чтобы авто-замена снесла и подняла замену из очереди.
  if (/confirm you'?re human|are you a human|подтвердите,? что вы человек|подтвердите что вы человек|докажите, что вы не робот/i.test(t))
    return { kind: 'captcha', label: 'КАПЧА «подтвердите, что вы человек» — акк спалён', note };
  if (/suspend|suspensa|suspendi|приостановлен|disabled your account|account (has been )?disabled|деактивирован|нарушил|foi desativ/i.test(t))
    return { kind: 'suspended', label: 'СУСПЕНД/бан', note };
  // Вериф номера: текст «подтверди/добавь номер телефона» ИЛИ видимое поле ввода телефона.
  const phoneText = /confirm your (mobile |phone )?number|add (your )?(mobile |phone )?(phone )?number|enter (your )?(mobile |phone )?number|phone number to get back|подтверд\w* (свой )?номер|введите (свой )?номер|добав\w* номер|номер (мобильного )?телефона|мобильн\w* номер/i.test(t);
  const phoneField = await page.locator('input[type="tel"], input[name="phone_number"], input[autocomplete="tel"]').first().isVisible().catch(() => false);
  if (phoneText || phoneField) return { kind: 'challenge_phone', label: 'чек-поинт: ВЕРИФ НОМЕРА телефона', note };
  if (/challenge|checkpoint|auth_platform/i.test(url)
    || /confirm it'?s you|help us confirm|unusual (login|activity)|suspicious|подозрительн|подтвердите, что это вы|enter the code|введите код|verification code|код подтвержд|we (suspect|detected) automated/i.test(t))
    return { kind: 'challenge', label: 'чек-поинт (challenge)', note };
  const loginForm = await page.locator(IG_LOGIN_SEL).first().isVisible().catch(() => false);
  if (loginForm || /log in|войти|log into instagram|phone number, username|телефон, имя пользователя/i.test(t))
    return { kind: 'login', label: 'разлогинен (логин-форма)', note };
  return { kind: 'unknown', label: 'неопознанный экран', note };
}

// ИСХОДЫ ВХОДА. Два последних — НЕ вердикт об аккаунте, а «попытка не состоялась» (07.08):
//   'rate_limited' — IG сказал «попробуйте позже»: это про ЧАСТОТУ наших заходов, акк цел;
//   'error'        — исключение внутри входа (упал прокси, оборвался CDP, таймаут навигации):
//                    возвращается ТОЛЬКО из catch, то есть это всегда наша инфраструктура.
// Вызывающим: по этим двум статус аккаунта НЕ менять и login_fails НЕ увеличивать, просто отступить.
// Зачем правило: «попробуйте позже» лежал в одном регексе с суспендом и давал ig_status='challenge'
// + status='paused', а автозамена сносит именно такие акки вместе с профилем GoLogin. То есть
// рейт-лимит Instagram приводил к безвозвратной потере живого аккаунта.
export type LoginResult = 'ok' | 'need_login' | 'challenge' | 'captcha' | 'bad_creds' | 'error' | 'rate_limited';

// === Авто-прохождение email-челленджа Instagram (фича «фарм не теряется») ===
// IG на входе с нового устройства часто требует код, отправленный НА ПОЧТУ акка. Раньше это был тупик
// (return 'challenge' → акк мёртв, руками). Теперь: читаем код из почты (imapcode.cjs) и вводим сами.
// Работает ТОЛЬКО если у акка сохранены ig_email + ig_email_password. Любой сбой → 'challenge' (как раньше).

export interface LoginCreds { login: string; password: string; totpSecret?: string | null; email?: string | null; emailPassword?: string | null; }

// Читает свежий 6-значный IG-код с почты акка (боевой imapcode.cjs, только чтение). Ретраит ~90с:
// письмо с кодом приходит не мгновенно. sinceMs отсекает старые (вчерашние) коды.
async function fetchEmailCode(email: string, pass: string, sinceMs: number): Promise<string | null> {
  const runOnce = () => new Promise<string | null>((resolve) => {
    execFile('node', [join(process.cwd(), 'imapcode.cjs'), email, pass, '', String(sinceMs)], { timeout: 25_000 }, (_e, stdout) => {
      try { const j = JSON.parse((String(stdout).match(/\{[\s\S]*\}/) || ['{}'])[0]); resolve(j.ok && j.code ? String(j.code) : null); }
      catch { resolve(null); }
    });
  });
  for (let i = 0; i < 8; i++) {
    const code = await runOnce();
    if (code) { console.log(`[email-chal] ${email}: код получен с почты`); return code; }
    await new Promise((r) => setTimeout(r, 11_000));
  }
  console.log(`[email-chal] ${email}: код с почты не пришёл за ~90с`);
  return null;
}

// Проходит экран email/SMS-подтверждения: (при необходимости выбираем e-mail и жмём «отправить код»),
// тянем код с почты, вводим, сабмитим, проверяем ленту. 'ok' — вошли; иначе 'challenge' (ручной путь).
async function solveEmailChallenge(page: Page, creds: LoginCreds): Promise<LoginResult> {
  if (!creds.email || !creds.emailPassword) return 'challenge';
  try {
    console.log(`[email-chal] ${creds.login}: пробую авто-подтверждение по почте ${creds.email}`);
    const homeSel = IG_HOME_SEL;
    const codeSel = 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="код" i], input[aria-label*="code" i], input[inputmode="numeric"]';
    const sinceMs = Date.now() - 240_000; // код от этой попытки входа (кулдаун входа ~1ч → вчерашние коды не спутаем)

    // Экран выбора способа: предпочитаем e-mail (не SMS).
    await clickAny(page, /e-?mail|по (эл\.?\s?)?почт|электронн/i);
    await page.waitForTimeout(700);
    // Код ещё не запрошен — жмём «отправить/продолжить/это я».
    if (!(await page.locator(codeSel).first().isVisible().catch(() => false))) {
      await clickAny(page, /Send( security)? code|Отправить( код)?|Continue|Продолжить|Confirm|Подтверд|This was me|Это я|Weiter|Next|Далее/i);
      await page.waitForTimeout(2500);
    }
    // Поле ввода кода: явные селекторы -> первый текстбокс.
    let cf = page.locator(codeSel).first();
    if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
    if (!(await cf.isVisible().catch(() => false))) { console.log(`[email-chal] ${creds.login}: поле кода не найдено`); return 'challenge'; }

    const code = await fetchEmailCode(creds.email, creds.emailPassword, sinceMs);
    if (!code) return 'challenge';
    await cf.click().catch(() => {});
    await cf.fill(code).catch(() => {});
    await page.waitForTimeout(400);
    if (!(await clickAny(page, /Continu|Confirm|Conferma|Подтверд|Weiter|Next|Далее|Verif|Submit|Invia|Отправ|Продолж/i))) await cf.press('Enter').catch(() => {});
    await page.waitForTimeout(6000);
    await clickAny(page, /Save info|Сохранить|Not now|Не сейчас|Später|Jetzt nicht/i); // «сохранить вход?»
    await page.waitForTimeout(1500);
    const ok = await page.locator(homeSel).first().isVisible().catch(() => false);
    console.log(`[email-chal] ${creds.login}: после ввода кода -> ${ok ? 'ВОШЛИ ✓' : 'ещё не лента'} url=${page.url().replace('https://www.instagram.com', '')}`);
    return ok ? 'ok' : 'challenge';
  } catch { return 'challenge'; }
}

// Есть ли живая IG-сессия (кука sessionid)? IG ставит sessionid ТОЛЬКО после ПОЛНОГО входа (вкл. 2FA).
// Это надёжный сигнал «залогинен», что бы поверх ни висело (onetap / free-with-ads / уведомления / фото и т.п.) —
// не надо перечислять каждый промежуточный экран IG, из-за чего и были ложные dead.
async function hasIgSession(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies(['https://www.instagram.com', 'https://i.instagram.com']);
    const sid = cookies.find((c) => c.name === 'sessionid');
    return !!(sid && sid.value && sid.value.length > 10);
  } catch { return false; }
}

// Робастный ввод 2FA-кода (порт логики chlogin «2FA-по-URL»): ждём отрисовки поля, вводим СВЕЖИЙ TOTP
// посимвольно, жмём Continue/Enter, ждём ухода с 2FA (тормозной прокси до ~24с). До 3 попыток (код мог попасть
// на границу 30-сек окна). 2FA — ШТАТНОЕ событие, вводим ВСЕГДА (без «кулдаунов»). Возврат: 'ok' — залогинены
// (кука/лента); 'left' — ушли с 2FA, но вход не подтверждён (решаем выше); 'stuck' — всё ещё на 2FA.
async function enter2faCode(page: Page, secret: string, login: string): Promise<'ok' | 'left' | 'stuck'> {
  const twofaSel = 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="код" i], input[aria-label*="code" i], input[aria-label*="Sicherheits" i]';
  // ждём, пока после перехода отрисуется поле кода (окно 2FA грузится через прокси) — до ~12с
  for (let w = 0; w < 12; w++) {
    if (await hasIgSession(page)) return 'ok';
    if (await page.locator(twofaSel).first().isVisible().catch(() => false)) break;
    if (!/two_factor|two_step|verification/i.test(page.url())) return 'left';
    await page.waitForTimeout(1000);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await hasIgSession(page)) return 'ok';
    const still = /two_factor|two_step|verification/i.test(page.url()) || await page.locator(twofaSel).first().isVisible().catch(() => false);
    if (!still) return 'left';
    let code: string; try { code = totpCode(secret); } catch { return 'stuck'; } // СВЕЖИЙ код на каждую попытку
    let cf = page.locator(twofaSel).first();
    if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
    if (!(await cf.isVisible().catch(() => false))) cf = page.locator('input[type="text"], input[type="tel"], input[inputmode="numeric"]').first();
    await cf.click().catch(() => {}); await cf.fill('').catch(() => {});
    await cf.pressSequentially(code, { delay: 90 }).catch(async () => { await cf.fill(code).catch(() => {}); }); // fill не триггерит React onChange
    await page.waitForTimeout(700);
    let clicked = false;
    const contBtn = page.getByRole('button', { name: /Continu|Confirm|Conferma|Подтверд|Bestätig|Weiter|Next|Далее|Verif|Submit|Invia|Отправ|Продолж/i }).first();
    for (let i = 0; i < 8; i++) { if (await contBtn.isVisible().catch(() => false) && await contBtn.isEnabled().catch(() => false)) { await contBtn.click().catch(() => {}); clicked = true; break; } await page.waitForTimeout(500); }
    if (!clicked) await cf.press('Enter').catch(() => {});
    for (let i = 0; i < 12; i++) { if (!/two_factor|two_step|verification/i.test(page.url()) || await hasIgSession(page)) break; await page.waitForTimeout(2000); }
    console.log(`[login-2fa] ${login}: attempt=${attempt} after=${page.url().replace('https://www.instagram.com', '')}`);
    if (!/two_factor|two_step|verification/i.test(page.url()) || await hasIgSession(page)) break;
    await page.waitForTimeout(2000);
  }
  if (await hasIgSession(page)) return 'ok';
  return /two_factor|two_step|verification/i.test(page.url()) ? 'stuck' : 'left';
}

// Полный вход по кредам: юзернейм + пароль + 2FA (TOTP из сохранённого сида). Дожимается ТОЛЬКО когда
// акк выкинуло полностью (ensureLoggedIn не справился). На челлендж/чекпоинт/капчу — СТОП + флаг (не
// обходим и не долбим: капчи запрещены, а спам-логины жгут акк). Пароль берётся из базы (ig_password).
export async function passwordLogin(page: Page, creds: LoginCreds): Promise<LoginResult> {
  try {
    if (!creds.login || !creds.password) return 'bad_creds';
    const homeSel = IG_HOME_SEL;
    const twofaSel = 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="код" i], input[aria-label*="code" i], input[aria-label*="Sicherheits" i]';
    // IG отдаёт ДВЕ формы входа: новую (name=username/password, button[submit]) и старую
    // (name=email/pass, input[submit]). Пароль ловим по type=password (общий для обеих), юзернейм и
    // сабмит — списком. Иначе поля «не находятся» и вход молча падает (была реальная причина).
    const passSel = 'input[type="password"]';
    const userSel = 'input[name="username"], input[name="email"]';
    const submitSel = 'button[type="submit"], input[type="submit"]';
    // ВСЕГДА каноничная форма /accounts/login/ (home-inline форма ведёт себя иначе и «отбрасывает»).
    if (!/\/accounts\/login|two_factor|two_step|challenge/i.test(page.url())) {
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    // Куки-баннер перекрывает форму — закрываем. Приватность: СНАЧАЛА «отклонить необязательные»,
    // и только если такой кнопки нет — «разрешить все» (раньше обе лежали в одной альтернации и
    // .first() по DOM-порядку жал «Allow all» — то есть мы фактически соглашались на все куки).
    await dismissAll(page).catch(() => []);
    await page.waitForTimeout(900);
    // ПРЯМОЙ 2FA-ПО-URL (порт chlogin): IG мог бросить акк СРАЗУ на 2FA-экран (кука частично жива) — ни пароля,
    // ни Continue-as. Раньше это молча уходило в 'need_login' БЕЗ ввода кода (реальная дыра). Ловим 2FA здесь и
    // вводим TOTP. 2FA — штатное событие, вводим ВСЕГДА и быстро (правило начальника 23.07).
    if (creds.totpSecret && (/two_factor|two_step|verification/i.test(page.url()) || await page.locator(twofaSel).first().isVisible().catch(() => false))) {
      const r2 = await enter2faCode(page, creds.totpSecret, creds.login);
      if (r2 === 'ok') { await dismissIgInterstitials(page).catch(() => {}); return 'ok'; }
      // 'left'/'stuck' → проваливаемся в обычный поток (лента/пароль/вердикт разберутся ниже)
    }
    await page.locator(passSel).first().waitFor({ timeout: 9000 }).catch(() => {}); // форма могла догружаться
    const pass = page.locator(passSel).first();
    if (!(await pass.isVisible().catch(() => false))) {
      // нет формы пароля: либо уже вошли (кука/лента), либо промежуточный экран (onetap/consent), либо «Continue as X».
      if (await hasIgSession(page)) { await dismissIgInterstitials(page).catch(() => {}); return 'ok'; }
      if (/\/accounts\/onetap\//i.test(page.url()) || await isAdConsentScreen(page)) { await dismissIgInterstitials(page).catch(() => {}); return 'ok'; }
      if (await page.locator(homeSel).first().isVisible().catch(() => false)) return 'ok';
      // «Continue as X» — сохранённый аккаунт (remembered): формы пароля НЕТ, но есть кнопка Continue. ЖМЁМ её,
      // чтобы возобновить сессию — ИНАЧЕ воркер ложно метил акк dead и НЕ доходил до 2FA (реальная причина
      // «воркер не вводит 2FA»). После Continue: либо лента, либо 2FA (вводим TOTP), либо форма пароля (обычный вход ниже).
      // ⚠️ Регексп БЫЛ заякорен на ^Continue$ — а IG на этом экране рисует «Continue as <username>».
      // Кнопка не находилась → return 'need_login' ещё ДО всякой 2FA (это и есть «воркер не вводит 2FA»).
      const resumeBtn = page.getByRole('button', { name: /^\s*Continue(\s+as\b.*)?\s*$|^\s*Продолжить(\s+как(?![а-яё]).*)?\s*$|^\s*Weiter\b.*$|^\s*Devam(\s*et)?\b.*$|^\s*Continuar\b.*$/i }).first();
      if (!(await resumeBtn.isVisible().catch(() => false))) return 'need_login';
      await resumeBtn.click().catch(() => {});
      await page.waitForTimeout(6000);
      if (await hasIgSession(page)) { await dismissIgInterstitials(page).catch(() => {}); return 'ok'; }
      if (await page.locator(homeSel).first().isVisible().catch(() => false)) return 'ok';
      // после Continue появилась ФОРМА ПАРОЛЯ → выходим из ветки в обычный вход ниже. Иначе — 2FA-экран.
      if (!(await page.locator(passSel).first().isVisible().catch(() => false))) {
        const codeSelR = 'input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="код" i], input[aria-label*="code" i], input[inputmode="numeric"]';
        // ЖДЁМ ЗАГРУЗКИ ОКНА 2FA после Continue (баг начальника 23.07 «не дождался окна 2FA»): раньше решали
        // раньше, чем поле кода отрисуется через тормозной прокси → бросали 'need_login', код не вводился. До ~12с
        // ждём появления 2FA (URL/поле) ИЛИ формы пароля ИЛИ ленты — потом решаем.
        for (let w = 0; w < 12; w++) {
          if (/two_factor|two_step|verification/i.test(page.url())) break;
          if (await page.locator(codeSelR).first().isVisible().catch(() => false)) break;
          if (await page.locator(passSel).first().isVisible().catch(() => false)) break;
          if (await hasIgSession(page)) break;
          await page.waitForTimeout(1000);
        }
        const on2faR = /two_factor|two_step|verification/i.test(page.url()) || await page.locator(codeSelR).first().isVisible().catch(() => false);
        if (!(on2faR && creds.totpSecret)) return 'need_login';
        for (let att = 0; att < 2; att++) {
          // Гейт по URL И по видимому полю кода: IG умеет рисовать 2FA ИНЛАЙНОМ (на /accounts/login/
          // или auth_platform), URL при этом не меняется → раньше цикл рвался на первой итерации и
          // код не вводился НИ РАЗУ, а наверх уходило 'need_login'.
          const still2fa = /two_factor|two_step|verification/i.test(page.url())
            || await page.locator(codeSelR).first().isVisible().catch(() => false);
          if (!still2fa || await hasIgSession(page)) break;
          let code: string; try { code = totpCode(creds.totpSecret); } catch { return 'challenge'; }
          let cf = page.locator(codeSelR).first();
          if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
          await cf.click().catch(() => {}); await cf.fill('').catch(() => {});
          await cf.pressSequentially(code, { delay: 90 }).catch(async () => { await cf.fill(code).catch(() => {}); });
          await page.waitForTimeout(700);
          if (!(await clickAny(page, /Continu|Confirm|Conferma|Подтверд|Weiter|Next|Далее|Verif|Submit|Invia|Отправ|Продолж/i))) await cf.press('Enter').catch(() => {});
          for (let i = 0; i < 10; i++) { if (!/two_factor|two_step|verification/i.test(page.url()) || await hasIgSession(page)) break; await page.waitForTimeout(2000); }
          if (await hasIgSession(page) || await page.locator(homeSel).first().isVisible().catch(() => false)) return 'ok';
          await page.waitForTimeout(2000);
        }
        // Не сдаёмся в кулдаун: 2FA — штатное событие, войдём снова следующим тиком и введём код заново.
        return 'need_login';
      }
      // (после Continue появилась форма пароля) — НЕ возвращаем, проваливаемся в обычный вход ниже
    }
    const user = page.locator(userSel).first();
    // ВВОД ПОСИМВОЛЬНО: fill() у нового React-логина IG не триггерит onChange → кнопка «Log in» disabled → сабмит
    // впустую → висим на форме (был реальный баг: submit_btn=false, postUrl=/accounts/login/). Нажатия чинят.
    await user.click().catch(() => {}); await user.fill('').catch(() => {});
    await user.pressSequentially(creds.login, { delay: 25 }).catch(async () => { await user.fill(creds.login).catch(() => {}); });
    await pass.click().catch(() => {}); await pass.fill('').catch(() => {});
    await pass.pressSequentially(creds.password, { delay: 25 }).catch(async () => { await pass.fill(creds.password).catch(() => {}); });
    await page.waitForTimeout(500);
    const uLen = (await user.inputValue().catch(() => '')).length;
    const pLen = (await pass.inputValue().catch(() => '')).length;
    const preUrl = page.url();
    // САБМИТ: ждём АКТИВНУЮ кнопку. type=submit ИЛИ role=button «Log in» (новый IG — role=button без submit,
    // Enter в такой форме не срабатывает). Только в последнюю очередь — Enter.
    let subHow = 'none';
    for (let i = 0; i < 16; i++) {                               // до ~8с: медленным формам (тормозной прокси) даём дорисовать кнопку
      const sb = page.locator('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])').first();
      if (await sb.isVisible().catch(() => false)) { await sb.click({ timeout: 6000 }).catch(() => {}); subHow = 'submit'; break; }
      const lb = page.getByRole('button', { name: /^\s*Log ?in\s*$|^\s*Войти\s*$|Anmelden|Accedi|Se connecter|Giriş|Iniciar sesión/i }).first();
      if (await lb.isVisible().catch(() => false) && await lb.isEnabled().catch(() => false)) { await lb.click().catch(() => {}); subHow = 'role-btn'; break; }
      await page.waitForTimeout(500);
    }
    if (subHow === 'none') { await pass.press('Enter').catch(() => {}); subHow = 'enter'; }
    await page.waitForTimeout(6000);
    console.log(`[login] ${creds.login}: user_filled=${uLen > 0} pass_filled=${pLen > 0} submit=${subHow} preUrl=${preUrl.replace('https://www.instagram.com', '')} postUrl=${page.url().replace('https://www.instagram.com', '')}`);
    // ВАЖНО: после сабмита переход на 2FA/home не мгновенный. Ждём, пока страница ОСЯДЕТ в опознаваемое
    // состояние (2FA / home / ошибка), иначе проверим экран раньше загрузки и пропустим ввод 2FA-кода.
    for (let i = 0; i < 8; i++) {
      if (/two_factor|two_step|challenge|checkpoint/i.test(page.url())) break;
      if (await page.locator(homeSel).first().isVisible().catch(() => false)) break;
      if (await page.locator('#slfErrorAlert, div[role="alert"]').first().isVisible().catch(() => false)) break;
      const bt = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
      if (/authentication app|authenticator|6-digit|6 cifre|6 chiffres|код из приложения|verification code|codice di|two-factor|двухфактор/i.test(bt)) break;
      await page.waitForTimeout(1500);
    }
    // 2FA / чекпоинт-код. Определяем по URL/ТЕКСТУ (селектор поля локализован — «Codice»/«Code»/«Код»…).
    // TOTP вводим ТОЛЬКО для 2FA приложения-аутентификатора; email/SMS-чекпоинт — руками (наш код не подойдёт).
    const body1 = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
    const on2fa = /two_factor|two_step|2fa|verification/i.test(page.url())
      || /authentication app|authenticator|app di autenticazione|app d'authentification|autenticaç|аутентификатор|код из приложения|codice a 6|6-digit|6 cifre|6 chiffres|duo mobile|google authenticator|verifica in due passaggi|two-factor auth/i.test(body1)
      || ((await page.getByRole('textbox').first().isVisible().catch(() => false)) && /codice|\bcode\b|(?<![а-яёa-z])код(?![а-яёa-z])|verification/i.test(body1));
    if (on2fa) {
      const emailSms = /we sent|sent you|sent a code|отправили код|abbiamo inviato|inviato un codice|check your email|via email|via sms|per email|per sms|по sms|на телефон|на почту|controlla la tua email/i.test(body1);
      const authApp = /authentication app|authenticator|app di autenticazione|app d'authentification|аутентификатор|код из приложения|duo mobile|google authenticator|app a due fattori/i.test(body1);
      if (emailSms && !authApp) return await solveEmailChallenge(page, creds); // почта/SMS — авто-код с почты (или 'challenge')
      if (!creds.totpSecret) return 'challenge';
      // ДИАГ инпутов 2FA-страницы (один раз, для отладки полей).
      const fields = await page.evaluate(() => [...document.querySelectorAll('input')]
        .map((i) => ({ t: (i as HTMLInputElement).type, n: (i as HTMLInputElement).name, a: i.getAttribute('aria-label'), ml: (i as HTMLInputElement).maxLength, im: (i as HTMLInputElement).inputMode }))
        .filter((i) => i.t !== 'hidden')).catch(() => [] as any[]);
      console.log(`[login-2fa] ${creds.login}: inputs=${JSON.stringify(fields).slice(0, 260)}`);
      // ДО 2 ПОПЫТОК: если 1-й код протух (сгенерён у границы 30-сек окна, сабмит ушёл позже через тормозной
      // прокси → IG отбил) — вводим СВЕЖИЙ код и повторяем. Между попытками проходит ~24с (ожидание ниже) →
      // TOTP-окно сменяется → 2-я попытка гарантированно с новым кодом.
      for (let attempt = 1; attempt <= 2; attempt++) {
        // Гейт по URL И по видимому полю кода (2FA бывает инлайновой, без смены URL — см. коммент выше).
        const still2fa = /two_factor|two_step|verification/i.test(page.url())
          || await page.locator(twofaSel).first().isVisible().catch(() => false);
        if (!still2fa || await hasIgSession(page)) break; // уже приняли
        let code: string;
        try { code = totpCode(creds.totpSecret); } catch { return 'challenge'; } // СВЕЖИЙ код на КАЖДУЮ попытку
        // Поле кода: явные селекторы -> первый текстбокс -> первый видимый input text/tel.
        let cf = page.locator(twofaSel).first();
        if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
        if (!(await cf.isVisible().catch(() => false))) cf = page.locator('input[type="text"], input[type="tel"], input[inputmode="numeric"]').first();
        // ВВОД ПОСИМВОЛЬНО: fill() не триггерит React onChange нового виджета → кнопка Continue disabled → клик впустую.
        await cf.click().catch(() => {});
        await cf.fill('').catch(() => {});
        await cf.pressSequentially(code, { delay: 90 }).catch(async () => { await cf.fill(code).catch(() => {}); });
        const codeLen = (await cf.inputValue().catch(() => '')).length;
        await page.waitForTimeout(700);
        // Жмём кнопку, ДОЖДАВШИСЬ активации (не disabled). Иначе — Enter в поле.
        let clicked = false;
        const contBtn = page.getByRole('button', { name: /Continu|Confirm|Conferma|Подтверд|Bestätig|Weiter|Next|Далее|Autorizza|Verif|Submit|Invia|Отправ|Продолж|Absenden/i }).first();
        for (let i = 0; i < 8; i++) {
          if (await contBtn.isVisible().catch(() => false) && await contBtn.isEnabled().catch(() => false)) { await contBtn.click().catch(() => {}); clicked = true; break; }
          await page.waitForTimeout(500);
        }
        if (!clicked) clicked = await clickAny(page, /Continu|Confirm|Conferma|Подтверд|Bestätig|Weiter|Next|Далее|Autorizza|Verif|Submit|Invia|Отправ|Продолж|Absenden/i);
        if (!clicked) await cf.press('Enter').catch(() => {});
        // Ждём, пока страница реально УЙДЁТ с 2FA (переход 2FA→onetap→лента). ТОРМОЗНОЙ ОБЛАЧНЫЙ ПРОКСИ обрабатывает
        // код + редиректит до ~60с — раньше ждали лишь 24с и рано сдавались/закрывали (баг 24.07 «не дождался окна
        // подтверждения»). Портируем терпение chlogin: ждём ДОЛЬШЕ (до ~60с) + СПИННЕР-ГЕЙТ (IG грузит = ещё обрабатывает
        // код, НЕ решаем) + onetap/Save-info = УСПЕХ (вход прошёл, IG предлагает сохранить). Код принят → выходим сразу.
        for (let i = 0; i < 30; i++) {
          if (!/two_factor|two_step|verification/i.test(page.url())) break; // ушли = код принят
          if (await hasIgSession(page)) break;                             // кука есть = авторизованы
          if (await page.locator(homeSel).first().isVisible().catch(() => false)) break;
          if (/accounts\/onetap/i.test(page.url())) break;                 // onetap = ПОСЛЕ успешного входа
          if (await page.getByRole('button', { name: /^\s*(Save info|Сохранить(\sинформацию)?)\s*$/i }).first().isVisible().catch(() => false)) break; // Save info = вошли
          const spinning = await page.locator('button svg circle[stroke-dasharray], [role="progressbar"], button[disabled] svg[aria-label*="oad" i]').first().isVisible().catch(() => false);
          await page.waitForTimeout(spinning ? 1500 : 2000); // спиннер виден → IG ещё думает, просто ждём дальше
        }
        console.log(`[login-2fa] ${creds.login}: attempt=${attempt} code_len=${codeLen} btn=${clicked} after_url=${page.url().replace('https://www.instagram.com', '')}`);
        if (!/two_factor|two_step|verification/i.test(page.url()) || await hasIgSession(page)) break; // приняли → выходим
        await page.waitForTimeout(2000); // всё ещё на 2FA → короткая пауза, свежий код на 2-й попытке
      }
    }
    // плашки «сохранить вход / не сейчас»
    await clickAny(page, /Save info|Save Info|Сохранить|Not now|Не сейчас|Jetzt nicht|Später|Şimdi değil/i);
    await page.waitForTimeout(1200);
    // ДИАГНОСТИКА (без секретов): что на экране ПОСЛЕ сабмита — чтобы точно знать состояние и чинить по факту.
    try {
      const dUrl = page.url();
      const dBody = (await page.evaluate(() => (document.body.innerText || '').slice(0, 600)).catch(() => '')).replace(/\s+/g, ' ');
      const dHome = await page.locator(homeSel).first().isVisible().catch(() => false);
      const dPass = await page.locator(passSel).first().isVisible().catch(() => false);
      const d2fa = await page.locator(twofaSel).first().isVisible().catch(() => false);
      console.log(`[login-diag] url=${dUrl} home=${dHome} pass=${dPass} 2fa=${d2fa} body="${dBody.slice(0, 450)}"`);
    } catch { /* диагностика best-effort */ }
    // вердикт — DEFAULT-DENY: 'ok' ТОЛЬКО при явном признаке ленты. Неопознанный экран = НЕ успех.
    // two_factor/two_step НЕ считаем challenge — это штатная 2FA (обработана выше). Если после ввода кода
    // мы ВСЁ ЕЩЁ на 2FA — это ретрай (код мог попасть на границу 30-сек окна), а не пауза акка.
    const url = page.url();
    // /accounts/onetap/ = экран «Сохранить данные входа?» — IG показывает его ТОЛЬКО ПОСЛЕ УСПЕШНОГО входа.
    // БЫЛ РЕАЛЬНЫЙ БАГ: акк заходил (код 2FA принят), падал на onetap, а вердикт не видел тут ни ленты, ни формы
    // → возвращал need_login → воркер ложно метил акк dead. Onetap = залогинен, точка.
    if (/\/accounts\/onetap\//i.test(url)) { await clickAny(page, /Save info|Save Info|Сохранить|Not now|Не сейчас|Jetzt nicht|Später|Şimdi değil/i).catch(() => {}); return 'ok'; }
    // Meta ads-consent («free with ads?») — тоже ПОСЛЕ успешного входа. Проходим и считаем 'ok'.
    if (await isAdConsentScreen(page)) { await passAdConsent(page); return 'ok'; }
    if (/challenge|checkpoint|auth_platform|suspend|disabled|locked/i.test(url)) return 'challenge';
    if (await page.locator('iframe[src*="captcha" i], iframe[title*="captcha" i], [class*="captcha" i]').first().isVisible().catch(() => false)) return 'captcha';
    // ещё на 2FA после ввода кода = код не успел ввестись / попал на границу 30-сек окна. 2FA — ШТАТНОЕ
    // событие (IG регулярно разлогинивает 2FA-акки), НЕ повод для кулдауна: '2fa_cooldown' убран как
    // несуществующая механика (начальник 23.07). Обычный ретрай — войдём снова и введём код заново, быстро.
    if (/two_factor|two_step|verification/i.test(url)) return 'need_login';
    // ГЛАВНЫЙ сигнал успеха: кука sessionid стоит = акк авторизован (2FA пройдена), что бы поверх ни висело
    // (onetap / free-with-ads / «включить уведомления» / «добавь фото» и любой будущий экран IG). Мы уже
    // прошли проверки challenge/captcha/2FA выше, так что кука здесь = чистый вход. Это ЛЕЧИТ «застревание».
    if (await hasIgSession(page)) { await dismissIgInterstitials(page).catch(() => {}); return 'ok'; }
    const alert = page.locator('#slfErrorAlert, div[role="alert"]').first();
    if (await alert.isVisible().catch(() => false)) {
      const t = (await alert.innerText().catch(() => '')).toLowerCase();
      if (/password|пароль|incorrect|неверн|couldn|wasn'?t|not match|didn'?t/i.test(t)) return 'bad_creds';
    }
    // суспенд/блок/«подтверди это ты» инлайн (без role=alert) — по тексту страницы
    const body = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
    // РЕЙТ-ЛИМИТ ОТДЕЛЬНО ОТ БАНА (07.08). «Попробуйте позже / try again later» лежало в одном
    // регексе с суспендом и давало 'challenge': акк уезжал в ig_status='challenge' + status='paused',
    // а автозамена сносит ровно такие акки вместе с профилем GoLogin. Живой аккаунт терялся
    // насовсем из-за фразы про частоту заходов. Проверяем ДО терминального регекса.
    if (/попробуйте позже|try again later|wait a few minutes|подождите несколько минут|too many attempts|слишком много попыток/i.test(body)) return 'rate_limited';
    // Терминальные состояния (бан/суспенд) — авто-код не поможет, сразу ручной путь.
    if (/suspend|disabled your account|заблокир|отключил|we removed|account has been/i.test(body)) return 'challenge';
    // «Подтверди, что это ты / необычный вход / подтверди аккаунт» — это email-код, пробуем авто-подтверждение.
    if (/подтверди[тл].*это ты|confirm it'?s you|help us confirm|unusual login|подозрительн|verify your account|подтвердит.*аккаунт|verify to keep using/i.test(body)) return await solveEmailChallenge(page, creds);
    // 'ok' ТОЛЬКО когда лента есть И формы логина НЕТ (иначе разлогиненная стр. с лента-похожим элементом = ложный ok).
    const homeVis = await page.locator(homeSel).first().isVisible().catch(() => false);
    const passVis = await page.locator(passSel).first().isVisible().catch(() => false);
    if (homeVis && !passVis) return 'ok'; // ← единственный путь к 'ok'
    if (passVis) return 'need_login';
    return 'need_login'; // вход не подтверждён → НЕ считаем успехом (счётчик неудач в воркере ограничит)
  } catch {
    return 'error';
  }
}

// Вход в TikTok по кредам: юзернейм/почта + пароль (+ TOTP-2FA, если сид есть). Тот же контракт исходов,
// что у passwordLogin (IG). TikTok агрессивно кидает капчу/челлендж на авто-вход — их НЕ обходим (пауза,
// руками в GoLogin). Селекторы TikTok хешируются — держим устойчивые якоря + текстовые фолбэки (RU/KK/EN).
export async function tiktokLogin(page: Page, creds: LoginCreds): Promise<LoginResult> {
  try {
    if (!creds.login || !creds.password) return 'bad_creds';
    // Залогинен, если виден профиль/аплоад и нет формы логина.
    const homeSel = '[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="upload-icon"], a[href*="/tiktokstudio/upload"], a[href*="/upload"]';
    const userSel = 'input[name="username"], input[type="text"][placeholder*="mail" i], input[type="text"][placeholder*="user" i], input[type="text"][placeholder*="почт" i], input[type="text"][placeholder*="логин" i]';
    const passSel = 'input[type="password"], input[name="password"]';
    const submitSel = 'button[data-e2e="login-button"], button[type="submit"]';
    const captchaSel = '#captcha-verify-container, div[class*="captcha" i], div[id*="captcha" i], iframe[src*="captcha" i]';
    const code2faSel = 'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"][maxlength="6"]';
    // Прямая форма входа по email/username (минуя выбор способа).
    if (!/\/login|\/foryou|two_step|two-factor|verify/i.test(page.url())) {
      await page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    // Уже внутри?
    if (await page.locator(homeSel).first().isVisible().catch(() => false)) return 'ok';
    // Куки-баннер (приоритет — отклонить необязательные).
    await clickAny(page, /Decline optional cookies|Отклонить (все|необязательные)|Тек қажеттілерін|Decline all|Only allow essential/i);
    await page.waitForTimeout(800);
    // Если форма ещё за выбором способа — дожмём «Use phone / email / username» и «Log in with email or username».
    if (!(await page.locator(passSel).first().isVisible().catch(() => false))) {
      await clickAny(page, /Use phone \/ email|email or username|почт[аеы].*(логин|username)|телефон.*(почт|email)|Пайдалану/i);
      await page.waitForTimeout(1200);
      await clickAny(page, /Log in with email or username|Войти.*(почт|логин|username)|email or username/i);
      await page.waitForTimeout(1200);
    }
    await page.locator(passSel).first().waitFor({ timeout: 9000 }).catch(() => {});
    const pass = page.locator(passSel).first();
    if (!(await pass.isVisible().catch(() => false))) {
      // формы нет и не залогинен → капча/челлендж на входной странице?
      if (await page.locator(captchaSel).first().isVisible().catch(() => false)) return 'captcha';
      return (await page.locator(homeSel).first().isVisible().catch(() => false)) ? 'ok' : 'need_login';
    }
    const user = page.locator(userSel).first();
    await user.click().catch(() => {}); await user.fill(creds.login).catch(() => {});
    await pass.click().catch(() => {}); await pass.fill(creds.password).catch(() => {});
    await page.waitForTimeout(500);
    const uLen = (await user.inputValue().catch(() => '')).length;
    const pLen = (await pass.inputValue().catch(() => '')).length;
    const submit = page.locator(submitSel).first();
    const subVis = await submit.isVisible().catch(() => false);
    if (subVis) await submit.click({ timeout: 8000 }).catch(() => {});
    else await pass.press('Enter').catch(() => {});
    await page.waitForTimeout(6000);
    console.log(`[tt-login] ${creds.login}: user_filled=${uLen > 0} pass_filled=${pLen > 0} submit_btn=${subVis} url=${page.url().replace('https://www.tiktok.com', '')}`);
    // Дать экрану осесть (капча/2FA/лента/ошибка).
    for (let i = 0; i < 8; i++) {
      if (await page.locator(homeSel).first().isVisible().catch(() => false)) break;
      if (await page.locator(captchaSel).first().isVisible().catch(() => false)) break;
      const bt = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
      if (/verification code|6-digit|код подтвержд|authenticator|аутентификатор|incorrect|неверн|too many|тым көп/i.test(bt)) break;
      await page.waitForTimeout(1500);
    }
    // Капча — не обходим.
    if (await page.locator(captchaSel).first().isVisible().catch(() => false)) return 'captcha';
    // 2FA/верификация. TOTP вводим только для приложения-аутентификатора; SMS/email — руками (нет авто-кода TikTok).
    const body1 = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
    const on2fa = /two[-_ ]?step|two[-_ ]?factor|verification code|6-digit|код подтвержд|введите код|enter.*code|аутентификатор|authenticator/i.test(body1)
      || (await page.locator(code2faSel).first().isVisible().catch(() => false));
    if (on2fa) {
      const authApp = /authenticator|authentication app|аутентификатор|код из приложения/i.test(body1);
      const emailSms = /sent.*(email|sms|code|phone)|отправили код|на (почт|телефон|номер)|via (email|sms)|check your email/i.test(body1);
      if (!authApp && emailSms) return 'challenge'; // код на почту/SMS — руками в GoLogin
      if (!creds.totpSecret) return 'challenge';
      let code: string;
      try { code = totpCode(creds.totpSecret); } catch { return 'challenge'; }
      let cf = page.locator(code2faSel).first();
      if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
      await cf.click().catch(() => {});
      await cf.fill(code).catch(() => {});
      await page.waitForTimeout(400);
      const clicked = await clickAny(page, /Next|Continu|Confirm|Verify|Submit|Далее|Подтверд|Продолж|Растау|Келесі/i);
      if (!clicked) await cf.press('Enter').catch(() => {});
      await page.waitForTimeout(6000);
      console.log(`[tt-login-2fa] ${creds.login}: after_url=${page.url().replace('https://www.tiktok.com', '')}`);
    }
    await page.waitForTimeout(1200);
    // Вердикт — DEFAULT-DENY: 'ok' только при явном признаке ленты/профиля.
    if (await page.locator(captchaSel).first().isVisible().catch(() => false)) return 'captcha';
    const url = page.url();
    if (/suspend|banned|account\/status|deactivat/i.test(url)) return 'challenge';
    const body = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
    // Неверные креды / rate-limit.
    if (/account or password is incorrect|password.*incorrect|incorrect.*password|doesn'?t match|неверн(ый|ые).*(логин|парол)|парол.*неверн|wrong password/i.test(body)) return 'bad_creds';
    if (/too many attempts|maximum number of attempts|тым көп|слишком много попыток|try again later|повторите попытку позже/i.test(body)) return 'challenge';
    if (/suspend|banned|account was banned|аккаунт заблок|приостановлен|we removed/i.test(body)) return 'challenge';
    if (await page.locator(homeSel).first().isVisible().catch(() => false)) return 'ok'; // ← единственный путь к 'ok'
    if (await page.locator(passSel).first().isVisible().catch(() => false)) return 'need_login';
    return 'need_login';
  } catch {
    return 'error';
  }
}

// ЗРЯЧИЙ вход: модель смотрит скриншот и говорит СЛЕДУЮЩИЙ шаг (координаты — в долях экрана, DPR-независимо).
// Значения (логин/пароль/2FA) вводит приложение из базы — модель их НЕ видит, только «куда кликнуть».
// Устойчив к любой форме/локали/куки-баннеру без селекторов. Капчу/челлендж/email-SMS — НЕ обходит (stuck).
const VLOGIN_SYS = `You automate an Instagram web login by looking at ONE screenshot and choosing the SINGLE next action.
The app already holds the account's username, password and a fresh 2FA authenticator code; you NEVER see or type their values, you only say WHERE the field/button is.
Reply with ONLY compact JSON (no markdown, no prose):
{"screen":"<state>","action":"<action>","x":<0..1>,"y":<0..1>,"click_text":"<visible button label or empty>","reason":"<short>"}
x,y are FRACTIONS of the image (0=left/top,1=right/bottom) at the CENTER of the target element.
state: login_form | two_factor_app | two_factor_email_or_sms | cookie_banner | save_login_dialog | challenge_checkpoint | captcha | logged_in | loading | other
action: type_user | type_pass | type_2fa | click | press_enter | wait | done | stuck
Rules:
- cookie_banner (consent dialog): action=click on the dismiss button; prefer "Decline optional cookies"/"Only allow essential", else "Allow all"; give its x,y+click_text.
- login_form: username/email field empty -> type_user at that field. else password empty -> type_pass at password field. else both filled -> click the Log in button (give x,y+click_text).
- two_factor_app (mentions authenticator app / 6-digit code / Google Authenticator / Duo): code field empty -> type_2fa at code field. else -> click Continue/Confirm.
- two_factor_email_or_sms (a code was sent to email/phone/SMS): action=stuck.
- challenge_checkpoint (confirm it's you / suspicious / unusual login / we removed / try again later): action=stuck.
- captcha (image puzzle / not a robot): screen=captcha.
- save_login_dialog ("Save your login info?"/"Turn on notifications"): click "Not now".
- logged_in (home feed / stories / bottom or side nav visible): action=done.
- loading/blank: action=wait.`;

export async function visionLogin(page: Page, creds: LoginCreds): Promise<LoginResult> {
  try {
    if (!creds.login || !creds.password) return 'bad_creds';
    await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {}); // может не сработать на облаке — не критично
    if (!/instagram\.com/i.test(page.url())) {
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    await page.waitForTimeout(2500);
    const vp = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1280, height: 860 }));
    const passSel = 'input[type="password"]';
    const userSel = 'input[name="username"], input[name="email"]';
    let noDecision = 0, submitTries = 0;
    for (let step = 0; step < 14; step++) {
      const shot = await page.screenshot({ type: 'png' }).catch(() => null);
      if (!shot) { await page.waitForTimeout(1500); continue; }
      const raw = await visionAct(shot.toString('base64'), VLOGIN_SYS, 'Screenshot attached. Return the next action as JSON only.');
      let d: any = {};
      try { d = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { /* модель не дала JSON */ }
      const scr = String(d.screen || ''); const act = String(d.action || '');
      console.log(`[vlogin] ${creds.login} step${step}: screen=${scr} action=${act} xy=${d.x},${d.y} (${String(d.reason || '').slice(0, 55)})`);
      if (!scr && !act) { if (++noDecision >= 3) return 'need_login'; await page.waitForTimeout(2000); continue; }
      noDecision = 0;
      if (scr === 'logged_in' || act === 'done') return 'ok';
      if (scr === 'captcha') return 'captcha';
      // Email/SMS-подтверждение или чекпоинт «это ты» — пробуем авто-код с почты; не вышло → 'challenge'.
      if (scr === 'two_factor_email_or_sms' || scr === 'challenge_checkpoint') { const r = await solveEmailChallenge(page, creds); return r === 'ok' ? 'ok' : 'challenge'; }
      if (act === 'stuck') return 'challenge';
      const cx = Math.round((Number(d.x) >= 0 ? Number(d.x) : 0.5) * (vp.width || 1280));
      const cy = Math.round((Number(d.y) >= 0 ? Number(d.y) : 0.5) * (vp.height || 860));
      // URL — АВТОРИТЕТНЫЙ сигнал 2FA: если мы на two_factor, а модель считает это «формой логина» (бывает) —
      // всё равно обрабатываем как 2FA, иначе цикл на 2FA-экране.
      const on2faUrl = /two_factor|two_step|two_step_verification/i.test(page.url());

      // ФОРМА ЛОГИНА: поля заполняем через DOM (координаты модели для полей промахиваются), сабмит — Enter.
      if (scr === 'login_form' && !on2faUrl) {
        const uf = page.locator(userSel).first();
        const pf = page.locator(passSel).first();
        if (await uf.isVisible().catch(() => false) && !((await uf.inputValue().catch(() => '')) || '').trim()) { await uf.click().catch(() => {}); await uf.fill(creds.login).catch(() => {}); }
        if (await pf.isVisible().catch(() => false) && !((await pf.inputValue().catch(() => '')) || '').trim()) { await pf.click().catch(() => {}); await pf.fill(creds.password).catch(() => {}); }
        await page.waitForTimeout(500);
        const uv = ((await uf.inputValue().catch(() => '')) || '').length;
        const pv = ((await pf.inputValue().catch(() => '')) || '').length;
        const bad = (t: string) => /incorrect|неверн|information you entered is incorrect|didn'?t match|wasn'?t right|не совпад/i.test(t);
        if (uv > 0 && pv > 0) {
          // Оба поля заполнены, но всё ещё на форме после 2 сабмитов — НЕ долбим (спам-логины жгут акк):
          // это либо неверный пароль/soft-block, либо форма не принимает — отдаём вердикт и выходим.
          if (submitTries >= 2) {
            const bt = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
            return bad(bt) ? 'bad_creds' : 'need_login';
          }
          submitTries++;
          // СABМИТ ФОРМОЙ: кнопка submit по DOM (клик модели по координатам промахивался и цикл крутился),
          // иначе Enter по полю пароля.
          const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
          if (await submitBtn.isVisible().catch(() => false)) await submitBtn.click({ timeout: 6000 }).catch(() => {});
          else await pf.press('Enter').catch(() => {});
          await page.waitForTimeout(5500);
          // «Неверный пароль» ловим сразу — не крутим ещё 12 шагов (усугубляет soft-block).
          const bt = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).toLowerCase();
          if (bad(bt)) return 'bad_creds';
        } else { await page.waitForTimeout(1500); }
        continue;
      }
      // 2FA-ПРИЛОЖЕНИЕ: код в поле (DOM textbox, иначе координаты модели), сабмит — Continue/Enter.
      if (scr === 'two_factor_app' || act === 'type_2fa' || on2faUrl) {
        if (!creds.totpSecret) return 'challenge';
        let code: string; try { code = totpCode(creds.totpSecret); } catch { return 'challenge'; }
        let cf = page.locator('input[autocomplete="one-time-code"], input[name="verificationCode"]').first();
        if (!(await cf.isVisible().catch(() => false))) cf = page.getByRole('textbox').first();
        if (await cf.isVisible().catch(() => false)) { await cf.click().catch(() => {}); await cf.fill(code).catch(() => {}); }
        else { await page.mouse.click(cx, cy).catch(() => {}); await page.waitForTimeout(200); await page.keyboard.type(code, { delay: 70 }).catch(() => {}); }
        await page.waitForTimeout(500);
        if (!(await clickAny(page, /Continu|Confirm|Conferma|Подтверд|Weiter|Next|Далее|Verif|Invia|Autorizza/i))) await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(5500);
        continue;
      }
      // ПРОЧЕЕ (куки-баннер, «сохранить вход», промежуточные экраны) — клик по тексту кнопки / координатам.
      if (act === 'press_enter') { await page.keyboard.press('Enter').catch(() => {}); }
      else {
        const byText = d.click_text ? await clickAny(page, new RegExp(String(d.click_text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 30), 'i')) : false;
        if (!byText) await page.mouse.click(cx, cy).catch(() => {});
      }
      await page.waitForTimeout(3000);
    }
    return (await page.locator('a[href="/explore/"], a[href^="/direct/"]').first().isVisible().catch(() => false)) ? 'ok' : 'need_login';
  } catch {
    return 'error';
  }
}

async function searchPosts(page: Page, phrase: string): Promise<string[]> {
  await page.goto('https://www.instagram.com/explore/search/keyword/?q=' + encodeURIComponent(phrase), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await clickAny(page, /Jetzt nicht|Not now|Не сейчас/i);
  // ГЛУБЖЕ: скроллим выдачу, чтобы подгрузить больше постов, и берём до 25 ссылок (было 10) — больше
  // кандидатов на фильтр (свежих/высокоспросных). Аккуратно (свежий акк, чтобы не словить 429).
  const take = Math.max(10, Number(process.env.RADAR_SEARCH_TAKE) || 25);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1600).catch(() => {}); await page.waitForTimeout(1400); }
  return page.locator('a[href*="/p/"], a[href*="/reel/"]').evaluateAll(
    (els, n) => Array.from(new Set(els.map((e) => (e as HTMLAnchorElement).href))).slice(0, n), take,
  ).catch(() => [] as string[]);
}

interface PostData { code: string; url: string; image_url: string; caption: string; demand: number; comment_count: number; like_count: number; recent_comments: number; last_comment_at: string | null; taken_at: string | null; author_replies: number; dm_bait: boolean; comments_last_hour: number; comments_last_2h: number; ru: boolean; offtopic: boolean; audio_id: string; audio_title: string; }

// НЕ НАША ТЕМАТИКА: промпты/контент про психологию, заработок, эзотерику и т.п. — аудитория не наша,
// коммент «делал в нейронке» там мимо. Такие посты режем целиком (см. фильтр в maybeRadar).
const OFFTOPIC = ['психолог', 'психотерап', 'психосомат', 'заработ', 'заработк', 'пассивный доход', 'доход ',
  'инвест', 'крипт', 'трейд', 'ставк', 'бизнес', 'инфобиз', 'млм', 'воронк', 'продаж',
  'эзотер', 'таро', 'астролог', 'гадан', 'нумеролог', 'матриц судьбы', 'расстановк', 'натальн',
  'мотивац', 'саморазвит', 'медитац', 'аффирмац', 'марафон желаний', 'финанс',
  // продажа услуг/товаров и инфобиз-партнёрки — наш коммент там бесполезен
  'партнерк', 'партнёрк', 'на заказ', 'сделаю для вас', 'сделаю вам', 'актуальные цены', 'прайс'];

// Русскоязычный ли пост: сперва по ПОДПИСИ (кириллица vs латиница; англ-хэштеги не должны топить русский
// текст), если подпись куцая — по тексту страницы (комменты; там UI-шум локали искателя, поэтому порог выше).
function isRussian(caption: string, articleText: string): boolean {
  // ЛОВУШКА: казахский тоже на кириллице — счётчик кириллицы его пропускает. Ловим по специфичным
  // казахским буквам (ә ғ қ ң ө ұ ү һ і): 3+ таких в подписи = не русский пост.
  if (((caption.match(/[әғқңөұүһі]/gi) || []).length) >= 3) return false;
  const cnt = (s: string) => ({ c: (s.match(/[а-яё]/gi) || []).length, l: (s.match(/[a-z]/gi) || []).length });
  const cap = cnt(caption);
  // Русский пост часто несёт АНГЛИЙСКИЙ промт в подписи (норма ниши) — латиница перевешивает.
  // Поэтому: достаточно кириллицы в абсолюте → русский, независимо от объёма латиницы.
  if (cap.c >= 25) return true;
  if (cap.c + cap.l >= 8) return cap.c >= 5 && cap.c >= cap.l * 0.4;
  const t = cnt(articleText);
  return t.c >= 30 && t.c >= t.l * 0.3;
}

// Стрик 429 (IG throttling): растёт при rate-limit, сбрасывается при удачном чтении. По нему тормозим скан.
let radar429 = 0;
let radarPauseUntil = 0; // при серии 429 даём искателю отдохнуть — иначе IG банит/дольше троттлит
export function radar429Streak(): number { return radar429; }
export function radarThrottled(): boolean { return Date.now() < radarPauseUntil; }

// Сменить искателя: снять роль с текущего, посадить читателем ЖИВОЙ рабочий акк (НЕ дежурный).
// ПРИОРИТЕТ — акк с МАКСИМУМОМ банов от креаторов (post_account_blocks): он для комментинга уже
// балласт (авторы его заблокили), а ЧИТАТЬ/искать может свободно — не жжём чистый акк под чтение.
// При равных банах — наименее занятый. Причина: 429-душение ИЛИ разлогин искателя.
async function rotateReader(currentId: string, reason: string): Promise<void> {
  await query(`UPDATE accounts SET ig_role=NULL, reader_strikes=0 WHERE id=$1`, [currentId]).catch(() => {});
  const { rows: nx } = await query<{ id: string; slug: string; blocks: number; profile: string; token: string | null }>(
    `SELECT a.id, a.slug, a.gologin_profile_id AS profile, g.gologin_token AS token,
            (SELECT count(*) FROM post_account_blocks b WHERE b.account_id=a.id AND b.blocked) AS blocks
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND coalesce(a.ig_role,'')='' AND a.deleted_at IS NULL
       AND a.session_status='live' AND a.gologin_profile_id IS NOT NULL AND a.status<>'paused'
       AND coalesce(g.watchdog,false)=false
     ORDER BY (SELECT count(*) FROM post_account_blocks b WHERE b.account_id=a.id AND b.blocked) DESC,
              (CASE WHEN a.comments_day=(now() at time zone 'Europe/Warsaw')::date THEN a.comments_today ELSE 0 END) ASC,
              a.last_commented_at ASC NULLS FIRST LIMIT 1`).catch(() => ({ rows: [] as any[] }));
  if (nx[0]) {
    await query(`UPDATE accounts SET ig_role='reader' WHERE id=$1`, [nx[0].id]).catch(() => {});
    radarPauseUntil = 0; // новый искатель — сканим уже со следующего тика
    const bl = Number(nx[0].blocks || 0);
    // БЕЗЛИМ-ПРОКСИ СОХРАНЯЕМ ПРИ РОТАЦИИ: искатель много читает → на резид/click-ip это дорого. Если задан
    // RADAR_READER_PROXY (безлим), вешаем его на НОВОГО искателя — раньше ротация уводила искателя на его
    // click-ip. Смена IP переживается залогиненной сессией (проверено); не вышло — radar перелогинит.
    let proxyNote = '';
    const rp = process.env.RADAR_READER_PROXY;
    if (rp) {
      const spec = parseProxy(rp);
      if (spec) {
        try {
          await setProfileProxy(nx[0].profile, spec, nx[0].token);
          await query(`UPDATE accounts SET ig_proxy=$2 WHERE id=$1`, [nx[0].id, `${spec.username || ''}:${spec.password || ''}@${spec.host}:${spec.port}`]).catch(() => {});
          proxyNote = ' + безлим-прокси';
          console.log(`[radar] новому искателю ${nx[0].slug} повешен безлим-прокси ${spec.host}:${spec.port}`);
        } catch (e) { console.warn(`[radar] не смог повесить безлим-прокси на ${nx[0].slug}:`, e instanceof Error ? e.message.slice(0, 80) : e); }
      }
    }
    console.log(`[radar] ротация искателя (${reason}) → ${nx[0].slug}${bl ? ` (в бане у ${bl} креаторов)` : ''}${proxyNote}`);
    await notifyOwner(`🔄 Искатель радара сменён (${reason}). Новый: ${nx[0].slug}${bl ? ` — балласт (${bl} банов)` : ''}${proxyNote}`, { force: true }).catch(() => {});
  } else {
    await notifyOwner(`⚠️ Искатель радара выбыл (${reason}), живых акков на замену нет — назначь искателя в панели`, { force: true }).catch(() => {});
  }
}

async function readPost(page: Page, url: string): Promise<PostData | null> {
  const code = (url.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
  if (!code) return null;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // IG rate-limit: страница отдаёт «HTTP ERROR 429» / chrome-error. НЕ пишем мусор в базу — пропускаем
  // и взводим стрик (скан притормозит). Из-за 429 весь comment_count был =4 (это 4 строки экрана ошибки).
  const rl = await page.evaluate(() => location.href.startsWith('chrome-error') ||
    /HTTP ERROR 429|Too Many Requests|isn.t working|Please wait a few minutes|подождите несколько/i.test((document.body?.innerText || '').slice(0, 300))).catch(() => false);
  if (rl) { radar429++; console.warn(`[radar] 429/throttle при чтении ${code} (стрик ${radar429}) — пропускаю`); return null; }
  radar429 = 0;
  // ВАЖНО: читаем через evaluate (мгновенно), а НЕ через локаторы — те авто-ждут по 30с если элемента
  // нет (login-wall/чужая вёрстка) и вешают весь скан. querySelector даёт null сразу.
  const og = await page.evaluate(() => ({
    image: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
    desc: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
  })).catch(() => ({ image: '', desc: '' }));
  const image_url = og.image;
  const ogDesc = og.desc;
  const likeM = ogDesc.match(/([\d.,]+\s*[KMBkmbкмКМ]?)\s*(?:likes|отметки|лайк)/i);
  const like_count = likeM ? parseMetric(likeM[1]) : 0;
  const cm = ogDesc.match(/([\d.,]+\s*[KMBkmbкмКМ]?)\s*(?:comments|комментар)/i);
  let comment_count = cm ? parseMetric(cm[1]) : 0;
  const pre = ogDesc.match(/^[\d.,KMBkmbкмКМ\s]+likes[^:]*:\s*/i);
  const caption = (pre ? ogDesc.slice(pre[0].length) : ogDesc).slice(0, 600);
  // Подгружаем комменты (ленивые) — скроллим пару раз и читаем текст статьи (тоже через evaluate).
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1400).catch(() => {}); await page.waitForTimeout(1000); }
  // ВАЖНО: у IG на странице поста НЕТ <article> (проверено вживую) — читаем main/body, иначе всё пусто.
  const articleText = await page.evaluate(() => ((document.querySelector('main') as HTMLElement | null) || document.body)?.innerText || '').catch(() => '');
  const lines = articleText.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 280);
  let demand = 0;
  for (const l of lines) { const low = l.toLowerCase(); if (DEMAND.some((w) => low.includes(w))) demand++; }
  if (!comment_count) comment_count = lines.length;
  // Даты: у поста и у комментов есть <time datetime="…"> (по всей странице, НЕ в article — его нет).
  // Самый старый = дата поста, самый свежий = последний коммент (насколько пост живой).
  const dts = await page.evaluate(
    () => Array.from(document.querySelectorAll('time[datetime]')).map((e) => e.getAttribute('datetime')).filter((x): x is string => !!x),
  ).catch(() => [] as string[]);
  const stamps = dts.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const taken_at = stamps.length ? new Date(stamps[0]).toISOString() : null;
  const last_comment_at = stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : null;
  // Свежие комменты за последние 2 суток (комменты = все <time>, кроме самого старого — даты поста).
  const nowMs = Date.now();
  const commentStamps = stamps.length > 1 ? stamps.slice(1) : [];
  const recent_comments = commentStamps.filter((s) => nowMs - s < 2 * 86400000).length;
  const comments_last_hour = commentStamps.filter((s) => nowMs - s < 3600000).length;
  const comments_last_2h = commentStamps.filter((s) => nowMs - s < 2 * 3600000).length; // «вирал»: 10+/2ч = набирает
  // РУБРИКА. (1) Автор поста + сколько раз он сам появляется в комментах = отвечает ли он на спрос.
  // Если спрос есть, а автор НЕ отвечает — нам есть куда влезть (10/10). Если всё отвечено — 3-4/10.
  const struct = await page.evaluate(() => {
    const seg = (h: string | null) => (h || '').replace(/^\//, '').split(/[/?]/)[0].toLowerCase();
    const SKIP = new Set(['explore', 'reels', 'reel', 'p', 'stories', 'direct', 'accounts', 'about', '']);
    const users = Array.from(document.querySelectorAll('a[href^="/"]')).map((a) => seg(a.getAttribute('href'))).filter((u) => u && !SKIP.has(u));
    const author = users[0] || '';
    // появления автора среди коммент-линков (минус 1 — его ссылка в шапке) = его ответы
    const author_replies = Math.max(0, users.filter((u) => u === author).length - 1);
    return { author_replies };
  }).catch(() => ({ author_replies: 0 }));
  // (2) DM-байт: креатор просит коммент/подписку, а гайд/промпт обещает ВЫСЛАТЬ В ЛИЧКУ — он ловит лиды,
  //     нам бесполезно (наш коммент не поможет, спрашивающие уйдут к нему в директ). Топим такие.
  const ft = (caption + ' ' + articleText).toLowerCase();
  const deliverDM = /(?:в\s*(?:личк|лс|директ|дм|dm)|in\s+dm|via\s+dm|(?:пришл|вышл|скин|отправл|кин)\w*\s+(?:в\s+)?(?:лич|дир|лс|дм))/i.test(ft);
  const objectGuide = /(?:промпт|гайд|шаблон|урок|инструкц|туториал|ссылк|guide|prompt|tutorial|preset|пресет)/i.test(ft);
  const dm_bait = deliverDM && objectGuide;
  const ru = isRussian(caption, articleText);
  const offtopic = OFFTOPIC.some((w) => ft.includes(w));
  // АУДИО рилса: ссылка вида /reels/audio/{id}/ (у рилса под трендовый саунд она есть). id + название песни.
  const audio = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/reels/audio/"]');
    const href = a?.getAttribute('href') || '';
    const id = (href.match(/\/reels\/audio\/(\d+)/) || [])[1] || '';
    return { id, title: (a?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) };
  }).catch(() => ({ id: '', title: '' }));
  return { code, url, image_url, caption, demand, comment_count, like_count, recent_comments, last_comment_at, taken_at, author_replies: struct.author_replies, dm_bait, comments_last_hour, comments_last_2h, ru, offtopic, audio_id: audio.id, audio_title: audio.title };
}

// «14K» -> 14000, «1.2M» -> 1200000, «2,801» -> 2801 (запятая = разряды).
function parseMetric(raw: string): number {
  const m = raw.match(/([\d.,]+)\s*([KMBkmbкмКМ])?/);
  if (!m) return 0;
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K' || suf === 'К') return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1e3);
  if (suf === 'M' || suf === 'М') return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1e6);
  if (suf === 'B') return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1e9);
  return parseInt(m[1].replace(/[.,\s]/g, ''), 10) || 0;
}

// Шорткоды последних постов профиля креатора (для детекта нового поста).
async function readCreatorCodes(page: Page, username: string): Promise<string[]> {
  await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 35_000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const hrefs = await page.locator('a[href*="/p/"], a[href*="/reel/"]').evaluateAll(
    (els) => els.map((e) => (e as HTMLAnchorElement).href)).catch(() => [] as string[]);
  const codes: string[] = [];
  for (const h of hrefs) { const c = (h.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1]; if (c && !codes.includes(c)) { codes.push(c); if (codes.length >= 8) break; } }
  return codes;
}

// Проверить включённых креаторов: новый пост -> в радар (сверху) + алерт в ТГ «комментируй первым».
async function checkCreators(page: Page): Promise<void> {
  const { rows: creators } = await query<Record<string, any>>(
    `SELECT id, username, last_codes FROM radar_creators WHERE enabled=true ORDER BY checked_at ASC NULLS FIRST`);
  for (const cr of creators) {
    const codes = await readCreatorCodes(page, cr.username).catch(() => [] as string[]);
    await query(`UPDATE radar_creators SET checked_at=now() WHERE id=$1`, [cr.id]).catch(() => {});
    if (!codes.length) continue;
    const prev: string[] = Array.isArray(cr.last_codes) ? cr.last_codes : [];
    if (!prev.length) { // первый заход — базовая линия, без алерта
      await query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(codes)]).catch(() => {});
      continue;
    }
    const fresh = codes.filter((c) => !prev.includes(c)); // новые = чего не было
    for (const code of fresh.slice(0, 3)) {
      const url = `https://www.instagram.com/p/${code}/`;
      const p = await readPost(page, url).catch(() => null);
      await query(
        `INSERT INTO radar_posts (code, tag, url, image_url, caption, comment_count, like_count, status, source, relevance, score, last_comment_at, taken_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'new','creator',90,90,$8,$9)
         ON CONFLICT (code) DO UPDATE SET status='new', source='creator', score=greatest(radar_posts.score,90)`,
        [code, `креатор @${cr.username}`, p?.url || url, p?.image_url || '', p?.caption || '', p?.comment_count || 0, p?.like_count || 0, p?.last_comment_at || null, p?.taken_at || null],
      ).catch(() => {});
      await notifyOwner(`🆕 Новый пост у @${cr.username} — комментируй ПЕРВЫМ!\n${url}`, { force: true });
      console.log(`[radar] новый пост креатора @${cr.username}: ${code}`);
    }
    await query(`UPDATE radar_creators SET last_codes=$2 WHERE id=$1`, [cr.id, JSON.stringify(codes)]).catch(() => {});
  }
}

// Перечитать НЕСКОЛЬКО существующих постов панели (самые давно проверенные), обновить их живость
// и УДАЛИТЬ утонувшие — где нет новых комментов больше 2 дней. За несколько заходов покрываем все посты.
async function recheckPosts(page: Page, limit = 5): Promise<void> {
  // Перечитываем и НЕОТРАБОТАННЫЕ ('new'), и УЖЕ ОТРАБОТАННЫЕ недавно ('replied' с worked_count) —
  // у последних ловим прирост комментов (докомментить). Креаторские/ручные не трогаем.
  const { rows } = await query<{ code: string; url: string; status: string; worked_count: number | null; recomment_at: Date | null }>(
    `SELECT code, url, status, worked_count, recomment_at FROM radar_posts
     WHERE coalesce(source,'') NOT IN ('creator','manual')
       AND (status='new' OR (status='replied' AND worked_count IS NOT NULL AND coalesce(rechecked_at, created_at) > now() - interval '4 days'))
     ORDER BY rechecked_at ASC NULLS FIRST LIMIT ${limit}`);
  const MAX_STALE_DAYS = Number(process.env.RADAR_MAX_STALE_DAYS) || 4;
  const RECOMMENT_MIN = Number(process.env.RADAR_RECOMMENT_MIN) || 15; // +N новых комментов = повод докомментить
  for (const post of rows) {
    const p = await readPost(page, post.url).catch(() => null);
    if (!p) { await query(`UPDATE radar_posts SET rechecked_at=now() WHERE code=$1`, [post.code]).catch(() => {}); continue; }
    const sunk = p.last_comment_at !== null && (Date.now() - Date.parse(p.last_comment_at)) > MAX_STALE_DAYS * 86400000;
    if (sunk) {
      await query(`DELETE FROM radar_posts WHERE code=$1`, [post.code]).catch(() => {});
      console.log(`[radar] recheck: мёртвый (посл. коммент >${MAX_STALE_DAYS} дн), удалён ${post.code}`);
      continue;
    }
    // ПЕРЕПРОВЕРКА ФИЛЬТРОВ на recheck: не русский / офтоп / мало комментов (ВОЗРАСТНОЙ порог — свежий
    // пост с малым числом комментов НЕ режем, он ещё на взлёте) → удаляем.
    const FRESH_MIN = Number(process.env.RADAR_FRESH_MIN_COMMENTS) || 5;
    const OLD_MIN = Number(process.env.RADAR_MIN_COMMENTS) || 15;
    const rcAge = p.taken_at ? (Date.now() - Date.parse(p.taken_at)) / 86400000 : null;
    const rcMin = (rcAge !== null && rcAge <= 2) ? FRESH_MIN : OLD_MIN;
    const badReason = !p.ru ? 'не русский' : p.offtopic ? 'офтоп' : p.comment_count < rcMin ? `<${rcMin} комментов` : null;
    if (badReason) {
      await query(`DELETE FROM radar_posts WHERE code=$1`, [post.code]).catch(() => {});
      console.log(`[radar] recheck: ${badReason}, удалён ${post.code}`);
      continue;
    }
    await query(
      `UPDATE radar_posts SET comment_count=$2, like_count=$3, recent_comments=$4, last_comment_at=coalesce($5, last_comment_at), rechecked_at=now() WHERE code=$1`,
      [post.code, p.comment_count, p.like_count, p.recent_comments, p.last_comment_at],
    ).catch(() => {});
    // ДОКОММЕНТ: пост уже отработан, но набежали НОВЫЕ комменты (+RECOMMENT_MIN) и пост живой (посл. коммент
    // ≤2ч ИЛИ есть свежий спрос) → воскрешаем в панель + увед «докомментить парой акков». Троттлинг ~6ч.
    if (post.status === 'replied' && post.worked_count !== null) {
      const grew = p.comment_count - post.worked_count;
      const freshActivity = p.comments_last_2h >= 2 || (p.last_comment_at !== null && Date.now() - Date.parse(p.last_comment_at) < 2 * 3600000);
      const cooled = !post.recomment_at || (Date.now() - post.recomment_at.getTime()) > 6 * 3600000;
      if (grew >= RECOMMENT_MIN && freshActivity && cooled) {
        await query(`UPDATE radar_posts SET status='new', queued_at=now(), recomment_at=now() WHERE code=$1`, [post.code]).catch(() => {});
        await notifyWithButtons(
          `🔁 Докомментить: пост уже отрабатывали, набежало +${grew} новых комментов (свежие ≤2ч). Пройтись парой акков по новым спрашивающим?\n${post.url}`,
          [{ text: '🚀 В работу', data: `q:${post.code}` }, { text: '✕ Позже', data: `s:${post.code}` }],
        ).catch(() => {});
        console.log(`[radar] recheck: докомментить ${post.code} (+${grew} новых)`);
      }
    }
  }
  if (rows.length) console.log(`[radar] recheck: перечитано ${rows.length} постов`);
}

let lastRadar = 0;
let lastCreators = 0;
const CREATOR_EVERY = Number(process.env.CREATOR_EVERY_MS) || 12 * 60 * 60 * 1000; // проверка креаторов ~2 раза в день

// === ОБУЧЕНИЕ ФРАЗ === из подписей АКТИВНЫХ постов (свежих, со спросом, что реально прошли фильтр) достаём
// 2-3-словные ниша-фразы → ищем по ним ещё похожие. Само-усиление: что работает → ищем такое же. Раньше
// фразы были зашиты статично; теперь радар подхватывает язык живых постов панели.
const NICHE_WORDS = ['нейросет', 'нейронк', 'промпт', 'промт', 'gpt', 'чат гпт', 'бьюти', 'разбор внешн', 'подбор стрижк', 'подбор цвета', 'ии фото', 'ии-фото', 'нейрофото', 'оживить фото', 'сгенер', 'nano banana', 'нано банан'];
async function phrasesFromActivePosts(): Promise<string[]> {
  try {
    const { rows } = await query<{ cap: string }>(
      `SELECT coalesce(caption,'') cap FROM radar_posts WHERE status='new' AND coalesce(demand_hits,0)>=1
         AND created_at > now() - interval '5 days' ORDER BY score DESC LIMIT 15`);
    const freq = new Map<string, number>();
    for (const r of rows) {
      const low = r.cap.toLowerCase().replace(/[^0-9a-zа-яё ]/gi, ' ').replace(/\s+/g, ' ').trim();
      const w = low.split(' ').filter(Boolean);
      for (let i = 0; i < w.length; i++) for (const len of [2, 3]) {
        const win = w.slice(i, i + len); if (win.length < len) continue;
        const ph = win.join(' ');
        if (NICHE_WORDS.some((k) => ph.includes(k)) && (ph.match(/[а-яё]/g) || []).length >= 6) freq.set(ph, (freq.get(ph) || 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]);
  } catch { return []; }
}

export async function maybeRadar(now: Date): Promise<void> {
  const { rows: cfg } = await query<{ tags: string; enabled: boolean }>(`SELECT tags, enabled FROM radar_config WHERE id=1`);
  if (!cfg[0]?.enabled) return;
  if (Date.now() < radarPauseUntil) return; // IG троттлит искателя (429) — отдыхаем, не долбим

  // Адаптивный ритм. Один слот GoLogin делят радар и аккаунты (прогрев/комменты),
  // поэтому нон-стоп невозможен без голодания аккаунтов. Компромисс: когда свежих
  // постов в панели мало — сканим часто (наполняем очередь, «первое время»);
  // когда очередь набита — отходим, отдаём слот аккаунтам.
  // МИН 5 мин: чаще нельзя — IG даёт 429 (искателя рейтлимитит), и весь скан возвращает мусор.
  const RADAR_MIN = Number(process.env.RADAR_MIN_MS) || 5 * 60 * 1000;   // очередь пустая — но не чаще 5 мин
  const RADAR_MAX = Number(process.env.RADAR_MAX_MS) || 12 * 60 * 1000;  // очередь полная — спокойно
  const FRESH_TARGET = Number(process.env.RADAR_FRESH_TARGET) || 20;
  const { rows: fr } = await query<{ n: string }>(`SELECT count(*) AS n FROM radar_posts WHERE status='new'`);
  const fresh = Number(fr[0]?.n || 0);
  const every = fresh < FRESH_TARGET ? RADAR_MIN : RADAR_MAX;
  if (now.getTime() - lastRadar < every) return;
  // Фразы панели (radar_config.tags) — теперь ФОЛБЭК: сканим по трендам, а по общим фразам —
  // только когда трендовые ничего не вернули (пустая выдача бывает).
  const phrases = String(cfg[0].tags || '').split(',').map((s) => s.trim()).filter(Boolean);

  const { rows: rd } = await query<{ id: string; gologin_profile_id: string; group_token: string | null }>(
    `SELECT a.id, a.gologin_profile_id, g.gologin_token AS group_token
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.ig_role='reader' AND a.gologin_profile_id IS NOT NULL LIMIT 1`);
  const reader = rd[0];
  if (!reader) return;

  lastRadar = now.getTime(); // отмечаем СРАЗУ, чтобы не входить каждый тик

  // Чистка панели: удаляем МЁРТВЫЕ посты (последний коммент старше 4 суток) — ЖЁСТКО, без исключений
  // для больших/высокоспросных (правило юзера: отвечать там уже некому). Креаторские/ручные не трогаем.
  await query(
    `DELETE FROM radar_posts WHERE status='new' AND coalesce(source,'') NOT IN ('creator','manual')
       AND last_comment_at IS NOT NULL AND last_comment_at < now() - interval '${Number(process.env.RADAR_MAX_STALE_DAYS) || 4} days'`,
  ).then((r) => { if (r.rowCount) console.log(`[radar] чистка: удалено мёртвых постов ${r.rowCount}`); }).catch(() => {});
  // Кандидаты на поиск: СНАЧАЛА трендовые фразы (перемешаны, каждая знает свой тренд),
  // ПОТОМ общие фразы панели — они в ход идут, только если трендовые вернули 0 ссылок.
  const shuffle = <T,>(a: T[]): T[] => a.map((p) => ({ p, r: Math.random() })).sort((x, y) => x.r - y.r).map((x) => x.p);
  type Cand = { phrase: string; trend: Trend | null };
  // Выученные фразы с активных постов — приоритетно (свежайший сигнал «что работает»), потом тренд-фразы,
  // потом запасные теги панели. Дедуп: одну и ту же фразу не гоняем дважды.
  const learned = await phrasesFromActivePosts();
  if (learned.length) console.log(`[radar] выученные фразы с активных постов: ${learned.join(' | ')}`);
  const seen = new Set<string>();
  const uniq = (cands: Cand[]) => cands.filter((c) => { const k = c.phrase.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const order: Cand[] = [
    ...uniq(shuffle(learned.map((phrase) => ({ phrase, trend: null as Trend | null })))),
    ...uniq(shuffle(TRENDS.flatMap((t) => t.phrases.map((phrase) => ({ phrase, trend: t }))))),
    ...uniq(shuffle(phrases.map((phrase) => ({ phrase, trend: null as Trend | null })))),
  ];
  if (!order.length) return;
  let cand = order[0];

  // ОБУЧЕНИЕ: юзер оценивает посты 1-10 → считаем средний рейтинг на фразу. «Хорошая» фраза поднимает
  // скоринг своих постов, «плохая» — опускает. Мало оценок (n<2) — не влияем.
  const pq = new Map<string, { avg: number; n: number }>();
  try {
    const qr = await query<{ tag: string; avg: number; n: number }>(
      `SELECT tag, avg(rating)::float AS avg, count(*)::int AS n FROM radar_posts WHERE rating IS NOT NULL AND coalesce(tag,'')<>'' GROUP BY tag`);
    for (const r of qr.rows) pq.set(r.tag, { avg: r.avg, n: r.n });
  } catch { /* нет оценок — сканим без буста */ }
  const phraseBoost = (t: string): number => {
    const q = pq.get(t);
    if (!q || q.n < 2) return 0;
    return Math.max(-15, Math.min(15, Math.round((q.avg - 5) * 3))); // avg5=0, 8→+9, 2→−9, кламп ±15
  };

  await withBrowserLock(async () => {
    let session: Session | null = null;
    try {
      // ВАЖНО: профиль искателя может жить под ТОКЕНОМ ГРУППЫ (напр. «РАБОЧИЕ АККИ» — свой GoLogin-акк):
      // коннект env-токеном к чужому профилю даёт 503. Передаём токен группы, если он есть.
      session = await connect(reader.gologin_profile_id, reader.group_token);
      const ok = await ensureLoggedIn(session.page);
      console.log(`[radar] искатель вошёл: ${ok}`);
      if (!ok) {
        // Искатель разлогинен. Транзиентный сбой (GoLogin шторм) — переживём; но 2 раза подряд = реально
        // выпал → АВТО-РОТАЦИЯ на живой акк (раньше висел вечными «дожми вход», радар стоял до ручного входа).
        await query(`UPDATE accounts SET session_status='dead' WHERE id=$1`, [reader.id]).catch(() => {});
        const { rows: st } = await query<{ n: string }>(
          `UPDATE accounts SET reader_strikes=coalesce(reader_strikes,0)+1 WHERE id=$1 RETURNING reader_strikes AS n`, [reader.id]).catch(() => ({ rows: [] as { n: string }[] }));
        const strikes = Number(st[0]?.n || 1);
        if (strikes >= 2) await rotateReader(reader.id, `разлогинен ${strikes}×`);
        else await logError('radar', 'искатель не залогинен', 'дожми вход в GoLogin; при повторе сменю искателя авто');
        return;
      }
      await query(`UPDATE accounts SET session_status='live', session_checked_at=now() WHERE id=$1`, [reader.id]).catch(() => {});

      // До 3 фраз за заход: берём первую, что вернула посты (трендовые идут первыми).
      let links: string[] = [];
      for (const c of order.slice(0, 3)) {
        cand = c;
        links = await searchPosts(session.page, c.phrase);
        if (links.length) break;
      }
      const tagLabel = cand.trend ? cand.trend.name : cand.phrase; // метка в панели + ключ обучения оценками
      console.log(`[radar] «${cand.phrase}»${cand.trend ? ` [${cand.trend.name}]` : ''}: поиск дал ${links.length} ссылок`);
      let kept = 0;
      // МЕДЛЕННЕЕ: меньше постов за заход (8) + пауза 4-8с между чтениями — иначе IG даёт 429 и весь скан
      // возвращает мусор (было comment_count=4 = экран ошибки). При серии 429 обрываем заход.
      const scanN = Number(process.env.RADAR_SCAN_N) || 8;
      for (const url of links.slice(0, scanN)) {
        const p = await readPost(session.page, url);
        await session.page.waitForTimeout(4000 + Math.floor(Math.random() * 4000)); // 4-8с между постами
        if (radar429Streak() >= 3) { radarPauseUntil = Date.now() + 40 * 60 * 1000; console.warn('[radar] серия 429 — обрываю заход + пауза 40 мин, IG троттлит искателя'); break; }
        if (!p) continue;
        // ОБЪЁМ (ВОЗРАСТНОЙ ПОРОГ): свежий пост (≤2 дня) ловим НА ВЗЛЁТЕ — хватит FRESH_MIN комментов
        // (успеем первыми, пока набирает); старше — нужно OLD_MIN (иначе мелкий мёртвый). Даты нет → строгий OLD_MIN.
        const FRESH_MIN = Number(process.env.RADAR_FRESH_MIN_COMMENTS) || 5;
        const OLD_MIN = Number(process.env.RADAR_MIN_COMMENTS) || 15;
        const ageDays = p.taken_at ? (now.getTime() - Date.parse(p.taken_at)) / 86400000 : null;
        const minComments = (ageDays !== null && ageDays <= 2) ? FRESH_MIN : OLD_MIN;
        if (p.comment_count < minComments) { console.log(`[radar] ${p.code}: комментов ${p.comment_count} < ${minComments} (${ageDays !== null && ageDays <= 2 ? 'свежий' : 'старый'}) — мимо`); continue; }
        // ЯЗЫК: берём только русскоязычные посты — наша ЦА (нейронка без впн, картой РФ) русская.
        if (!p.ru) { console.log(`[radar] ${p.code}: не русскоязычный — мимо`); continue; }
        // ТЕМАТИКА: психология/заработок/эзотерика и т.п. — не наше, даже если там просят промпты.
        if (p.offtopic) { console.log(`[radar] ${p.code}: не наша тематика (психология/заработок и т.п.) — мимо`); continue; }
        const low = p.caption.toLowerCase();
        const capRel = CAP.some((w) => low.includes(w));
        // ТРЕНД ОПРЕДЕЛЯЕМ ПО ПОДПИСИ поста (а НЕ по фразе, которой искали): пост попадает в тренд, если
        // его подпись содержит слова тренда. Значит любой трендовый пост получит метку «тренд: …» —
        // видно в панели, к какому тренду он относится, независимо от того, как его нашли.
        const capTrend = TRENDS.find((t) => t.match.some((w) => low.includes(w)));
        const trendHit = !!capTrend;
        const postTag = capTrend ? capTrend.name : tagLabel; // тег поста = имя тренда (если попал) / иначе фраза
        if (p.demand === 0 && !capRel && !trendHit) continue; // не релевантно — мимо
        // Режем только ЯВНЫЙ бизнес-фаннел/спам (курсы/марафоны/тг-ссылки) — но НЕ «ссылка в шапке»
        // и не «в директ» (это почти все ИИ-посты, иначе список пустеет). Их берём, но отвечаем по делу.
        if (/t\.me\/|https?:\/\/\S+|мой курс|курс по|обучени|марафон|инфопрод|розыгрыш|гивэвей|giveaway/.test(low)) continue;
        // ЖИВОСТЬ. Пост «утонул», если он НЕ свежак И за 2 дня в нём нет хотя бы 2 комментов — такой
        // никому не нужен, не берём. Свежак (пост младше 2 суток) берём даже без комментов — успеем первыми.
        const postAgeDays = p.taken_at ? (now.getTime() - Date.parse(p.taken_at)) / 86400000 : null;
        const activityDays = p.last_comment_at ? (now.getTime() - Date.parse(p.last_comment_at)) / 86400000 : null;
        // ЖЁСТКОЕ ПРАВИЛО (юзер): последний коммент старше 4 дней = мёртвый пост, НИКОГДА не берём (без
        // исключений для больших/трендовых — отвечать там уже некому, лента ушла).
        const MAX_STALE_DAYS = Number(process.env.RADAR_MAX_STALE_DAYS) || 4;
        if (activityDays !== null && activityDays > MAX_STALE_DAYS) { console.log(`[radar] ${p.code}: мёртвый (посл. коммент ${activityDays.toFixed(1)} дн > ${MAX_STALE_DAYS}) — мимо`); continue; }
        const isBrandNew = postAgeDays !== null && postAgeDays <= 2;
        const highDemand = p.demand >= 3; // много НЕОТВЕЧЕННОГО спроса (впн/платный/промт) — ценно даже старый
        if (activityDays !== null) {
          // Утонул — нет новых комментов больше 2 дней. НЕ режем, если: пост большой (сотни комментов — IG
          // отдаёт даты лишь первых ~12, свежак не виден) ИЛИ высокий спрос (люди спрашивают доступ — это лиды).
          if (!isBrandNew && !highDemand && activityDays > 2 && p.comment_count < 300) continue;
        } else if (p.demand === 0 && p.comment_count < 8 && !trendHit) {
          continue; // дат нет (IG не отдал <time>) — судим по объёму: пусто, без спроса и не тренд — мимо
        }
        // СКОРИНГ: спрос («где сделать / дайте промпт») — сильнее всего; затем вовлечённость
        // (комменты + лайки, лог-шкала); затем свежесть активности + бонус свежему посту.
        const relevance = Math.min(100, Math.min(60, p.demand * 15) + (capRel ? 30 : 0) + (trendHit ? 40 : 0)); // для фильтра панели
        const demandScore = Math.min(45, p.demand * 12) + (capRel ? 10 : 0);
        const engageScore = Math.min(20, Math.round(Math.log10(p.comment_count + 1) * 12))
                          + Math.min(15, Math.round(Math.log10(p.like_count + 1) * 6));
        const recentScore = Math.min(20, p.recent_comments * 5) + (isBrandNew ? 8 : 0);
        // Подтверждённый тренд — наш формат, комментарий «делал в нейронке» попадает в точку: буст,
        // свежему трендовому — двойной (успеть первыми, пока в комментах просят промт).
        const trendScore = trendHit ? (isBrandNew ? 25 : 14) : 0;
        let score = demandScore + engageScore + recentScore + trendScore + phraseBoost(postTag);
        // === РУБРИКА ВЫДАЧИ === приоритет = ЖИВОЙ неотвеченный спрос (прям сейчас просят промпт).
        const fresh = p.comments_last_hour >= 2 || p.recent_comments >= 5; // 2+/час (день) ИЛИ 5+/2дня (ночь)
        const stale = activityDays !== null && activityDays > 3 && p.comments_last_hour === 0; // последний коммент >3 дней = мёртвый
        const answeredRatio = p.demand > 0 ? p.author_replies / p.demand : 0;
        const notAnswered = p.demand >= 2 && answeredRatio < 0.5; // спрос есть, а креатор его не отвечает
        if (p.dm_bait) {
          score = Math.min(score, 22); // креатор ловит лиды в ЛС — наш коммент бесполезен, топим
        } else if (notAnswered && fresh) {
          score += 28; // ЖИВОЙ неотвеченный спрос — топ-кейс 10/10, влезаем и отвечаем
        } else if (notAnswered) {
          score += 6; // неотвечено, но не свежак — чуть выше нуля
        } else if (p.demand >= 1 && answeredRatio >= 0.7) {
          score -= 18; // почти всё отвечено — нам места нет
        }
        // Старый/мёртвый пост (типа DIekicisqpC, коммент недели назад) — НЕ выкидываем (плашку кинуть можно),
        // но жёстко вниз приоритета: 3-4/10. Живые посты всегда выше.
        if (stale) score = Math.min(score, 38);
        score = Math.max(0, Math.min(100, Math.round(score)));
        // Варианты/промпт НЕ генерим тут (тормозило скан) — они делаются лениво: варианты при открытии
        // окна ответа, промпт под пост — при отправке. Скан остаётся быстрым.
        await query(
          `INSERT INTO radar_posts (code, tag, url, image_url, caption, comment_count, like_count, recent_comments, demand_hits, relevance, score, last_comment_at, taken_at, dm_bait, author_replies, audio_id, audio_title)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (code) DO UPDATE SET
             image_url=coalesce(nullif(excluded.image_url,''), radar_posts.image_url),
             caption=excluded.caption, comment_count=excluded.comment_count, like_count=excluded.like_count,
             recent_comments=excluded.recent_comments, demand_hits=excluded.demand_hits,
             relevance=excluded.relevance, score=excluded.score, last_comment_at=excluded.last_comment_at, taken_at=excluded.taken_at,
             dm_bait=excluded.dm_bait, author_replies=excluded.author_replies,
             audio_id=coalesce(nullif(excluded.audio_id,''), radar_posts.audio_id), audio_title=coalesce(nullif(excluded.audio_title,''), radar_posts.audio_title)
           WHERE radar_posts.status='new'`,
          [p.code, postTag, p.url, p.image_url, p.caption, p.comment_count, p.like_count, p.recent_comments, p.demand, relevance, score, p.last_comment_at, p.taken_at, p.dm_bait, p.author_replies, p.audio_id || null, p.audio_title || null],
        ).then(() => kept++).catch(() => {});
        // АУДИО-ТРЕНД: у ТРЕНДОВОГО рилса есть саунд → регистрируем/считаем его в radar_audios (популярные
        // саунды = кандидаты на аудио-поиск свежих рилсов). Копим сейчас; сканер аудио-страниц — следующим шагом.
        if (trendHit && p.audio_id) {
          await query(
            `INSERT INTO radar_audios (audio_id, title) VALUES ($1,$2)
             ON CONFLICT (audio_id) DO UPDATE SET seen_count=radar_audios.seen_count+1, title=coalesce(nullif(excluded.title,''), radar_audios.title)`,
            [p.audio_id, p.audio_title || null]).catch(() => {});
          console.log(`[radar] 🎵 трендовый саунд: ${p.audio_title || p.audio_id} (пост ${p.code})`);
        }
        // 🚀 ВИРАЛ-УВЕД: пост НАБИРАЕТ (10+ комментов за 2ч) — шлём владельцу один раз (hot_alerted), он
        // решает, брать ли в работу (жмёт 🚀 в панели). Порог по СКОРОСТИ, не по абсолютному числу/скору.
        const HOT_2H = Number(process.env.RADAR_HOT_2H) || 10;
        if (p.comments_last_2h >= HOT_2H) {
          const { rows: ha } = await query<{ hot_alerted: boolean }>(
            `UPDATE radar_posts SET hot_alerted=true WHERE code=$1 AND status='new' AND hot_alerted=false RETURNING hot_alerted`, [p.code]).catch(() => ({ rows: [] as any[] }));
          if (ha.length) {
            // ИСТОРИЯ: если пост уже в работе или мы уже кому-то отвечали — сразу пишем в уведе, чтобы не
            // толкать на повторную отработку вслепую.
            const { rows: hist } = await query<{ answered: string; queued: boolean }>(
              `SELECT (SELECT count(*) FROM radar_reply_targets t WHERE t.post_code=$1) AS answered,
                      (SELECT queued_at IS NOT NULL FROM radar_posts WHERE code=$1) AS queued`, [p.code]).catch(() => ({ rows: [] as any[] }));
            const answered = Number(hist[0]?.answered || 0);
            const histNote = (hist[0]?.queued ? ' · ⚠ уже в работе' : '') + (answered > 0 ? ` · ⚠ уже ответили ${answered}` : '');
            // Кнопки прямо в ТГ: подтверждаешь «в работу» / «пропустить» не открывая панель.
            await notifyWithButtons(
              `🚀 Вирал набирает: ${p.comments_last_2h} комментов за 2ч${postTag.startsWith('тренд') ? ` · ${postTag}` : ''} · спрос ${p.demand}${histNote}\n${p.url}`,
              [{ text: '🚀 В работу', data: `q:${p.code}` }, { text: '✕ Пропустить', data: `s:${p.code}` }],
            ).catch(() => {});
            console.log(`[radar] 🚀 вирал-увед: ${p.code} (${p.comments_last_2h}/2ч)${histNote}`);
          }
        }
      }
      console.log(`[radar] «${cand.phrase}»: из ${links.length} постов в панель попало ${kept}`);
      // === РОТАЦИЯ ИСКАТЕЛЯ === IG задушил скан серией 429 → страйк: 1-й — отдых 40 мин, 2-й — 80 мин.
      // 3 подряд = искатель «в спаме» и не фиксится отдыхом → ВЫКИДЫВАЕМ: снимаем роль, читателем сажаем
      // наименее занятый живой рабочий акк (комментит меньше всех — не жалко под чтение). Чистый скан = сброс.
      if (radarThrottled()) {
        const { rows: st } = await query<{ n: string }>(
          `UPDATE accounts SET reader_strikes=coalesce(reader_strikes,0)+1 WHERE id=$1 RETURNING reader_strikes AS n`, [reader.id]);
        const strikes = Number(st[0]?.n || 1);
        if (strikes >= 3) {
          await rotateReader(reader.id, '3 серии 429 подряд');
        } else {
          radarPauseUntil = Date.now() + strikes * 40 * 60 * 1000; // страйк 1 → 40 мин, страйк 2 → 80 мин
          console.log(`[radar] искатель под 429 (страйк ${strikes}/3) — отдых ${strikes * 40} мин`);
        }
        return; // recheck и креаторов НЕ гоняем: каждое лишнее чтение продлевает бан
      }
      // Скан чистый — искатель здоров, страйки сбрасываем.
      await query(`UPDATE accounts SET reader_strikes=0 WHERE id=$1 AND coalesce(reader_strikes,0)>0`, [reader.id]).catch(() => {});
      // Перечитываем пачку существующих постов панели — обновляем живость, удаляем утонувшие.
      await recheckPosts(session.page, Number(process.env.RADAR_RECHECK) || 5).catch((e) => console.warn('[radar] recheck:', e instanceof Error ? e.message.slice(0, 100) : e));
      // Креаторов проверяем РЕДКО (~2 раза в день), а не каждый заход — не гоняем искателя по профилям.
      if (Date.now() - lastCreators > CREATOR_EVERY) {
        lastCreators = Date.now();
        await checkCreators(session.page).catch((e) => console.warn('[radar] креаторы:', e instanceof Error ? e.message.slice(0, 100) : e));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[radar] сбой:', msg.slice(0, 140));
      await logError('radar', 'браузерный радар упал', msg.slice(0, 300));
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey(reader.group_token)); // замок GoLogin-акка ИСКАТЕЛЯ (токен группы, если есть; иначе env-акк1)
}
