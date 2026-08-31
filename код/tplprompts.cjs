// СБОР ЮЗЕРСКИХ ПРОМПТОВ ШАБЛОНОВ → кэш /tmp/tplprompts.json (и копия рядом со скриптом).
//
// Зачем: владелец 04.08 задал формулу описания поста: «даю промпт ниже, но проще всего написать
// нейронка про шаблоны в яндекс…» + сам промпт до 4000 знаков. Промпт шаблона живёт за логином
// на /generate/image?tpl=<id> (префилл textarea). Публичного API нет (проверено: /api/templates 404).
// Скрейпим один раз админ-профилем и кэшируем: промпты меняются редко.
//
// Запуск: node tplprompts.cjs [id ...]   (без аргументов — все шаблоны из TEMPLATE_GROUPS genposts)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const CACHE = path.join(__dirname, 'tplprompts.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_IDS = [
  'img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-nose-verdict',
  'img-boyfriend-match', 'img-canon-g7x', 'img-retro-90s', 'img-magazine-cover',
  'img-bw-editorial', 'img-golden-portrait', 'img-double-exposure', 'img-bw-fingers',
  'img-flower-cloud', 'img-gelik-azs', 'img-winx-fairy', 'img-anime', 'img-pixar-3d',
  'img-popart', 'img-fantasy-char', 'img-sketch-collage', 'img-gta', 'img-new-forms',
];

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
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_IDS;
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    for (const id of ids) {
      if (cache[id] && cache[id].length > 100) { console.log(`  · ${id}: в кэше`); continue; }
      try {
        await page.goto(`https://neironka.pro/generate/image?tpl=${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);
        // Промпт префиллится в textarea редактора; берём самый длинный из видимых.
        const val = await page.evaluate(() => {
          const cands = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
            .map((e) => (e.value || e.textContent || '').trim()).filter(Boolean);
          return cands.sort((a, b) => b.length - a.length)[0] || '';
        });
        if (val.length > 100) { cache[id] = val; console.log(`  ✓ ${id}: ${val.length} зн.`); }
        else console.log(`  ✗ ${id}: промпт не префиллился (${val.length} зн.)`);
      } catch (e) { console.log(`  ✗ ${id}: ${String(e.message).slice(0, 60)}`); }
    }
  } finally {
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
    fs.writeFileSync('/tmp/tplprompts.json', JSON.stringify(cache, null, 1));
    await ctx.close().catch(() => {});
  }
  console.log(`ИТОГ: в кэше ${Object.keys(cache).length} промптов → ${CACHE}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
