// IGLIB — ЕДИНСТВЕННЫЙ модуль работы с интерфейсом Instagram (контракт после разбора ошибок 31.07).
// Правила, которые этот модуль воплощает (нарушать нельзя, копировать логику в другие файлы нельзя):
//   1. Состояние экрана определяется ПОЛОЖИТЕЛЬНЫМ признаком (кука/URL/уникальный элемент), не отсутствием.
//   2. Порядок классификации: от самого специфичного к общему; «не понял» = unknown, никогда не «ок».
//   3. Ввод только в ВИДИМЫЙ и редактируемый элемент; после ввода текст читается ОБРАТНО из того же узла.
//   4. Каждый провал шага несёт причину + скрин + дамп видимых кнопок (отладка по своим логам, не по чужим скринам).
//   5. Модуль НЕ пишет в БД и НЕ судит аккаунты — только возвращает факты вызывающему.
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── скрин + дамп ────────────────────────────────────────────────────────────
// ТЕГ ПРОГОНА В ИМЕНИ СКРИНА (07.08). Скрины провалов писались как fail_3_диалог_создания.jpg
// без имени аккаунта, и КАЖДЫЙ следующий прогон затирал предыдущий: разбор пяти провалов подряд
// опирался на один файл от последнего акка. Тег ставит вызывающий (у публикатора это post2_<slug>).
let __shotTag = '';
function setShotTag(t) { __shotTag = String(t || '').replace(/[^\wЀ-ӿ.-]+/g, '_').slice(0, 40); }
async function snap(page, dir, tag) {
  const file = `${dir}/${tag}.jpg`;
  try { fs.writeFileSync(file, await page.screenshot({ type: 'jpeg', quality: 50, timeout: 12000 })); return file; } catch { return null; }
}
// Видимые кнопки/иконки + url — чтобы чинить селекторы по факту
async function dumpUI(page) {
  const url = page.url();
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('button,div[role="button"],a[role="link"],svg[aria-label]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim())
      .filter(Boolean).slice(0, 25),
  ).catch(() => []);
  return { url, buttons: [...new Set(btns)] };
}

// ── шаг с обязательной причиной провала ─────────────────────────────────────
// step(page, dir, name, fn): fn кидает Error с причиной → ловим, снимаем скрин+дамп, кидаем дальше
// с контекстом. Молчаливых catch{} в вызывающем коде быть не должно.
let __stepNo = 0;
async function step(page, dir, name, fn) {
  const no = ++__stepNo;
  process.stdout.write(`  → ${name}… `);
  try { const v = await fn(); console.log('ok'); return v; }
  catch (e) {
    console.log('ПРОВАЛ');
    // Имя шага кириллицей → \W съедает всё; нумеруем, иначе все скрины пишутся в один файл.
    const shot = await snap(page, dir, `fail_${__shotTag ? __shotTag + '_' : ''}${no}_${name.replace(/[^\wЀ-ӿ]+/g, '_')}`);
    const ui = await dumpUI(page);
    // ЖИВА ЛИ ВООБЩЕ СТРАНИЦА (07.08). Два провала «рабочий диалог закрылся» оказались смертью
    // окна: скрин не снялся, дамп кнопок пришёл пустым, а причина указывала на интерфейс — и
    // разбор пошёл по ложному следу. Мёртвую страницу называем прямо, это разные болезни.
    const live = await pageAlive(page);
    console.log(`    причина: ${e.message}`);
    console.log(`    url: ${ui.url}`);
    console.log(`    видимые кнопки: ${JSON.stringify(ui.buttons)}`);
    if (!live.alive) console.log(`    ⛔ СТРАНИЦА НЕ ОТВЕЧАЕТ [${live.kind}]: ${live.why} — интерфейс тут ни при чём, поэтому и дамп пуст`);
    if (shot) console.log(`    скрин: ${shot}`);
    const err = new Error(`[${name}] ${e.message}` + (live.alive ? '' : ` | СТРАНИЦА НЕ ОТВЕЧАЕТ (${live.kind}): ${live.why}`));
    err.stepName = name; err.shot = shot; err.ui = ui; err.pageDead = !live.alive; err.pageState = live.kind;
    throw err;
  }
}

// ── жива ли страница ────────────────────────────────────────────────────────
// Дешёвый положительный признак: страница отвечает на evaluate.
// ТРИ РАЗНЫХ СОСТОЯНИЯ, которые раньше сваливались в одно «диалог закрылся» (07.08):
//   closed — окно закрыли снаружи (closeone, чужой pkill), лечить нечем;
//   unresponsive — главный поток занят (Instagram жмёт видео в самом браузере после загрузки
//     файла) ЛИБО упал рендерер. В этот момент ЛЮБАЯ проверка через locator/evaluate молча
//     отдаёт «ничего не нашёл»: count() и isVisible() обёрнуты в catch, скрин не снимается, дамп
//     кнопок приходит пустым. Именно так выглядели провалы savion8683 и promt.vibe.lab: url есть
//     (он не требует рендерера), а всё остальное пусто. Занятость — состояние ВРЕМЕННОЕ, ждать.
async function pageAlive(page, waitMs = 5000) {
  try { if (typeof page.isClosed === 'function' && page.isClosed()) return { alive: false, kind: 'closed', why: 'страница закрыта' }; } catch {}
  const busy = Symbol('busy');
  try {
    const r = await Promise.race([page.evaluate(() => 1), sleep(waitMs).then(() => busy)]);
    if (r === busy) return { alive: false, kind: 'unresponsive', why: `страница не отвечает ${waitMs} мс (рендерер занят обработкой видео или упал)` };
    return { alive: true, kind: 'ok', why: null };
  } catch (e) {
    const msg = String(e.message).split('\n')[0].slice(0, 120);
    return { alive: false, kind: /closed/i.test(msg) ? 'closed' : 'unresponsive', why: msg };
  }
}

