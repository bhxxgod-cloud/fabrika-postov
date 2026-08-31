// ПЕРЕ-РЕНДЕР СЛАЙДА 1 у трёх постов сердец (06.08, главный чат): хук тонул на светлой
// одежде (претензия начальника). Новый рендер с подложкой-градиентом и шрифтом 42px, тот же
// хук (pick детерминирован по tag), домашние кадры уже лежат в /tmp, генераций ноль.
// Запуск: node rehook_hearts.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45 } = require('./slidekit.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
// СТОРОЖ (07.08, инцидент fix4.cjs: работа сделана, процесс висел 45 минут молча).
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 20), stallMinutes: 5, label: 'перенос хука на обложки (rehook_hearts)' });

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOKS = [
  'я тоже сделала этот тренд с волосами,\nи парень сразу на обои поставил ❤️',
  'сделала этот тренд ночью просто так,\nа утром он спросил кто снимал',
  'думала такое только у блогеров,\nа получилось с первого раза 🙈',
  'я тоже повторила этот тренд,\nподруги до сих пор спрашивают как',
  'этот кадр собрал больше реакций,\nчем всё что я выкладывала за год',
];
const pick = (arr, seed) => { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return arr[h % arr.length]; };

const WORK = [
  ['Полина', '28d56e7e-4340-493f-89b9-e7b3419af3c6'],
  ['Дарья', '24b28615-a3f4-41ad-9037-9ace9f99ba30'],
  ['Мия', '6027d045-a47a-44db-8dd4-8a89d38723ee'],
];

async function renderHook(src, out, text) {
  const b64 = fs.readFileSync(src).toString('base64');
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0}
    body{width:1080px;height:1350px;position:relative;overflow:hidden;background:#000;
      font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
    img{width:1080px;height:1350px;object-fit:cover;display:block}
    .t{position:absolute;left:0;right:0;bottom:430px;padding:26px 96px;text-align:center;
      color:rgba(255,255,255,.97);font-size:42px;font-weight:500;line-height:1.36;
      text-shadow:0 2px 6px rgba(0,0,0,.85),0 6px 22px rgba(0,0,0,.55);
      background:linear-gradient(to bottom,rgba(0,0,0,0),rgba(0,0,0,.34) 22%,rgba(0,0,0,.34) 78%,rgba(0,0,0,0))}
  </style><img src="data:image/jpeg;base64,${b64}">
  <div class="t">${String(text).split('\n').map((l) => `<div>${l}</div>`).join('')}</div>`;
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const b = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const page = await b.newPage({ viewport: { width: 1080, height: 1350 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    const png = out.replace(/\.jpe?g$/i, '.png');
    await page.screenshot({ path: png });
    execFileSync(require('ffmpeg-static'), ['-y', '-i', png, '-q:v', '2', out], { stdio: 'ignore' });
    fs.unlinkSync(png);
  } finally { await b.close().catch(() => {}); }
  return out;
}

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
  // 1) Рендерим все три слайда локально, без лока.
  const ready = [];
  for (const [girl, postId] of WORK) {
    const tag = `${girl.toLowerCase()}_hearts-trend`;
    const home = `/tmp/mp_${tag}_home.png`;
    if (!fs.existsSync(home)) { console.log(`✗ ${girl}: нет домашнего кадра ${home}`); continue; }
    const hook = pick(HOOKS, tag);
    const out = await renderHook(to45(home, `/tmp/rh_${tag}_raw.jpg`), `/tmp/rh_${tag}_1.jpg`, hook);
    ready.push([girl, postId, out]);
    console.log(`✓ ${girl}: слайд 1 перерисован (${path.basename(out)})`);
  }
  if (!ready.length) throw new Error('нечего заливать');

  // 2) Одна сессия браузера: заливаем и меняем image_urls[0].
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (const [girl, postId, file] of ready) {
      const b64 = fs.readFileSync(file).toString('base64');
      const url = await page.evaluate(async ({ b64, name }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
        const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await x.json().catch(() => ({}));
        if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
        return j.url;
      }, { b64, name: `rehook_${girl}_1.jpg` });
      const r = await c.query(`SELECT meta->'image_urls' urls FROM posts WHERE id=$1`, [postId]);
      const urls = [...(r.rows[0].urls || [])];
      urls[0] = url;
      await c.query(`UPDATE posts SET media_url=$3, meta = meta || jsonb_build_object('image_urls', $2::jsonb,
        'rehook1', 'scrim 06.08') WHERE id=$1`, [postId, JSON.stringify(urls), url]);
      console.log(`✓ ${girl}: слайд 1 заменён в посте ${String(postId).slice(0, 8)}`);
      await sleep(800);
    }
  } finally { wd.poke('закрываю браузер и базу'); await page.close().catch(() => {}); await ctx.close().catch(() => {}); freeLock(); await c.end().catch(() => {}); }
  // ЯВНЫЙ ВЫХОД: без него скрипт печатает ИТОГ и висит (инцидент 07.08 с fix4.cjs).
  wd.done(0, 'ИТОГ: готово');
})().catch((e) => { freeLock(); wd.fail(e); });
