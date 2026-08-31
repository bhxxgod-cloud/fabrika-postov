// ПОДМЕНА ОДНОГО СЛАЙДА В ГОТОВОМ ПОСТЕ (05.08).
//
// Зачем: четвёртый слайд тренда «сердечки» существует в двух вариантах (рисованный эскиз
// с промптом и арт с плашкой «бесплатно можно сделать»), решение за начальником. Чтобы его
// выбор применялся за минуту, а не пересборкой поста, слайд меняется точечно.
//
// Запуск: node swapslide.cjs <id_поста|--template hearts-trend> <номер_слайда_с_1> <файл>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const [target, idxArg, file] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 15 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
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

(async () => {
  const idx = Number(idxArg);
  if (!target || !idx || !file) { console.log('usage: node swapslide.cjs <id|--template X> <номер> <файл>'); process.exit(1); }
  if (!fs.existsSync(file)) { console.log(`ИТОГ: ✗ нет файла ${file}`); process.exit(1); }

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = target === '--template'
    ? (await c.query(`SELECT id, meta->'image_urls' urls FROM posts WHERE meta->>'template'=$1 AND status IN ('backlog','approved')`, [idxArg && process.argv[5] ? process.argv[5] : 'hearts-trend'])).rows
    : (await c.query(`SELECT id, meta->'image_urls' urls FROM posts WHERE id::text LIKE $1 || '%'`, [target])).rows;
  if (!rows.length) { console.log('ИТОГ: ✗ пост не найден'); await c.end(); process.exit(1); }

  await takeLock();
  // Невидимый служебный браузер: окон и иконок в доке не создаём (06.08).
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const b64 = fs.readFileSync(file).toString('base64');
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    const url = await page.evaluate(async ({ b64, name, mime }) => {
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const fd = new FormData();
      fd.append('file', new File([bin], name, { type: mime }));
      const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
      const j = await x.json().catch(() => ({}));
      if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
      return j.url;
    }, { b64, name: path.basename(file), mime });

    for (const r of rows) {
      const urls = [...(r.urls || [])];
      if (urls.length < idx) { console.log(`  · ${String(r.id).slice(0, 8)}: слайда ${idx} нет, пропуск`); continue; }
      urls[idx - 1] = url;
      await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('image_urls', $2::jsonb) WHERE id=$1`,
        [r.id, JSON.stringify(urls)]);
      console.log(`  ✓ ${String(r.id).slice(0, 8)}: слайд ${idx} заменён`);
    }
  } finally { await done(); freeLock(); await c.end(); }
  console.log('ИТОГ: готово');
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