// ── куки ────────────────────────────────────────────────────────────────────
function normCookies(raw) {
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (Array.isArray(arr) ? arr : []).filter((x) => x && x.name && x.value).map((x) => ({
    name: x.name, value: String(x.value), domain: x.domain || '.instagram.com', path: x.path || '/',
    httpOnly: !!x.httpOnly, secure: x.secure !== false,
    ...(x.expires && x.expires > 0 ? { expires: Math.floor(x.expires) } : {}),
  }));
}
const pickCookie = (cks, name) => (cks.find((x) => x.name === name) || {}).value || null;

// ── классификация экрана ────────────────────────────────────────────────────
// От специфичного к общему. Каждый вердикт = положительное доказательство.
// dsUserId в logged_in — ЧЕЙ это логин (сверять с ожидаемым делает вызывающий).
async function classifyScreen(ctx, page) {
  const url = page.url();
  const visible = (sel) => page.locator(sel).first().isVisible({ timeout: 1500 }).catch(() => false);

  // URL — самый честный признак. Урок 01.08: экран «Confirm you're human» на /accounts/suspended/ это
  // НЕ проверка на человека, а форма ОБЖАЛОВАНИЯ БЛОКИРОВКИ. Раньше путали и считали акк «живым, но с капчей».
  if (/\/accounts\/suspended\//.test(url)) return { state: 'suspended', evidence: `url ${url.slice(0, 60)}` };
  if (/\/challenge\//.test(url)) return { state: 'challenge', evidence: `url ${url}` };
  // «Your email may not be secure» (08.08, neuro.vibe.club39). Это ТОЖЕ челлендж, но живёт он НЕ на
  // /challenge/, а на /accounts/update_risky_contactpoint/, поэтому правило выше его не ловило: акк
  // выглядел живым, задача публикации крутилась впустую и упиралась в этот экран молча.
  // Смысл экрана: почта акка засвечена (у купленных она общая с другими акками прежнего владельца),
  // и IG держит вход, пока не привяжут ДРУГУЮ почту. Снимается только руками начальника: код
  // приходит на новый ящик, и прочитать его может лишь он. Автовходом не лечится, поэтому терминал.
  if (/update_risky_contactpoint/.test(url)) {
    return { state: 'needs_email_change', evidence: 'IG: почта небезопасна, требует привязать другую (руками)' };
  }
  if (await visible('text=/confirm you.?re human|подтвердите, что вы человек/i')) return { state: 'captcha', evidence: 'текст капчи' };
  if (/two_factor|2fa/.test(url) && await visible('input[name="verificationCode"]')) return { state: 'twofactor', evidence: 'url two_factor + видимое поле кода' };
  // «Пароль не подошёл» — это про КРЕДЫ в нашей базе, а не про акк: он жив, просто данные устарели
  // или их дали неверными при покупке. Раньше приезжало как 'unknown', и мы записывали в непонятные
  // здоровый аккаунт. Проверять до общего экрана логина: там тоже видно поле пароля.
  if (await visible('text=/login information you entered is incorrect|неверные данные для входа|пароль введ[её]н неверно/i')) {
    return { state: 'bad_credentials', evidence: 'IG: введённые данные для входа неверны' };
  }
  if (await visible('input[name="password"]')) return { state: 'login', evidence: 'видимое поле пароля' };

  // Кука — источник истины логина: попапы её не перекрывают, недогруз страницы её не подделает.
  const cks = await ctx.cookies('https://www.instagram.com').catch(() => []);
  const sess = cks.find((x) => x.name === 'sessionid' && x.value && x.value.length > 10);
  if (sess) return { state: 'logged_in', evidence: 'кука sessionid', dsUserId: (cks.find((x) => x.name === 'ds_user_id') || {}).value || null };

  // 429 = «слишком много запросов». Это про НАС (частота заходов), а не про аккаунт: 02.08 три
  // здоровых акка подряд получили этот экран после того, как постер сто раз долбанулся в мёртвый акк.
  // Раньше он приезжал как 'unknown' и акк выглядел подозрительным, хотя с ним всё в порядке.
  if (await visible('text=/HTTP ERROR 429|This page isn.?t working/i')) {
    return { state: 'rate_limited', evidence: 'HTTP 429 — режет ЧАСТОТА наших заходов, акк ни при чём' };
  }

  return { state: 'unknown', evidence: 'ни один положительный признак не совпал', ui: await dumpUI(page) };
}

// ── видимый редактируемый элемент ───────────────────────────────────────────
// Возвращает первый ВИДИМЫЙ И редактируемый матч (не первый в DOM — там часто скрытые дубли).
async function visEdit(scope, selector, timeoutMs = 6000) {
  const t0 = Date.now();
  for (;;) {
    const loc = scope.locator(selector);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false) && await el.isEditable().catch(() => false)) return el;
    }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(500);
  }
}

// Ввод с обратным чтением ИЗ ТОГО ЖЕ узла. Возврат {ok, got} — «ввели» без проверки не бывает.
// КОПИПАСТ вместо побуквенного набора (начальник 06.08: ровная машинная скорость печати =
// бот-паттерн, за это банят). insertText кладёт весь текст одним событием, как вставка Cmd+V,
// с человеческой паузой перед ней.
async function typeVerified(el, text) {
  await el.click({ timeout: 4000 });
  await sleep(300 + Math.floor(Math.random() * 500));
  await el.page().keyboard.insertText(text);
  await sleep(400);
  const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
  const got = tag === 'input' || tag === 'textarea'
    ? await el.inputValue().catch(() => '')
    : await el.evaluate((n) => n.innerText || n.textContent || '').catch(() => '');
  const clean = (s) => String(s).replace(/\s+/g, '');
  const ok = clean(got).length >= Math.floor(clean(text).length * 0.9) && clean(got).length > 0;
  return { ok, got };
}

