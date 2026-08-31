// ПРОВЕРКА КАДРОВ СКЛАДА ПЕРЕД РЕГЕНЕРАЦИЕЙ (09.08, приказ начальника: «были посты с браком, где
// были танки, ты это нашёл и учёл? это важно до регенерации постов»).
//
// ЧТО ЛОВИМ. На третьем кадре телефон, и на его экране должен лежать НАШ арт со второго кадра.
// Иногда в экран попадала посторонняя картинка (в одном случае танки), и пост уходил в ленту с
// чужим кадром. Глазами это заметно сразу, а в базе никак не помечено.
//
// КАК ЛОВИМ БЕЗ ЗРЕНИЯ. Сравниваем перцептивный отпечаток центральной зоны третьего кадра (там
// экран телефона) с отпечатком второго кадра. Наш арт на экране даёт близкий отпечаток, чужая
// картинка даёт далёкий. Плюс сверяем насыщенность: наш арт часто чёрно-белый, а посторонние
// кадры цветные, это второй независимый признак.
//
// ТИП ТРЕНДА БОЛЬШЕ НЕ УГАДЫВАЕМ ПО ПИКСЕЛЯМ (09.08). Раньше тип брался из второго кадра
// («светлый фон и низкая насыщенность значит карточка»), и светлый чёрно-белый арт уходил в
// карточки, а тёмная карточка в арт. Тип берём из контракта templates.cjs, а пиксели оставили
// вторым независимым признаком: если они расходятся с контрактом, печатаем это отдельной строкой.
//
// Ничего не удаляем: только помечаем в базе и печатаем список, решение за начальником.
// Запуск: node framesaudit.cjs [сколько]     MARK=1 — записать метки в базу
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('ffmpeg-static');
const { hashImage, hamming } = require('./coverguard.cjs');
const { fetchToFile } = require('./watchdog.cjs');
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
const MARK = /^(1|true|yes)$/i.test(String(process.env.MARK || ''));
const TMP = '/tmp/fa';

function stats(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-vf', 'format=yuv420p,signalstats,metadata=print', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  const t = String(r.stderr || '');
  const num = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    y: num(/YAVG:\s*([\d.]+)/),          // яркость 0-255
    uDev: num(/UAVG:\s*([\d.]+)/),
    vDev: num(/VAVG:\s*([\d.]+)/),
    sat: (() => { const u = num(/UAVG:\s*([\d.]+)/), v = num(/VAVG:\s*([\d.]+)/); return u === null || v === null ? null : Math.hypot(u - 128, v - 128); })(),
  };
}
// Центральная зона третьего кадра: там экран телефона на всех наших мокапах.
function centerHash(file, tag) {
  const out = path.join(TMP, `c_${tag}.jpg`);
  spawnSync(FF, ['-y', '-i', file, '-vf', 'crop=iw*0.44:ih*0.5:iw*0.28:ih*0.22,scale=256:-2', '-frames:v', '1', out], { stdio: 'ignore' });
  return fs.existsSync(out) ? hashImage(out) : null;
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls
      FROM posts
     WHERE status IN ('backlog','approved') AND published_at IS NULL
       AND jsonb_array_length(meta->'image_urls') >= 3
     ORDER BY created_at DESC`)).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`постов к проверке: ${work.length}\n`);

  const bad = [], ok = [];
  for (const [i, p] of work.entries()) {
    const short = String(p.id).slice(0, 8);
    try {
      const f2 = await fetchToFile(p.urls[1], path.join(TMP, `${short}_2.jpg`), { what: 'кадр 2', ms: 60000, min: 5000 });
      const f3 = await fetchToFile(p.urls[2], path.join(TMP, `${short}_3.jpg`), { what: 'кадр 3', ms: 60000, min: 5000 });
      const s2 = stats(f2);
      const h2 = hashImage(f2), hc = centerHash(f3, short);
      const dist = h2 && hc ? hamming(h2, hc) : 99;
      // ТИП ПОСТА БЕРЁМ ИЗ КОНТРАКТА (09.08). Раньше он угадывался ПО ПИКСЕЛЯМ второго кадра
      // («светлый фон и почти нет цвета значит карточка»), и любой светлый чёрно-белый АРТ
      // читался как карточка, а тёмная карточка как арт. Пиксели остались, но уже не решают:
      // они второй независимый признак и годятся только на то, чтобы заметить расхождение.
      const isCard = TPL.isCard(p.tpl);
      const pixelCard = s2.y !== null && s2.y > 150 && s2.sat !== null && s2.sat < 12;
      // Брак экрана ищем ТОЛЬКО там, где телефон вообще положен (у тренда с волосами): у остальных
      // шаблонов третий кадр это отдельный образ, и расхождение с артом там норма, а не дефект.
      const screenBad = TPL.phoneOk(p.tpl) && dist > 34;
      const row = { пост: short, персона: p.pn, шаблон: p.tpl, тип: TPL.kindRu(p.tpl), расхождение: dist };
      if (pixelCard !== isCard) {
        row.пиксели = pixelCard ? 'похоже на карточку' : 'похоже на фото';
        console.log(`  ℹ ${short} (${p.tpl}): контракт говорит «${TPL.kindRu(p.tpl)}», а кадр 2 по пикселям ${row.пиксели}`);
      }
      (screenBad ? bad : ok).push(row);
      if (screenBad) console.log(`  ⚠ ${short} ${p.pn} (${p.tpl}): экран телефона не совпадает с артом, расхождение ${dist} бит`);
      if ((i + 1) % 10 === 0) console.log(`  … проверено ${i + 1} из ${work.length}`);
    } catch (e) {
      console.log(`  ✗ ${short}: ${String(e.message).slice(0, 70)}`);
    }
  }
  if (MARK && bad.length) {
    await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('frame3_defect', true, 'frame3_checked_at', to_jsonb(now()))
                    WHERE left(id::text,8) = ANY($1)`, [bad.map((b) => b.пост)]);
    console.log(`\nпометил в базе как брак: ${bad.length}`);
  }
  await c.end().catch(() => {});
  console.log(`\nИТОГ: подозрительных ${bad.length}, чистых ${ok.length}`);
  if (bad.length) console.table(bad);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
