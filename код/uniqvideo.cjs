// УНИКАЛИЗАЦИЯ ГОТОВОГО ВИДЕО ПЕРЕД ПОВТОРНОЙ ЗАЛИВКОЙ (09.08).
//
// ЗАЧЕМ. Начальник отдал 22 своих рилса, которые УЖЕ публиковались. Если залить их как есть,
// Instagram узнает файл по отпечатку и либо срежет охват, либо не покажет вовсе, а на новых
// аккаунтах повтор чужой публикации это прямой повод для ограничения.
//
// ЧТО МЕНЯЕМ (каждый пункт бьёт по своему отпечатку, вместе дают другой файл):
//   • обрезка краёв по времени: начало и конец на доли секунды, сдвигает хэш кадров;
//   • зум 2-4 процента и микроповорот: меняет геометрию, для глаза незаметно;
//   • скорость 0,97-1,03: ломает покадровое совпадение и длину;
//   • ЗВУК заменяем нашим треком со своего отрывка: аудио-отпечаток самый чувствительный;
//   • новая сетка кадров, битрейт и полная очистка метаданных.
// Всё считается от номера файла, поэтому один и тот же вход всегда даёт один и тот же выход.
//
// Запуск: node uniqvideo.cjs <папка-с-видео> [папка-результата]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const SRC = process.argv[2];
const OUT = process.argv[3] || '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/uniq_out';
const AUDIO_DIR = path.join(__dirname, 'audio');

function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function probe(args) { return String(spawnSync(FF, args, { encoding: 'utf8' }).stderr || ''); }
function durationOf(f) {
  const m = probe(['-hide_banner', '-i', f]).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}
// Отрывок трека: самое громкое окно нужной длины, кэш рядом с треком (как в reelbuild).
function loudStart(track, need) {
  const cache = track + '.uniq' + need;
  try { const c = JSON.parse(fs.readFileSync(cache, 'utf8')); if (typeof c.start === 'number') return c.start; } catch {}
  const dur = durationOf(track);
  if (!dur || dur < need + 4) return 0;
  let best = { t: 0, db: -999 };
  for (let t = 0; t + need <= dur - 1; t += Math.max(4, Math.round(need / 2))) {
    const o = probe(['-hide_banner', '-ss', String(t), '-t', String(need), '-i', track, '-af', 'volumedetect', '-f', 'null', '-']);
    const m = o.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    if (m && parseFloat(m[1]) > best.db) best = { t: Math.round(t), db: parseFloat(m[1]) };
  }
  try { fs.writeFileSync(cache, JSON.stringify(best)); } catch {}
  return best.t;
}

(async () => {
  if (!SRC || !fs.existsSync(SRC)) { console.log('usage: node uniqvideo.cjs <папка> [результат]'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const tracks = fs.readdirSync(AUDIO_DIR).filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f)).sort();
  if (!tracks.length) { console.log('в audio/ нет треков, звук заменить нечем'); process.exit(1); }

  const files = fs.readdirSync(SRC).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).sort();
  console.log(`видео на входе: ${files.length}, треков в пуле: ${tracks.length}\n`);
  let ok = 0, bad = 0;
  for (const [i, f] of files.entries()) {
    const src = path.join(SRC, f);
    const seed = f + ':' + i;
    const dur = durationOf(src);
    if (!dur) { console.log(`  ✗ ${f}: длину не прочитал`); bad++; continue; }
    // Обрезка краёв и скорость: и то и другое меняет длину, поэтому считаем итог заранее.
    const cutHead = 0.2 + (hash('a' + seed) % 5) / 10;   // 0,2-0,6 сек
    const cutTail = 0.2 + (hash('b' + seed) % 4) / 10;   // 0,2-0,5 сек
    const speed = 1 + ((hash('c' + seed) % 7) - 3) / 100; // 0,97-1,03
    const zoom = 1.02 + (hash('d' + seed) % 3) / 100;     // 1,02-1,04
    const rot = ((hash('e' + seed) % 5) - 2) * 0.25;      // -0,5 до +0,5 градуса
    const body = Math.max(4, dur - cutHead - cutTail);
    const outDur = body / speed;
    const track = path.join(AUDIO_DIR, tracks[hash('t' + seed) % tracks.length]);
    const aStart = Math.max(0, loudStart(track, Math.ceil(outDur)) - 1 + ((hash('j' + seed) % 5) - 2));
    const out = path.join(OUT, `u_${String(i + 1).padStart(2, '0')}_${f.replace(/\.(mov|m4v)$/i, '.mp4')}`);

    const vf = [
      `scale=iw*${zoom}:ih*${zoom}`,
      rot ? `rotate=${(rot * Math.PI / 180).toFixed(5)}:fillcolor=black@0` : null,
      `crop=1080:1920`,
      `setpts=PTS/${speed.toFixed(3)}`,
      `fps=30`,
    ].filter(Boolean).join(',');

    const args = ['-y', '-ss', String(cutHead.toFixed(2)), '-t', String(body.toFixed(2)), '-i', src,
      '-stream_loop', '-1', '-ss', String(aStart), '-i', track,
      '-filter_complex', `[0:v]${vf}[v];[1:a]atrim=0:${outDur.toFixed(2)},asetpts=N/SR/TB,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0, outDur - 0.8).toFixed(2)}:d=0.8,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-crf', String(23 + (hash('q' + seed) % 3)), '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-map_metadata', '-1', '-movflags', '+faststart',
      '-t', outDur.toFixed(2), out];
    const r = spawnSync(FF, args, { encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(out)) {
      console.log(`  ✗ ${f}: ${String(r.stderr || '').slice(-160)}`);
      bad++; continue;
    }
    const mb = (fs.statSync(out).size / 1048576).toFixed(1);
    console.log(`  ✅ ${f} → ${path.basename(out)} (${mb} МБ, ${outDur.toFixed(1)} сек, зум ${zoom.toFixed(2)}, скорость ${speed.toFixed(2)}, трек ${path.basename(track)} с ${aStart} сек)`);
    ok++;
  }
  console.log(`\nИТОГ: уникализировано ${ok}, ошибок ${bad}, папка ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
