// ИМПОРТ УЖЕ ОТРЕНДЕРЕННЫХ постов фабрики на склад постера.
//
// Зачем: если заказчик (genposts/genref) упал МЕЖДУ рендером и записью на склад, деньги на
// рендер потрачены, а поста в БД нет. Этот скрипт добирает готовое: находит пост на фабрике
// по id, гоняет ту же валидацию и кладёт в backlog. Ничего не заказывает и не рендерит.
//
// Запуск: node importfactory.cjs <factory_id...> --persona "Карина"
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
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
      if (Date.now() > until) throw new Error('профиль занят больше 15 минут');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  const pi = process.argv.indexOf('--persona');
  const persona = pi > 0 ? process.argv[pi + 1] : '';
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== persona);
  if (!ids.length || !persona) { console.log('usage: node importfactory.cjs <factory_id...> --persona "Имя"'); process.exit(1); }

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
    const posts = await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo/posts');
      return r.ok ? (await r.json()).posts || [] : [];
    });
    for (const want of ids) {
      const p = posts.find((x) => String(x.id).startsWith(want));
      if (!p) { console.log(`  ✗ ${want}: на фабрике не найден`); continue; }
      if (p.status !== 'done' || !(p.imageUrls || []).length) { console.log(`  ✗ ${want}: статус ${p.status}, картинок нет`); continue; }
      const dup = await db.query(`SELECT 1 FROM posts WHERE meta->>'factory_id'=$1`, [p.id]);
      if (dup.rowCount) { console.log(`  · ${want}: уже на складе`); continue; }

      let verdict = 'unknown', problems = [];
      if (process.env.VALIDATE_OFF !== '1') {
        try {
          const v = await require('./validatepost.cjs').validateCarousel(p.imageUrls, { template: p.templateId });
          verdict = v.verdict; problems = v.problems || [];
        } catch {}
      }
      const acc = (await db.query(
        `SELECT id FROM accounts WHERE session_status='live' AND persona<>'' AND deleted_at IS NULL
          ORDER BY random() LIMIT 1`)).rows[0];
      const caption = [p.hookText, p.captionText].filter(Boolean).join('\n\n');
      await db.query(
        `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
         VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb)`,
        [acc.id, caption, p.imageUrls[0], 'https://neironka.pro',
         JSON.stringify({ factory_id: p.id, template: p.templateId, image_urls: p.imageUrls,
           persona, imported: true,
           validation: { verdict, problems, at: new Date().toISOString() } }),
         verdict === 'reject' ? 'rejected' : 'backlog']);
      console.log(`  ${verdict === 'reject' ? '⛔ брак' : '✓ на склад'} ${want} (${p.templateId})${problems.length ? ' — ' + problems[0] : ''}`);
    }
  } finally {
    await ctx.close().catch(() => {});
    await db.end().catch(() => {});
  }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