// ── модалки ─────────────────────────────────────────────────────────────────
// Правило проекта: Escape в IG не работает; у безымянных диалогов жмём ПОСЛЕДНЮЮ кнопку.
async function dismissDialogs(page) {
  for (const rx of [/Allow all cookies|Разрешить все|Accept all/i, /^(Not now|Не сейчас|Позже|Dismiss|OK|Ок|Понятно|Got it)$/i]) {
    try {
      const b = page.getByRole('button', { name: rx }).first();
      if (await b.isVisible({ timeout: 1000 }).catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(700); }
    } catch {}
  }
  for (let i = 0; i < 3; i++) {
    try {
      const dlg = page.locator('div[role="dialog"]').first();
      if (!(await dlg.isVisible({ timeout: 800 }).catch(() => false))) break;
      // диалог с input[type=file] — рабочий (создание поста), его не гасим
      if ((await dlg.locator('input[type="file"]').count().catch(() => 0)) > 0) break;
      const btns = dlg.locator('button, div[role="button"]');
      const n = await btns.count().catch(() => 0);
      if (!n) break;
      await btns.nth(n - 1).click({ timeout: 3000 }).catch(() => {});
      await sleep(900);
    } catch { break; }
  }
}

// ── рабочий диалог создания поста vs объявление-оверлей ─────────────────────
// Факт 31.07: поверх экрана Crop всплыло объявление «Video posts are now shared as reels» с кнопкой OK.
// Клик по иконке кадрирования ушёл в оверлей и ВЫБИЛ из создания поста — дальше скрипт тыкал Next в ленте.
// Отсюда класс правил: (1) объявления гасим ПЕРЕД КАЖДЫМ действием, (2) живость рабочего диалога — инвариант.
// Признаки СТРУКТУРНЫЕ, не текстовые. Урок 01.08: текстовая эвристика приняла объявление
// «Video posts are now shared as reels» за рабочий диалог — слово «shared» матчилось на /Share/,
// объявление не гасилось, и мастер оставался перекрыт. Свободный текст к классификации не допускать.
const WIZARD_BTN_RX = /^\s*(Next|Далее|Share|Поделиться|Опубликовать|Back|Назад)\s*$/i;
const NOTICE_BTN_RX = /^\s*(OK|Ок|Got it|Понятно|Not now|Не сейчас|Dismiss|Закрыть)\s*$/i;

// Рабочий диалог мастера = файловый инпут ИЛИ его собственные кнопки навигации.
async function isWorkDialog(dlg) {
  if ((await dlg.locator('input[type="file"]').count().catch(() => 0)) > 0) return true;
  return (await dlg.getByRole('button', { name: WIZARD_BTN_RX }).count().catch(() => 0)) > 0;
}

// Объявление опознаём ПОЛОЖИТЕЛЬНО: видимая кнопка OK/Got it/Not now, которой в мастере нет.
// Ищем по всей странице — оверлей IG бывает ВЛОЖЕН в рабочий диалог, обход по диалогам его не видит.
async function dismissAnnouncements(page) {
  const killed = [];
  for (let pass = 0; pass < 4; pass++) {
    const btn = page.getByRole('button', { name: NOTICE_BTN_RX }).first();
    if (!(await btn.isVisible({ timeout: 800 }).catch(() => false))) break;
    const label = String(await btn.textContent().catch(() => '')).trim().slice(0, 20);
    if (!(await btn.click({ timeout: 3000 }).then(() => true).catch(() => false))) break;
    killed.push(label || 'объявление');
    await sleep(1200);
  }
  return killed;
}
async function workDialog(page) {
  const dlgs = page.locator('div[role="dialog"]');
  const n = await dlgs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const d = dlgs.nth(i);
    if (await d.isVisible().catch(() => false) && await isWorkDialog(d)) return d;
  }
  return null;
}
// Гасим всё, что перекрывает работу: (1) объявления по кнопке OK/Got it по ВСЕЙ странице
// (оверлей бывает вложен в рабочий диалог), (2) отдельные не-рабочие диалоги последней кнопкой.
async function clearOverlays(page) {
  const killed = await dismissAnnouncements(page);
  for (let pass = 0; pass < 3; pass++) {
    const dlgs = page.locator('div[role="dialog"]');
    const n = await dlgs.count().catch(() => 0);
    let acted = false;
    for (let i = 0; i < n; i++) {
      const d = dlgs.nth(i);
      if (!(await d.isVisible().catch(() => false))) continue;
      if (await isWorkDialog(d)) continue;
      const title = String(await d.innerText().catch(() => '')).split('\n')[0].slice(0, 60);
      // безымянный оверлей: правило проекта — жмём последнюю кнопку (Escape в IG не работает)
      const btns = d.locator('button, div[role="button"]');
      const bn = await btns.count().catch(() => 0);
      if (!bn) continue;
      await btns.nth(bn - 1).click({ timeout: 3000 }).catch(() => {});
      killed.push(title); acted = true; await sleep(900);
    }
    if (!acted) break;
  }
  return killed;
}
// Клик ТОЛЬКО по элементу (не по слепым координатам): Playwright сам проверит перекрытие
// и вернёт причину, вместо того чтобы «попасть» в оверлей и молча сломать сценарий.
// opts.skipClear — НЕ гасить оверлеи перед кликом. Урок 01.08: меню «…» поста это диалог БЕЗ признаков
// мастера, и clearOverlays его сам закрывал (жал последнюю кнопку) → клик по Delete/Archive уходил в
// пустоту с «Timeout». Кликая ВНУТРИ меню/модалки, гасилку выключаем.
async function clickSafe(page, el, what, opts = {}) {
  if (!opts.skipClear) await clearOverlays(page);
  try { await el.click({ timeout: 6000 }); }
  catch (e) { throw new Error(`клик «${what}» не прошёл: ${String(e.message).split('\n')[0].slice(0, 120)}`); }
}

