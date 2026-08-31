// ПРОВЕРКА ЗДОРОВЬЯ АККА (ограничения/удалённый контент) — один заход, без всякой активности.
// Зачем: урок 01.08 — постили на акк, у которого IG уже удалил фото за спам и добавил restriction.
// Итог пишем в accounts.health_state/health_note/health_checked_at; restricted → ig_status='restricted'
// + status='paused' (инвариант 3 ARCHITECTURE.md: такие акки вне всех пулов).
// Запуск: node ighealth.cjs "<slug>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const L = require('./iglib.cjs');
const SLUG = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';

global.__GL = null; let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });

(async () => {
  if (!SLUG) { console.log('usage: node ighealth.cjs <slug>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT a.id, a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies,
            coalesce(a.health_state,'') health_state, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug=$1 AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL
      ORDER BY (coalesce(a.ig_password,'')<>'') DESC LIMIT 1`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
  console.log(`ЗДОРОВЬЕ @${row.h}${row.persona ? ` (${row.persona})` : ''}`);

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  let state = 'unknown', note = null;
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(5000); await L.clearOverlays(page);
    const cls = await L.classifyScreen(ctx, page);
    // ТЕРМИНАЛЬНЫЕ экраны отделяем от «просто не залогинены»: раньше бан приезжал как no_session,
    // ig_status оставался прежним, и забаненный акк продолжал числиться живым — воркер вёл на него
    // ролик за роликом. Экран честно говорит «бан», значит и в БД должно быть написано «бан».
    if (['suspended', 'captcha', 'challenge'].includes(cls.state)) { state = cls.state; note = `экран=${cls.state} (${cls.evidence})`; }
    else if (cls.state !== 'logged_in') { state = 'no_session'; note = `экран=${cls.state} (${cls.evidence})`; }
    else {
      const hs = await L.checkAccountStatus(page);
      state = hs.state; note = hs.hit || hs.excerpt;
      await L.snap(page, SHOT, `health_${SLUG.replace(/\W+/g, '_')}`);
      console.log(`  🩺 ${state}${hs.hit ? `: «${hs.hit}»` : ''}`);
      console.log(`  экран: ${hs.excerpt.slice(0, 180)}`);
      // ПОЙМАЛИ ФРАЗУ — ЧИТАЕМ ПОДРОБНОСТИ (претензия начальника 07.08). «Ограничен» без ответа на
      // «что именно, за что и до какого числа» бесполезно: по такому факту нельзя решить, лечится ли
      // это ожиданием. Сессия уже открыта, значит подробности стоят пары переходов по «See why».
      // try обязателен: чтение подробностей не должно ломать проверку здоровья.
      if (state === 'restricted') {
        try {
          const RD = require('./restrictdetail.cjs');
          const r = await RD.readAndSaveOnce({ client: c, page, accountId: row.id, slug: SLUG, tagBase: `health_${SLUG.replace(/\W+/g, '_')}_restrict` });
          note = `${(r.summary.what || []).join('; ')} | причина: ${(r.summary.reasons || []).join('; ')} | срок: ${(r.summary.dates || []).slice(0, 3).join(' / ') || 'не указан'}`;
          console.log(`  📄 подробности: ${note} (${r.skipped ? `из базы, прочитано ${r.at}` : `блокер ${r.blocker}, скрины ${(r.shots || []).join(' ')}`})`);
        } catch (e) { console.log(`  ⚠ подробности прочитать не удалось: ${String(e.message).slice(0, 120)}`); }
      }
      // куки заодно освежим — заход и так оплачен
      try {
        const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
        if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) await c.query(`UPDATE accounts SET ig_cookies=$2::jsonb WHERE id=$1`, [row.id, JSON.stringify(fresh)]);
      } catch {}
    }
    await b.close().catch(() => {});
  } catch (e) { state = 'error'; note = String(e.message).slice(0, 200); }

  // СБОЙ ПРОГОНА НЕ ПЕРЕПИСЫВАЕТ ВЕРДИКТ О ЗДОРОВЬЕ (07.08). state='error' это наша инфраструктура:
  // не поднялась Orbita, оборвался CDP, таймаут. Раньше такой сбой писался в health_state поверх
  // всего, и вместе с ним затирался 'keep' — а именно 'keep' служит замком против автосноса акка
  // (см. maybeReplaceBlocked в worker.ts). То есть неудачный запуск браузера снимал с аккаунта защиту
  // от удаления. Теперь при сбое пишем только заметку и время, сам вердикт не трогаем.
  // Отдельно защищаем 'keep': это приказ владельца «не удалять, ждём», косметический прогон его не снимает.
  const cur = String(row.health_state || '');
  if (state === 'error' || cur === 'keep') {
    await c.query(`UPDATE accounts SET health_note=$2, health_checked_at=now() WHERE id=$1`,
      [row.id, `${state === 'error' ? 'прогон не состоялся' : `прогон: ${state}`} (вердикт не менял${cur ? `, остаётся «${cur}»` : ''}): ${String(note || '').slice(0, 300)}`]).catch(() => {});
    console.log(`  ？ вердикт НЕ пишу: ${state === 'error' ? 'сбой прогона' : `состояние «${cur}» защищено`} — ${String(note || '').slice(0, 90)}`);
  } else {
    await c.query(`UPDATE accounts SET health_state=$2, health_note=$3, health_checked_at=now() WHERE id=$1`,
      [row.id, state, String(note || '').slice(0, 400)]).catch(() => {});
  }
  if (['restricted', 'suspended', 'captcha', 'challenge'].includes(state)) {
    await c.query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead' WHERE id=$1`,
      [row.id, state === 'restricted' ? 'restricted' : state]).catch(() => {});
    // и снимаем то, что ему уже назначено: постер не должен раз за разом заходить на мёртвый акк
    const off = await c.query(
      `UPDATE posts SET status='cancelled', error='акк ' || $2 || ' — снят проверкой здоровья'
        WHERE account_id=$1 AND status IN ('approved','publishing') AND post_submitted=false RETURNING id`,
      [row.id, state]).catch(() => ({ rowCount: 0 }));
    console.log(`  ⛔ акк помечен ${state}+paused — вне всех пулов (замена, не лечение), снято постов: ${off.rowCount}`);
  }
  console.log(`ИТОГ: ${state === 'ok' ? '✅ здоров' : state === 'restricted' ? '⛔ ОГРАНИЧЕН' : '⚠ ' + state}${note ? ' · ' + String(note).slice(0, 120) : ''}`);
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
