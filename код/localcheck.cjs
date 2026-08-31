// ЛОКАЛЬНАЯ ПРОВЕРКА КАРУСЕЛИ — ПЕРВЫЙ ЭШЕЛОН. СТОИТ НОЛЬ.
//
// Зачем (инцидент 07.08): проверка картинок ходила ТОЛЬКО в платный vision (OpenRouter). Когда на
// балансе кончились деньги, сервис начал отвечать HTTP 402, вердикт приходил 'unknown', и девять
// готовых постов подряд ушли в брак — публикация встала полностью. Вывод: гейт качества не имеет
// права целиком зависеть от платного сервиса и от чужого баланса.
//
// Поэтому боевые дефекты, которые видны АРИФМЕТИКОЙ, ловим локально и бесплатно:
//   • не 4 кадра или размер не 1080×1350 (карусель едет в ленте, кадр обрезан в полосу);
//   • два кадра — один и тот же снимок (байтовый дубль или перцептивный);
//   • чёрный, пустой или залитый одним тоном кадр (генератор отдал пустышку);
//   • на кадре 1 нет надписи-хука, на кадре 4 нет фирменного блока (рендер молча не сработал).
//
// Чего локальная проверка НЕ умеет: подмена лица, битые буквы («ОФАЛ» вместо «ОВАЛ»), призрачный
// слой. Это остаётся за vision. Поэтому эшелон работает В ОДНУ СТОРОНУ: он умеет ЗАБРАКОВАТЬ,
// но никогда не выдаёт «годится» вместо vision. Пройденная локальная проверка это только
// «явных дефектов нет».
//
// ИСКЛЮЧЕНИЕ ПО ДУБЛЯМ: пара «кадр 2 и кадр 4» — наш стандарт (кадр 4 это кадр 2 в другом
// кадрировании плюс фирменный блок), их сходство браком не считается. Все остальные пары — брак.
//
// Запуск отдельно: node localcheck.cjs <файл|url> …   |   node localcheck.cjs --post <uuid>
//                  node localcheck.cjs --backlog [--write]   — весь склад; --write ставит пометку
//                  meta.local_check (НИЧЕГО не удаляет и статус не меняет).
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const W = 1080, H = 1350;                                  // жёсткий формат 4:5 из STANDARD-POSTS.md
// Порог «надпись есть». Метрика — доля белых штрихов в промилле площади полосы (см. textScore).
// Калибровка на 20 боевых постах: кадры с надписью 16.7…80.3, кадры без надписи 0.0…8.7.
// 12 стоит в середине разрыва.
const TEXT_MIN = Number(process.env.LC_TEXT_MIN || 12);
// Порог перцептивного дубля в битах из 256 (dHash из coverguard). Калибровка: у РАЗНЫХ кадров
// одного поста расстояние 89…159 бит, включая пару 2-4 после перекадрирования. Один и тот же
// снимок после пережатия в jpeg даёт единицы бит. 32 — с большим запасом от ложных срабатываний.
const DUP_BITS = Number(process.env.LC_DUP_BITS || 32);
const BLACK_MEAN = 12;                                     // средняя яркость ниже — кадр чёрный
const FLAT_STD = 6;                                        // дисперсия ниже — кадр залит одним тоном

