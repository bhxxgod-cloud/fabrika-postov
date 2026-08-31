'use strict';
// ТЕСТ: ВСЕ ЧЕТЫРЕ КАДРА РОЖДАЮТСЯ В 9:16, ТЕКСТ НАНОСИМ ЗАНОВО (приказ 11.08).
//
// ПОЧЕМУ ТАК, А НЕ ПРИВЕДЕНИЕМ ГОТОВЫХ КАДРОВ. Готовый кадр 4:5 нельзя ни обрезать (срежет текст),
// ни зеркалить (текст встаёт вверх ногами), ни вписать (появляются поля). Значит берём ЧИСТЫЕ
// исходники без надписей, заливаем ими экран целиком, а хук и финальную плашку рисуем СВОЕЙ
// вёрсткой уже по кадру 1080x1920: тогда текст всегда внутри безопасной зоны и режется нечему.
//
// КАРТОЧКА ФАБРИКИ это исключение: она документ 1080x1440, текст идёт от края до края. Её кладём
// целиком, а недостающие полосы заливаем ЕЁ ЖЕ цветом края (карточка светлая и ровная), так что
// стыка не видно и кадр читается как одна карточка, а не как фото в рамке.
//
// Запуск: node reeltest916.cjs [id поста]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('ffmpeg-static');
const TT = require('./ttkit.cjs');

const W = 1080, H = 1920;
const БАЗА = '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/reel916';

/** Цвет края картинки: одна усреднённая точка с самой кромки. */
function цветКрая(src) {
  const r = spawnSync(FF, ['-hide_banner', '-i', src, '-vf', 'crop=iw:6:0:0,scale=1:1',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
  const b = r.stdout;
  if (b && b.length >= 3) return `0x${[b[0], b[1], b[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return '0xf2f0ea';
}

/** Карточка целиком, полосы её же цветом края. */
function карточка916(src, out) {
  const цвет = цветКрая(src);
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', src, '-vf',
    `scale=${W}:-2,pad=${W}:${H}:0:(oh-ih)/2:color=${цвет}`, '-q:v', '2', out]);
  return { out, цвет };
}

(async () => {
  fs.rmSync(БАЗА, { recursive: true, force: true });
  fs.mkdirSync(БАЗА, { recursive: true });
  const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
    ssl: { rejectUnauthorized: false } });
  await c.connect();
  const где = process.argv[2] ? `id = '${process.argv[2]}'` : `meta->>'frame4_raw' IS NOT NULL AND meta->>'source_cover_url' IS NOT NULL`;
  const r = await c.query(
    `SELECT id, meta->>'persona' p, meta->>'hook_text' hook, meta->'image_urls' urls,
            meta->>'source_cover_url' cover_raw, meta->>'frame4_raw' f4raw, caption
       FROM posts WHERE ${где} AND status IN ('backlog','approved') AND published_at IS NULL
      ORDER BY created_at DESC LIMIT 1`);
  await c.end();
  if (!r.rows.length) throw new Error('подходящий пост не нашёлся: нужны чистые исходники кадров 1 и 4');
  const п = r.rows[0];
  console.log(`пост ${п.id} (${п.p}), хук: ${String(п.hook || '').replace(/\n/g, ' / ')}`);

  const качать = (url, имя) => {
    const f = path.join(БАЗА, имя);
    execFileSync('curl', ['-s', '-m', '60', '-o', f, url]);
    if (!fs.existsSync(f) || fs.statSync(f).size < 15000) throw new Error(`не скачался ${имя}`);
    return f;
  };

  const чистая1 = качать(п.cover_raw, 'raw1.jpg');
  const карта = качать(п.urls[1], 'card.jpg');
  const фото3 = качать(п.urls[2], 'raw3.jpg');
  const чистая4 = качать(п.f4raw, 'raw4.jpg');

  const k1 = path.join(БАЗА, 'f1.jpg');
  await TT.hookSlideTT(чистая1, k1, String(п.hook || '').replace(/\\n/g, '\n'), { fill: true });
  console.log('  кадр 1: залит на весь экран, хук нанесён заново');

  const k2 = path.join(БАЗА, 'f2.jpg');
  const инфо2 = карточка916(карта, k2);
  console.log(`  кадр 2: карточка целиком, полосы её цветом ${инфо2.цвет}`);

  const k3 = path.join(БАЗА, 'f3.jpg');
  TT.to916(фото3, k3, { fill: true });
  console.log('  кадр 3: залит на весь экран');

  const k4 = path.join(БАЗА, 'f4.jpg');
  await TT.ctaSlideTT(чистая4, k4, { platform: 'reels', cover: чистая1, fill: true });
  console.log('  кадр 4: залит на весь экран, плашка нанесена заново');

  // Склейка с музыкой: 3 секунды на кадр.
  const кадры = [k1, k2, k3, k4];
  const аудио = fs.existsSync('audio') ? fs.readdirSync('audio').filter((f) => /\.(mp3|m4a|wav)$/i.test(f)) : [];
  const args = ['-y', '-loglevel', 'error'];
  кадры.forEach((f) => args.push('-loop', '1', '-t', '3', '-i', f));
  if (аудио.length) args.push('-stream_loop', '-1', '-ss', '60', '-i', path.join('audio', аудио[0]));
  const fc = кадры.map((_, i) => `[${i}:v]fps=30,setsar=1[v${i}]`).join(';') + ';'
    + кадры.map((_, i) => `[v${i}]`).join('') + `concat=n=${кадры.length}:v=1:a=0[v]`;
  const out = path.join(БАЗА, 'test916.mp4');
  args.push('-filter_complex', fc, '-map', '[v]');
  if (аудио.length) args.push('-map', `${кадры.length}:a`, '-af', 'loudnorm=I=-14:TP=-1.5,afade=t=out:st=11:d=1', '-ac', '2');
  args.push('-t', String(кадры.length * 3), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', out);
  execFileSync(FF, args);
  console.log(`\nготово: ${out}`);
})().catch((e) => { console.error('ОШИБКА', e.message); process.exit(1); });
