// УНИКАЛИЗАЦИЯ ЛИЧНЫХ ВИДЕО НАЧАЛЬНИКА БЕЗ ПОРЧИ КАРТИНКИ (09.08).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ uniqvideo.cjs. Тот скрипт гнал всё в 1080x1920 и жал crf 23, поэтому
// вертикальные и квадратные видео начальника резались по краям и шакалились («ты его сжал
// физически разрешение и пропорции»). Приказ: прогнать уникализатором, НЕ трогая размеры.
//
// ПРАВИЛА ЭТОГО СКРИПТА:
//   • разрешение и пропорции остаются РОДНЫЕ (читаем у файла и возвращаем ровно их);
//   • звук остаётся СВОЙ, ничего не накладываем (отдельный приказ начальника);
//   • качество высокое: crf 18 и preset slow, файл может стать даже больше исходного, это нормально.
//
// ЧТО ЛОМАЕТ ОТПЕЧАТОК (глазу незаметно, поиску по совпадению достаточно):
//   • обрезка краёв по времени: доли секунды с начала и с конца;
//   • микрозум: срезаем 2-3 процента по краям и растягиваем обратно в РОДНОЙ размер;
//   • скорость 0,97-1,03 с той же поправкой на звук через atempo, поэтому губы не расходятся;
//   • новая сетка кадров и битрейт, полная очистка метаданных.
// Всё считается от имени файла, один вход всегда даёт один и тот же выход.
//
// Запуск: node uniqmine.cjs <папка-с-видео> [папка-результата]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const SRC = process.argv[2];
const OUT = process.argv[3] || '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/uniq_mine';

function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function probe(file) {
  const t = String(spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '');
  const d = t.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  // Берём размер из строки видеопотока, отсекая служебные цифры вроде «SAR 1:1 DAR 9:16».
  const s = t.match(/Video:.*?[\s,](\d{2,5})x(\d{2,5})[\s,]/);
  const fps = t.match(/([\d.]+) fps/);
  const rot = t.match(/rotation of (-?[\d.]+)/);
  return {
    dur: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0,
    w: s ? +s[1] : 0,
    h: s ? +s[2] : 0,
    fps: fps ? Math.min(60, Math.round(parseFloat(fps[1]))) : 30,
    rotated: rot ? Math.abs(parseFloat(rot[1])) % 180 === 90 : false,
    hasAudio: /Audio:/.test(t),
  };
}

(async () => {
  if (!SRC || !fs.existsSync(SRC)) { console.log('usage: node uniqmine.cjs <папка> [результат]'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(SRC).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).sort();
  console.log(`видео на входе: ${files.length}, размеры не трогаем, звук родной\n`);

  let ok = 0, bad = 0;
  for (const [i, f] of files.entries()) {
    const src = path.join(SRC, f);
    const seed = f + ':' + i;
    const m = probe(src);
    if (!m.dur || !m.w) { console.log(`  ✗ ${f}: не прочитал параметры`); bad++; continue; }
    // У съёмки с телефона размеры в потоке лежат до поворота: ffmpeg развернёт кадр сам, и тогда
    // родной размер это перевёрнутая пара. Иначе микрозум вернул бы видео в другой ориентации.
    const W = m.rotated ? m.h : m.w;
    const H = m.rotated ? m.w : m.h;

    const cutHead = 0.2 + (hash('a' + seed) % 5) / 10;    // 0,2-0,6 сек
    const cutTail = 0.2 + (hash('b' + seed) % 4) / 10;    // 0,2-0,5 сек
    const speed = 1 + ((hash('c' + seed) % 7) - 3) / 100;  // 0,97-1,03
    const keep = 1 - (2 + (hash('d' + seed) % 2)) / 100;   // оставляем 97-98 процентов кадра
    const body = Math.max(2, m.dur - cutHead - cutTail);
    const outDur = body / speed;
    const out = path.join(OUT, `u_${String(i + 1).padStart(2, '0')}_${f.replace(/\.(mov|m4v|MOV|M4V)$/i, '.mp4')}`);

    // Микрозум: crop чуть внутрь и обратно в РОДНОЙ размер. Чётные числа обязательны для yuv420p.
    const cw = Math.round(W * keep / 2) * 2;
    const ch = Math.round(H * keep / 2) * 2;
    const vf = [
      `crop=${cw}:${ch}:(iw-${cw})/2:(ih-${ch})/2`,
      `scale=${W}:${H}:flags=lanczos`,
      `setpts=PTS/${speed.toFixed(3)}`,
      `fps=${m.fps}`,
    ].join(',');

    const args = ['-y', '-ss', cutHead.toFixed(2), '-t', body.toFixed(2), '-i', src, '-vf', vf];
    if (m.hasAudio) {
      // atempo тянет звук ровно так же, как setpts тянет картинку, поэтому синхрон сохраняется.
      args.push('-af', `atempo=${speed.toFixed(3)}`, '-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-an');
    }
    args.push('-c:v', 'libx264', '-crf', String(18 + (hash('q' + seed) % 2)), '-preset', 'slow',
      '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-movflags', '+faststart', out);

    const r = spawnSync(FF, args, { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 10000) {
      console.log(`  ✗ ${f}: ${String(r.stderr || '').slice(-200)}`);
      bad++; continue;
    }
    const g = probe(out);
    const sizeOk = g.w === W && g.h === H;
    console.log(`  ${sizeOk ? '✅' : '⚠'} ${f} → ${path.basename(out)} | ${g.w}x${g.h} (было ${W}x${H}) | ${(fs.statSync(out).size / 1048576).toFixed(1)} МБ | ${outDur.toFixed(1)} сек | зум ${((1 / keep - 1) * 100).toFixed(0)}% | скорость ${speed.toFixed(2)} | звук ${m.hasAudio ? 'свой' : 'нет'}`);
    ok++;
  }
  console.log(`\nИТОГ: уникализировано ${ok}, ошибок ${bad}, папка ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