function dims(file) {
  try { execFileSync(FF, ['-hide_banner', '-i', file], { stdio: 'pipe' }); }
  catch (e) {
    const m = String(e.stderr).match(/Stream #0:0.*?, (\d+)x(\d+)/);
    if (m) return { w: +m[1], h: +m[2] };
  }
  return null;
}

// Кадр целиком в серых пикселях, в НАТИВНОМ размере: из одного буфера считаем и полосы, и яркость.
function grayFull(file, w, h) {
  const px = execFileSync(FF, ['-nostdin', '-loglevel', 'error', '-y', '-i', file,
    '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1 << 26 });
  if (px.length < w * h) throw new Error(`ffmpeg не отдал пиксели: ${file}`);
  return px;
}

function meanStd(px, w, h, y0 = 0, y1 = h) {
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) { const v = px[y * w + x]; s += v; s2 += v * v; n++; }
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

// ЕСТЬ ЛИ В НИЖНЕЙ ЧАСТИ КАДРА НАША НАДПИСЬ.
// Наши хук и призыв рендерятся чистым белым поверх фото или тёмного градиента (slidekit: .hookbar
// bottom:300px, .ctabar bottom:210px). Признак буквы — ЯРКИЙ пиксель, у которого в пределах 5 px по
// горизонтали есть заметно тёмный сосед: это край штриха. У фотографии таких тонких контрастных
// штрихов почти нет, у текста их много.
// Считаем по ТРЁМ перекрывающимся полосам по 200 px и берём максимум: разные варианты плашки лежат
// на разной высоте, а узкая полоса не размывает сигнал площадью пустого фона.
function textScore(px, w, h) {
  const bands = [Math.round(h * 0.578), Math.round(h * 0.689), Math.round(h * 0.8)];
  const bh = Math.round(h * 0.148);
  let best = 0;
  for (const y0 of bands) {
    const y1 = Math.min(h, y0 + bh);
    let n = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = 5; x < w - 5; x++) {
        if (px[row + x] < 225) continue;
        if (px[row + x - 5] < 150 || px[row + x + 5] < 150) n++;
      }
    }
    const v = n / (w * (y1 - y0)) * 1000;
    if (v > best) best = v;
  }
  return best;
}

// ПОЛОСЫ ПО КРАЯМ. Кадр, который «вписали» вместо кропа, получает ровные поля сверху или снизу —
// в ленте это читается как обрезанный пост.
// Считаем НЕ среднее по полосе, а длину серии подряд идущих ПОЧТИ ПОСТОЯННЫХ строк от края.
// Первая версия смотрела среднюю яркость полосы 6% и дала 5 ложных срабатываний из 7 на складе:
// тёмное ночное фото (телефон на столе, чёрно-белый арт) она принимала за полосу. У настоящей
// полосы строка залита одним значением (дисперсия ~0), у тёмной фотографии всегда есть текстура.
// Замер на складе: настоящие полосы 61…270 строк, тёмные фото ровно 0.
//
// ПОРОГ ПЕРЕСТАВЛЕН 10.08 ПО ЗАМЕРУ, а не на глаз. Прежние условия (дисперсия < 2 и яркость < 12)
// всё равно ловили ночные фото: пост нов50 ушёл в брак с «полосой 35 px» на кадре 1, хотя полос на
// кадре НЕТ вообще, исходник ровно 4:5 (736×920), а тёмный край это салон машины в темноте.
// Ложный брак стоил 0.09 живых денег, и это второй раз, когда тёмное фото признают полосой.
//
// ЧТО НАМЕРЕНО (одной и той же меркой, PIL, кадр целиком):
//   · настоящая ЧЁРНАЯ полоса от ffmpeg pad — яркость 0.00, дисперсия 0.000 (все строки);
//   · настоящая БЕЛАЯ полоса от ffmpeg pad — яркость 255.00, дисперсия 0.000;
//   · тёмный край ночного фото нов50 — яркость 5.2…7.2, дисперсия 1.7…3.7;
//   · СВОЁ БЕЛОЕ ПОЛЕ КАРТОЧКИ фабрики — яркость 252.00 при дисперсии 0.000 (у нов50) и 243.75
//     при дисперсии 12.4 (у нов47). Это рисунок самой карточки, а не наша вписка, и браком быть
//     не может: карточку рисует фабрика, у неё сверху свой отступ до линейки.
// Разрыв между заливкой и картинкой огромный, поэтому порог ставим ВНУТРИ разрыва, вплотную к
// заливке: дисперсия < 0.8 и яркость < 4 либо > 254. Полоса, нарисованная заливкой, всегда ровно
// 0 или ровно 255, а в фотографии и в карточке есть шум сенсора, шум сжатия или свой оттенок
// фона — ни одно из этого в заливку не попадает.
const BAR_SD = Number(process.env.LC_BAR_SD || 0.8);
const BAR_DARK = Number(process.env.LC_BAR_DARK || 4);
const BAR_LIGHT = Number(process.env.LC_BAR_LIGHT || 254);
function flatRun(px, w, h, fromTop) {
  let n = 0;
  const max = Math.round(h * 0.2);
  for (let i = 0; i < max; i++) {
    const y = fromTop ? i : h - 1 - i;
    let s = 0, s2 = 0;
    for (let x = 0; x < w; x++) { const v = px[y * w + x]; s += v; s2 += v * v; }
    const m = s / w, sd = Math.sqrt(Math.max(0, s2 / w - m * m));
    if (sd < BAR_SD && (m < BAR_DARK || m > BAR_LIGHT)) n++; else break;
  }
  return n;
}
const BAR_ROWS = Number(process.env.LC_BAR_ROWS || 20);    // 20 строк из 1350 ≈ 1.5% высоты
function letterbox(px, w, h) {
  const top = flatRun(px, w, h, true), bot = flatRun(px, w, h, false);
  const n = Math.max(top, bot);
  return n >= BAR_ROWS ? n : 0;
}

// dHash 16x16 (та же схема, что в coverguard) — считаем из уже поднятого буфера, без второго ffmpeg.
function dhashFrom(px, w, h) {
  const S = 16, g = new Float64Array((S + 1) * S);
  const cw = w / (S + 1), ch = h / S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x <= S; x++) {
      let s = 0, n = 0;
      const x0 = Math.floor(x * cw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * cw));
      const y0 = Math.floor(y * ch), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ch));
      for (let yy = y0; yy < y1 && yy < h; yy++) for (let xx = x0; xx < x1 && xx < w; xx++) { s += px[yy * w + xx]; n++; }
      g[y * (S + 1) + x] = n ? s / n : 0;
    }
  }
  let hex = '', nib = 0, bits = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      nib = (nib << 1) | (g[y * (S + 1) + x] > g[y * (S + 1) + x + 1] ? 1 : 0);
      if (++bits === 4) { hex += nib.toString(16); nib = 0; bits = 0; }
    }
  }
  return hex;
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 9999;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15];
  return d;
}

