// ЗАМЕНА СЛАЙДА 2 НА ЧИСТУЮ ЗАПИСКУ С ПРОМПТОМ (06.08).
//
// Было: фиолетовая фирменная плашка с логотипом и призывом «можно сделать на neironka.pro».
// Начальник: «и 2 картинка фиолетовая с рекламой, и последняя тоже с». Два промо-кадра из
// четырёх — пост читается как реклама, охваты режутся. Оставляем рекламу ТОЛЬКО на финале.
//
// Запуск: node replate.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
// СТОРОЖ (07.08, инцидент fix4.cjs: работа сделана, процесс висел 45 минут молча).
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 25), stallMinutes: 5, label: 'очистка второго слайда (replate)' });

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const LIMIT = Number(process.argv[2] || 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 25 * 60000) {
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
  const mkDb = async () => {
    const d = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
    d.on('error', () => {});
    await d.connect();
    return d;
  };
  let c = await mkDb();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls FROM posts
     WHERE status='backlog' AND kind='promo' AND (meta->>'refit4')::bool IS TRUE
       AND coalesce((meta->>'cleanplate')::bool,false) = false
       AND jsonb_array_length(coalesce(meta->'image_urls','[]'::jsonb)) = 4
     ORDER BY created_at DESC LIMIT $1`, [LIMIT])).rows;
  console.log(`постов под замену слайда 2: ${rows.length}`);
  if (!rows.length) { await c.end(); return; }

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'tplprompts.json'), 'utf8')); } catch {}

  const ready = [];
  for (const r of rows) {
    const prompt = cache[r.tpl];
    if (!prompt) { console.log(`  · ${r.pn}/${r.tpl}: нет промпта в кэше`); continue; }
    const f = `/tmp/plate2_${String(r.id).slice(0, 8)}.jpg`;
    try {
      execFileSync('node', [path.join(__dirname, 'frame4.cjs'), '--text', prompt, f],
        { encoding: 'utf8', timeout: 150000 });
      if (fs.existsSync(f)) ready.push({ ...r, file: f });
    } catch { console.log(`  ✗ ${r.pn}/${r.tpl}: рендер не вышел`); }
  }
  console.log(`записок отрисовано: ${ready.length}`);

  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1200, height: 860 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let ok = 0;
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (const r of ready) {
      try {
        const b64 = fs.readFileSync(r.file).toString('base64');
        const url = await page.evaluate(async ({ b64, name }) => {
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const fd = new FormData();
          fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
          const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
          const j = await x.json().catch(() => ({}));
          if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
          return j.url;
        }, { b64, name: path.basename(r.file) });
        const urls = [...r.urls];
        urls[1] = url;   // слайд 2
        try { await c.query('SELECT 1'); } catch { try { await c.end(); } catch {} c = await mkDb(); }
        await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('image_urls', $2::jsonb, 'cleanplate', true)
                       WHERE id=$1`, [r.id, JSON.stringify(urls)]);
        ok++;
        console.log(`  ✓ ${r.pn}/${r.tpl}`);
      } catch (e) { console.log(`  ✗ ${r.pn}/${r.tpl}: ${String(e.message).slice(0, 60)}`); }
      await sleep(1100);
    }
  } finally { wd.poke('закрываю браузер и базу'); await ctx.close().catch(() => {}); freeLock(); await c.end().catch(() => {}); }
  // ЯВНЫЙ ВЫХОД: без него скрипт печатает ИТОГ и висит (инцидент 07.08 с fix4.cjs).
  wd.done(0, `ИТОГ: слайд 2 очищен от рекламы в ${ok} пост(ах)`);
})().catch((e) => { freeLock(); wd.fail(e); });
