// ПЕРЕРИСОВКА ВТОРОГО И ТРЕТЬЕГО КАДРОВ: УБИРАЕМ БЕЛЫЕ ПОЛЯ ПО БОКАМ (09.08, приказ начальника:
// «2 и 3 фото белые края по бокам, нельзя так», решение: «пусть растягиваются чуть чтобы края
// закрывать»).
//
// Что было: карточка от фабрики выше 4:5 вписывалась целиком (to45fit), и по бокам оставались
// белые полосы примерно по 33 пикселя. В ленте это читается как склейка на телефоне.
// Что делаем: белые поля СРЕЗАЕМ (получаем ровно ту карточку, что была до вписывания) и приводим
// её к 1080x1350 через to45smart из slidekit.cjs, который слегка растягивает кадр и при
// необходимости срезает лишнюю высоту с привязкой к верху (заголовок карточки остаётся).
//
// ГЕНЕРАЦИЙ НОЛЬ. Это чистая вёрстка: скачали готовый кадр, перерисовали, залили, обновили ссылку.
// Запуск: node rebuild23.cjs [сколько]
//   ONLY_TEMPLATES=img-face-report,img-beauty-guide  фильтр по шаблону (по умолчанию все)
//   PERSONA_LIKE=нов%                                фильтр персоны (по умолчанию нов%)
//   DRY_RUN=1                                        только проверка полей, без заливки
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('ffmpeg-static');
const { to45smart } = require('./slidekit.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
const DRY = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ''));
const W = 1080, H = 1350;
const TMP = '/tmp/rb23';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ЧТЕНИЕ КАДРА ПИКСЕЛЯМИ. cropdetect тут не годится: он ищет ЧЁРНЫЕ поля и на светлой карточке
// молчит. Считаем сами: разворачиваем кадр в rgb24 (4 мегабайта, это дешёво) и смотрим столбцы.
function columns(file) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const b = r.stdout;
  const sz = size(file);
  if (!b || !sz.w || b.length < sz.w * sz.h * 3) throw new Error('кадр не читается пикселями');
  const out = [];
  for (let x = 0; x < sz.w; x++) {
    let mn = 255, sum = 0;
    for (let y = 0; y < sz.h; y++) {
      const o = (y * sz.w + x) * 3;
      const v = Math.min(b[o], b[o + 1], b[o + 2]);
      if (v < mn) mn = v;
      sum += (b[o] + b[o + 1] + b[o + 2]) / 3;
    }
    out.push({ min: mn, mean: sum / sz.h });
  }
  return { cols: out, ...sz };
}

function size(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
  return m ? { w: +m[1], h: +m[2] } : { w: 0, h: 0 };
}

// ПОЛЕ ЭТО ИДЕАЛЬНО БЕЛЫЙ СТОЛБЕЦ ВО ВСЮ ВЫСОТУ. Порог держим жёстким (min>=243, среднее>=250):
// у карточек «оценка внешности» фон бежевый, крайние столбцы дают 232-249 и полем НЕ считаются,
// иначе я срезал бы живой фон. Настоящее поле от pad=white даёт ровно 255.
function whiteEdges(file) {
  const { cols, w, h } = columns(file);
  const white = (c) => c.min >= 243 && c.mean >= 250;
  let L = 0; while (L < w && white(cols[L])) L++;
  let R = 0; while (R < w - L && white(cols[w - 1 - R])) R++;
  // Поле считаем настоящим от 8 пикселей с КАЖДОЙ стороны: одиночный белый столбец бывает у
  // карточки с белой рамкой, и трогать её не за что.
  const has = L >= 8 && R >= 8 && (L + R) < w * 0.35;
  return { L, R, w, h, has };
}

// Срезаем поля и получаем ту самую карточку, которую фабрика отдала до вписывания.
function cutPads(src, out, L, R, w, h) {
  let cw = w - L - R;
  if (cw % 2) cw--;                        // yuvj420p не любит нечётную ширину
  execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
    '-vf', `crop=w=${cw}:h=${h}:x=${L}:y=0`, '-q:v', '2', out], { stdio: 'ignore' });
  return out;
}

