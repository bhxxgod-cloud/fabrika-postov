// РАЗОВЫЙ ФИКС ЗАДВОЕННОГО ХУКА НА ОБЛОЖКЕ (09.08, приказ: «пост 1 и 2 ты перекрыл текстом старый
// текст, убери свой новый оставь старый»). Хук печатался дважды (фабрика + наш слой), внизу кадра
// оставалась двойная тёмная подложка. Чиним прямо: берём ЧИСТОЕ исходное фото (source_cover) и
// наносим хук РОВНО ОДИН раз через hookSlide, потом заливаем и меняем первый кадр поста.
// Запуск: node fixcover.cjs персона1,персона2
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { hookSlide } = require('./slidekit.cjs');
const { openAdmin } = require('./adminbrowser.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PERSONAS = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  // ФИЛЬТР ОБЯЗАТЕЛЕН (09.08). Без него скрипт брал ВСЕ посты персоны, включая опубликованные и
  // отменённые, а у части из них hook_text пустой, и на обложке печаталось слово «null». Трогаем
  // только склад, только непубликованные и только там, где хук реально есть.
  const rows = (await c.query(
    `SELECT id, meta->>'persona' pn, meta->>'source_cover' src, meta->>'hook_text' hook, meta->'image_urls' urls
       FROM posts
      WHERE meta->>'persona' = ANY($1)
        AND status IN ('backlog','approved') AND published_at IS NULL
        AND coalesce(meta->>'hook_text','') <> ''
        AND jsonb_array_length(meta->'image_urls') = 4`, [PERSONAS])).rows;
  const { page, done } = await openAdmin();
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(2500);
    for (const p of rows) {
      const short = String(p.id).slice(0, 8);
      // Источник обложки: source_cover, если задан, иначе оригинал начальника refs/<персона>.jpg.
      // У старых постов source_cover пустой, но их исходное фото лежит в refs.
      let srcFile = p.src ? (path.isAbsolute(p.src) ? p.src : path.join(__dirname, p.src)) : null;
      if (!srcFile || !fs.existsSync(srcFile)) srcFile = path.join(__dirname, 'refs', `${p.pn}.jpg`);
      if (!fs.existsSync(srcFile)) { console.log(`  ✗ ${p.pn}: нет исходника ни в source_cover, ни в refs`); continue; }
      // Обложку приводим к 4:5 обрезкой, затем один хук.
      const { to45 } = require('./slidekit.cjs');
      const flat = to45(srcFile, `/tmp/cflat_${short}.jpg`);
      srcFile = flat;
      // Один хук на чистом фото, никаких вторых слоёв.
      const out = `/tmp/cover_${short}.jpg`;
      await hookSlide(srcFile, out, p.hook);
      const b64 = fs.readFileSync(out).toString('base64');
      const url = await page.evaluate(async ({ b64, fname }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
        const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error(j.error || `upload HTTP ${r.status}`);
        return j.url;
      }, { b64, fname: `cover_${short}.jpg` });
      const urls = p.urls.slice(); urls[0] = url;
      await c.query(`UPDATE posts SET meta = jsonb_set(meta, '{image_urls}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify(urls), p.id]);
      console.log(`  ✅ ${p.pn}: обложка перенанесена начисто, хук «${String(p.hook).slice(0, 30)}...»`);
    }
  } finally { await done(); await c.end().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