// ── КЛИК ПО ВИДИМОМУ ТЕКСТУ (обход мусора в доступном имени) ────────────────
// КОРЕНЬ ПРОВАЛОВ МАСТЕРА 07.08. У пунктов меню Instagram внутри лежит <svg><title>Post</title></svg>,
// поэтому textContent пункта равен «PostPost», а доступное имя — «Post Post». Строгий матчер
// getByRole('button', {name:/^Post$/}) не находил НИ ОДНОГО такого пункта. Дамп с боевого провала:
// ["New postCreate","New post","PostPost","Post","Live videoLive video","AdAd","AIAI",…].
// innerText от этого свободен: <title> внутри svg не рендерится, у пункта он ровно «Post».
// Поэтому ищем по innerText, помечаем найденный узел атрибутом и кликаем ПО ЭЛЕМЕНТУ
// (правило проекта: никаких слепых координат — Playwright сам проверит перекрытие).
const CLICKABLE = 'div[role="button"],button,a,[role="menuitem"],[role="link"],[role="tab"],span[role="button"]';
// markPreexisting — помечает всё, что подходит под тот же текст УЖЕ СЕЙЧАС. Нужно, чтобы потом
// кликнуть только НОВЫЙ элемент. Пример боли: в ленте под каждым постом есть своя кнопка «Post»
// (отправить коммент), и слепой поиск «Post» мог попасть в неё вместо пункта меню создания.
async function markPreexisting(page, rx, { maxLen = 40 } = {}) {
  const src = rx.source, flags = rx.flags.replace(/[gy]/g, '');
  return await page.evaluate(({ sel, src, flags, maxLen }) => {
    const rx = new RegExp(src, flags);
    document.querySelectorAll('[data-np-pre]').forEach((e) => e.removeAttribute('data-np-pre'));
    let n = 0;
    for (const e of document.querySelectorAll(sel)) {
      if (e.offsetParent === null) continue;
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > maxLen || !rx.test(t)) continue;
      e.setAttribute('data-np-pre', '1'); n++;
    }
    return n;
  }, { sel: CLICKABLE, src, flags, maxLen }).catch(() => 0);
}
// findByText — ищет кликабельный элемент по ВИДИМОМУ тексту и отдаёт его локатором (клик бывает
// нужен позже: кнопку «Поделиться» жмут уже после отметки post_submitted в базе).
async function findByText(page, rx, { exclude = null, timeout = 6000, maxLen = 40, skipPre = false } = {}) {
  const t0 = Date.now();
  const src = rx.source, flags = rx.flags.replace(/[gy]/g, '');
  for (;;) {
    const hit = await page.evaluate(({ sel, src, flags, excl, maxLen, skipPre }) => {
      const rx = new RegExp(src, flags), ex = excl ? new RegExp(excl, flags) : null;
      document.querySelectorAll('[data-np-hit]').forEach((e) => e.removeAttribute('data-np-hit'));
      for (const e of document.querySelectorAll(sel)) {
        if (e.offsetParent === null) continue;
        if (skipPre && e.hasAttribute('data-np-pre')) continue;
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > maxLen) continue;
        if (ex && ex.test(t)) continue;
        if (!rx.test(t)) continue;
        e.setAttribute('data-np-hit', '1');
        return t;
      }
      return null;
    }, { sel: CLICKABLE, src, flags, excl: exclude ? exclude.source : null, maxLen, skipPre }).catch(() => null);
    if (hit) return { ok: true, text: hit, el: page.locator('[data-np-hit="1"]').first() };
    if (Date.now() - t0 > timeout) return { ok: false, text: null, el: null };
    await sleep(500);
  }
}
async function clickByText(page, rx, opts = {}) {
  const t0 = Date.now(), timeout = opts.timeout == null ? 6000 : opts.timeout;
  for (;;) {
    const f = await findByText(page, rx, { ...opts, timeout: Math.max(0, timeout - (Date.now() - t0)) });
    if (f.ok) {
      const done = await f.el.click({ timeout: 6000 }).then(() => true).catch(() => false);
      await page.evaluate(() => document.querySelectorAll('[data-np-hit]').forEach((e) => e.removeAttribute('data-np-hit'))).catch(() => {});
      if (done) return { ok: true, text: f.text };
    }
    if (Date.now() - t0 > timeout) return { ok: false, text: f.text || null };
    await sleep(500);
  }
}

// ── МАСТЕР СОЗДАНИЯ ПОСТА ───────────────────────────────────────────────────
// Текстовые признаки самого мастера (нужны только для варианта БЕЗ обёртки role=dialog).
const WIZARD_TEXT_RX = /create new post|drag photos and videos here|select from computer|создать публикацию|нов(ая|ую) публикаци|перетащите фото|выбрать на компьютере/i;
// Возвращает {where, scope, input} или null. ПОЛОЖИТЕЛЬНЫЙ признак мастера — файловый инпут
// ВНУТРИ видимого диалога (язык не важен) либо характерный текст мастера + инпут на странице.
// ПОЧЕМУ НЕ «любой input[type=file] на странице» (ошибка 07.08): такой инпут висит в разметке и
// вне мастера, шаг «диалог создания» проходил ложно, файл уходил в чужое поле, а следом падало
// «рабочий диалог закрылся». Голый инпут доказательством открытого мастера НЕ является.
async function createWizard(page) {
  const dlgs = page.locator('div[role="dialog"]');
  const n = await dlgs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const d = dlgs.nth(i);
    if (!(await d.isVisible().catch(() => false))) continue;
    if ((await d.locator('input[type="file"]').count().catch(() => 0)) > 0) {
      return { where: 'диалог', scope: d, input: d.locator('input[type="file"]').first() };
    }
    const txt = String(await d.innerText().catch(() => '')).slice(0, 600);
    if (WIZARD_TEXT_RX.test(txt) && (await page.locator('input[type="file"]').count().catch(() => 0)) > 0) {
      return { where: 'диалог+инпут на странице', scope: d, input: page.locator('input[type="file"]').first() };
    }
  }
  const body = String(await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 5000);
  if (WIZARD_TEXT_RX.test(body) && (await page.locator('input[type="file"]').count().catch(() => 0)) > 0) {
    return { where: 'страница без role=dialog', scope: page, input: page.locator('input[type="file"]').first() };
  }
  return null;
}