const wd = armWatchdog({ minutes: 20, stallMinutes: 5, label: 'перерисовка кадров 2 и 3 без белых полей' });

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  wd.stage('читаю склад');
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls
      FROM posts
     WHERE status IN ('backlog','approved') AND published_at IS NULL
       AND jsonb_array_length(meta->'image_urls') = 4
       AND meta->>'persona' LIKE $1
       AND ($2::text IS NULL OR meta->>'template' = ANY(string_to_array($2, ',')))
     ORDER BY created_at DESC`,
    [process.env.PERSONA_LIKE || 'нов%', process.env.ONLY_TEMPLATES || null])).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`постов к проверке: ${work.length}${DRY ? ' (СУХОЙ ПРОГОН, заливки не будет)' : ''}`);

  // Сначала СМОТРИМ все кадры и только потом лезем в браузер: если полей ни у кого нет, вкладка
  // админки вообще не понадобится.
  const plan = [];
  for (const [i, p] of work.entries()) {
    const short = String(p.id).slice(0, 8);
    wd.stage(`смотрю кадры поста ${i + 1} из ${work.length} (${short}, ${p.pn})`);
    const need = [];
    const fine = [];
    for (const idx of [1, 2]) {
      const url = (p.urls || [])[idx];
      if (!url) { fine.push(`кадр ${idx + 1}: ссылки нет`); continue; }
      try {
        const f = await fetchToFile(url, `${TMP}/${short}_${idx + 1}.jpg`, { what: `кадр ${idx + 1}`, ms: 60000, min: 5000 });
        const e = whiteEdges(f);
        if (e.has) need.push({ idx, file: f, e });
        else fine.push(`кадр ${idx + 1}: полей нет (белых столбцов слева ${e.L}, справа ${e.R})`);
      } catch (err) { fine.push(`кадр ${idx + 1}: не проверен (${String(err.message).slice(0, 50)})`); }
    }
    console.log(`  ${short} (${p.pn}, ${p.tpl}): перерисовать ${need.length ? need.map((n) => n.idx + 1).join(' и ') : 'нечего'}`);
    for (const t of fine) console.log(`     · ${t}`);
    for (const n of need) console.log(`     · кадр ${n.idx + 1}: БЕЛЫЕ ПОЛЯ ${n.e.L} слева и ${n.e.R} справа`);
    if (need.length) plan.push({ p, short, need });
  }

  const total = plan.reduce((s, x) => s + x.need.length, 0);
  console.log(`итого кадров с полями: ${total} в ${plan.length} постах`);
  if (!plan.length || DRY) { await c.end().catch(() => {}); wd.done(0, DRY ? 'сухой прогон закончен' : 'перерисовывать нечего'); return; }

  wd.stage(`беру вкладку в статичном хроме, постов ${plan.length}`);
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  let ok = 0, bad = 0;
  try {
    // Ретраи на открытие панели: рядом может работать фабрика, и вкладка не успевает за 60 секунд.
    let opened = false;
    for (let att = 1; att <= 3 && !opened; att++) {
      try { await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 120000 }); opened = true; }
      catch (e) {
        console.log(`  ⚠ попытка ${att} из 3: админка не открылась за 120с (${String(e.message).slice(0, 60)})`);
        if (att === 3) throw new Error('админка не открылась за 3 попытки');
        await sleep(5000);
      }
    }
    await sleep(2000);

    for (const [i, job] of plan.entries()) {
      const { p, short, need } = job;
      wd.stage(`перерисовываю пост ${i + 1} из ${plan.length} (${short}, ${p.pn})`);
      const urls = [...(p.urls || [])];
      const changed = [];
      for (const n of need) {
        try {
          const cut = cutPads(n.file, `${TMP}/${short}_${n.idx + 1}_cut.jpg`, n.e.L, n.e.R, n.e.w, n.e.h);
          const out = to45smart(cut, `${TMP}/${short}_${n.idx + 1}_new.jpg`);
          const s = size(out);
          if (s.w !== W || s.h !== H) throw new Error(`размер после перерисовки ${s.w}x${s.h}, а нужен ${W}x${H}`);
          const after = whiteEdges(out);
          if (after.has) throw new Error(`поля остались (${after.L} и ${after.R})`);

          const b64 = fs.readFileSync(out).toString('base64');
          const url = await page.evaluate(async ({ b64, fname }) => {
            const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
            const fd = new FormData();
            fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
            const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.url) throw new Error('кадр не залился');
            return j.url;
          }, { b64, fname: path.basename(out) });
          urls[n.idx] = url;
          changed.push(n.idx + 1);
          console.log(`  ✅ ${short} (${p.pn}): кадр ${n.idx + 1} перерисован, поля срезаны (${n.e.L}/${n.e.R}) → ${url.slice(-24)}`);
        } catch (e) {
          console.log(`  ✗ ${short} (${p.pn}): кадр ${n.idx + 1} не перерисован: ${String(e.message).slice(0, 80)}`);
          bad++;
        }
      }
      if (!changed.length) continue;
      try {
        await c.query(`UPDATE posts SET
            meta = meta || jsonb_build_object('image_urls', $2::jsonb, 'refit23', true,
                             'frames_changed_at', to_jsonb(now()))
          WHERE id=$1`, [p.id, JSON.stringify(urls)]);
        ok += changed.length;
        console.log(`  💾 ${short} (${p.pn}): в базе обновлены кадры ${changed.join(' и ')}`);
      } catch (e) {
        bad += changed.length;
        console.log(`  ✗ ${short}: база не обновилась: ${String(e.message).slice(0, 80)}`);
      }
      await sleep(300);
    }
  } finally { wd.poke('отцепляюсь от хрома и от базы'); await done(); await c.end().catch(() => {}); }
  // Выход явный: после CDP в процессе живут сокеты playwright и нода сама не завершается.
  wd.done(0, `ИТОГ: перерисовано кадров ${ok}, ошибок ${bad}`);
})().catch((e) => wd.fail(e));
