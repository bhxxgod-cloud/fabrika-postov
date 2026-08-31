// ДОБАВЛЕНИЕ 4-го КАДРА В ПОСТЫ СКЛАДА (05.08, новая логика начальника).
//
// Фабрика отдаёт 3 кадра (фото с хуком → плашка результата → финал), четвёртый наш:
// промпт + логотип + «можно сделать на neironka.pro». Здесь он генерится (frame4.cjs),
// заливается в наше хранилище и дописывается в meta.image_urls, после чего его подхватывают
// и постинг в IG, и отправка в телеграм — оба берут карусель именно оттуда.
//
// Одна браузерная сессия на всю пачку: заливка идёт через админ-профиль (кука httpOnly),
// открывать окно на каждый пост — расточительно и дольше.
//
// Запуск: node addframe4.cjs [сколько]   (по умолчанию 12)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
// СТОРОЖ (07.08, инцидент fix4.cjs: работа сделана, процесс висел 45 минут молча).
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 25), stallMinutes: 5, label: 'добавление 4-го кадра (addframe4)' });

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const LIMIT = Number(process.argv[2] || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 20 * 60000) {
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
      if (Date.now() > until) throw new Error('админ-профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls
      FROM posts
     WHERE status='backlog' AND kind='promo'
       AND meta->>'template' IS NOT NULL AND meta->>'persona' IS NOT NULL
       AND coalesce((meta->>'frame4')::bool, false) = false
       AND jsonb_array_length(coalesce(meta->'image_urls','[]'::jsonb)) = 3
     ORDER BY created_at DESC LIMIT $1`, [LIMIT])).rows;
  console.log(`постов под 4-й кадр: ${rows.length}`);
  if (!rows.length) { await c.end(); return; }

  // Промпты шаблонов: без промпта плашка бессмысленна.
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'tplprompts.json'), 'utf8')); } catch {}

  const ready = [];
  for (const r of rows) {
    const prompt = cache[r.tpl];
    if (!prompt || prompt.length < 40) { console.log(`  · ${r.pn}/${r.tpl}: нет промпта в кэше, пропуск`); continue; }
    const f = `/tmp/frame4_${String(r.id).slice(0, 8)}.jpg`;
    try {
      execFileSync('node', [path.join(__dirname, 'frame4.cjs'), '--text', prompt, f],
        { encoding: 'utf8', timeout: 120000 });
      if (fs.existsSync(f) && fs.statSync(f).size > 20000) ready.push({ ...r, file: f });
    } catch (e) { console.log(`  ✗ ${r.pn}/${r.tpl}: рендер плашки упал`); }
  }
  // ЧЕСТНАЯ ФОРМУЛИРОВКА (07.08): это только локальные файлы, в базе ещё НИЧЕГО не изменилось.
  console.log(`плашек отрисовано локально: ${ready.length} (в базу ещё не записано)`);
  if (!ready.length) { await c.end(); return; }

  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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
        const urls = [...r.urls, url];
        await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('image_urls', $2::jsonb, 'frame4', true)
                       WHERE id=$1`, [r.id, JSON.stringify(urls)]);
        ok++;
        console.log(`  ✓ ${r.pn}/${r.tpl}: карусель ${urls.length} кадра`);
      } catch (e) { console.log(`  ✗ ${r.pn}/${r.tpl}: ${String(e.message).slice(0, 70)}`); }
      await sleep(1500);
    }
  } finally { wd.poke('закрываю браузер и базу'); await ctx.close().catch(() => {}); freeLock(); await c.end().catch(() => {}); }
  // ЯВНЫЙ ВЫХОД: без него скрипт печатает ИТОГ и висит (инцидент 07.08 с fix4.cjs).
  wd.done(0, `ИТОГ: 4-й кадр добавлен в ${ok} пост(ов)`);
})().catch((e) => { freeLock(); wd.fail(e); });
