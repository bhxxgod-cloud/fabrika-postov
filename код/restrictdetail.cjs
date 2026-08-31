// ЧТЕНИЕ ПОДРОБНОСТЕЙ ОГРАНИЧЕНИЯ (07.08, претензия начальника).
//
// БОЛЬ. Мы много раз ловили «АККАУНТ ОГРАНИЧЕН: added a restriction to your account», писали это в
// лог и останавливались. За ссылкой «See why» лежит вся суть: ЧТО именно ограничено (охват, реклама,
// возможность публиковать/лайкать), ЗА ЧТО (спам, повторяющийся контент, правила сообщества) и ДО
// КАКОГО ЧИСЛА. Без этого нельзя решить, лечится ли ожиданием, и решение каждый раз принималось
// наугад. Этот модуль ЧИТАЕТ подробности и складывает их в базу, чтобы больше никто не лазил руками.
//
// КОНТРАКТ (как в iglib.cjs): read* только читает страницу и возвращает факты, save* только пишет в
// базу. Читалка НЕ жмёт ничего, что меняет состояние: клики разрешены строго по белому списку
// навигации («See why», «See details», «Learn more»), а «Acknowledge / I disagree / Appeal / Delete»
// в чёрном списке — обжалование и подтверждение решает человек, а не скрипт.
//
// Запуск: node restrictdetail.cjs <slug|ник>            один заход на куках, читает и пишет в базу
//         node restrictdetail.cjs <slug> --dry          без записи в базу
'use strict';
const fs = require('node:fs');
const L = require('./iglib.cjs');

const SHOT_DIR = process.env.SHOT_DIR || '/tmp';

// ── что именно ограничено ───────────────────────────────────────────────────
// Разделяем ОХВАТ (посты видит меньше людей, аккаунт живой) и ДЕЙСТВИЯ (нельзя публиковать/лайкать).
// Это главный вопрос начальника: первое лечится ожиданием и сменой контента, второе останавливает работу.
const RX = {
  reach: /not be recommended|won'?t be recommended|aren'?t recommended|not recommend|reduce[sd]? (the )?(reach|distribution|visibility)|less visible|lower in feed|shown lower|not be suggested|non-followers|people who don'?t follow you|не будем рекомендовать|меньше людей|охват/i,
  actions: /can'?t (post|comment|like|follow|send|share|use|create|go live|add)|cannot (post|comment|like|follow)|restricted from (posting|commenting|liking|following)|temporarily (blocked|restricted) from|blocked from (posting|commenting|liking)|action blocked|не можете (публиковать|комментировать|ставить|подписываться)|заблокирован[ао]? возможность/i,
  // «реклама» ловим ТОЛЬКО в связке с ограничением: слово ads есть в любом меню Instagram,
  // и без связки экран уведомлений всегда выглядел бы как «ограничена реклама».
  ads: /\b(ads?|advertising)\b[^.\n]{0,60}(restrict|disabl|paus|limit|ineligib)|(restrict|disabl|limit|ineligib)[^.\n]{0,60}\b(ads?|advertising)\b|monetiz|monetis|branded content|монетиз/i,
  removed: /we removed your (photo|post|video|reel|comment|content)|your (post|photo|video|reel|comment) was removed|мы удалили (ваш|вашу)/i,
  appeal: /disagree|appeal|request (a )?review|ask for (a )?review|tell us|submit.*review|оспорить|не согласен|обжалов/i,
  ack: /acknowledge|got it|i understand|okay|ok\b|continue|подтверждаю|понятно/i,
};
// причины формулируются десятком стандартных фраз, ловим каждую отдельно (нужна конкретика, не «нарушение»)
const REASONS = [
  [/repetitive|repeatedly|posting the same|duplicate|repeated content|повтор/i, 'повторяющийся/дублирующийся контент'],
  [/spam/i, 'спам'],
  [/inauthentic|fake (engagement|account|activity)|misleading|impersonat/i, 'неаутентичное поведение / выдача себя за другого'],
  [/community guidelines/i, 'Community Guidelines (правила сообщества)'],
  [/community standards/i, 'Community Standards (нормы сообщества)'],
  [/recommendation guidelines/i, 'Recommendation Guidelines (правила рекомендаций)'],
  [/\b(too fast|too quickly|too frequently|rate limit|automated|automation|bots?)\b/i, 'темп действий / признаки автоматизации'],
  [/\b(links?|urls?)\b[^.\n]{0,40}(spam|not allowed|against|restrict)|(spam|against|restrict)[^.\n]{0,40}\b(links?|urls?)\b/i, 'ссылки'],
  [/nudity|sexual|adult/i, 'нагота / сексуальный контент'],
  [/intellectual property|copyright|trademark/i, 'права на контент'],
  [/scam|fraud|deceptive|sell/i, 'мошенничество / продажи'],
  [/bullying|harass|hate|violence|dangerous/i, 'травля / опасный контент'],
];
// сроки: и абсолютные («until August 14»), и относительные («for 7 days», «3 days left»)
const DATE_RX = [
  /until\s+([A-Z][a-z]+\s+\d{1,2}(,\s*\d{4})?|\d{1,2}\s+[A-Z][a-z]+(\s+\d{4})?|\d{1,2}[./]\d{1,2}[./]\d{2,4})/gi,
  /до\s+(\d{1,2}\s+[а-яё]+(\s+\d{4})?|\d{1,2}[./]\d{1,2}[./]\d{2,4})/gi,
  /for\s+(\d+)\s+(hour|day|week|month)s?/gi,
  /(\d+)\s+(hour|day|week)s?\s+(left|remaining|to go)/gi,
  /(ends?|expires?|lifted|restored)\s+(on|in)?\s*([A-Z][a-z]+\s+\d{1,2}|\d+\s+(hour|day|week)s?)/gi,
  /на\s+(\d+)\s+(час|день|дн|сут|недел)/gi,
];

