// ЗАЛПОВЫЙ ЗАКАЗ ПО СВОЕМУ ФОТО (05.08, владелец: «сделай много запросов, они все параллельно
// генерятся — зачем ждать»). Отличие от genref.cjs: НЕ ждём рендер после каждого заказа.
// Залп: референс каждой девочки грузится один раз → все заказы POST'ятся подряд → один общий
// опрос готовности → валидация → склад → ТГ (ключ дедупа post:<id>).
// Запуск: node genref_par.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Остаток люкс-волны: Полина уже отработана серийным конвейером.
const WORK = [
  // ПОЛНАЯ НОВАЯ ПАЧКА 05.08 («сделай сейчас все посты новые — шаблоны наши и модели наши»).
  // Наши 4 рабочих шаблона × наши модели с готовыми люкс-референсами.
  ['Карина', './refs/Карина.jpg', ['img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-bw-fingers']],
  ['Дарья', './refs/Дарья.jpg', ['img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-bw-fingers']],
  ['Полина', './refs/Полина.jpg', ['img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-bw-fingers']],
  ['Мия', './refs/Мия.jpg', ['img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-bw-fingers']],
  ['Тати', './refs/Тати.jpg', ['img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-bw-fingers']],
  ['Анечка', './refs/Анечка.jpg', ['img-beauty-guide', 'img-face-report', 'img-makeup-colortype', 'img-bw-fingers']],
];

