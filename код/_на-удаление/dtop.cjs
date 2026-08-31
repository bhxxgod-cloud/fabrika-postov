// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
//
// DTOP — обход сломанного reply-режима. Цепляемся к УЖЕ ОТКРЫТОЙ локальной сессии по CDP (НЕ поднимаем вторую,
// НЕ закрываем её в конце — процесс просто выходит, браузер живёт дальше). Вместо «Ответить» (которое у части
// акков IG не включает — поле не переходит в режим ответа) пишем ТОП-ЛЕВЕЛ коммент с @упоминанием спрашивающего:
// человек получает то же уведомление, а действие для IG — обычный коммент, который у этих акков проходит.
//
// Запуск: CDP=http://127.0.0.1:23002 node dtop.cjs <slug> <url> [сколько]
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');

const CDP = process.env.CDP || 'http://127.0.0.1:23002';
const SLUG = process.argv[2];
const URL = process.argv[3] || 'https://www.instagram.com/reel/DZQe5pIIP-C/';
const WANT = Number(process.argv[4] || 2);
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const CODE = (URL.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
const SHOT = process.env.SHOT_DIR || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Спрашивающие: просят промпт/ссылку/название нейросети. Автора поста и наших ботов отсекаем отдельно.
const ASK = /(промт|промпт|prompt|промд|как (сдел|это|повтор)|что за (нейрос|прилож|прог)|какая (нейрос|прог)|какое прилож|ссылк|скинь|подскаж|скажите как|где дел)/i;

// БЕЗ @УПОМИНАНИЙ. Проверено 21.07.2026 контрольными тестами (testpub.cjs) на emanuel/darrell/elvis:
// «промпт» ✅, нейтральный текст ✅, бренд ✅, а ЛЮБОЙ текст с «@ник» → «Не удалось опубликовать».
// Reply-режим IG сам подставляет @ник — поэтому все наши ответы неделями отбивались, хотя акки живы.
//
// БРЕНД ОБЯЗАТЕЛЕН (решение владельца 21.07.2026): «нейронка про» должна упоминаться в КАЖДОМ тексте.
// Нейтральные комменты без бренда не пишем вообще — они не дают трафика, смысла в них нет.
// Формат: топ-левел отзыв от 1 лица, без указания пола (ник акка виден рядом → «сама делала» с ника Graham = палево).
const TPL = [
  () => 'нейронка про выручает, бесплатно, в яндексе находится',
  () => 'делаю такое в нейронка про, бесплатно, готовый шаблон, в яндексе найдёте',
  () => 'юзаю нейронка про, там всё бесплатно и по-русски, в яндексе есть',
  () => 'у меня это через нейронка про собрано, бесплатно, вбейте в яндекс',
  () => 'это в нейронка про делается, бесплатно, готовые шаблоны, поищите в яндексе',
  () => 'нейронка про использую, всё бесплатно, в яндексе набрать',
];

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

(async () => {
  if (!SLUG) { console.log('нужен slug'); process.exit(1); }
  const c = await db();
  // Кого уже отвечали (кросс-аккаунтный дедуп) + наши же ники, чтобы не писать самим себе.
  const answered = new Set((await c.query('SELECT username FROM post_answered WHERE code=$1', [CODE]).catch(() => ({ rows: [] }))).rows.map((r) => String(r.username).toLowerCase()));
  const ours = new Set((await c.query("SELECT slug FROM accounts WHERE platform='comments'").catch(() => ({ rows: [] }))).rows.map((r) => String(r.slug).toLowerCase()));
  const author = (URL.includes('alina') ? 'alina.rpnsk' : '');
  // Реквизиты профиля нужны для ОБЛАЧНОГО режима (основной) — берём сразу, пока коннект к БД открыт.
  const acc = (await c.query(
    `SELECT a.gologin_profile_id AS pid,
            coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [SLUG])).rows[0];
  await c.end();

  // Основа — ОБЛАЧНЫЕ профили GoLogin. CDP задаётся только чтобы прицепиться к уже открытой ЛОКАЛЬНОЙ сессии.
  let b, cloud = false;
  if (process.env.CDP) {
    console.log(`[dtop] ${SLUG} → локальная сессия ${CDP} | уже отвечено ${answered.size} | цель ${WANT}`);
    b = await chromium.connectOverCDP(CDP, { timeout: 60000 });
  } else {
    if (!acc || !acc.pid || !acc.tok) { console.log(`[dtop] у ${SLUG} нет gologin_profile_id/токена — выхожу`); process.exit(1); }
    cloud = true;
    console.log(`[dtop] ${SLUG} → ОБЛАКО GoLogin | уже отвечено ${answered.size} | цель ${WANT}`);
    const u = new global.URL('wss://cloudbrowser.gologin.com/connect');
    u.searchParams.set('token', acc.tok); u.searchParams.set('profile', acc.pid);
    for (let k = 0; k < 5 && !b; k++) {
      try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); }
      catch (e) { console.log('коннект try' + k + ': ' + String(e.message).slice(0, 60)); await sleep(k === 0 ? 22000 : 14000); }
    }
    if (!b) { console.log('[dtop] облако не поднялось за 5 попыток — выхожу'); process.exit(1); }
  }
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /instagram/.test(p.url())) || ctx.pages()[0] || await ctx.newPage();

  // Правило 4: свежая страница вместо зависшей. hl=ru — чтобы селекторы кнопок совпадали.
  const urlRu = URL + (URL.includes('?') ? '&' : '?') + 'hl=ru';
  await page.goto(urlRu, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(5000);
  console.log('страница обновлена:', page.url().slice(0, 70));

  // Открыть панель комментов (на reel она может быть свёрнута).
  for (const sel of ['svg[aria-label="Комментировать"]', 'svg[aria-label="Comment"]', 'a[href$="/comments/"]']) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 5000 }).catch(() => {}); await sleep(3000); break; }
  }

  // Ждём, пока комменты реально отрисуются: считаем кнопки «Ответить» (по одной на коммент).
  // Фиксированной паузы мало — после релоада список приезжает асинхронно и мы читали пустой DOM.
  const countReply = () => page.evaluate(() => Array.from(document.querySelectorAll('*'))
    .filter((e) => e.children.length === 0 && /^(Ответить|Reply)$/.test(String(e.textContent || '').trim())).length).catch(() => 0);
  let nrep = 0;
  for (let i = 0; i < 15; i++) { nrep = await countReply(); if (nrep > 0) break; await sleep(3000); }
  console.log(`комментов на странице: ${nrep}${nrep ? '' : ' — список не отрисовался'}`);

  // Подгрузить ещё комментов (немного — свежие сверху, глубоко копать не нужно).
  for (let i = 0; i < 3; i++) {
    const more = page.locator('svg[aria-label="Загрузить ещё комментарии"], svg[aria-label="Load more comments"]').first();
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click({ timeout: 5000 }).catch(() => {});
    await sleep(3500);
  }

  // Извлекаем пары (ник, текст). Якорь — кнопка «Ответить»: она есть ровно один раз на коммент.
  // (От ссылки на профиль вверх идти нельзя: первый же предок с текстом — общий контейнер всего списка.)
  const items = await page.evaluate(() => {
    const out = [];
    const leaves = Array.from(document.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && /^(Ответить|Reply)$/.test(String(e.textContent || '').trim()));
    for (const leaf of leaves) {
      let box = leaf;
      for (let i = 0; i < 10 && box; i++) {
        box = box.parentElement;
        if (!box) break;
        const a = box.querySelector('a[href^="/"]');
        const t = String(box.innerText || '').trim();
        // Поднимаемся до первого предка, где уже есть и автор, и текст, но список ещё не «слипся» в один блок.
        if (a && t.length > 12 && t.length < 600) {
          // ВАЖНО: hl=ru тянется в href («/nick/?hl=ru»), поэтому query обязателен в регекспе — без него 0 целей.
          const m = a.getAttribute('href').match(/^\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/);
          if (m) { out.push({ nick: m[1], text: t.replace(/\s+/g, ' ') }); break; }
        }
      }
    }
    return out;
  }).catch(() => []);
  console.log(`извлечено блоков: ${items.length}`);

  // Отбор целей: спрашивают, не автор, не наши, не отвеченные, без дублей.
  const targets = [];
  const used = new Set();
  for (const it of items) {
    const n = it.nick.toLowerCase();
    if (used.has(n) || n === author || ours.has(n) || answered.has(n)) continue;
    if (!ASK.test(it.text)) continue;
    used.add(n); targets.push(it);
    if (targets.length >= WANT * 3) break;
  }
  console.log(`целей найдено: ${targets.length}${targets.length ? ' → ' + targets.slice(0, 6).map((t) => '@' + t.nick).join(', ') : ''}`);
  if (!targets.length) { console.log("НЕТ НОВЫХ СПРАШИВАЮЩИХ — выхожу, сессию НЕ трогаю"); process.exit(0); }

  const composer = () => page.locator('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]').first();
  const composerEmpty = async () => page.evaluate(() => {
    const b = document.querySelector('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]');
    const t = b ? (b.value || b.innerText || b.textContent || '').trim() : '';
    return t.length < 3;
  }).catch(() => false);

  let done = 0;
  for (const t of targets) {
    if (done >= WANT) break;
    const msg = TPL[done % TPL.length]();
    // Ник цели пишем только в лог/БД (кому «в ответ» по смыслу), в САМ ТЕКСТ он не попадает — см. TPL выше.
    console.log(`\n→ коммент в ветку (повод: @${t.nick}): ${msg.slice(0, 60)}…`);
    try {
      const box = composer();
      await box.click({ timeout: 10000 });
      await sleep(700);
      // Чистим поле от возможного мусора/прежнего @упоминания.
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await sleep(400);
      await box.pressSequentially(msg, { delay: 45 });
      await sleep(1200);
      // @упоминание открывает автокомплит — гасим Escape, иначе Enter выберет подсказку вместо отправки.
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);

      const POST_RX = /^(Опубликовать|Post|投稿)$/i;
      const clickPost = async () => {
        for (const cnd of [page.getByRole('button', { name: POST_RX }), page.locator('div[role="button"]').filter({ hasText: POST_RX }), page.getByText(POST_RX)]) {
          const el = cnd.first();
          if (!(await el.isVisible().catch(() => false))) continue;
          const bb = await el.boundingBox().catch(() => null);
          if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); return true; }
          await el.click({ timeout: 4000 }).catch(() => {}); return true;
        }
        await box.press('Enter').catch(() => {}); return false;
      };
      await clickPost(); await sleep(4200);
      // Правило 5: успех = композер очистился (а не «нет баннера ошибки»).
      let ok = await composerEmpty();
      if (!ok) { await box.press('Enter').catch(() => {}); await sleep(3500); ok = await composerEmpty(); }
      if (!ok) { await clickPost(); await sleep(3500); ok = await composerEmpty(); }

      await page.screenshot({ path: `${SHOT}/dtop_${SLUG}_${t.nick}.png` }).catch(() => {});
      if (ok) {
        done++;
        console.log(`✓ ОПУБЛИКОВАНО @${t.nick}  (скрин ${SHOT}/dtop_${SLUG}_${t.nick}.png)`);
        const c2 = await db();
        await c2.query('INSERT INTO post_answered(code, username, ts) VALUES($1,$2,now()) ON CONFLICT DO NOTHING', [CODE, t.nick]).catch(() => {});
        await c2.end();
        await sleep(20000 + Math.floor(Math.random() * 15000)); // пауза между комментами
      } else {
        console.log(`✗ НЕ опубликовалось @${t.nick} → релоад и следующий`);
        await page.goto(urlRu, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
        await sleep(6000);
      }
    } catch (e) {
      console.log(`✗ ошибка на @${t.nick}: ${String(e.message).slice(0, 90)}`);
      await page.goto(urlRu, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await sleep(6000);
    }
  }

  console.log(`\nИТОГ: опубликовано ${done} из ${WANT}`);
  // Облачную сессию ГАСИМ штатно (DELETE /web) — иначе профиль висит занятым и следующий заход не поднимется.
  // Локальную НЕ трогаем: b.close() на CDP-коннекте может прибить Orbita, а с ней разлогинить акк (RULES п.1).
  if (cloud) {
    await fetch('https://api.gologin.com/browser/' + acc.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + acc.tok } }).catch(() => {});
    console.log('облачная сессия закрыта штатно');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', String(e.message).slice(0, 160)); process.exit(1); });