// Открыть мастер создания поста. ДВА ВАРИАНТА ИНТЕРФЕЙСА (факт 07.08, дампы боевых прогонов):
//   • обычный профиль: клик по иконке «New post» сразу открывает диалог мастера;
//   • ПРОФЕССИОНАЛЬНЫЙ профиль (в меню есть «Professional dashboard»): «Create» раскрывает
//     список «Post / Live video / Ad / AI», и нужен ещё один клик по пункту «Post».
// Второго клика не было — отсюда «диалог с input[type=file] не появился» на promt.vibe.lab,
// ai.promt.mood, mahjobi__mks при том, что личные акки постили в тот же час.
// Прямой переход на /create/select/ УБРАН: в 2026 Instagram трактует этот путь как НИК и
// открывает ЧУЖОЙ профиль @create (скрин post2_FOL_1155_uploaded.jpg — «Chris Shelley, 75.7K
// followers»), а клики после этого уходят по чужой странице.
const CREATE_ICON = 'svg[aria-label="New post" i], svg[aria-label="Создать" i], svg[aria-label="Новая публикация" i]';
const POST_ITEM_RX = /^(post|публикация|reel|рилс|publicación|postagem)$/i;
const NOT_POST_RX = /new post|создать|создание|professional|dashboard/i;
async function openCreateWizard(page, { tries = 4, log = () => {} } = {}) {
  const notes = [];
  let marked = false;
  for (let t = 0; t < tries; t++) {
    let w = await createWizard(page);
    if (w) return { ...w, notes };
    await clearOverlays(page);
    // На последней попытке снимаем ограничение «только новый элемент»: если Instagram нарисует
    // пункт меню заранее (скрытым не будет, а мы его пометим как «был до клика»), запрет закроет
    // единственный верный пункт. Кнопка коммента в ленте при пустом поле неактивна, поэтому
    // последний шанс безопаснее, чем упасть на ровном месте.
    const skipPre = t < tries - 1;
    if (!skipPre) log('последняя попытка: ищу пункт «Post» без ограничения «появился после клика»');
    // Меню могло остаться раскрытым с прошлой попытки — тогда сразу пункт «Post».
    let item = marked ? await clickByText(page, POST_ITEM_RX, { exclude: NOT_POST_RX, timeout: 1200, skipPre }) : { ok: false };
    if (!item.ok) {
      // Запоминаем ВСЕ «Post», которые уже есть на экране до раскрытия меню (в ленте это кнопки
      // отправки коммента под каждым постом) — кликать будем только по НОВОМУ пункту.
      const pre = await markPreexisting(page, POST_ITEM_RX);
      marked = true;
      if (pre) log(`на экране уже ${pre} элемент(ов) с текстом «Post» (кнопки комментов в ленте) — их не трогаю`);
      const icon = page.locator(`${CREATE_ICON}, div[role="button"]:has(${CREATE_ICON})`).first();
      if (await icon.isVisible({ timeout: 4000 }).catch(() => false)) {
        if (!(await icon.click({ timeout: 5000 }).then(() => true).catch(() => false))) {
          await clearOverlays(page);
          await icon.click({ timeout: 5000 }).catch(() => {});
        }
        notes.push('клик «New post»');
      } else {
        const byText = await clickByText(page, /^(create|создать)$/i, { timeout: 3000 });
        if (byText.ok) notes.push('клик по тексту «Create»');
        else notes.push('кнопки создания не видно');
      }
      await sleep(3000);
      w = await createWizard(page);
      if (w) return { ...w, notes };   // обычный профиль: диалог открылся сразу
      item = await clickByText(page, POST_ITEM_RX, { exclude: NOT_POST_RX, timeout: 6000, skipPre });
    }
    if (item.ok) { notes.push(`клик пункта меню «${item.text}»`); log(`меню создания: выбран пункт «${item.text}»`); await sleep(4000); }
    w = await createWizard(page);
    if (w) { await page.evaluate(() => document.querySelectorAll('[data-np-pre]').forEach((e) => e.removeAttribute('data-np-pre'))).catch(() => {}); return { ...w, notes }; }
    await sleep(2500);
  }
  await page.evaluate(() => document.querySelectorAll('[data-np-pre]').forEach((e) => e.removeAttribute('data-np-pre'))).catch(() => {});
  return null;
}

