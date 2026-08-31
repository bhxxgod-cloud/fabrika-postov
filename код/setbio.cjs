// БИО С ВНЕШНЕЙ ПРОВЕРКОЙ (05.08, начальник: «напишем что видео делаю в нейронка про» +
// «какая логика проверки акков, постоянно проебываемся»).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ПРОШЛЫХ ПОПЫТОК. Раньше скрипт кликал Submit и писал «✓ био вписано»,
// а по факту IG отвечал 400 «You need an email or confirmed phone number» и поле оставалось
// пустым — врали все пять акков. Теперь:
//   1) слушаем сетевой ответ /api/v1/web/accounts/edit/ и знаем ТОЧНУЮ причину отказа;
//   2) после сохранения перечитываем поле после перезагрузки страницы;
//   3) и главное — проверяем СНАРУЖИ анонимным запросом, как видит зритель;
//   4) в базу пишем правду: bio_set=true только если снаружи видно текст.
//
// Запуск: node setbio.cjs <slug> [текст]   (без текста — вариант из пула по слагу)
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const sleep = L.sleep;

// Все варианты говорят одно: видео делаю в нейронка про. Разными словами, чтобы у пяти акков
// не стояло слово в слово одинаковое био (одинаковость = маркер сетки).
const BIO_POOL = [
  'видео делаю в нейронка про 🤍',
  'все видео из нейронка про ✨',
  'видео и фото делаю в нейронка про 💛',
  'делаю видео в нейронка про, шаблоны там же 🌿',
  'нейронка про — там делаю все видео 💫',
  'видео мои, делаю их в нейронка про 🫶',
  'тут ии-эксперименты, видео делаю в нейронка про',
  'видео делаю в нейронка про, повторяй за мной 😌',
];
function pickBio(seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BIO_POOL[h % BIO_POOL.length];
}

// Внешняя правда: что видит человек, открывший профиль. Без входа, без риска.
function bioOutside(handle) {
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '25',
      '-H', 'x-ig-app-id: 936619743392459',
      '-A', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return ((JSON.parse(out).data || {}).user || {}).biography ?? null;
  } catch { return null; }
}

async function closeLocal() {
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (gl.killBrowser) gl.killBrowser(); } catch {}
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await closeLocal(); process.exit(0); });

(async () => {
  if (!SLUG) { console.log('usage: node setbio.cjs <slug> [текст]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const row = (await c.query(`SELECT a.id, coalesce(a.ig_login,a.slug) h, a.ig_cookies, a.gologin_profile_id pid,
      a.session_status, g.gologin_token tok
    FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
  if (row.session_status !== 'live') { console.log(`ИТОГ: ✗ сессия ${row.session_status} — не открываем`); await c.end(); process.exit(0); }
  const BIO = process.argv[3] || pickBio(SLUG);

  const before = bioOutside(row.h);
  if (before && before.trim()) { console.log(`ИТОГ: · био уже стоит: ${JSON.stringify(before)}`); await c.end(); process.exit(0); }
  console.log(`@${row.h}: ставлю «${BIO}»`);

  const { default: GoLogin } = await import('gologin');
  // БЕЗ ОКОН (06.08, правило начальника: «окна открываются и мешают, хром не трогай»). Orbita
  // поднимается в headless: экранная работа тут не нужна, нам важен только сетевой ответ IG и
  // внешняя проверка. Нужно окно глазами, ставим SHOW=1.
  const extra = process.env.SHOW === '1' ? [] : ['--headless=new'];
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid, extra }));
  let netError = '';
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    // Ловим настоящую причину отказа, а не тост «что-то пошло не так».
    page.on('response', async (r) => {
      if (/web\/accounts\/edit/i.test(r.url()) && r.request().method() === 'POST' && r.status() >= 400) {
        const t = await r.text().catch(() => '');
        const m = t.match(/"errors":\["([^"]+)"/);
        netError = m ? m[1] : `HTTP ${r.status()}`;
      }
    });

    await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);
    await L.clearOverlays(page);
    const bio = page.locator('textarea#pepBio, textarea[aria-label*="Bio" i], textarea[name="biography"]').first();
    if (!(await bio.isVisible({ timeout: 8000 }).catch(() => false))) throw new Error('поле био не найдено');
    await bio.click(); await sleep(400);
    await bio.pressSequentially(BIO, { delay: 35 });
    await sleep(1200);
    const submit = page.getByRole('button', { name: /Submit|Save|Отправить|Сохранить/i }).first();
    if (await submit.isEnabled().catch(() => false)) { await submit.click(); await sleep(7000); }
    else { console.log('  ⚠ Submit неактивен'); }
  } catch (e) { console.log(`  ⚠ ${String(e.message).slice(0, 80)}`); }
  finally { await closeLocal(); }

  // ПРАВДА: смотрим снаружи, а не на свои же клики.
  await sleep(4000);
  const after = bioOutside(row.h);
  const ok = !!(after && after.trim());
  await c.query(`UPDATE accounts SET bio_set=$2, health_checked_at=now(),
      health_note=$3 WHERE id=$1`,
    [row.id, ok, ok ? 'био стоит (проверено снаружи)' : `био НЕ сохранилось: ${netError || 'причина неизвестна'}`]).catch(() => {});
  await c.end();
  if (ok) console.log(`ИТОГ: ✅ снаружи видно био: ${JSON.stringify(after)}`);
  else console.log(`ИТОГ: ⛔ био пустое снаружи. Причина от IG: ${netError || 'нет ответа'}`);
})().catch(async (e) => { console.error('ОШИБКА:', e.message); await closeLocal(); process.exit(1); });
