'use strict';
// ПУЛ АВАТАРОК ДЛЯ magos ИЗ НАШИХ ЖЕ ЧИСТЫХ ИСХОДНИКОВ (приказ 11.08).
//
// ЗАЧЕМ. Магос ставит аватарку каждому акку из ZIP-пула, по одной штуке. Брать аву со стороны
// нельзя: чужое лицо не совпадёт с постами акка. Берём ИСХОДНИК КАДРА 1 того же склада постов
// (meta.source_cover_url) — это фотография БЕЗ НАДПИСЕЙ, из которой конвейер делал обложку.
// Надписи на аватарке недопустимы: аватарка мелкая, текст читается как мусор.
//
// ЧТО ДЕЛАЕМ С КАДРОМ. Инстаграм показывает аву кругом, поэтому режем КВАДРАТ по лицу: центр
// квадрата ставим по рамке лица (ttkit.faceBox), сторона в 3.2 высоты лица, но не больше меньшей
// стороны кадра. Если лицо не нашлось, берём центральный квадрат.
//
// Запуск: node avapack.cjs [сколько] [куда]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('ffmpeg-static');
const TT = require('./ttkit.cjs');

const СКОЛЬКО = Number(process.argv[2] || 162);
const КУДА = process.argv[3] || '/tmp/avapack';
const СТОРОНА = 1080;

/** Квадрат по лицу. */
function квадрат(src, out) {
  const fb = TT.faceBox(src);
  const sz = TT.probeSize(src) || { w: 1080, h: 1350 };
  let side = Math.min(sz.w, sz.h);
  let cx = sz.w / 2, cy = sz.h / 2;
  if (fb && fb.face) {
    side = Math.min(side, Math.round(fb.face.h * 3.2));
    cx = fb.face.x + fb.face.w / 2;
    cy = fb.face.y + fb.face.h * 0.55;
  }
  side = Math.max(320, Math.round(side / 2) * 2);
  const x = Math.min(Math.max(0, Math.round(cx - side / 2)), Math.max(0, sz.w - side));
  const y = Math.min(Math.max(0, Math.round(cy - side / 2)), Math.max(0, sz.h - side));
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', src, '-vf',
    `crop=${side}:${side}:${x}:${y},scale=${СТОРОНА}:${СТОРОНА}`, '-q:v', '2', out]);
  return { лицо: !!(fb && fb.face), сторона: side };
}

(async () => {
  fs.rmSync(КУДА, { recursive: true, force: true });
  fs.mkdirSync(КУДА, { recursive: true });
  const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
    ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Берём РАЗНЫЕ персоны и только чистые исходники: одна ава на акк, повторов между акками быть
  // не должно, иначе ферма видна с профиля.
  const r = await c.query(
    `SELECT DISTINCT ON (meta->>'persona') meta->>'persona' p, meta->>'source_cover_url' src
       FROM posts
      WHERE meta->>'source_cover_url' IS NOT NULL
      ORDER BY meta->>'persona', created_at DESC
      LIMIT $1`, [СКОЛЬКО]);
  await c.end();
  console.log(`исходников найдено: ${r.rows.length}`);

  let готово = 0, слицом = 0;
  for (const п of r.rows) {
    const сыр = path.join(КУДА, `src_${готово}.jpg`);
    try {
      execFileSync('curl', ['-s', '-m', '40', '-o', сыр, п.src]);
      if (!fs.existsSync(сыр) || fs.statSync(сыр).size < 15000) throw new Error('не скачался');
      const out = path.join(КУДА, `ava_${String(готово + 1).padStart(3, '0')}_${п.p}.jpg`);
      const и = квадрат(сыр, out);
      if (и.лицо) слицом++;
      готово++;
      if (готово % 20 === 0) console.log(`  ...${готово}`);
    } catch (e) {
      console.log(`  ✗ ${п.p}: ${String(e.message).slice(0, 60)}`);
    } finally { try { fs.unlinkSync(сыр); } catch {} }
  }
  const zip = path.join(КУДА, 'avatars.zip');
  const файлы = fs.readdirSync(КУДА).filter((f) => f.startsWith('ava_'));
  execFileSync('zip', ['-q', '-j', zip, ...файлы.map((f) => path.join(КУДА, f))]);
  console.log(`\nИТОГ: аватарок ${готово} (лицо найдено у ${слицом}), архив ${zip} `
    + `(${Math.round(fs.statSync(zip).size / 1024)} КБ)`);
})().catch((e) => { console.error('ОШИБКА', e.message); process.exit(1); });