// ШУМ ЛЕНТЫ ОТРЕЗАЕМ ДО РАЗБОРА (07.08, поймано на @cherry.mood59). Ниже самих уведомлений идёт
// блок «Suggested for you» с чужими никами, и один из них был «jessandra._.spam» — от этого разбор
// объявил причиной ограничения СПАМ, чего Instagram не писал. Ложный вывод хуже отсутствия вывода:
// по нему принимают решения. Разбираем только содержательные строки до блока рекомендаций и без подвала.
const NOISE_CUT = /\n(?:Suggested for you|See All Suggestions|ABOUT US|ABOUT\nHELP|Meta\nAbout\nBlog)/;
function cleanText(t) { const s = String(t || ''); const i = s.search(NOISE_CUT); return i > 0 ? s.slice(0, i) : s; }
// строки-предложения: одиночные ники и кнопки «Follow» в разбор не идут, они не про ограничение
function sentences(t) {
  return cleanText(t).split('\n').map((x) => x.trim())
    .filter((x) => x.split(/\s+/).length >= 4 || /restrict|removed|guideline|standard|ограничен|удалили/i.test(x));
}

function summarize(screens) {
  const all = screens.map((s) => sentences(s.text).join('\n')).join('\n').replace(/ /g, ' ');
  const what = [];
  if (RX.reach.test(all)) what.push('охват (посты видит меньше людей / не рекомендуют)');
  if (RX.actions.test(all)) what.push('действия (публикация/лайки/комментарии/подписки)');
  if (RX.ads.test(all)) what.push('реклама/монетизация');
  if (RX.removed.test(all)) what.push('удалён наш контент');
  const reasons = REASONS.filter(([rx]) => rx.test(all)).map(([, ru]) => ru);
  const dates = [];
  for (const rx of DATE_RX) { let m; const r = new RegExp(rx.source, rx.flags); while ((m = r.exec(all))) { dates.push(m[0].trim()); if (dates.length > 12) break; } }
  const buttons = [...new Set(screens.flatMap((s) => s.buttons || []))];
  // цитаты: строки, где IG прямым текстом говорит про ограничение — это то, что читает человек
  const quotes = all.split('\n').map((x) => x.trim()).filter((x) => x.length > 12
    && /restrict|recommend|removed|guidelines|standards|can'?t |spam|repetit|until|review|appeal|ограничен|удалили|рекоменд/i.test(x)).slice(0, 25);
  return {
    what: what.length ? what : ['не удалось определить по тексту'],
    reasons: reasons.length ? reasons : ['причина в тексте не названа'],
    dates: [...new Set(dates)],
    has_appeal: buttons.some((b) => RX.appeal.test(b)) || RX.appeal.test(all),
    has_ack: buttons.some((b) => RX.ack.test(b)),
    posts_listed: [...new Set(screens.flatMap((s) => s.media || []))],
    buttons, quotes,
  };
}

// ── читалка ────────────────────────────────────────────────────────────────
// Возвращает {state, screens[], summary, shots[]}. НИЧЕГО не пишет в базу и не жмёт кнопок решений.
// state: 'restricted' | 'clean' | 'unknown'
const CLICK_ALLOW = /see why|see details|view details|see more|learn more|what happened|see restrictions?|account status|узнать|подробн|почему/i;
const CLICK_DENY = /disagree|agree|appeal|acknowledge|request|delete|remove|report|log ?out|switch|not now|dismiss|cancel|оспор|удалить|выйти|отмен/i;

async function snapFull(page, tag) {
  const file = `${SHOT_DIR}/${tag}.jpg`;
  try { fs.writeFileSync(file, await page.screenshot({ type: 'jpeg', quality: 60, fullPage: true, timeout: 20000 })); return file; }
  catch { return L.snap(page, SHOT_DIR, tag); }
}
async function grab(page, name, tag) {
  await L.sleep(1200);
  const text = String(await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 12000);
  const ui = await L.dumpUI(page).catch(() => ({ url: page.url(), buttons: [] }));
  const media = await page.evaluate(() => [...document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]')]
    .map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 30)).catch(() => []);
  // Ссылки экрана сохраняем ВСЕГДА: адрес страницы статуса Instagram меняет от версии к версии, и
  // прочитанный из живого DOM href «See why» дороже любого угаданного адреса (07.08: наш
  // /accounts/account_status/ отдаёт «page isn't available», значит путь надо брать со страницы).
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
    .map((a) => ({ t: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), href: a.getAttribute('href') }))
    .filter((x) => x.href && !/^\/(p|reel|explore|direct)\//.test(x.href)).slice(0, 80)).catch(() => []);
  const shot = await snapFull(page, tag);
  return { step: name, url: ui.url, buttons: ui.buttons, media, links, shot, text };
}