async function takeLock(waitMs = 30 * 60000) {
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
      if (Date.now() > until) throw new Error('профиль занят');
      console.log('  ⏳ жду освобождения профиля…');
      await sleep(20000);
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
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const orders = []; // {id, girl, tpl, hook, caption}
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    // ЗАЛП: заказываем всё подряд, рендер идёт на фабрике параллельно.
    for (const [girl, ref, tpls] of WORK) {
      if (!fs.existsSync(ref)) { console.log(`✗ ${girl}: нет референса`); continue; }
      const b64 = fs.readFileSync(ref).toString('base64');
      const refUrl = await page.evaluate(async ({ b64, name }) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
        const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error(j.error || `upload HTTP ${r.status}`);
        return j.url;
      }, { b64, name: `lux_${girl}.jpg` });
      for (const tpl of tpls) {
        try {
          // Фабрика требует hookText 20–140 знаков, PATCH текстов больше не отдаёт — без
          // запасного хука заказ падает в HTTP 400 (ночь 06.08).
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
          }, { refUrl, tpl, fallbackHook: require('./slidekit.cjs').factoryHook(tpl) });
          if (res.id) { orders.push({ id: res.id, girl, tpl, hook: res.hookText, caption: res.captionText }); console.log(`  → залп: ${girl} ${tpl}`); }
          else console.log(`  ✗ ${girl} ${tpl}: ${res.error}`);
        } catch (e) { console.log(`  ✗ ${girl} ${tpl}: ${String(e.message).slice(0, 60)}`); }
        await sleep(2000);
      }
    }
    console.log(`ЗАЛП ОТДАН: ${orders.length} заказов, жду рендеры…`);

    // ОДИН опрос на всех: до 25 минут.
    const until = Date.now() + 25 * 60000;
    const done = new Map();
    while (Date.now() < until && done.size < orders.length) {
      await sleep(15000);
      const posts = await page.evaluate(async () => {
        const r = await fetch('/api/admin/promo/posts');
        return r.ok ? (await r.json()).posts || [] : [];
      });
      for (const o of orders) {
        if (done.has(o.id)) continue;
        const p = posts.find((x) => x.id === o.id);
        // ЧЕСТНАЯ ФОРМУЛИРОВКА (07.08). Здесь стояло «✓ готов», и счётчик показывал «24 из 24»,
        // хотя в базе не лежало ни одного поста: склад и ТГ идут НИЖЕ, после опроса. Ровно этот
        // ложный прогресс стоил 197 руб на залпе 06.08 (оплачено 17, собрано 0).
        if (p && p.status === 'done' && (p.imageUrls || []).length) { done.set(o.id, p); console.log(`  ⧗ ОПЛАЧЕН рендер: ${o.girl} ${o.tpl} (${done.size}/${orders.length}), пост ещё НЕ собран`); }
        else if (p && p.status === 'error') { done.set(o.id, { error: p.error || 'фабрика: ошибка' }); console.log(`  ✗ упал: ${o.girl} ${o.tpl}`); }
      }
    }
    // страница больше не нужна
    await ctx.close().catch(() => {});
    freeLock();

    // ВАЛИДАЦИЯ + СКЛАД + ТГ (без браузера и без лока).
    // Соединение живёт весь длинный проход (24 поста × паузы = десятки минут), и Postgres
    // рвёт простаивающий коннект — 05.08 из-за этого залп упал на третьем посте, потеряв 21
    // оплаченный рендер. Держим keep-alive и переподключаемся на каждой позиции.
    const mkDb = async () => {
      const d = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
      d.on('error', (e) => console.log('  ⚠ соединение с базой упало: ' + String(e.message).slice(0, 60)));
      await d.connect();
      return d;
    };
    let db = await mkDb();
    const { validateCarousel } = require('./validatepost.cjs');
    let ok = 0, bad = 0;
    for (const o of orders) {
      const p = done.get(o.id);
      if (!p || p.error) { bad++; continue; }
      // Пересоздаём коннект перед каждой позицией: дешевле, чем терять оплаченные рендеры.
      try { await db.query('SELECT 1'); } catch { try { await db.end(); } catch {} db = await mkDb(); }
      let verdict = 'unknown', problems = [];
      try { const v = await validateCarousel(p.imageUrls, { template: o.tpl }); verdict = v.verdict; problems = v.problems || []; } catch {}
      const acc = (await db.query(`SELECT id FROM accounts WHERE session_status='live' AND persona<>'' AND deleted_at IS NULL ORDER BY random() LIMIT 1`)).rows[0];
      const caption = [o.hook, o.caption].filter(Boolean).join('\n\n');
      const ins = await db.query(
        `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
         VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
        [acc.id, caption, p.imageUrls[0], 'https://neironka.pro',
         JSON.stringify({ factory_id: o.id, template: o.tpl, image_urls: p.imageUrls, persona: o.girl, ref_type: true, lux: true,
           validation: { verdict, problems, at: new Date().toISOString() } }),
         verdict === 'reject' ? 'rejected' : 'backlog']);
      if (verdict === 'reject') { bad++; console.log(`  ⛔ брак: ${o.girl} ${o.tpl} — ${problems[0] || ''}`); continue; }
      ok++;
      // в ТГ с ключом поста
      try {
        const d = '/tmp/tgn_' + String(ins.rows[0].id).slice(0, 8);
        fs.mkdirSync(d, { recursive: true });
        const files = [];
        for (const [i, url] of p.imageUrls.entries()) {
          const f = path.join(d, (i + 1) + '.jpg');
          // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): fetch без сигнала висит вечно; здесь это особенно дорого,
          // потому что рендеры уже оплачены, а пачка встаёт молча.
          await require('./watchdog.cjs').fetchToFile(url, f, { what: `кадр ${i + 1}`, ms: 90000 });
          files.push(f);
        }
        execFileSync('node', ['tgsend.cjs', ...files, '--carousel', '--key', String(ins.rows[0].id),
          '--persona', o.girl, '--type', o.tpl.replace('img-', ''), '--template', o.tpl, '--note', caption],
          { cwd: __dirname, encoding: 'utf8' });
        console.log(`  → ТГ: ${o.girl} ${o.tpl}`);
      } catch (e) { console.log(`  ✗ ТГ ${o.girl}: ${String(e.stdout || e.message).slice(-80)}`); }
      await sleep(20000);
    }
    await db.end();
    console.log(`ИТОГ ЗАЛПА: на склад ${ok}, брак/ошибки ${bad} из ${orders.length}`);
  } finally { await ctx.close().catch(() => {}); freeLock(); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