// Мастер ГОТОВ К РАБОТЕ после загрузки файла: ждём положительный признак (свои кнопки навигации
// или превью медиа), гасим объявления каждый проход. Раньше тут стояла глухая пауза 14 секунд и
// один опрос: на медленном бесплатном прокси обработка файла в неё не укладывалась.
async function waitEditorReady(page, { timeoutMs = 120000, log = () => {} } = {}) {
  const t0 = Date.now();
  let killedAll = [];
  let busyPasses = 0;
  for (let pass = 0; ; pass++) {
    const live = await pageAlive(page);
    // Закрытое окно ждать бессмысленно — выходим сразу и называем причину.
    if (live.kind === 'closed') return { ok: false, reason: `окно браузера закрыто снаружи (${live.why})`, dead: true, killed: killedAll };
    // Занятый рендерер — НЕ провал: Instagram в это время жмёт видео. Ждём дальше, но говорим вслух.
    if (!live.alive) {
      if (++busyPasses === 1 || busyPasses % 4 === 0) log(`страница не отвечает (${live.why}) — жду, это обработка файла, а не потеря мастера`);
      if (Date.now() - t0 > timeoutMs) {
        return { ok: false, killed: killedAll, dead: false, busy: true,
          reason: `страница не отвечает ${Math.round((Date.now() - t0) / 1000)}с подряд (рендерер занят или упал): проверить мастер нечем` };
      }
      await sleep(3000); continue;
    }
    const killed = await clearOverlays(page);
    if (killed.length) { killedAll = killedAll.concat(killed); log(`погашены объявления поверх мастера: ${JSON.stringify(killed)}`); }
    const d = await workDialog(page);
    let has = null;
    if (d) {
      // ПРИЗНАК ИМЕННО РЕДАКТОРА, а не пустого окна «Drag photos and videos here»: в диалоге
      // появилось медиа (кадр/ролик) или кнопка перехода дальше. Без этого шаг проходил мгновенно,
      // пока файл ещё обрабатывается, и следующие шаги упирались в не готовый мастер.
      has = await d.evaluate((n) => ({
        media: n.querySelectorAll('video, img[src^="blob:"], canvas').length,
        nav: [...n.querySelectorAll('div[role="button"],button')].some((e) => e.offsetParent !== null
          && /^(next|далее|share|поделиться|опубликовать)$/i.test((e.innerText || '').replace(/\s+/g, ' ').trim())),
        text: (n.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      })).catch(() => null);
      if (has && (has.media > 0 || has.nav)) {
        return { ok: true, dialog: d, secs: Math.round((Date.now() - t0) / 1000), media: has.media, killed: killedAll };
      }
    }
    if (Date.now() - t0 > timeoutMs) {
      return { ok: false, killed: killedAll, dead: false,
        reason: d
          ? `за ${Math.round(timeoutMs / 1000)}с мастер не дошёл до редактора: медиа в диалоге ${has ? has.media : '?'}, кнопки перехода нет (текст: «${has ? has.text : '—'}») — файл не обработался`
          : `за ${Math.round(timeoutMs / 1000)}с не появился рабочий диалог мастера (свои кнопки Next/Share/Back)` };
    }
    await sleep(2500);
  }
}

// ── единые параметры запуска Orbita ─────────────────────────────────────────
// КРИТ (01.08): Chrome показывал НАТИВНОЕ окно «Sign in as <ник>» (менеджер паролей браузера) поверх
// формы входа. Это UI браузера, а не страница: через DOM его не видно и не закрыть, ввод логина/пароля
// молча не проходил. Лечится только флагами запуска — гасим менеджер паролей и автозаполнение.
// ФЛАГИ ЗАПУСКА. Всё это — борьба с НАТИВНЫМИ окнами браузера: они рисуются вне страницы, в DOM их
// нет, закрыть из кода нельзя, а перекрывают они ровно то, по чему надо кликать.
// 02.08: поверх экрана 2FA вылез пузырь «Save password?» — `--disable-save-password-bubble` в свежих
// сборках Chrome уже не действует, поэтому душим сам сервис сохранения паролей через фичи.
const ORBITA_ARGS = [
  '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,PasswordManagerEnableAccountStore,'
    + 'AutofillKeyBoardAccessory,PasswordManagerRedesign,PasswordLeakDetection,AutofillEnableAccountWalletStorage,'
    + 'PasswordChangeAffiliationInfo,PasswordManagerPasskeys',
  '--disable-save-password-bubble',
  '--disable-password-generation',
  '--password-store=basic',
  '--disable-blink-features=AutomationControlled',   // и не светим автоматизацию
  '--no-default-browser-check',
  '--no-first-run',
];
// Единая точка создания опций GoLogin: все скрипты берут отсюда, чтобы флаги не разъезжались.
// ПУСТОЙ АРХИВ ПРОФИЛЯ = ЧИСТЫЙ БРАУЗЕР (07.08, разбор фермы). SDK проверяет архив профиля
// только на существование, а не на размер: файл нулевой длины проходит проверку, S3 не качается,
// распаковка падает и профиль стартует ПУСТЫМ, без кук и истории. На диске нашлось 5 таких, и
// четыре принадлежали боевым аккам (savion8683, roderick97493, carter15909, micah760184): каждый
// их запуск начинался с нуля, отсюда и «сессия не поднимается». Сносим битый архив перед старом,
// тогда SDK честно скачает профиль заново.
function dropBrokenProfileZip(profileId) {
  try {
    const os = require('node:os'), fsx = require('node:fs'), p = require('node:path');
    const f = p.join(os.tmpdir(), `gologin_${profileId}.zip`);
    if (fsx.existsSync(f) && fsx.statSync(f).size === 0) {
      fsx.unlinkSync(f);
      console.log(`  ⚠ битый архив профиля (0 байт) удалён, GoLogin скачает заново: ${profileId}`);
    }
  } catch {}
}

function glOpts({ token, profile_id, width = 1280, height = 900, extra = [] }) {
  return {
    token, profile_id, uploadCookiesToServer: true,
    resolution: { width, height },
    extra_params: [...ORBITA_ARGS, ...extra],
  };
}

// ── закалка контекста: гасим НАТИВНЫЕ диалоги браузера ──────────────────────
// КРИТ (01.08): поверх формы входа всплывало окно браузера «Sign in as <ник>» с Cancel/Sign In.
// Это НЕ менеджер паролей и НЕ элемент страницы: его вызывает САМА страница через Credential
// Management API (navigator.credentials.get) и WebAuthn. Через DOM его не видно и не закрыть,
// флаги запуска не помогают → ввод логина/пароля молча не проходил. Лечится подменой API ДО загрузки.
async function hardenContext(ctx) {
  await ctx.addInitScript(() => {
    try {
      if (navigator.credentials) {
        // get() — тот самый «Sign in as X»; store()/create() — «сохранить пароль?»
        navigator.credentials.get = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
        navigator.credentials.store = () => Promise.resolve();
        navigator.credentials.create = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      }
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      }
    } catch {}
  }).catch(() => {});
}

