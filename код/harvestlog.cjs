// СПАСЕНИЕ ОПЛАЧЕННОГО ПО ЛОГУ ЗАЛПА (07.08).
//
// ЗАЧЕМ. В залпе часть сборок упала на перегрузе служебного браузера («Failed to fetch»), но
// заказы у фабрики к тому моменту были УЖЕ ОПЛАЧЕНЫ и дорендерились. Днём такая же история
// стоила 197 руб: рендеры остались бесхозными, потому что связка «персона → номер заказа» жила
// только в памяти упавшего процесса. Здесь эту связку достаём ИЗ ЛОГА: сборщик печатает
// «жду рендер заказ 1 <id>» с идентификатором, значит по логу можно восстановить, какой заказ
// принадлежал какой персоне, и собрать пост без новых трат.
//
// Обложку берём из refs/<персона>.jpg (кадр начальника лежит там же, куда его положил залп).
// Кадр 4 собираем по стандарту: арт с сердцами в другом кадрировании плюс фирменный блок.
//
// Запуск: node harvestlog.cjs <файл-лога> [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { to45, reframe, ctaSlide, postCaption } = require('./slidekit.cjs');
const { coverUsed, registerCover } = require('./coverguard.cjs');
const W = require('./watchdog.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LOG = process.argv[2] || '/tmp/fabwave4.log';
const LIMIT = Number(process.argv[3] || 0);
const TEMPLATE = process.env.TEMPLATE || 'img-heart-hair';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Разбор лога: персона печатается строкой «=== девочкаNN ← kadr..», номер заказа строкой
// «жду рендер заказ 1 <id>». Идут они по процессам вперемешку, поэтому связываем по имени
// персоны, которое сборщик пишет в начале своей строки сердцебиения.
function parseLog(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const orders = new Map();     // персона -> id заказа
  const failed = new Set();     // персоны, чья сборка упала
  const done = new Set();       // персоны, чей пост собрался
  for (const line of txt.split('\n')) {
    let m = line.match(/^\s*(\S+?):\s+⏱ жду рендер заказ \d+ ([0-9a-f-]{6,})/);
    if (m) { orders.set(m[1], m[2]); continue; }
    m = line.match(/«фабричный пост (\S+?)\//);
    if (m && /упал на шаге/.test(line)) { failed.add(m[1]); continue; }
    m = line.match(/ИТОГ: ✅ (\S+?)\//);
    if (m) done.add(m[1]);
  }
  return { orders, failed, done };
}

(async () => {
  const wd = W.armWatchdog({ minutes: 40, stallMinutes: 12, label: 'спасение оплаченного по логу' });
  const { orders, failed, done } = parseLog(LOG);
  const lost = [...orders.keys()].filter((p) => !done.has(p));
  console.log(`в логе персон с заказами: ${orders.size}, собрано: ${done.size}, потеряно: ${lost.length}`);
  if (!lost.length) return wd.done(0, 'ИТОГ: спасать нечего, все посты собраны');

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done: closeTab } = await openAdmin();
  let ok = 0, skip = 0, bad = 0;
  try {
    wd.stage('открываю админку промо');
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const work = LIMIT > 0 ? lost.slice(0, LIMIT) : lost;

    for (const [i, persona] of work.entries()) {
      const oid = orders.get(persona);
      wd.stage(`${persona} (${i + 1} из ${work.length})`);
      try {
        // Уже есть пост по этому заказу? Тогда ничего не делаем: дубль хуже потери.
        const has = await c.query(`SELECT 1 FROM posts WHERE meta->>'factory_order' = $1 LIMIT 1`, [oid]);
        if (has.rowCount) { console.log(`  ⚠ ${persona}: пост по заказу уже есть`); skip++; continue; }

        const got = await page.evaluate(async (id) => {
          const r = await fetch('/api/admin/promo/posts');
          if (!r.ok) return null;
          const x = ((await r.json()).posts || []).find((z) => z.id === id);
          return x ? { st: x.status, urls: x.imageUrls || [], cost: x.providerCostKopecks || 0 } : null;
        }, oid);
        if (!got) { console.log(`  ⚠ ${persona}: заказа ${String(oid).slice(0, 8)} нет в выдаче фабрики`); skip++; continue; }
        if (got.st !== 'done' || got.urls.length < 2) { console.log(`  ⚠ ${persona}: заказ ещё ${got.st}, кадров ${got.urls.length}`); skip++; continue; }

        const ref = path.join(__dirname, 'refs', `${persona}.jpg`);
        if (!fs.existsSync(ref)) { console.log(`  ⚠ ${persona}: нет исходного кадра в refs`); skip++; continue; }

        const tag = `hl_${persona}`;
        const f1 = await W.fetchToFile(got.urls[0], `/tmp/${tag}_1src.jpg`);
        const f2 = await W.fetchToFile(got.urls[1], `/tmp/${tag}_2src.jpg`);
        const f3 = got.urls[2] ? await W.fetchToFile(got.urls[2], `/tmp/${tag}_3src.jpg`) : f2;
        const s1 = to45(f1, `/tmp/${tag}_1.jpg`);        // фабричный кадр с нашим хуком
        const cu = await coverUsed(s1, persona).catch(() => ({ used: false }));
        if (cu.used) { console.log(`  ⚠ ${persona}: обложка уже в посте ${String(cu.postId).slice(0, 8)}`); skip++; continue; }
        const s2 = to45(f2, `/tmp/${tag}_2.jpg`);
        const s3 = to45(f3, `/tmp/${tag}_3.jpg`);
        const s4 = (await ctaSlide(reframe(s2, `/tmp/${tag}_4raw.jpg`, `${persona}_4`), `/tmp/${tag}_4.jpg`, { seed: `${persona}_4` })).out || `/tmp/${tag}_4.jpg`;
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
          await sleep(500);
        }

        let verdict = 'unknown', problems = [];
        try {
          const vr = await require('./validatepost.cjs').validateCarousel(files, { template: TEMPLATE, coverRef: true, frame4Art: true });
          verdict = vr.verdict; problems = vr.problems || [];
        } catch {}

        const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND deleted_at IS NULL
          ORDER BY random() LIMIT 1`)).rows[0];
        const ins = await c.query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
           VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
          [acc.id, postCaption(TEMPLATE), urls[0], 'https://neironka.pro',
           JSON.stringify({ template: TEMPLATE, persona, image_urls: urls, frame4: true, frame4_art: true,
             cover_from_owner: true, harvested_by_log: true, factory_order: oid, source_cover: ref,
             frames_changed_at: new Date().toISOString(),
             validation: { verdict, problems, at: new Date().toISOString() } }),
           verdict === 'reject' ? 'rejected' : 'backlog']);
        try { await registerCover(s1, persona, ins.rows[0].id); } catch {}
        console.log(`  ✅ ${persona}: пост ${String(ins.rows[0].id).slice(0, 8)} спасён (заказ ${String(oid).slice(0, 8)}, ${(got.cost / 100).toFixed(2)} руб)`);
        ok++;
      } catch (e) { console.log(`  ✗ ${persona}: ${String(e.message).slice(0, 80)}`); bad++; }
    }
  } finally { await closeTab(); await c.end().catch(() => {}); }
  wd.done(0, `ИТОГ: спасено ${ok}, пропущено ${skip}, ошибок ${bad}`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
