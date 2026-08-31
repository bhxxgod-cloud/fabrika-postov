// СПАСЕНИЕ ОПЛАЧЕННОГО ПО ОТПЕЧАТКУ КАДРА (07.08).
//
// ЗАЧЕМ. В залпе 22 сборки упали на перегрузе служебного браузера, но заказы у фабрики были уже
// оплачены и дорендерились. Восстановить «какой заказ чей» по логу не вышло: при восьми
// параллельных процессах строки сердцебиения печатаются без имени персоны, и связка живёт только
// в памяти упавшего процесса. Днём такая же потеря стоила 197 руб.
//
// РЕШЕНИЕ. Связку восстанавливаем по САМОМУ КАДРУ: фабрика первым кадром отдаёт фото начальника,
// которое мы ей и передали, значит достаточно сравнить его перцептивный отпечаток с кадрами в
// refs/<персона>.jpg. Это надёжнее любого лога и работает, даже если процесс умер молча.
//
// Ничего нового НЕ заказываем: только забираем оплаченное.
// Запуск: node harvesthash.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { to45, reframe, ctaSlide, postCaption } = require('./slidekit.cjs');
const { hashImage, hamming, coverUsed, registerCover } = require('./coverguard.cjs');
const W = require('./watchdog.cjs');
const { execFileSync } = require('node:child_process');
const FF = require.resolve('ffmpeg-static') && require('ffmpeg-static');