// ── вход в один клик (Continue as <ник>) ────────────────────────────────────
// ЗОЛОТАЯ ЖИЛА (01.08): у многих профилей IG держит сохранённую сессию и предлагает «Continue as X».
// Это вход БЕЗ пароля → без капчи «Confirm you're human», которая жжёт акки при обычном логине.
// Раньше клик делался «мягко» (.catch(() => {})) и молча не срабатывал → акк считали мёртвым.
// Здесь: несколько попыток, поиск и по роли, и по тексту, результат проверяется ПОЛОЖИТЕЛЬНО.
async function oneTapContinue(page, ctx, tries = 4) {
  for (let t = 0; t < tries; t++) {
    const cks = await ctx.cookies('https://www.instagram.com').catch(() => []);
    if (cks.some((x) => x.name === 'sessionid' && x.value && x.value.length > 10)) return { ok: true, clicks: t };
    let btn = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
    if (!(await btn.isVisible({ timeout: 2500 }).catch(() => false))) {
      btn = page.getByText(/^(Continue|Продолжить)$/i).first();
      if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) return { ok: false, reason: 'кнопки Continue нет на экране', clicks: t };
    }
    try { await btn.click({ timeout: 6000 }); }
    catch (e) { return { ok: false, reason: `клик Continue не прошёл: ${String(e.message).split('\n')[0].slice(0, 80)}`, clicks: t }; }
    await sleep(7000);
    await clearOverlays(page);
  }
  const cks = await ctx.cookies('https://www.instagram.com').catch(() => []);
  const ok = cks.some((x) => x.name === 'sessionid' && x.value && x.value.length > 10);
  return { ok, reason: ok ? null : 'после кликов Continue сессия так и не появилась', clicks: tries };
}

// ── совпадение личности: персона ↔ ник ↔ имя профиля ────────────────────────
// Урок 01.08 (владелец): у модели «Дарья» ник varya.smirnova13 — Варя это ДРУГОЕ имя, живой человек
// замечает такое мгновенно, и акк читается как фейк. Проверяем машинно, а не на глаз.
const NAME_ROOTS = {
  'дарья': ['darya', 'daria', 'dasha', 'dashka', 'dari'],
  'даша': ['dasha', 'darya', 'daria'],
  'маша': ['masha', 'maria', 'mariya', 'mash', 'mary'],
  'мария': ['maria', 'masha', 'mariya'],
  'карина': ['karina', 'karin', 'kari', 'karinka'],
  'варя': ['varya', 'varvara', 'vary'],
  'варвара': ['varvara', 'varya'],
  'алина': ['alina', 'alin', 'ali'],
  'катя': ['katya', 'kate', 'ekaterina', 'katia'],
  'аня': ['anya', 'ania', 'anna', 'annie', 'аня', 'анечка'],
  'анечка': ['anya', 'ania', 'anna', 'annie', 'аня', 'анечка'],
  'лена': ['lena', 'elena', 'alena'],
  'настя': ['nastya', 'anastasia', 'nastia'],
  'вика': ['vika', 'viktoria', 'victoria'],
  'соня': ['sonya', 'sofia', 'sofya'],
  'кира': ['kira', 'kyra'],
  'ника': ['nika', 'veronika', 'nica'],
};
// Возвращает {ok, issues[]}: несовпадение персоны с ником и/или с именем профиля.
function checkIdentity({ persona, handle, displayName }) {
  const issues = [];
  const p = String(persona || '').trim().toLowerCase();
  const h = String(handle || '').toLowerCase();
  const dn = String(displayName || '').toLowerCase();
  if (!p) return { ok: true, issues };
  const roots = NAME_ROOTS[p] || [p];
  if (h && !roots.some((r) => h.includes(r))) {
    // чужое ИМЯ в нике опаснее нейтрального ника: «Дарья» на @varya читается как фейк
    const foreign = Object.entries(NAME_ROOTS).find(([n, rs]) => n !== p && rs.some((r) => h.includes(r)));
    issues.push(foreign
      ? `ник @${handle} содержит ЧУЖОЕ имя «${foreign[0]}», а модель «${persona}»`
      : `ник @${handle} не связан с именем «${persona}» (нейтральный)`);
  }
  if (dn && !roots.some((r) => dn.includes(r)) && !dn.includes(p)) {
    issues.push(`имя профиля «${displayName}» не содержит имени модели «${persona}»`);
  }
  return { ok: issues.length === 0, issues };
}

// ── здоровье аккаунта ПЕРЕД работой ─────────────────────────────────────────
// Урок 01.08 (владелец): у Маши висело «We added a restriction to your account» + удалённое фото
// за спам, а постер этого не видел и постил вслепую. Постить на ограниченный акк = добивать его.
// Проверяем ПОЛОЖИТЕЛЬНЫМИ признаками на странице статуса; неизвестный экран НЕ считаем «всё ок».
const RESTRICT_RX = /added a restriction to your account|account is restricted|We restrict certain activity|We removed your (photo|post|video|reel|content)|goes against our Community Standards|мы добавили ограничени|ваш аккаунт ограничен|мы удалили (ваш|вашу)/i;
const CLEAN_RX = /No restrictions|isn'?t restricted|not restricted|in good standing|Everything looks good|нет ограничений|не ограничен/i;

