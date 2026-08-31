// СПАСЕНИЕ ОПЛАЧЕННЫХ РЕНДЕРОВ ЗАЛПА (05.08). Залп на 24 поста отрендерил всё, но сборка
// упала на третьем: соединение с Postgres оборвалось за время длинного прохода. 21 готовый
// рендер остался висеть на фабрике неоприходованным.
//
// Здесь мы забираем с фабрики её ГОТОВЫЕ посты за последний час, которых ещё нет у нас в базе,
// валидируем и кладём на склад. Деньги за них уже уплачены — терять нельзя.
// Запуск: node rescue_salvo.cjs
'use strict';

// ГЕЙТ ПОДТВЕРЖДЕНИЯ (06.08, после сгоревших 197 руб): это массовый добор заказов фабрики. Запуск без явного
// SALVO_CONFIRM=1 запрещён: сначала ОДИН пост глазами и апрув начальника, потом пачка.
if (!/^(1|true|yes)$/i.test(String(process.env.SALVO_CONFIRM || ''))) {
  console.log('ИТОГ: ✗ массовый платный запуск без SALVO_CONFIRM=1 запрещён (правило: сначала один пост)');
  process.exit(3);
}
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 20 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('админ-профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);

(async () => {
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1200, height: 860 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let posts = [];
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    posts = await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo/posts');
      if (!r.ok) return [];
      return ((await r.json()).posts || []).filter((p) => p.status === 'done' && (p.imageUrls || []).length >= 3)
        .map((p) => ({ id: p.id, urls: p.imageUrls, hook: p.hookText || p.hook || '', cap: p.captionText || p.caption || '', tpl: p.templateId || p.template || '', at: p.createdAt }));
    });
  } finally { await ctx.close().catch(() => {}); freeLock(); }
  console.log(`на фабрике готовых: ${posts.length}`);

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  const known = new Set((await c.query(
    `SELECT meta->>'factory_id' f FROM posts WHERE meta ? 'factory_id'`)).rows.map((r) => r.f).filter(Boolean));
  const fresh = posts.filter((p) => !known.has(p.id) && (Date.now() - new Date(p.at).getTime()) < 3 * 3600 * 1000);
  console.log(`не оприходовано у нас: ${fresh.length}`);

  const { validateCarousel } = require('./validatepost.cjs');
  let ok = 0, bad = 0;
  // Валидация каждого поста — это минуты работы vision-модели, и коннект успевает протухнуть.
  // Поэтому перед КАЖДОЙ вставкой проверяем соединение и при нужде поднимаем новое.
  let db = c;
  const alive = async () => {
    try { await db.query('SELECT 1'); return db; } catch {}
    try { await db.end(); } catch {}
    db = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
    db.on('error', () => {});
    await db.connect();
    return db;
  };
  for (const p of fresh) {
    let verdict = 'unknown', problems = [];
    try { const v = await validateCarousel(p.urls, { template: p.tpl }); verdict = v.verdict; problems = v.problems || []; } catch {}
    await alive();
    const acc = (await db.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
      AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
    const caption = [p.hook, p.cap].filter(Boolean).join('\n\n');
    await db.query(
      `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
       VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb)`,
      [acc.id, caption, p.urls[0], 'https://neironka.pro',
       JSON.stringify({ factory_id: p.id, template: p.tpl, image_urls: p.urls, rescued: true,
         validation: { verdict, problems, at: new Date().toISOString() } }),
       verdict === 'reject' ? 'rejected' : 'backlog']);
    if (verdict === 'reject') { bad++; console.log(`  ⛔ ${p.tpl}: ${problems[0] || 'брак'}`); }
    else { ok++; console.log(`  ✓ спасён ${p.tpl}`); }
  }
  await db.end().catch(() => {});
  console.log(`ИТОГ: спасено ${ok}, брак ${bad}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