// Путь к подробностям: ищем в DOM ссылку/элемент «See why» рядом с текстом об ограничении.
// Возврат {href} — тогда просто переходим по адресу (безопаснее клика: ничего лишнего не нажмём),
// либо {locator} — если это не ссылка, а кнопка.
const DETAIL_HREF_RX = /account_status|enforcement|accountstatus|restrict|violation|appeal_?status|guidelines_status/i;

// ТОЧНЫЙ КЛИК ПО СЛОВАМ «See why» (07.08, разбор двух неудачных попыток).
// Почему так, а не locator/getByText: у этого уведомления НЕТ ссылки (проверено на двух акках, в DOM
// ни одного <a>), а вся фраза «We added a restriction to your account. See why. 11h» лежит одним
// узлом. Клик по узлу летит в его центр, то есть в пустоту между текстом и отметкой времени, и
// ничего не происходит: ровно так мы дважды «нажали» и остались на месте. Через Range получаем
// прямоугольник ИМЕННО подстроки «See why» и щёлкаем мышью по её середине.
async function clickSeeWhy(page) {
  const spot = await page.evaluate(() => {
    const ROW = /added a restriction to your account|ограничени[ея].{0,40}аккаунт/i;
    const WHY = /(see why|узнать причину|подробнее)/i;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = w.nextNode())) {
      const d = tn.data || '';
      if (!WHY.test(d)) continue;
      const par = tn.parentElement;
      if (!par || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(par.tagName)) continue;  // «See why» бывает и в коде страницы
      // текстовый узел либо сам содержит всю фразу, либо лежит рядом с ней в той же строке
      const ctx = par.closest('div,li,span') || par;
      const around = ctx ? (ctx.textContent || '') : d;
      if (!ROW.test(around) && !ROW.test(d)) continue;
      const m = WHY.exec(d);
      const mk = () => { const r = document.createRange(); r.setStart(tn, m.index); r.setEnd(tn, m.index + m[0].length); return r.getBoundingClientRect(); };
      if (ctx.scrollIntoView) ctx.scrollIntoView({ block: 'center' });
      let box = mk();
      if (!box || !box.width) continue;
      // точка должна быть В ОКНЕ: клик по координате за пределами вьюпорта уходит в никуда
      if (box.y < 0 || box.y > innerHeight - 4) { window.scrollBy(0, box.y - innerHeight / 2); box = mk(); }
      if (!box || !box.width) continue;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const el = document.elementFromPoint(x, y);
      const underOk = !!el && WHY.test(el.textContent || '') ;
      return { x, y, word: m[0], row: around.slice(0, 120), underOk, under: el ? (el.tagName + '.' + (el.className || '').toString().slice(0, 30)) : null };
    }
    return null;
  }).catch(() => null);
  if (!spot) return null;
  await L.sleep(800);
  await page.mouse.click(spot.x, spot.y).catch(() => {});
  // Если под точкой оказался не тот узел (перекрытие всплывашкой, сдвиг после скролла) — второй
  // заход: жмём сам элемент со словами через Playwright, он сам доскроллит и попадёт в центр слова.
  if (!spot.underOk) {
    const el = page.locator('span,a,button,div[role="button"]').filter({ hasText: /^\s*See why\s*\.?\s*$/i }).last();
    if (await el.isVisible({ timeout: 2500 }).catch(() => false)) await el.click({ timeout: 6000 }).catch(() => {});
  }
  return spot;
}
async function findDetailLink(page) {
  const found = await page.evaluate((rxs) => {
    const HREF = new RegExp(rxs, 'i');
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const t = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
      const href = a.getAttribute('href');
      if (!href) continue;
      const byText = /see why|why this happened|see details|view details|подробн|почему/i.test(t);
      if (byText || HREF.test(href)) out.push({ t: t.slice(0, 80), href, byText });
    }
    return out;
  }, DETAIL_HREF_RX.source).catch(() => []);
  return found;
}

