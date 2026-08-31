// ЗАКАЗ ПОСТА ПО СВОЕМУ ФОТО (разовый референс).
//
// Зачем: на фабрике появилась опция «Своё фото» — можно собрать все три слайда по любому лицу,
// не заводя постоянную личность. Это открывает рубрику «бьюти-гайд по типажу»: берём портрет
// нужной внешности и получаем разбор под неё, без привязки к нашим моделям.
//
// Контракт (снят с живой формы 04.08):
//   POST /api/admin/promo/upload   FormData c полем file → {url}
//   POST /api/admin/promo/posts    {customPhotoUrl, templateId, hookText, captionText}
//   (personaId при этом НЕ передаётся, у готового поста он придёт null)
//
// Запуск: node genref.cjs <путь-к-фото> [templateId] [--label "имя типажа"]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Тот же лок, что у genposts: профиль Chrome работает только в одном экземпляре.
async function takeLock(waitMs = 15 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      // Лок держит СМОТРИТЕЛЬ окна (правило начальника 06.08: хром с нейронкой всегда открыт,
      // когда конвейер свободен) — просим его уступить и ждём.
      try { if (String(pid) === fs.readFileSync('/tmp/genkeeper.pid','utf8').trim()) fs.writeFileSync('/tmp/genkeeper.stop',''); } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      // TTL: генерация не живёт дольше 45 минут, всё старше = зависший лок (06.08 конвейер
      // дважды вставал из-за вечного лока после жёсткого убийства процесса).
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('профиль занят больше 15 минут');
      console.log(`  ⏳ профиль занят процессом ${pid}, жду…`);
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  const file = process.argv[2];
  const tpl = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'img-beauty-guide';
  const li = process.argv.indexOf('--label');
  const label = li > 0 ? process.argv[li + 1] : path.basename(file || '', path.extname(file || ''));
  if (!file || !fs.existsSync(file)) { console.log('usage: node genref.cjs <фото> [templateId] [--label "типаж"]'); process.exit(1); }

  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const db = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    // 1) Заливаем референс. Файл шлём через FormData из контекста страницы: так уходит сессионная
    // кука админки, которой у нас снаружи нет (она httpOnly).
    const b64 = fs.readFileSync(file).toString('base64');
    const refUrl = await page.evaluate(async ({ b64, name }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
      const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error || `upload HTTP ${r.status}`);
      return j.url;
    }, { b64, name: path.basename(file) });
    console.log(`  ✓ референс загружен: ${String(refUrl).slice(-40)}`);

    // 2) Текст берём тем же способом, что и обычные посты, затем заказываем сборку.
    // Фабрика требует hookText 20–140 знаков, PATCH текстов больше не отдаёт — без запасного
    // хука заказ падает в HTTP 400 (ночь 06.08).
    const { factoryHook } = require('./slidekit.cjs');
    const res = await page.evaluate(async ({ refUrl, tpl, fallbackHook }) => {
      const t = await (await fetch('/api/admin/promo/posts', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: tpl }),
      })).json().catch(() => ({}));
      let hookText = String(t.hookText || t.hook || '').trim();
      if (hookText.length < 20 || hookText.length > 140) hookText = fallbackHook;
      const captionText = t.captionText || t.caption || '';
      const r = await fetch('/api/admin/promo/posts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customPhotoUrl: refUrl, templateId: tpl, hookText, captionText }),
      });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { id: j.id || j.postId || (j.post && j.post.id), hookText, captionText }
                  : { error: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
    }, { refUrl, tpl, fallbackHook: factoryHook(tpl) });
    if (res.error || !res.id) throw new Error(res.error || 'фабрика не вернула id');
    console.log(`  → заказан ${tpl} · ${String(res.id).slice(0, 8)}`);

    // 3) Ждём рендер.
    console.log('ЖДУ РЕНДЕР…');
    const until = Date.now() + 15 * 60000;
    let done = null;
    while (Date.now() < until && !done) {
      await sleep(10000);
      const posts = await page.evaluate(async () => {
        const r = await fetch('/api/admin/promo/posts');
        return r.ok ? (await r.json()).posts || [] : [];
      });
      const p = posts.find((x) => x.id === res.id);
      if (!p) continue;
      if (p.status === 'done' && (p.imageUrls || []).length) done = p;
      else if (p.status === 'error') throw new Error(p.error || 'фабрика вернула ошибку');
    }
    if (!done) throw new Error('не дождался рендера за 15 минут');
    // «Готов» тут = фабрика отрендерила и деньги списаны. Пост на складе появится ниже, после
    // валидатора и INSERT, поэтому формулировка честная (07.08).
    console.log(`  ⧗ ОПЛАЧЕН рендер · ${done.imageUrls.length} фото · ${(done.providerCostKopecks || 0) / 100} ₽, пост ещё НЕ на складе`);

    // 4) Проверяем качество тем же валидатором, что и обычные посты.
    let verdict = 'unknown', problems = [];
    if (process.env.VALIDATE_OFF !== '1') {
      try {
        const v = await require('./validatepost.cjs').validateCarousel(done.imageUrls, { template: tpl });
        verdict = v.verdict; problems = v.problems || [];
      } catch {}
      console.log(`  проверка: ${verdict}${problems.length ? ' — ' + problems.slice(0, 2).join('; ') : ''}`);
    }

    // 5) На склад. account_id NOT NULL, поэтому вешаем на живой акк — на публикацию его подберёт
    // тот, у кого будет свободный слот; типажные посты не привязаны к конкретной модели.
    const acc = (await db.query(
      `SELECT id FROM accounts WHERE session_status='live' AND persona<>'' AND deleted_at IS NULL
        ORDER BY random() LIMIT 1`)).rows[0];
    const caption = [res.hookText, res.captionText].filter(Boolean).join('\n\n');
    await db.query(
      `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
       VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb)`,
      [acc.id, caption, done.imageUrls[0], 'https://neironka.pro',
       JSON.stringify({ factory_id: done.id, template: tpl, image_urls: done.imageUrls,
         persona: label, ref_type: true, custom_photo: refUrl,
         validation: { verdict, problems, at: new Date().toISOString() } }),
       verdict === 'reject' ? 'rejected' : 'backlog']);
    console.log(`ИТОГ: пост по типажу «${label}» ${verdict === 'reject' ? 'ЗАБРАКОВАН' : 'на складе'}`);
  } finally {
    await ctx.close().catch(() => {});
    await db.end().catch(() => {});
  }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
