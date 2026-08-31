// БРЕНД-БАТЧ: 1 акк открывает Orbita ЛОКАЛЬНО один раз → комментит N постов по 1 бренд-комменту → закрывает.
// 0 облачных часов GoLogin. Логика бренд-постинга скопирована из vcomment (поле → печать → отправка → верификация).
// Запуск: DB_PUBLIC_URL=… node brandbatch.cjs <slug> <url1,url2,...> [--free]  (--free = поставить GoLogin-free прокси)
const { Client } = require('pg');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const URLS = String(process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
const FREE = process.argv.includes('--free');
const SHOT = process.env.SHOT_DIR || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_TOP = [
  'Бесплатный рабочий бот @gener7_bot, там бесплатные генерации и готовый шаблон',
  '@gener7_bot в тг, бесплатные генерации и готовый шаблон, реально работает',
  'юзаю @gener7_bot, бесплатно генерит, шаблон уже готовый внутри',
  '@gener7_bot бот бесплатный, генерации не платные, шаблон готовый есть',
  'в тг бот @gener7_bot, бесплатные генерации, готовый шаблон, всё пашет',
  '@gener7_bot, там бесплатно генерит по готовому шаблону',
  'рабочий бот @gener7_bot в телеге, бесплатные генерации и шаблон готовый',
  '@gener7_bot, бесплатные генерации и готовый пресет, реально рабочий',
  'через @gener7_bot, бесплатно, генерации и готовый шаблон в боте',
  'бот @gener7_bot бесплатный, генерит по готовому шаблону, в тг',
  '@gener7_bot в тг, бесплатные генерации, шаблон готовый, всё бесплатно',
  'держи @gener7_bot, там бесплатные генерации и готовый шаблон',
  '@gener7_bot рабочий бот, генерит бесплатно, шаблон уже внутри',
  'в телеге @gener7_bot, бесплатно генерит и готовый шаблон, топ',
  '@gener7_bot, бесплатные генерации, готовый шаблон, ничего не платишь',
  '@gener7_bot делает бесплатно, готовый шаблон уже внутри, в тг',
  'кидаешь фото в @gener7_bot и всё, бесплатные генерации',
  '@gener7_bot топ бот, генерит бесплатно по готовому промпту',
  'в @gener7_bot бесплатные генерации, шаблон готовый, без оплаты',
  'попробуй @gener7_bot, бот в тг, генерит бесплатно по шаблону',
  '@gener7_bot, закидываешь фото, готовый промпт, бесплатно',
  'бот @gener7_bot реально рабочий, бесплатные генерации в тг',
  '@gener7_bot в телеге бесплатно, шаблон готовый, кидай фото',
  'юзаю @gener7_bot, генерации бесплатные, промпт уже готовый',
  '@gener7_bot бот, бесплатно генерит, готовый шаблон под рукой',
  'заходи в @gener7_bot, бесплатные генерации и готовый пресет',
  '@gener7_bot, всё бесплатно, готовый шаблон, генерит прямо в тг',
  'рабочий @gener7_bot, генерации бесплатно, шаблон уже готовый',
  '@gener7_bot в тг, кидаешь фото, бесплатный результат по шаблону',
  'бот @gener7_bot, бесплатные генерации, промпт готовый, просто в тг',
];
const FAIL_RX = /Не удалось опубликовать|Couldn.?t post|Try again|Что-то пошло не так|Something went wrong|action blocked|Действие заблокировано/i;
async function dismiss(page) {
  for (const rx of [/Allow all cookies|Разрешить все|Accept all|Принять все/i, /Not now|Не сейчас|Позже|Dismiss|Закрыть/i]) {
    try { const b = page.getByRole('button', { name: rx }).first(); if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(600); } } catch { /* */ }
  }
}
// Аварийное закрытие локального окна по сигналу (аудит 28.07: SIGTERM убивал процесс, Orbita оставалась орфаном)
global.__GL = null;
async function closeLocal(why) { const gl = global.__GL; if (!gl) return; try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {} }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
(async () => {
  if (!SLUG || !URLS.length) { console.log('usage: node brandbatch.cjs <slug> <url1,url2,...> [--free]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const a = (await c.query(`SELECT a.id, a.gologin_profile_id pid, g.gologin_token tok FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0];
  if (!a) { console.log('акк не найден'); await c.end(); process.exit(1); }
  if (FREE) { await fetch(`https://api.gologin.com/browser/${a.pid}/proxy`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + a.tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'gologin', autoProxyRegion: 'us' }), signal: AbortSignal.timeout(20000) }).then((r) => console.log('GoLogin-free proxy:', r.status)).catch(() => {}); }
  const { chromium } = require('playwright-core');
  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true, resolution: { width: 1280, height: 900 } });
  console.log(`[${SLUG}] стартую Orbita локально…`);
  const started = await gl.startLocal().catch((e) => { console.log('startLocal FAIL:', (e.message || '').slice(0, 60)); return null; });
  if (!started || !started.wsUrl) { console.log('startLocal без wsUrl'); await closeLocal('no-ws'); await c.end(); process.exit(1); }
  const b = await chromium.connectOverCDP(started.wsUrl, { timeout: 60000 }).catch((e) => { console.log('коннект к Orbita FAIL:', (e.message || '').slice(0, 50)); return null; });
  if (!b) { await closeLocal('no-cdp'); await c.end(); process.exit(1); }
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
  let ok = 0, fail = 0;
  for (let i = 0; i < URLS.length; i++) {
    const url = URLS[i];
    const CODE = (url.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1] || url;
    process.stdout.write(`[${SLUG}] пост ${i + 1}/${URLS.length} ${CODE}: `);
    try {
      await page.goto(`https://www.instagram.com/p/${CODE}/?hl=ru`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(4000); await dismiss(page);
      // добить открытие поля коммента кликом иконки (до ~12с)
      for (let w = 0; w < 8; w++) {
        if (await page.locator('textarea, div[contenteditable="true"]').first().isVisible().catch(() => false)) break;
        const cb = page.locator('svg[aria-label="Comment" i], svg[aria-label*="omment" i], svg[aria-label*="омментир" i]').first();
        if (await cb.isVisible().catch(() => false)) { const bb = await cb.boundingBox().catch(() => null); if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {}); else await cb.click().catch(() => {}); }
        await sleep(1500);
      }
      const idx = Math.abs([...(SLUG + CODE)].reduce((s, ch) => s + ch.charCodeAt(0), 0)) % BOT_TOP.length;
      const bText = BOT_TOP[idx];
      const box = page.locator('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]').first();
      if (!(await box.isVisible().catch(() => false))) { console.log('поле коммента не найдено'); fail++; continue; }
      await box.click().catch(() => {}); await sleep(300);
      await box.pressSequentially(bText, { delay: 40 }).catch(() => {}); await sleep(500);
      const bt = page.getByText(/^(Опубликовать|Post|Publier|Publicar|Отправить)$/i).first();
      if (await bt.isVisible().catch(() => false)) await bt.click().catch(() => {}); else await box.press('Enter').catch(() => {});
      await sleep(4500);
      fs.writeFileSync(`${SHOT}/bb_${SLUG}_${CODE}.png`, (await page.screenshot({ type: 'png', timeout: 12000 }).catch(() => Buffer.alloc(0))));
      const cleared = await page.evaluate(() => { const el = document.querySelector('form textarea, textarea[aria-label], div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]'); const t = el ? (el.value || el.innerText || el.textContent || '').trim() : ''; return t.length < 4; }).catch(() => false);
      const failTxt = await page.getByText(FAIL_RX).first().isVisible().catch(() => false);
      if (cleared && !failTxt) { console.log(`✅ «${bText.slice(0, 45)}…»`); ok++; }
      else { console.log(`✗ не ушёл${failTxt ? ' (IG отклонил)' : ''}`); fail++; }
      await sleep(3000 + Math.floor(Math.random() * 4000)); // человеческая пауза между постами
    } catch (e) { console.log('ERR', (e.message || '').slice(0, 40)); fail++; }
  }
  console.log(`\n[${SLUG}] ИТОГ: ✅ ${ok} / ✗ ${fail} из ${URLS.length}`);
  // закрываем ОДИН раз
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); } catch { /* */ }
  await b.close().catch(() => {});
  try { if (typeof gl.killBrowser === 'function') gl.killBrowser(); } catch { /* */ }
  console.log(`[${SLUG}] окно закрыто`);
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