// СРАВНИВАЕМ ВЕРХНЮЮ ПОЛОВИНУ КАДРА. Фабрика печатает хук в нижней зоне, поэтому её кадр и наш
// исходник расходятся по полному отпечатку на 50-99 бит и опознание не срабатывает. Верхние 55%
// текста не содержат, значит там кадр остаётся тем же самым и отпечаток совпадает.
function topHash(src, tmp) {
  execFileSync(FF, ['-y', '-i', src, '-vf', 'crop=iw:ih*0.55:0:0,scale=512:-2', '-frames:v', '1', '-q:v', '2', tmp], { stdio: 'ignore' });
  return hashImage(tmp);
}

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const TEMPLATE = process.env.TEMPLATE || 'img-heart-hair';
const SINCE = process.env.SINCE || new Date(Date.now() - 6 * 3600e3).toISOString();
const LIMIT = Number(process.argv[2] || 0);
// Порог родства кадров: та же картинка после перегона в jpeg расходится на единицы бит, разные
// девушки не сходятся ближе 80 (замерено на боевом журнале обложек).
const NEAR = Number(process.env.NEAR_BITS || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const wd = W.armWatchdog({ minutes: 50, stallMinutes: 12, label: 'спасение оплаченного по отпечатку' });
  const lostList = fs.existsSync('/tmp/lost_personas.txt')
    ? fs.readFileSync('/tmp/lost_personas.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  // Отпечатки исходных кадров тех персон, у которых нет поста.
  const fp = [];
  for (const p of lostList) {
    const f = path.join(__dirname, 'refs', `${p}.jpg`);
    if (!fs.existsSync(f)) continue;
    try { fp.push({ persona: p, ref: f, h: topHash(f, `/tmp/th_${p}.jpg`) }); } catch {}
  }
  console.log(`персон без поста с исходным кадром: ${fp.length}`);
  if (!fp.length) return wd.done(0, 'ИТОГ: спасать нечего');

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done: closeTab } = await openAdmin();
  let ok = 0, skip = 0, bad = 0;
  try {
    wd.stage('читаю очередь фабрики');
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const orders = await page.evaluate(async ({ tpl, since }) => {
      const r = await fetch('/api/admin/promo/posts');
      if (!r.ok) return [];
      return ((await r.json()).posts || [])
        .filter((p) => p.templateId === tpl && p.createdAt >= since && p.status === 'done' && (p.imageUrls || []).length >= 2)
        .map((p) => ({ id: p.id, urls: p.imageUrls, cost: p.providerCostKopecks || 0, at: p.createdAt }));
    }, { tpl: TEMPLATE, since: SINCE });
    console.log(`оплаченных готовых заказов в окне: ${orders.length}`);

    const work = LIMIT > 0 ? orders.slice(0, LIMIT) : orders;
    for (const [i, o] of work.entries()) {
      wd.stage(`заказ ${i + 1} из ${work.length}`);
      try {
        const has = await c.query(`SELECT 1 FROM posts WHERE meta->>'factory_order' = $1 LIMIT 1`, [o.id]);
        if (has.rowCount) { skip++; continue; }

        const f1 = await W.fetchToFile(o.urls[0], `/tmp/hh_${String(o.id).slice(0, 8)}_1src.jpg`);
        // Кому принадлежит этот заказ: ищем самый близкий исходный кадр.
        const h1 = topHash(f1, `/tmp/hh_${String(o.id).slice(0, 8)}_probe.jpg`);
        let best = null;
        for (const x of fp) {
          const d = hamming(h1, x.h);
          if (!best || d < best.d) best = { ...x, d };
        }
        if (!best || best.d > NEAR) { console.log(`  ⚠ заказ ${String(o.id).slice(0, 8)}: хозяин не найден (ближайший ${best ? best.d : '—'} бит)`); skip++; continue; }
        const persona = best.persona;

        const f2 = await W.fetchToFile(o.urls[1], `/tmp/hh_${persona}_2src.jpg`);
        const f3 = o.urls[2] ? await W.fetchToFile(o.urls[2], `/tmp/hh_${persona}_3src.jpg`) : f2;
        const s1 = to45(f1, `/tmp/hh_${persona}_1.jpg`);
        const cu = await coverUsed(s1, persona).catch(() => ({ used: false }));
        if (cu.used) { console.log(`  ⚠ ${persona}: обложка уже в посте ${String(cu.postId).slice(0, 8)}`); skip++; continue; }
        const s2 = to45(f2, `/tmp/hh_${persona}_2.jpg`);
        const s3 = to45(f3, `/tmp/hh_${persona}_3.jpg`);
        const s4 = (await ctaSlide(reframe(s2, `/tmp/hh_${persona}_4raw.jpg`, `${persona}_4`), `/tmp/hh_${persona}_4.jpg`, { seed: `${persona}_4` })).out || `/tmp/hh_${persona}_4.jpg`;
        const files = [s1, s2, s3, s4];

        const urls = [];
        for (const f of files) {
          const b64 = fs.readFileSync(f).toString('base64');
          urls.push(await page.evaluate(async ({ b64, fname }) => {
            const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
            const fd = new FormData();
            fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
            const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.url) throw new Error('кадр не залился');
            return j.url;
          }, { b64, fname: path.basename(f) }));
          await sleep(400);
        }

        let verdict = 'unknown', problems = [];
        try {
          const vr = await require('./validatepost.cjs').validateCarousel(files, { template: TEMPLATE, coverRef: true, frame4Art: true });
          verdict = vr.verdict; problems = vr.problems || [];
        } catch {}

        const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND deleted_at IS NULL ORDER BY random() LIMIT 1`)).rows[0];
        const ins = await c.query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
           VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
          [acc.id, postCaption(TEMPLATE), urls[0], 'https://neironka.pro',
           JSON.stringify({ template: TEMPLATE, persona, image_urls: urls, frame4: true, frame4_art: true,
             cover_from_owner: true, harvested_by_hash: true, factory_order: o.id, source_cover: best.ref,
             match_bits: best.d, frames_changed_at: new Date().toISOString(),
             validation: { verdict, problems, at: new Date().toISOString() } }),
           verdict === 'reject' ? 'rejected' : 'backlog']);
        try { await registerCover(s1, persona, ins.rows[0].id); } catch {}
        console.log(`  ✅ ${persona}: пост ${String(ins.rows[0].id).slice(0, 8)} спасён (совпадение ${best.d} бит, ${(o.cost / 100).toFixed(2)} руб)`);
        ok++;
      } catch (e) { console.log(`  ✗ заказ ${String(o.id).slice(0, 8)}: ${String(e.message).slice(0, 80)}`); bad++; }
    }
  } finally { await closeTab(); await c.end().catch(() => {}); }
  wd.done(0, `ИТОГ: спасено ${ok}, пропущено ${skip}, ошибок ${bad}`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