async function readRestrictionDetails(page, { tagBase = 'restrict' } = {}) {
  const screens = [];
  // 1) ЛЕНТА УВЕДОМЛЕНИЙ — там IG пишет «We added a restriction to your account. See why.»
  await page.goto('https://www.instagram.com/notifications/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await L.sleep(5000); await L.clearOverlays(page).catch(() => {});
  screens.push(await grab(page, 'уведомления', `${tagBase}_1_notifications`));

  // 2) «See why» — путь к подробностям. Сначала ищем ССЫЛКУ в DOM и переходим по её адресу: клик по
  // тексту 07.08 не срабатывал, потому что весь абзац «We added a restriction… See why.» это один
  // узел, и проверка «текст начинается с see why» его не узнавала. Адрес честнее текста.
  let clicked = null;
  const before = { url: page.url(), len: (screens[0].text || '').length };
  const spot = await clickSeeWhy(page);
  if (spot) {
    await L.sleep(7000); await L.clearOverlays(page).catch(() => {});
    clicked = `клик по словам «${spot.word}» в строке «${spot.row}»`;
    screens.push(await grab(page, `подробности (${spot.word})`, `${tagBase}_2_seewhy`));
    // Проверяем ПОЛОЖИТЕЛЬНО, что клик что-то дал: сменился адрес или экран стал другим.
    const after = screens[screens.length - 1];
    const moved = after.url !== before.url
      || Math.abs((after.text || '').length - before.len) > 200
      || /account status|why this happened|we removed|recommend|restriction[^.]{0,40}(until|for )/i.test(after.text || '');
    if (!moved) {
      // клик не сработал — пробуем ссылку, если она вообще есть в DOM
      const cand = (await findDetailLink(page)).filter((x) => !/notifications/.test(x.href));
      if (cand.length) {
        const pick = cand.find((x) => x.byText) || cand[0];
        const abs = pick.href.startsWith('http') ? pick.href : `https://www.instagram.com${pick.href}`;
        await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await L.sleep(6000); await L.clearOverlays(page).catch(() => {});
        clicked += ` + переход по ссылке ${abs}`;
        screens.push(await grab(page, `подробности (ссылка ${pick.t || ''})`, `${tagBase}_2b_link`));
      } else clicked += ' (экран не изменился, ссылки в DOM нет)';
    }
  }

  // 3) ГЛУБЖЕ: на экране статуса подробности спрятаны за строкой-записью или «See details».
  // Сначала пробуем НОВЫЙ адрес из DOM (переход, а не клик), потом уже клик по разрешённому тексту.
  const seen = new Set(screens.map((s) => s.url));
  for (let depth = 0; depth < 2; depth++) {
    let went = false;
    const links = (await findDetailLink(page)).filter((x) => {
      const abs = x.href.startsWith('http') ? x.href : `https://www.instagram.com${x.href}`;
      return !seen.has(abs) && !/notifications/.test(abs);
    });
    if (links.length) {
      const pick = links.find((x) => x.byText) || links[0];
      const abs = pick.href.startsWith('http') ? pick.href : `https://www.instagram.com${pick.href}`;
      seen.add(abs);
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await L.sleep(5000); await L.clearOverlays(page).catch(() => {});
      screens.push(await grab(page, `глубже → ${abs.slice(0, 80)}`, `${tagBase}_3_deep${depth}`));
      went = true;
    } else {
      const deeper = page.locator('a,button,div[role="button"]');
      const m = Math.min(await deeper.count().catch(() => 0), 200);
      for (let i = 0; i < m; i++) {
        const el = deeper.nth(i);
        const t = String(await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!t || !CLICK_ALLOW.test(t) || CLICK_DENY.test(t)) continue;
        if (screens.some((s) => s.step.includes(`«${t}»`))) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 6000 }).catch(() => {});
        await L.sleep(5000); await L.clearOverlays(page).catch(() => {});
        screens.push(await grab(page, `глубже (клик «${t}»)`, `${tagBase}_3_deep${depth}`));
        went = true; break;
      }
    }
    if (!went) break;
  }

  // 4) ПРЯМЫЕ АДРЕСА статуса — второй независимый источник. Проверено 07.08: старый
  // /accounts/account_status/ отдаёт «Sorry, this page isn't available», поэтому пробуем ещё
  // /settings/account_status/ и записываем результат каждого: так адрес находится один раз и навсегда.
  const probes = ['https://www.instagram.com/accounts/account_status/?hl=en', 'https://www.instagram.com/settings/account_status/?hl=en'];
  for (let i = 0; i < probes.length; i++) {
    if (seen.has(probes[i])) continue;
    await page.goto(probes[i], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(4500); await L.clearOverlays(page).catch(() => {});
    const st = await grab(page, `страница статуса ${probes[i].replace(/^https:\/\/www\.instagram\.com/, '')}`, `${tagBase}_4_status${i}`);
    const stub = /page isn'?t available|This profile is private|Страница недоступна/i.test(st.text);
    screens.push(stub ? { ...st, text: `[заглушка] ${st.text.slice(0, 200)}` } : st);
    if (!stub) break;
  }

  const all = screens.map((s) => s.text || '').join('\n');
  const restricted = /added a restriction to your account|account is restricted|We restrict certain activity|We removed your (photo|post|video|reel|content)|goes against our (Community )?(Guidelines|Standards)|ваш аккаунт ограничен|мы удалили (ваш|вашу)/i.test(all);
  const clean = /No restrictions|isn'?t restricted|not restricted|in good standing|Everything looks good|Your account is in good|нет ограничений|не ограничен/i.test(all);
  return {
    state: restricted ? 'restricted' : clean ? 'clean' : 'unknown',
    clicked, screens, shots: screens.map((s) => s.shot).filter(Boolean),
    summary: summarize(screens),
  };
}

