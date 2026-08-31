// СБОР ФОТО СЦЕН ЛИЧНОСТЕЙ со вкладки «Личности» админки → /tmp/scenes/<Имя>/<сцена>.jpg
// Зачем: API списка сцен нет (GET /scenes → 405), а фото с подписями есть в DOM вкладки.
// Запуск: node scenegrab.cjs [фильтр-по-сцене, например "парк"]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const OUT = '/tmp/scenes';
const FILTER = (process.argv[2] || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 15 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1400, height: 1000 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const found = [];
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    await page.getByText('Личности', { exact: true }).first().click({ timeout: 8000 });
    await sleep(2500);
    const names = await page.evaluate(() => [...document.querySelectorAll('button')]
      .map((b) => b.textContent.trim()).filter((t) => /\d+ сцен/.test(t)).map((t) => t.replace(/\d+ сцен.*/, '').trim()));
    console.log('личности:', names.join(', '));
    for (const name of names) {
      // раскрываем карточку и собираем картинки с подписями
      await page.getByText(new RegExp(`^${name}\\d+ сцен`), { exact: false }).first().click({ timeout: 8000 }).catch(() => {});
      await sleep(2000);
      const items = await page.evaluate(() => {
        // подпись сцены лежит в блоке-оверлее внутри той же карточки, что и img
        const out = [];
        for (const img of document.querySelectorAll('img')) {
          const src = img.getAttribute('src') || '';
          if (!src.includes('/promo-assets/scenes/')) continue;
          let label = '';
          let el = img.parentElement;
          for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
            const t = (el.innerText || '').trim().split('\n').filter(Boolean);
            if (t.length) { label = t[t.length - 1]; break; }
          }
          out.push({ src, label });
        }
        return out;
      });
      const dir = path.join(OUT, name);
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const it of items) {
        if (FILTER && !it.label.toLowerCase().includes(FILTER)) continue;
        const base = (it.label || 'сцена').replace(/[^\wа-яё .·×-]/gi, '').slice(0, 40) || 'сцена';
        const dest = path.join(dir, `${base}_${++n}.jpg`);
        if (fs.existsSync(dest)) continue;
        try {
          // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): fetch без сигнала висит вечно.
          await require('./watchdog.cjs').fetchToFile(it.src, dest, { what: 'сцена', ms: 60000 });
          found.push(`${name}/${base}`);
        } catch {}
      }
      console.log(`  ${name}: скачано ${n}`);
      // сворачиваем обратно, чтобы DOM не разрастался
      await page.getByText(new RegExp(`^${name}`), { exact: false }).first().click({ timeout: 5000 }).catch(() => {});
      await sleep(800);
    }
  } finally { await ctx.close().catch(() => {}); }
  console.log(`ИТОГ: ${found.length} кадров в ${OUT}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