// Имя временного файла обязано быть уникальным ДАЖЕ внутри одного процесса: прогон по складу
// проверяет посты в четыре потока, и на «pid + номер кадра + миллисекунда» два потока сталкивались
// на одном файле — один затирал картинку другого, и пост получал ложное «метрики не посчитались».
let tmpSeq = 0;
async function materialize(src) {
  if (!/^https?:/i.test(src)) {
    if (!fs.existsSync(src)) throw new Error(`нет файла: ${src}`);
    return { path: src, tmp: false };
  }
  const out = `/tmp/lc_${process.pid}_${++tmpSeq}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const r = await fetch(src, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`не скачалось: HTTP ${r.status}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return { path: out, tmp: true };
}

/** Метрики одного кадра. */
function frameMetrics(file) {
  const d = dims(file);
  const px = grayFull(file, W, H);                          // приводим к эталонной сетке 1080×1350
  const whole = meanStd(px, W, H);
  return {
    dims: d,
    mean: whole.mean,
    std: whole.std,
    text: textScore(px, W, H),
    bars: letterbox(px, W, H),
    hash: dhashFrom(px, W, H),
    sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

/**
 * Локальная проверка карусели. Ноль платных запросов.
 * Возвращает {verdict:'ok'|'reject'|'unknown', problems:[], metrics:[]}.
 *   'reject'  — найден явный дефект, публиковать нельзя;
 *   'ok'      — явных дефектов нет (НЕ значит «пост годный»: лицо и буквы смотрит vision);
 *   'unknown' — сама проверка не отработала (нет ffmpeg, файл не скачался). Контент не судим.
 * opts.expect — сколько кадров ждём (по умолчанию 4). opts.frame4Art — кадр 4 сделан из кадра 2.
 */
async function localCheck(sources, opts = {}) {
  const expect = opts.expect === undefined ? 4 : opts.expect;
  if (!Array.isArray(sources) || !sources.length) return { verdict: 'unknown', problems: ['нет картинок'] };

  const files = [];
  try { for (const s of sources) files.push(await materialize(s)); }
  catch (e) {
    files.filter((f) => f.tmp).forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    return { verdict: 'unknown', problems: [`картинки не загрузились: ${e.message}`] };
  }

  const problems = [];
  let metrics = [];
  try {
    metrics = files.map((f) => frameMetrics(f.path));
  } catch (e) {
    return { verdict: 'unknown', problems: [`метрики не посчитались: ${String(e.message).slice(0, 90)}`] };
  } finally {
    files.filter((f) => f.tmp).forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
  }

  // 1. Число кадров.
  if (expect && sources.length !== expect) problems.push(`кадров ${sources.length}, а нужно ${expect}`);

  // 2. Размер каждого кадра. Разнобой ломает карусель, полоса = обрезанный кадр.
  metrics.forEach((m, i) => {
    if (!m.dims) { problems.push(`кадр ${i + 1}: размер не прочитался`); return; }
    if (m.dims.w !== W || m.dims.h !== H) problems.push(`кадр ${i + 1}: размер ${m.dims.w}×${m.dims.h}, а нужно ${W}×${H}`);
  });

  // 3. Чёрный / пустой / с полосами.
  metrics.forEach((m, i) => {
    if (m.mean < BLACK_MEAN) problems.push(`кадр ${i + 1}: почти чёрный (яркость ${m.mean.toFixed(0)})`);
    else if (m.std < FLAT_STD) problems.push(`кадр ${i + 1}: залит одним тоном, картинки нет (дисперсия ${m.std.toFixed(1)})`);
    if (m.bars) problems.push(`кадр ${i + 1}: ровная полоса по краю ${m.bars} px — кадр вписан, а не обрезан`);
  });

  // 4. Дубли кадров. Пара 2-4 — наш стандарт, её сходство не брак.
  const exempt = (a, b) => (a === 1 && b === 3);            // индексы с нуля: кадр 2 и кадр 4
  for (let a = 0; a < metrics.length; a++) {
    for (let b = a + 1; b < metrics.length; b++) {
      if (metrics[a].sha === metrics[b].sha) {
        if (exempt(a, b)) continue;
        problems.push(`кадры ${a + 1} и ${b + 1}: это один и тот же файл`);
        continue;
      }
      const d = hamming(metrics[a].hash, metrics[b].hash);
      if (d <= DUP_BITS && !exempt(a, b)) problems.push(`кадры ${a + 1} и ${b + 1}: один и тот же снимок (расхождение ${d} бит из 256)`);
    }
  }

  // 5. Надписи. Кадр 1 — хук, последний кадр — фирменный блок. Обе рендерит постер, значит их
  //    отсутствие это молчаливый сбой рендера, а не замысел.
  if (metrics.length >= 1 && metrics[0].text < TEXT_MIN) {
    problems.push(`кадр 1: нет надписи-хука (${metrics[0].text.toFixed(1)} при пороге ${TEXT_MIN})`);
  }
  const last = metrics.length - 1;
  if (expect === 4 && metrics.length === 4 && metrics[last].text < TEXT_MIN) {
    problems.push(`кадр 4: нет фирменного блока с призывом (${metrics[last].text.toFixed(1)} при пороге ${TEXT_MIN})`);
  }

  return {
    verdict: problems.length ? 'reject' : 'ok',
    problems,
    metrics: metrics.map((m, i) => ({
      frame: i + 1,
      size: m.dims ? `${m.dims.w}x${m.dims.h}` : '?',
      mean: +m.mean.toFixed(1), std: +m.std.toFixed(1),
      text: +m.text.toFixed(1), bars: m.bars, hash: m.hash.slice(0, 12),
    })),
  };
}

module.exports = { localCheck, frameMetrics, hamming, dhashFrom, textScore, TEXT_MIN, DUP_BITS, W, H };

function db() {
  const { Client } = require('pg');
  return new Client({
    connectionString: process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
    ssl: { rejectUnauthorized: false },
  });
}

// ПРОГОН ПО СКЛАДУ. Только читает и ставит пометку meta.local_check: статусы не трогаем,
// ничего не удаляем — решение о браке принимает человек или публикатор.
async function runBacklog(write) {
  const c = db();
  await c.connect();
  const r = await c.query(`SELECT id, meta->>'persona' persona, meta->>'template' tpl, meta->'image_urls' u
    FROM posts WHERE status='backlog' AND meta ? 'image_urls' ORDER BY created_at DESC`);
  console.log(`СКЛАД: ${r.rows.length} постов, проверяю локально (платных запросов ноль)\n`);
  const bad = [];
  let ok = 0, unknown = 0;
  const LIMIT = 4;
  let idx = 0;
  const results = new Array(r.rows.length);
  async function worker() {
    while (idx < r.rows.length) {
      const i = idx++;
      const row = r.rows[i];
      let res;
      try { res = await localCheck(row.u); }
      catch (e) { res = { verdict: 'unknown', problems: [String(e.message).slice(0, 90)] }; }
      results[i] = { row, res };
      const icon = res.verdict === 'ok' ? '✅' : res.verdict === 'reject' ? '⛔' : '❓';
      console.log(`${icon} ${row.id.slice(0, 8)} ${String(row.persona).padEnd(10)} ${String(row.tpl).slice(0, 20).padEnd(20)}`
        + (res.verdict === 'ok' ? '' : ' ' + (res.problems || []).join('; ').slice(0, 120)));
      if (write) {
        await c.query(`UPDATE posts SET meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('local_check', $2::jsonb) WHERE id=$1`,
          [row.id, JSON.stringify({ verdict: res.verdict, problems: res.problems || [], metrics: res.metrics || null, at: new Date().toISOString() })]).catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: LIMIT }, worker));
  for (const { row, res } of results.filter(Boolean)) {
    if (res.verdict === 'ok') ok++;
    else if (res.verdict === 'unknown') unknown++;
    else bad.push({ row, res });
  }
  console.log(`\nИТОГ СКЛАДА: ✅ прошли ${ok} · ⛔ с дефектом ${bad.length} · ❓ не проверились ${unknown}`);
  if (bad.length) {
    console.log('\nПОЧЕМУ НЕ ПРОШЛИ:');
    const byReason = {};
    bad.forEach(({ row, res }) => (res.problems || []).forEach((p) => {
      const k = p.replace(/\d+([.,]\d+)?/g, 'N').replace(/кадр[ыа]? N( и N)?/g, 'кадр');
      (byReason[k] = byReason[k] || []).push(row.id.slice(0, 8));
    }));
    Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)
      .forEach(([k, ids]) => console.log(`  ${String(ids.length).padStart(3)} × ${k}   (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? '…' : ''})`));
  }
  if (write) console.log('\nпометки meta.local_check записаны (статусы не менялись, ничего не удалено)');
  await c.end();
  return { ok, bad: bad.length, unknown };
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let sources = args.filter((a) => !a.startsWith('--'));
    if (args.includes('--backlog')) {
      await runBacklog(args.includes('--write'));
      process.exit(0);
    }
    if (args.includes('--post')) {
      const id = args[args.indexOf('--post') + 1];
      const { Client } = require('pg');
      const db = new Client({
        connectionString: process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
        ssl: { rejectUnauthorized: false },
      });
      await db.connect();
      const r = await db.query(`SELECT meta->'image_urls' u, meta->>'persona' p FROM posts WHERE id=$1`, [id]);
      await db.end();
      if (!r.rows[0]?.u) { console.log('ИТОГ: у поста нет image_urls'); process.exit(1); }
      sources = r.rows[0].u;
      console.log(`ЛОКАЛЬНАЯ ПРОВЕРКА: ${r.rows[0].p} (${sources.length} кадров)`);
    }
    if (!sources.length) { console.log('нужен файл, url или --post <uuid>'); process.exit(1); }
    const res = await localCheck(sources);
    const icon = res.verdict === 'ok' ? '✅' : res.verdict === 'reject' ? '⛔' : '❓';
    console.log(`${icon} ЛОКАЛЬНО: ${res.verdict}`);
    (res.metrics || []).forEach((m) => console.log(`   кадр ${m.frame}: ${m.size} ярк=${m.mean} дисп=${m.std} надпись=${m.text}${m.bars ? ' ПОЛОСЫ' : ''}`));
    (res.problems || []).forEach((p) => console.log(`   • ${p}`));
    process.exit(res.verdict === 'reject' ? 1 : 0);
  })();
}