// ── запись в базу ──────────────────────────────────────────────────────────
// account_events(kind='restriction_detail') — полный текст (это архив, из него можно перечитать всё).
// account_blockers(kind='restricted') — короткая суть со сроком, её читают скрипты и панель.
async function saveRestrictionDetails({ client, accountId, slug, facts }) {
  const B = require('./blockers.cjs');
  const s = facts.summary;
  const detail = {
    kto: 'restrictdetail.cjs',
    sostoyanie: facts.state,
    chto_ogranicheno: s.what,
    prichina: s.reasons,
    sroki: s.dates,
    est_osporit: s.has_appeal,
    est_podtverdit: s.has_ack,
    posty_v_pretenzii: s.posts_listed,
    knopki: s.buttons.slice(0, 30),
    citaty: s.quotes,
    skriny: facts.shots,
    ekrany: facts.screens.map((x) => ({ step: x.step, url: x.url, text: String(x.text || '').replace(/\s+/g, ' ').slice(0, 4000) })),
  };
  await client.query(
    `INSERT INTO account_events (account_id, slug, platform, kind, detail) VALUES ($1,$2,'ig','restriction_detail',$3::jsonb)`,
    [accountId, slug, JSON.stringify(detail)]);

  if (facts.state === 'restricted') {
    const blocks = [];
    if (s.what.some((x) => x.startsWith('действия'))) blocks.push('post', 'comment');
    if (s.what.some((x) => x.startsWith('охват'))) blocks.push('reach');
    const txt = `${s.what.join('; ')}. причина: ${s.reasons.join('; ')}`
      + (s.dates.length ? `. срок: ${s.dates.slice(0, 3).join(' / ')}` : '. срок не указан')
      + (s.has_appeal ? '. есть кнопка оспорить' : '');
    await B.add({ slug, kind: 'restricted', detail: txt.slice(0, 600), blocks, client });
    return { blocker: 'поставлен', txt };
  }
  if (facts.state === 'clean') {
    const n = await B.resolve({ slug, kind: 'restricted', by: 'экран статуса чист (restrictdetail)', client });
    return { blocker: n ? 'снят' : 'живого не было', txt: 'ограничений на экране нет' };
  }
  return { blocker: 'не трогал (экран не распознан)', txt: 'экран не распознан' };
}