// IG переезжает: /accounts/account_status/ в 2026 отдаёт «page isn't available» (проверено 01.08 на живом
// акке). Пробуем адреса по очереди и берём ПЕРВЫЙ отрендерившийся; «страница недоступна» не считаем ответом.
// ВАЖНО (01.08): «/settings/help/enforcement/» без параметров IG трактует как НИК → открывается чужой
// профиль @settings («This profile is private»), а «/accounts/account_status/» = page isn't available.
// Поэтому источник истины — ЛЕНТА УВЕДОМЛЕНИЙ: именно там IG пишет «We added a restriction to your
// account» и «We removed your photo» (скрин владельца 01.08). Один переход вместо трёх наугад.
const STATUS_URLS = ['https://www.instagram.com/notifications/'];
async function checkAccountStatus(page) {
  let url = '', text = '';
  for (const u of STATUS_URLS) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await sleep(4500);
    await clearOverlays(page);
    const t = String(await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 6000);
    // «профиль @settings» и «page isn't available» ответом НЕ считаем (это не наш экран)
    if (t && !/page isn'?t available|This profile is private|Страница недоступна/i.test(t)) { url = page.url(); text = t; break; }
    url = page.url(); text = t;
  }
  const restricted = RESTRICT_RX.test(text);
  const clean = CLEAN_RX.test(text);
  const hit = (text.match(RESTRICT_RX) || [])[0] || null;
  // порядок от специфичного к общему; «не понял экран» = unknown, а не «здоров»
  const state = restricted ? 'restricted' : clean ? 'ok' : 'unknown';
  return { state, hit, url, excerpt: text.replace(/\s+/g, ' ').slice(0, 300) };
}

// ── первый коммент на своём ролике ──────────────────────────────────────────
// Единственная реализация (не копировать!). Факт 01.08: на десктопном /reel/ поля коммента
// нет в DOM, пока не кликнута иконка «Comment». Ввод через typeVerified, успех подтверждаем
// положительно: наш текст появился в списке комментов.
async function postFirstComment(page, url, text) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(5000);
  await clearOverlays(page);
  let box = await visEdit(page, 'textarea[aria-label*="omment" i], div[contenteditable="true"][role="textbox"]', 4000);
  if (!box) {
    const icon = page.locator('svg[aria-label="Comment" i], svg[aria-label="Комментировать" i]').first();
    if (!(await icon.isVisible({ timeout: 5000 }).catch(() => false))) throw new Error('нет ни поля коммента, ни иконки Comment');
    await clickSafe(page, icon, 'иконка Comment');
    await sleep(2500);
    box = await visEdit(page, 'textarea[aria-label*="omment" i], div[contenteditable="true"][role="textbox"]', 6000);
    if (!box) throw new Error('поле коммента не появилось после клика по иконке');
  }
  const r = await typeVerified(box, text);
  if (!r.ok) throw new Error('текст коммента не прочитался обратно из поля');
  // Кнопка отправки: сначала по роли, потом по видимому тексту (доступное имя портит <title> из
  // svg — на этом 07.08 пропал пункт «Post» в меню создания), в последнюю очередь Enter.
  const pb = page.getByRole('button', { name: /^(Post|Опубликовать)$/i }).first();
  if (await pb.isVisible({ timeout: 3000 }).catch(() => false)) await pb.click({ timeout: 4000 });
  else if (!(await clickByText(page, /^(post|опубликовать)$/i, { timeout: 3000 })).ok) await box.press('Enter');
  await sleep(5000);
  // положительное доказательство: наш текст виден на странице вне поля ввода
  const probe = text.slice(0, 25);
  const seen = await page.getByText(probe, { exact: false }).first().isVisible({ timeout: 6000 }).catch(() => false);
  if (!seen) throw new Error('коммент отправлен, но текст не найден на странице (возможно не встал)');
  return true;
}

// ── ролики профиля ──────────────────────────────────────────────────────────
// Положительное доказательство публикации: НОВЫЙ shortcode на профиле (до/после).
async function getShortcodes(page, handle) {
  await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(5000);
  await clearOverlays(page);
  // ПРОФИЛЬ ОБЯЗАН ОТРЕНДЕРИТЬСЯ. Урок 01.08: недогруженный профиль отдавал ПУСТОЙ список, база «0 роликов»
  // на акке с постами → проверка успеха могла принять СТАРЫЙ пост за новый. Пустота ≠ «постов нет».
  // Урок 04.08 (@cherry.mood59): одна проверка через 5с — гонка, на медленном прокси профиль
  // догружается позже и два захода подряд падали «не отрендерился», хотя скриншот, снятый мигом
  // позже, показывал полную сетку. Поэтому опрашиваем до ~25с, а не стреляем один раз.
  let rendered = false;
  for (let i = 0; i < 10 && !rendered; i++) {
    rendered = await page.evaluate((h) => {
      const t = document.body.innerText || '';
      return new RegExp(`@?${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t)
        || /publications|posts|публикаци/i.test(t);
    }, handle).catch(() => false);
    if (!rendered) await sleep(2500);
  }
  if (!rendered) throw new Error(`профиль @${handle} не отрендерился (пустой список НЕ считаем «постов нет»)`);
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].map((a) => a.getAttribute('href')).filter(Boolean),
  ).catch(() => []);
  return new Set(hrefs.map((h) => (h.match(/\/(p|reel)\/([^/]+)/) || [])[2]).filter(Boolean));
}
async function waitNewShortcode(page, handle, before, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const now = await getShortcodes(page, handle).catch(() => new Set());
    for (const sc of now) if (!before.has(sc)) return sc;
    await sleep(15000);
  }
  return null;
}

module.exports = { dropBrokenProfileZip, glOpts, ORBITA_ARGS, hardenContext, sleep, snap, setShotTag, dumpUI, step, pageAlive, normCookies, pickCookie, classifyScreen, visEdit, typeVerified, dismissDialogs, dismissAnnouncements, clearOverlays, workDialog, clickSafe, findByText, clickByText, createWizard, openCreateWizard, waitEditorReady, oneTapContinue, checkIdentity, checkAccountStatus, postFirstComment, getShortcodes, waitNewShortcode };
