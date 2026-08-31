// ПЕРЕКРАС РЕЗУЛЬТАТА АНЕЧКИ (06.08, правка начальника: «нам надо другой цвет волос»).
// Пост 6136ca5a face-report: кадры 3 и 4 перегенериваются с кардинальной сменой цвета
// (блонд → медно-рыжий), композиция и лицо сохраняются. Исходники без плашек:
// fp_анечка_face-report_3src.jpg и 4src.jpg. Кадр 4 после перекраса получает плашку призыва.
// Запуск: node fix_anya34.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');
const { siteGenerate } = require('./sitegen.cjs');
const { to45, ctaSlide } = require('./slidekit.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const POST_ID = '6136ca5a';
const SRC3 = '/tmp/fp_анечка_face-report_3src.jpg';
const SRC4 = '/tmp/fp_анечка_face-report_4src.jpg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECOLOR = 'Точно то же самое фото: та же девушка, та же поза, тот же ракурс, тот же фон, тот же свет и та же одежда. ' +
  'ПОМЕНЯЙ ТОЛЬКО ЦВЕТ ВОЛОС: с блонда на насыщенный медно-рыжий, салонный ровный цвет от корней до кончиков, с глянцевым дорогим переливом, волосы прорисованы по прядям. ' +
  'ЖЁСТКО СОХРАНИТЬ: лицо и черты (разрез и цвет глаз, форма губ, овал), кожу с естественной текстурой, макияж, одежду, фон, кадрирование. ' +
  'ЗАПРЕЩЕНО: любой текст и надписи, водяные знаки, смена причёски или длины, изменение лица, пластиковая кожа, студийный свет, рамки, коллаж.';

async function takeLock(waitMs = 40 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('админ-профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);

(async () => {
  for (const f of [SRC3, SRC4]) if (!fs.existsSync(f)) throw new Error(`нет исходника ${f}`);
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const up = [];
  try {
    console.log('Анечка: перекрас кадра 3 (блонд → медно-рыжий)');
    const r3 = (await siteGenerate(page, { prompt: RECOLOR, refFile: SRC3, out: '/tmp/fa34_3.png' })).out;
    console.log('Анечка: перекрас кадра 4');
    const r4 = (await siteGenerate(page, { prompt: RECOLOR, refFile: SRC4, out: '/tmp/fa34_4.png' })).out;
    const s3 = to45(r3, '/tmp/fa34_3.jpg');
    const s4 = (await ctaSlide(to45(r4, '/tmp/fa34_4raw.jpg'), '/tmp/fa34_4.jpg')).out || '/tmp/fa34_4.jpg';

    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (const [i, f] of [[2, s3], [3, s4]]) {
      const b64 = fs.readFileSync(f).toString('base64');
      const url = await page.evaluate(async ({ b64, name }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
        const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await x.json().catch(() => ({}));
        if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
        return j.url;
      }, { b64, name: `anya_recolor_${i + 1}.jpg` });
      up.push([i, url]);
      await sleep(800);
    }
  } finally { await page.close().catch(() => {}); await ctx.close().catch(() => {}); freeLock(); }

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`SELECT id, meta->'image_urls' urls FROM posts WHERE id::text LIKE $1 || '%'`, [POST_ID]);
  const row = r.rows[0];
  const urls = [...(row.urls || [])];
  for (const [i, u] of up) urls[i] = u;
  await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('image_urls', $2::jsonb,
      'recolor34', 'blond-to-copper 06.08') WHERE id=$1`, [row.id, JSON.stringify(urls)]);
  await c.end();
  console.log('ИТОГ: кадры 3 и 4 заменены, файлы /tmp/fa34_3.jpg и /tmp/fa34_4.jpg');
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