// ЧИТАЕМ РЕДКО (07.08). С 07.08 постинг на акке с ограничением продолжается (решение начальника:
// ограничение про ссылки), значит гейт здоровья видит «restricted» на КАЖДОЙ публикации. Читать
// подробности каждый раз = лишние 4-5 переходов на каждый пост и лишний шум для Instagram, а текст
// ограничения меняется раз в дни, не раз в минуту. Поэтому читаем, если свежей записи нет.
async function readAndSaveOnce({ client, page, accountId, slug, tagBase, hours = 12 }) {
  const fresh = await client.query(
    `SELECT detail, to_char(created_at,'DD.MM HH24:MI') at,
            round(extract(epoch from now()-created_at)/60) age_min FROM account_events
      WHERE account_id=$1 AND kind='restriction_detail' ORDER BY created_at DESC LIMIT 1`,
    [accountId]).catch(() => ({ rowCount: 0, rows: [] }));
  if (fresh.rowCount) {
    const d = fresh.rows[0].detail || {}, age = Number(fresh.rows[0].age_min || 0);
    // ЗАПИСЬ «не удалось определить» НЕ СЧИТАЕМ ПРОЧИТАННЫМ (иначе одна неудачная попытка закрывает
    // тему на полсуток). Такую перечитываем, но не чаще раза в час: и не долбим, и не залипаем.
    const useful = (d.chto_ogranicheno || []).some((x) => !/не удалось определить/i.test(String(x)));
    if ((useful && age < hours * 60) || (!useful && age < 60)) {
      return { skipped: true, at: fresh.rows[0].at,
        summary: { what: d.chto_ogranicheno || [], reasons: d.prichina || [], dates: d.sroki || [] }, shots: d.skriny || [] };
    }
  }
  const facts = await readRestrictionDetails(page, { tagBase });
  const r = await saveRestrictionDetails({ client, accountId, slug, facts });
  return { skipped: false, ...r, summary: facts.summary, shots: facts.shots, state: facts.state };
}

