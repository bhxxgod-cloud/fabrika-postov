// reelanalyze.cjs — на УЖЕ ЗАЛОГИНЕННОМ локальном окне: резка трафика (видео/картинки/шрифты) → навигация на
// рил → чистый дамп структуры комментов (топ-левел vs ответы-в-ветке, CTA-сигналы). Окно оставляет открытым.
// usage: node reelanalyze.cjs <slug> [reelURL]
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const REEL = process.argv[3] || 'https://www.instagram.com/reel/Da5nHB4IbKf/';
const SHOT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findPort(pid) {
  try { const out = execSync('ps -Ao command 2>/dev/null', { encoding: 'utf8', maxBuffer: 1 << 24 });
    for (const line of out.split('\n')) { if (line.includes(`gologin_profile_${pid}`) && line.includes('remote-debugging-port=')) return (line.match(/remote-debugging-port=(\d+)/) || [])[1]; }
  } catch {} return null;
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 }); await c.connect();
  const a = (await c.query('SELECT slug, gologin_profile_id pid FROM accounts WHERE lower(slug)=lower($1) LIMIT 1', [SLUG])).rows[0];
  await c.end();
  const port = findPort(a.pid);
  if (!port) { console.log('окно не найдено — открой сперва'); process.exit(1); }
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();

  // РЕЗКА ТРАФИКА: рубим видео/картинки/шрифты (нам нужен только текст комментов)
  let blocked = 0, allowed = 0;
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'media' || t === 'image' || t === 'font') { blocked++; return route.abort().catch(() => {}); }
    allowed++; return route.continue().catch(() => {});
  }).catch(() => {});

  // онетап «сохранить вход» → жмём Save info (доверенное устройство), если висит
  for (const t of ['Save info', 'Not now']) { const btn = page.getByRole('button', { name: new RegExp(t, 'i') }).first(); if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(1500); break; } }

  console.log(`навигирую на рил (трафик режется)…`);
  await page.goto(REEL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000);
  // ОТКРЫТЬ панель комментов: на реле (залогинен) комменты СПРЯТАНЫ за иконкой-спич-бабл (не inline). Жмём её.
  const cIcon = page.locator('svg[aria-label="Comment" i], svg[aria-label*="omment" i], svg[aria-label*="омментир" i]').first();
  if (await cIcon.isVisible().catch(() => false)) { console.log('открываю панель комментов (клик иконки)…'); await cIcon.click().catch(() => {}); await sleep(4000); }
  // раскрыть скрытые ветки: жмём «View replies»/«Смотреть ответы» (до 8)
  for (let i = 0; i < 8; i++) {
    const vr = page.getByText(/View (all )?\d* ?replies|Смотреть( все)? ответ|Показать ответ/i).first();
    if (!(await vr.isVisible().catch(() => false))) break;
    await vr.click().catch(() => {}); await sleep(1200);
  }

  // ДАМП: топ-левел коммент = li с автором+текстом; ответ-в-ветке имеет больший left-отступ. Дедуп по автор+текст.
  const dump = await page.evaluate(() => {
    const seen = new Set(); const out = [];
    const nodes = Array.from(document.querySelectorAll('li, div')).filter((el) => {
      const t = el.innerText || ''; return /(\bReply\b|\bОтветить\b)/.test(t) && t.length < 350 && el.querySelector('a[href^="/"]');
    });
    // берём самый ГЛУБОКИЙ контейнер (без вложенных таких же) → убираем родителей-дубли
    const leaf = nodes.filter((el) => !nodes.some((o) => o !== el && el.contains(o)));
    for (const el of leaf) {
      const link = el.querySelector('a[href^="/"]');
      const author = link ? link.getAttribute('href').replace(/\//g, '') : '?';
      let txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const key = author + '|' + txt.slice(0, 40);
      if (seen.has(key)) continue; seen.add(key);
      const left = Math.round(el.getBoundingClientRect().left);
      out.push({ author, txt: txt.slice(0, 140), left });
    }
    return out;
  }).catch(() => []);

  const minLeft = Math.min(...dump.map((d) => d.left).filter((n) => n > 0), 9999);
  console.log(`\n=== КОММЕНТЫ (${dump.length}, трафик: заблокено ${blocked} / пропущено ${allowed}) ===`);
  for (const d of dump) {
    const thread = d.left > minLeft + 20 ? '  ↳ветка' : 'ТОП';
    console.log(`  [${thread} left=${d.left}] @${d.author}: ${d.txt}`);
  }
  await page.screenshot({ path: `${SHOT}/analyze_${a.slug}.png` }).catch(() => {});
  console.log(`\nскрин: analyze_${a.slug}.png. Окно оставляю открытым (CDP отключаю).`);
  await b.close().catch(() => {}); // только CDP, окно живёт
  process.exit(0);
})().catch((e) => { console.log('FATAL', String(e.message).slice(0, 160)); process.exit(1); });
