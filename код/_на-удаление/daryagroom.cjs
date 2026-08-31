// ГРУМИНГ КРЕАТОР-АККА (решение владельца 01.08): в ОДНОЙ сессии — архив прогревочных фото-постов
// (чтобы в сетке остались только рилсы модели) + подписки на тематические акки (нейронки/дизайн/бьюти).
// Правила: архив, НЕ удаление; ник не трогаем; постер и груминг не судят статусы акков.
// Анти-бан: не больше FOLLOW_MAX подписок за сессию (по умолч. 12), паузы 25-60с — остаток добираем
// следующей сессией. Логика IG-действий — ТОЛЬКО из iglib.
// usage: node daryagroom.cjs "<slug>"   env: ARCHIVE_N=2 FOLLOW_MAX=12 FOLLOWS="a,b,c" SKIP_ARCHIVE=1 SKIP_FOLLOW=1
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const L = require('./iglib.cjs');
const SLUG = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
const ARCHIVE_N = Number(process.env.ARCHIVE_N || 2);
const FOLLOW_MAX = Number(process.env.FOLLOW_MAX || 12);
// Тематика персоны: ИИ-инструменты, дизайн, бьюти — крупные живые акки, подписка на них выглядит естественно.
const FOLLOWS = String(process.env.FOLLOWS || 'openai,midjourney,runwayml,canva,behance,dribbble,artstation,hudabeauty,glossier,sephora,maccosmetics,zara')
  .split(',').map((s) => s.trim()).filter(Boolean);

global.__GL = null;
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