module.exports = { readRestrictionDetails, saveRestrictionDetails, readAndSaveOnce, summarize };

// ─────────────────────────── CLI: один заход на куках ───────────────────────
if (require.main === module) {
  const KEY = process.argv[2];
  const DRY = process.argv.includes('--dry');
  const { chromium } = require('playwright-core');
  const { Client } = require('pg');
  const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

  global.__GL = null; let closing = false;
  const closeLocal = async (why) => {
    if (closing) return; closing = true;
    const gl = global.__GL; if (!gl) return;
    try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(8000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
  };
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });

  (async () => {
    if (!KEY) { console.log('usage: node restrictdetail.cjs <slug|ник> [--dry]'); process.exit(1); }
    const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
    const row = (await c.query(
      `SELECT a.id, a.slug, a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies,
              g.gologin_token tok
         FROM accounts a JOIN account_groups g ON g.id=a.group_id
        WHERE a.deleted_at IS NULL AND (a.slug=$1 OR a.ig_login=$1) AND a.gologin_profile_id IS NOT NULL LIMIT 1`, [KEY])).rows[0];
    if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
    console.log(`ЧИТАЮ ОГРАНИЧЕНИЕ @${row.h} (${row.slug})${DRY ? ' [--dry, без записи]' : ''}`);

    L.dropBrokenProfileZip(row.pid);
    const { default: GoLogin } = await import('gologin');
    const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
    let facts = null, err = null;
    try {
      const st = await gl.startLocal();
      if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
      const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
      const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
      await L.hardenContext(ctx);
      await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
      try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}
      await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await L.sleep(5000); await L.clearOverlays(page).catch(() => {});
      const cls = await L.classifyScreen(ctx, page);
      console.log(`  экран входа: ${cls.state} (${cls.evidence})`);
      if (cls.state !== 'logged_in') {
        await snapFull(page, `restrict_${row.slug}_noSession`);
        throw new Error(`сессия не поднялась на куках: экран=${cls.state} — ПАРОЛЬ НЕ ВВОЖУ (запрет)`);
      }
      facts = await readRestrictionDetails(page, { tagBase: `restrict_${row.slug}` });
      // куки освежаем: заход и так оплачен, следующему проверяющему не придётся входить
      try {
        const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
        if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10) && !DRY) {
          await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb WHERE id=$1`, [row.id, JSON.stringify(fresh)]);
        }
      } catch {}
      await b.close().catch(() => {});
    } catch (e) { err = e.message; }
    await closeLocal('finish');

    if (facts) {
      const s = facts.summary;
      console.log(`\nСОСТОЯНИЕ: ${facts.state}`);
      console.log(`ЧТО ОГРАНИЧЕНО: ${s.what.join(' | ')}`);
      console.log(`ПРИЧИНА: ${s.reasons.join(' | ')}`);
      console.log(`СРОКИ: ${s.dates.length ? s.dates.join(' | ') : 'не указаны'}`);
      console.log(`ОСПОРИТЬ: ${s.has_appeal ? 'есть' : 'нет'} · ПОДТВЕРДИТЬ: ${s.has_ack ? 'есть' : 'нет'} · постов в претензии: ${s.posts_listed.length}`);
      console.log(`СКРИНЫ: ${facts.shots.join(' ')}`);
      const dump = `${SHOT_DIR}/restrict_${row.slug}_full.json`;
      fs.writeFileSync(dump, JSON.stringify(facts, null, 1));
      console.log(`ПОЛНЫЙ ДАМП: ${dump}`);
      for (const sc of facts.screens) {
        console.log(`\n──── ЭКРАН «${sc.step}» ${sc.url}\n${String(sc.text || '').slice(0, 3000)}`);
      }
      if (!DRY) {
        const r = await saveRestrictionDetails({ client: c, accountId: row.id, slug: row.slug, facts });
        console.log(`\nВ БАЗУ: событие restriction_detail записано, блокер ${r.blocker}`);
      }
    } else {
      console.log(`ИТОГ: ✗ прочитать не удалось: ${err}`);
    }
    await c.end();
    process.exit(0);
  })().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
}
