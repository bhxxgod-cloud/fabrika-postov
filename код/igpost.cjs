// ПУБЛИКАЦИЯ РОЛИКА В INSTAGRAM (Reels) — ЛОКАЛЬНО через Orbita, 0 облачных часов GoLogin.
// Цепочка владельца 29.07: промо-фабрика собрала ролик для личности → пост в очереди → этот скрипт публикует
// на привязанный акк и пишет первый коммент со ссылкой.
// Запуск: DB_PUBLIC_URL=… node igpost.cjs "<slug>" "<post_id>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const SLUG = process.argv[2];
const POST_ID = process.argv[3];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
global.__GL = null;
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });

async function snap(page, name) { try { fs.writeFileSync(`${SHOT}/post_${SLUG.replace(/\W/g, '_')}_${name}.png`, await page.screenshot({ type: 'jpeg', quality: 50, timeout: 12000 })); } catch {} }
async function dismiss(page) {
  // Именованные попапы
  for (const rx of [/Allow all cookies|Разрешить все|Accept all/i, /^(Not now|Не сейчас|Позже|Dismiss|OK|Ок|Понятно|Got it)$/i]) {
    try { const b = page.getByRole('button', { name: rx }).first(); if (await b.isVisible({ timeout: 1000 }).catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(700); } } catch {}
  }
  // ЛЮБАЯ оставшаяся модалка: жмём ПОСЛЕДНЮЮ кнопку диалога (правило проекта — Escape в IG не работает).
  // Наблюдение 29.07: модалка «You're in sleep mode» перекрывала ленту, и скрипт решал «не залогинен».
  for (let i = 0; i < 3; i++) {
    try {
      const dlg = page.locator('div[role="dialog"]').first();
      if (!(await dlg.isVisible({ timeout: 800 }).catch(() => false))) break;
      const btns = dlg.locator('button, div[role="button"]');
      const n = await btns.count().catch(() => 0);
      if (!n) break;
      await btns.nth(n - 1).click({ timeout: 3000 }).catch(() => {});
      await sleep(900);
    } catch { break; }
  }
}
// Скачиваем ролик во временный файл (IG принимает файл, не ссылку)
async function fetchVideo(url) {
  const out = `${SHOT}/promo_${Date.now()}.mp4`;
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('видео не скачалось: HTTP ' + r.status);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`  📥 ролик скачан: ${mb} МБ`);
  return out;
}
(async () => {
  if (!SLUG || !POST_ID) { console.log('usage: node igpost.cjs <slug> <post_id>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT p.id, p.caption, p.media_url, p.reply_text, p.post_submitted, a.id aid, a.gologin_profile_id pid,
            a.ig_cookies, coalesce(a.ig_login,a.slug) h, a.persona, g.gologin_token tok
       FROM posts p JOIN accounts a ON a.id=p.account_id JOIN account_groups g ON g.id=a.group_id
      WHERE p.id=$1 AND a.slug=$2`, [POST_ID, SLUG])).rows[0];
  if (!row) { console.log('пост/акк не найден'); await c.end(); process.exit(1); }
  // ИНВАРИАНТ (грабли проекта): после клика «Опубликовать» ретраи запрещены — иначе дубли постов.
  if (row.post_submitted) { console.log('пост уже отправлялся — ретрай запрещён'); await c.end(); process.exit(0); }
  if (!row.media_url) { console.log('нет media_url'); await c.end(); process.exit(1); }
  console.log(`ПУБЛИКУЮ для «${row.persona}» на @${row.h}: ${String(row.caption || '').slice(0, 60)}`);

  let videoPath = null;
  try { videoPath = await fetchVideo(row.media_url); }
  catch (e) { console.log('  ✗', e.message); await c.query(`UPDATE posts SET status='failed', error=$2 WHERE id=$1`, [row.id, String(e.message).slice(0, 200)]); await c.end(); process.exit(1); }

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin({ token: row.tok, profile_id: row.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 } });
  let ok = false, err = null, postUrl = null;
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
    // Подставляем сохранённую сессию — вход не нужен
    if (row.ig_cookies) {
      try {
        const raw = typeof row.ig_cookies === 'string' ? JSON.parse(row.ig_cookies) : row.ig_cookies;
        const cks = (Array.isArray(raw) ? raw : []).filter((x) => x && x.name && x.value).map((x) => ({
          name: x.name, value: String(x.value), domain: x.domain || '.instagram.com', path: x.path || '/',
          httpOnly: !!x.httpOnly, secure: x.secure !== false,
          ...(x.expires && x.expires > 0 ? { expires: Math.floor(x.expires) } : {}),
        }));
        if (cks.length) { await ctx.addCookies(cks); console.log(`  🍪 сессия подставлена (${cks.length} кук)`); }
      } catch {}
    }
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000); await dismiss(page);
    // one-tap «Continue» если появился
    for (let t = 0; t < 2; t++) {
      const cont = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
      if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) { await cont.click({ timeout: 5000 }).catch(() => {}); await sleep(7000); } else break;
    }
    await dismiss(page); // гасим всё, что успело всплыть
    // Кука — источник истины: попапы её не перекрывают (в отличие от DOM-маркеров).
    const ckNow = await ctx.cookies('https://www.instagram.com').catch(() => []);
    const hasSess = ckNow.some((x) => x.name === 'sessionid' && x.value && x.value.length > 10);
    const inFeed = hasSess || await page.locator('a[href="/explore/"], svg[aria-label="New post" i], svg[aria-label="Home" i]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!inFeed) { await snap(page, 'nologin'); throw new Error('не залогинен (сессия протухла — нужен вход)'); }
    console.log('  ✓ в аккаунте');

    // ОТКРЫВАЕМ СОЗДАНИЕ ПОСТА. Прямой переход на /create/select/ в IG-2026 НЕ работает (редиректит в ленту,
    // наблюдение 29.07: в дампе были кнопки ленты). Открываем ТОЛЬКО кликом по «New post» и ЖДЁМ диалог.
    let createOpen = false;
    for (let t = 0; t < 3 && !createOpen; t++) {
      const nb = page.locator('svg[aria-label="New post" i], svg[aria-label="Создать" i], a[href="/create/select/"], div[role="button"]:has(svg[aria-label="New post" i])').first();
      if (await nb.isVisible({ timeout: 4000 }).catch(() => false)) {
        const bb = await nb.boundingBox().catch(() => null);
        if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); else await nb.click({ timeout: 4000 }).catch(() => {});
        await sleep(3500);
      }
      // подменю «Post» (IG иногда предлагает Post / Story / Reel)
      const sub = page.getByRole('button', { name: /^(Post|Публикация|Reel)$/i }).first();
      if (await sub.isVisible({ timeout: 2500 }).catch(() => false)) { await sub.click({ timeout: 4000 }).catch(() => {}); await sleep(3000); }
      // признак открытого диалога загрузки
      createOpen = await page.getByText(/Create new post|Drag photos and videos|Создание публикации|Перетащите/i).first().isVisible({ timeout: 4000 }).catch(() => false)
        || (await page.locator('div[role="dialog"] input[type="file"]').count().catch(() => 0)) > 0;
      if (!createOpen) console.log(`  (диалог не открылся, попытка ${t + 1})`);
    }
    await snap(page, '1_create');
    if (!createOpen) {
      const ui = await page.evaluate(() => [...document.querySelectorAll('button,div[role="button"],svg[aria-label]')].filter((e) => e.offsetParent !== null).map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 20)).catch(() => []);
      console.log('  UI:', JSON.stringify([...new Set(ui)]));
      throw new Error('не открылся диалог создания поста');
    }
    console.log('  ✓ диалог создания открыт');

    // ЗАГРУЗКА ФАЙЛА
    const fileInput = page.locator('div[role="dialog"] input[type="file"], input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    await fileInput.setInputFiles(videoPath);
    console.log('  📤 файл отправлен, жду обработку…');
    await sleep(14000); await snap(page, '2_uploaded');
    // ФОРМАТ 9:16 — кнопка кадрирования слева снизу (подсказка владельца 29.07). Без неё Reels обрежет в квадрат.
    try {
      const cropBtn = page.locator('svg[aria-label*="Select crop" i], svg[aria-label*="Crop" i], svg[aria-label*="Кадр" i]').first();
      if (await cropBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const bb = await cropBtn.boundingBox().catch(() => null);
        if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); else await cropBtn.click().catch(() => {});
        await sleep(1800);
        const ratio = page.getByText(/^(9:16|Original|Оригинал)$/i).first();
        if (await ratio.isVisible({ timeout: 3000 }).catch(() => false)) { await ratio.click().catch(() => {}); console.log('  🔲 формат 9:16 выбран'); await sleep(1500); }
        else console.log('  ⚠ вариант 9:16 не найден в меню кадрирования');
        await snap(page, '2b_crop');
      } else console.log('  (кнопка кадрирования не найдена — возможно IG сам определил вертикаль)');
    } catch (e) { console.log('  (формат:', String(e.message).slice(0, 40) + ')'); }
    // дамп кнопок — чтобы чинить селекторы по факту, а не гадать
    try { const ui = await page.evaluate(() => [...document.querySelectorAll('button,div[role="button"],svg[aria-label]')].filter((e) => e.offsetParent !== null).map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 18)); console.log('  UI:', JSON.stringify([...new Set(ui)])); } catch {}

    // ПРОХОДИМ ШАГИ «Next» (обрезка → фильтры → подпись)
    for (let s = 0; s < 3; s++) {
      const next = page.getByRole('button', { name: /^(Next|Далее)$/i }).first();
      if (await next.isVisible({ timeout: 8000 }).catch(() => false)) { await next.click({ timeout: 5000 }).catch(() => {}); await sleep(4500); }
      else break;
    }
    await snap(page, '3_caption');

    // ПОДПИСЬ
    if (row.caption) {
      const capBox = page.locator('div[contenteditable="true"][role="textbox"], textarea[aria-label*="aption" i]').first();
      if (await capBox.isVisible({ timeout: 6000 }).catch(() => false)) {
        await capBox.click().catch(() => {});
        await capBox.pressSequentially(String(row.caption).slice(0, 2100), { delay: 12 }).catch(() => {});
        console.log('  ✍️ подпись введена');
      } else console.log('  ⚠ поле подписи не найдено');
    }
    await sleep(1500);

    // ПУБЛИКАЦИЯ (после этого ретраи запрещены — сразу метим в БД)
    const share = page.getByRole('button', { name: /^(Share|Поделиться|Опубликовать)$/i }).first();
    if (!(await share.isVisible({ timeout: 8000 }).catch(() => false))) { await snap(page, 'noshare'); throw new Error('кнопка Share не найдена'); }
    await c.query(`UPDATE posts SET post_submitted=true, status='publishing' WHERE id=$1`, [row.id]);
    await share.click({ timeout: 6000 }).catch(() => {});
    console.log('  🚀 Share нажат, жду загрузку…');
    for (let w = 0; w < 24; w++) {
      await sleep(5000);
      const done = await page.getByText(/Your (reel|post) has been shared|Ваш пост опубликован|shared/i).first().isVisible({ timeout: 1500 }).catch(() => false);
      if (done) { ok = true; break; }
    }
    await snap(page, '4_result');
    if (!ok) { const stillSharing = await page.getByText(/Sharing|Публикуется/i).first().isVisible().catch(() => false); if (!stillSharing) ok = true; }

    if (ok) {
      console.log('  ✅ опубликовано');
      // Первый коммент со ссылкой (ссылку в тело поста не кладём — правило проекта)
      if (row.reply_text) {
        try {
          await page.goto(`https://www.instagram.com/${row.h}/`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
          await sleep(6000);
          const first = page.locator('a[href*="/p/"], a[href*="/reel/"]').first();
          if (await first.isVisible({ timeout: 6000 }).catch(() => false)) {
            const href = await first.getAttribute('href').catch(() => null);
            if (href) {
              postUrl = 'https://www.instagram.com' + href;
              await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
              await sleep(5000);
              const box = page.locator('textarea, div[contenteditable="true"][role="textbox"]').first();
              if (await box.isVisible({ timeout: 6000 }).catch(() => false)) {
                await box.click().catch(() => {});
                await box.pressSequentially(String(row.reply_text), { delay: 25 }).catch(() => {});
                await sleep(600);
                const pb = page.getByText(/^(Post|Опубликовать)$/i).first();
                if (await pb.isVisible().catch(() => false)) await pb.click().catch(() => {}); else await box.press('Enter').catch(() => {});
                await sleep(4000);
                console.log('  💬 первый коммент со ссылкой отправлен');
              }
            }
          }
        } catch (e) { console.log('  (первый коммент не вышел:', String(e.message).slice(0, 40) + ')'); }
      }
    }
    await b.close().catch(() => {});
  } catch (e) { err = String(e.message).slice(0, 200); console.log('  ✗ ОШИБКА:', err); }

  await c.query(`UPDATE posts SET status=$2, published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,
      external_url=coalesce($3,external_url), error=$4 WHERE id=$1`,
    [row.id, ok ? 'published' : 'failed', postUrl, err]);
  try { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch {}
  console.log(`ИТОГ: ${ok ? '✅ опубликовано' : '✗ не вышло'}${postUrl ? ' → ' + postUrl : ''}`);
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