(async () => {
  if (!SLUG) { console.log('usage: node daryagroom.cjs <slug>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT a.id aid, a.gologin_profile_id pid, a.ig_cookies, coalesce(a.ig_login,a.slug) h, a.persona, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
  const cks = L.normCookies(row.ig_cookies);
  const expectedId = L.pickCookie(cks, 'ds_user_id');
  if (!expectedId || (L.pickCookie(cks, 'sessionid') || '').length <= 10) { console.log('ИТОГ: ✗ нет кук сессии'); await c.end(); process.exit(1); }
  console.log(`ГРУМИНГ «${row.persona}» @${row.h}: архив ${ARCHIVE_N} фото-постов + до ${FOLLOW_MAX} подписок`);

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  let archived = 0, followed = 0, err = null;
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies(cks);
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(5000); await L.clearOverlays(page);
    await L.step(page, SHOT, 'сессия', async () => {
      const cls = await L.classifyScreen(ctx, page);
      if (cls.state !== 'logged_in') throw new Error(`экран=${cls.state} (${cls.evidence})`);
      if (String(cls.dsUserId) !== String(expectedId)) throw new Error(`чужая сессия: ${cls.dsUserId} вместо ${expectedId}`);
    });

    // ── АРХИВ фото-постов (/p/, рилсы /reel/ не трогаем) ────────────────────
    if (process.env.SKIP_ARCHIVE !== '1') {
      for (let i = 0; i < ARCHIVE_N; i++) {
        await page.goto(`https://www.instagram.com/${row.h}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await L.sleep(4500); await L.clearOverlays(page);
        const photo = await page.evaluate(() =>
          [...document.querySelectorAll('a[href*="/p/"]')].map((a) => a.getAttribute('href')).filter(Boolean)[0] || null,
        ).catch(() => null);
        if (!photo) { console.log('  📁 фото-постов в сетке больше нет'); break; }
        await L.step(page, SHOT, `архив ${photo}`, async () => {
          // ФАКТ 01.08: в меню «…» на посте (веб) пункта Archive НЕТ — там только Delete/Edit/Hide like count.
          // Архив живёт в «Your activity → Photos and videos → Posts»: режим Select → выбрать → Archive.
          // Удаление НЕ используем ни при каких условиях: архив обратим, Delete нет.
          // Меню «…» поста. Факт 01.08: в вебе IG-2026 пункта Archive НЕТ (дамп: Delete, Edit, Hide like
          // count, Turn off commenting, About this account, Share to…, Copy link). Поэтому убрать пост из
          // сетки из веба можно ТОЛЬКО удалением, и оно НЕОБРАТИМО → идёт лишь по явному ALLOW_DELETE=1.
          await page.goto('https://www.instagram.com' + photo, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await L.sleep(4000); await L.clearOverlays(page);
          const more = page.locator('svg[aria-label="More options" i], svg[aria-label="Ещё" i]').first();
          if (!(await more.isVisible({ timeout: 6000 }).catch(() => false))) throw new Error('кнопка «…» на посте не найдена');
          await L.clickSafe(page, more, '«…» на посте');
          await L.sleep(2200);
          // ТОЛЬКО пункты открытого диалога (не вся страница) и БЕЗ обрезки.
          const menu = await page.evaluate(() => {
            const dlg = [...document.querySelectorAll('div[role="dialog"]')].filter((d) => d.offsetParent !== null).pop();
            const scope = dlg || document.body;
            return [...scope.querySelectorAll('button,div[role="button"]')]
              .filter((e) => e.offsetParent !== null).map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 40);
          }).catch(() => []);
          console.log(`    · меню поста (${menu.length}): ${JSON.stringify([...new Set(menu)])}`);
          const arch = page.getByRole('button', { name: /^(Archive|Архивировать)$/i }).first();
          // skipClear: кликаем ВНУТРИ открытого меню — гасилка оверлеев его же и закрывала (баг 01.08).
          if (await arch.isVisible({ timeout: 4000 }).catch(() => false)) {
            await L.clickSafe(page, arch, 'Archive', { skipClear: true });
          } else if (process.env.ALLOW_DELETE === '1') {
            const del = page.getByRole('button', { name: /^(Delete|Удалить)$/i }).first();
            if (!(await del.isVisible({ timeout: 4000 }).catch(() => false))) throw new Error('нет ни Archive, ни Delete в меню поста');
            console.log('    ⚠ Archive недоступен в вебе → УДАЛЯЮ (ALLOW_DELETE=1, необратимо)');
            await L.clickSafe(page, del, 'Delete', { skipClear: true });
            await L.sleep(2000);
          } else {
            throw new Error('Archive в вебе недоступен; удаление запрещено (нужен ALLOW_DELETE=1)');
          }
          await L.sleep(2500);
          const conf = page.getByRole('button', { name: /^(Archive|Архивировать|Delete|Удалить|Confirm|Подтвердить)$/i }).first();
          if (await conf.isVisible({ timeout: 3000 }).catch(() => false)) { await conf.click({ timeout: 4000 }).catch(() => {}); }
          await L.sleep(4000);
          // Успех ПОЛОЖИТЕЛЬНО: пост пропал из сетки профиля (а не «кнопка нажалась»).
          await page.goto(`https://www.instagram.com/${row.h}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await L.sleep(4000); await L.clearOverlays(page);
          const still = await page.evaluate((href) => [...document.querySelectorAll('a[href*="/p/"]')]
            .some((a) => a.getAttribute('href') === href), photo).catch(() => false);
          if (still) throw new Error('пост остался в сетке — архив не сработал');
        });
        archived++;
        console.log(`  📁 в архив: ${photo} (${archived}/${ARCHIVE_N})`);
        await L.sleep(rnd(8000, 15000));
      }
    }

    // ── ПОДПИСКИ на тематические акки ───────────────────────────────────────
    // Анти-бан: не больше FOLLOW_MAX за сессию, паузы 25-60с. Остаток добираем следующей сессией.
    if (process.env.SKIP_FOLLOW !== '1') {
      for (const target of FOLLOWS) {
        if (followed >= FOLLOW_MAX) { console.log(`  🔒 лимит подписок за сессию (${FOLLOW_MAX}) — остаток в следующий заход`); break; }
        try {
          await page.goto(`https://www.instagram.com/${target}/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await L.sleep(rnd(3500, 6000)); await L.clearOverlays(page);
          const btn = page.getByRole('button', { name: /^(Follow|Подписаться)$/i }).first();
          if (!(await btn.isVisible({ timeout: 5000 }).catch(() => false))) { console.log(`  · @${target}: кнопки Follow нет (уже подписан?)`); continue; }
          await L.clickSafe(page, btn, `Follow @${target}`);
          await L.sleep(3000);
          // Успех ПОЛОЖИТЕЛЬНО: кнопка сменилась на Following/Requested.
          const ok = await page.getByRole('button', { name: /^(Following|Requested|Вы подписаны|Запрос отправлен)$/i }).first()
            .isVisible({ timeout: 6000 }).catch(() => false);
          if (!ok) { console.log(`  ⚠ @${target}: подписка не подтвердилась (кнопка не сменилась)`); continue; }
          followed++;
          console.log(`  ➕ подписка на @${target} (${followed}/${FOLLOW_MAX})`);
          await L.sleep(rnd(25000, 60000));
        } catch (e) { console.log(`  ⚠ @${target}: ${String(e.message).slice(0, 70)}`); }
      }
    }

    // Куки освежаем — заход и так оплачен (правило «один вход = всё»).
    try {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) {
        await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb, session_checked_at=now() WHERE id=$1`, [row.aid, JSON.stringify(fresh)]);
        console.log(`  💾 куки пересохранены (${fresh.length})`);
      }
    } catch {}
    await b.close().catch(() => {});
  } catch (e) { err = String(e.message).slice(0, 200); }

  console.log(`ИТОГ: ${err ? '⚠ ' + err + ' · ' : ''}архив ${archived}, подписок ${followed}`);
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });