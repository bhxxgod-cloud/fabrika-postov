'use strict';
// ТЕСТ: ЧЕТЫРЕ КАДРА ЦЕЛИКОМ, ЭКРАН ЗАПОЛНЕН, НИЧЕГО НЕ ОБРЕЗАНО (приказ 11.08).
//
// Задача геометрии. Кадр приходит 1080x1440, экран рилса 1080x1920. Залить экран обрезкой значит
// срезать текст у карточки и у финальной плашки. Значит идём другим путём: картинку НЕ трогаем
// вовсе, ставим её целиком по центру, а недостающие полосы сверху и снизу достраиваем ЗЕРКАЛЬНЫМ
// ПРОДОЛЖЕНИЕМ самой картинки. Сцена продолжается за край, поля не читаются как рамка, и при этом
// не потеряно ни одного пикселя исходника.
//
// Запуск: node reeltest_mirror.cjs [id поста]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('ffmpeg-static');

const W = 1080, H = 1920;
const БАЗА = '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/reeltest';

/** Кадр целиком по центру, полосы сверху и снизу это зеркало самой картинки. */
function зеркальный(src, out) {
  const fc = [
    `[0:v]scale=${W}:-2[img]`,
    `[img]split=3[a][b][c]`,
    `[b]crop=${W}:in_h/3:0:0,vflip,scale=${W}:${H}[topbig]`,
    `[c]crop=${W}:in_h/3:0:in_h-in_h/3,vflip,scale=${W}:${H}[botbig]`,
    `[topbig][botbig]vstack=2,scale=${W}:${H}[bgfull]`,
    `[bgfull][a]overlay=0:(H-h)/2,setsar=1[v]`,
  ].join(';');
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', src, '-filter_complex', fc, '-map', '[v]', '-q:v', '2', out]);
  return out;
}

(async () => {
  fs.rmSync(БАЗА, { recursive: true, force: true });
  fs.mkdirSync(БАЗА, { recursive: true });
  const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(),
    ssl: { rejectUnauthorized: false } });
  await c.connect();
  const где = process.argv[2] ? `id = '${process.argv[2]}'` : `1=1`;
  const r = await c.query(
    `SELECT id, meta->>'persona' p, meta->'image_urls' urls, caption
       FROM posts WHERE ${где} AND status IN ('backlog','approved') AND published_at IS NULL
        AND jsonb_array_length(meta->'image_urls') = 4
      ORDER BY created_at DESC LIMIT 1`);
  await c.end();
  if (!r.rows.length) throw new Error('пост не нашёлся');
  const п = r.rows[0];
  console.log(`пост ${п.id} (${п.p})`);

  const кадры = [];
  п.urls.forEach((u, i) => {
    const сыр = path.join(БАЗА, `src${i}.jpg`);
    execFileSync('curl', ['-s', '-m', '40', '-o', сыр, u]);
    const гот = path.join(БАЗА, `f${i}.jpg`);
    зеркальный(сыр, гот);
    кадры.push(гот);
    console.log(`  кадр ${i + 1}: целиком, зеркальные полосы`);
  });

  // Склейка: по 3 секунды на кадр, звук берём первым треком из audio/.
  const аудио = fs.existsSync('audio') ? fs.readdirSync('audio').filter((f) => /\.(mp3|m4a|wav)$/i.test(f)) : [];
  const args = ['-y', '-loglevel', 'error'];
  кадры.forEach((f) => args.push('-loop', '1', '-t', '3', '-i', f));
  if (аудио.length) args.push('-stream_loop', '-1', '-ss', '60', '-i', path.join('audio', аудио[0]));
  const fc = кадры.map((_, i) => `[${i}:v]fps=30,setsar=1[v${i}]`).join(';')
    + ';' + кадры.map((_, i) => `[v${i}]`).join('') + `concat=n=${кадры.length}:v=1:a=0[v]`;
  const out = path.join(БАЗА, 'test_mirror.mp4');
  args.push('-filter_complex', fc, '-map', '[v]');
  if (аудио.length) args.push('-map', `${кадры.length}:a`, '-af', 'loudnorm=I=-14:TP=-1.5,afade=t=out:st=11:d=1', '-ac', '2');
  args.push('-t', String(кадры.length * 3), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium',
    '-crf', '20', '-c:a', 'aac', '-b:a', '128k', out);
  execFileSync(FF, args);
  console.log(`\nготово: ${out}`);
})().catch((e) => { console.error('ОШИБКА', e.message); process.exit(1); });
