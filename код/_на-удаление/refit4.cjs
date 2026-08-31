// ПЕРЕСБОРКА КАРУСЕЛИ ПОД ФИНАЛЬНУЮ ЛОГИКУ НАЧАЛЬНИКА (05.08):
//   1 — фото с байтовой надписью (хук от фабрики)
//   2 — САМ ПРОМПТ (наша плашка)
//   3 — результат (гайд/плашка шаблона)
//   4 — ЕЩЁ ОДНО фото результата + ненавязчивая, но заметная надпись:
//       «бесплатно сделала на neironka.pro / найти шаблон напишите "нейронка про шаблоны" в яндекс»
//
// Доп-фото результата генерить НЕ НАДО: фабрика и так отдаёт три кадра, третий — как раз ещё
// один результат. Меняется порядок и добавляется подпись на последний кадр.
// Было (после addframe4): [хук, гайд, результат, промпт] → стало: [хук, промпт, гайд, результат+подпись]
//
// Запуск: node refit4.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const TPL = require('./templates.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
// СТОРОЖ (07.08, инцидент fix4.cjs: работа сделана, процесс висел 45 минут молча).
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 25), stallMinutes: 5, label: 'пересборка порядка кадров (refit4)' });

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const LIMIT = Number(process.argv[2] || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Финальный кадр собираем через общий модуль: 5 утверждённых стилей в СЛУЧАЙНОМ порядке
// (выбор начальника 05.08 — варианты 1,3,4,5,7 из семи; «давай их в рандом порядке юзать»).
const { ctaSlide } = require('./slidekit.cjs');

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

// ТРЕНД «ВОЛОСЫ СЕРДЕЧКАМИ» СЮДА НЕ ХОДИТ: у него свой третий кадр и своя цепочка сборки,
// общий порядок «хук → промпт → результат → доп+подпись» ему не подходит.
// Раньше здесь стояло сравнение с ОДНОЙ строкой ('hearts-trend'), а у тренда ДВА шаблона —
// img-heart-hair (85 постов) проскакивал в выборку и его финал пересобирался по чужим правилам.
// Своего списка шаблонов тут больше НЕТ: спрашиваем у контракта templates.cjs (09.08).
const HEARTS = TPL.list().filter(TPL.isHearts);

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls FROM posts
     WHERE status='backlog' AND kind='promo' AND (meta->>'frame4')::bool IS TRUE
       AND coalesce((meta->>'refit4')::bool,false) = false
       AND coalesce(meta->>'template','') <> ALL($2::text[])
       AND jsonb_array_length(coalesce(meta->'image_urls','[]'::jsonb)) = 4
     ORDER BY created_at DESC LIMIT $1`, [LIMIT, HEARTS])).rows;
  console.log(`постов на пересборку: ${rows.length} (шаблоны тренда пропущены: ${HEARTS.join(', ')})`);
  if (!rows.length) { await c.end(); return; }

  // Готовим подписанные финальные кадры локально (браузер для наложения, без админ-профиля).
  const ready = [];
  for (const r of rows) {
    try {
      const [hook, plate, result, prompt] = r.urls;
      const src = `/tmp/refit_${String(r.id).slice(0, 8)}_src.jpg`;
      const out = `/tmp/refit_${String(r.id).slice(0, 8)}_cta.jpg`;
      // Скачивание с таймаутом (07.08): fetch без сигнала = тот же тихий висяк, только внутри шага.
      await fetchToFile(result, src, { what: 'результат фабрики', ms: 90000, min: 10000 });
      await ctaSlide(src, out);
      ready.push({ ...r, order: [hook, prompt, plate], ctaFile: out });
    } catch (e) { console.log(`  ✗ ${r.pn}/${r.tpl}: ${String(e.message).slice(0, 60)}`); }
  }
  // ЧЕСТНАЯ ФОРМУЛИРОВКА (07.08): это только локальные файлы, в базе ещё НИЧЕГО не изменилось.
  console.log(`подписей наложено локально: ${ready.length} (в базу ещё не записано)`);

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
        const b64 = fs.readFileSync(r.ctaFile).toString('base64');
        const url = await page.evaluate(async ({ b64, name }) => {
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const fd = new FormData();
          fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
          const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
          const j = await x.json().catch(() => ({}));
          if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
          return j.url;
        }, { b64, name: path.basename(r.ctaFile) });
        const urls = [...r.order, url];
        await c.query(`UPDATE posts SET media_url=$3, meta = meta || jsonb_build_object('image_urls', $2::jsonb, 'refit4', true)
                       WHERE id=$1`, [r.id, JSON.stringify(urls), urls[0]]);
        ok++;
        console.log(`  ✓ ${r.pn}/${r.tpl}: порядок хук → промпт → результат → доп+подпись`);
      } catch (e) { console.log(`  ✗ ${r.pn}/${r.tpl}: ${String(e.message).slice(0, 60)}`); }
      await sleep(1200);
    }
  } finally { wd.poke('закрываю браузер и базу'); await ctx.close().catch(() => {}); freeLock(); await c.end().catch(() => {}); }
  // ЯВНЫЙ ВЫХОД: без него скрипт печатает ИТОГ и висит (инцидент 07.08 с fix4.cjs).
  wd.done(0, `ИТОГ: пересобрано ${ok} пост(ов)`);
})().catch((e) => { freeLock(); wd.fail(e); });
