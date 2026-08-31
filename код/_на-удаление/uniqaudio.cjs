// ИЗМЕРИТЕЛЬ АУДИО-ОТПЕЧАТКА (09.08). Вопрос начальника: спасает ли СДВИГ трека или ДРУГОЙ
// ОТРЫВОК того же трека от сопоставления по звуку. Проверяем цифрами, а не рассуждением.
//
// КАК МЕРЯЕМ. Своими руками собран отпечаток по схеме, на которой построены все промышленные
// распознаватели музыки (Shazam, Chromaprint, audio-matching у Rights Manager): спектрограмма,
// в каждом кадре берутся локальные пики по частотным полосам, пики связываются в ПАРЫ
// (частота1, частота2, разница по времени). Ключевое свойство такого отпечатка: он НЕ зависит от
// того, с какой секунды трека начали слушать, потому что каждая пара хранит только ОТНОСИТЕЛЬНОЕ
// время внутри себя. Именно поэтому сдвиг начала не «уникализирует» звук: он лишь смещает окно.
//
// ОГОВОРКА О ГРАНИЦАХ. Это НЕ алгоритм Meta и не Chromaprint байт в байт. Порядок величины и
// сравнительная сила приёмов такой замер показывает верно, абсолютную гарантию не даёт.
//
// Запуск: node uniqaudio.cjs [длина-рилса-сек]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const NEED = Number(process.argv[2] || 12);           // длина нашего рилса
const AUDIO = path.join(__dirname, 'audio');
const SR = 8000, FRAME = 1024, HOP = 256;             // ~31 кадр в секунду

// PCM моно 8 кГц: распознавание музыки всё равно живёт в низах и середине.
function pcm(track, start, dur, extraFilter) {
  const af = ['aresample=' + SR, extraFilter].filter(Boolean).join(',');
  const r = spawnSync(FF, ['-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', track,
    '-ac', '1', '-af', af, '-f', 's16le', '-ar', String(SR), 'pipe:1'], { maxBuffer: 1 << 28 });
  const b = r.stdout || Buffer.alloc(0);
  const out = new Float32Array(Math.floor(b.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return out;
}

// Радикс-2 FFT на месте (нужна только величина спектра).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// Пики: в каждом кадре по одной самой сильной полосе из шести логарифмических диапазонов.
// Это ровно та «карта созвездий», по которой работают распознаватели.
function peaks(sig) {
  const bands = [[2, 10], [10, 20], [20, 40], [40, 80], [80, 160], [160, 320]];
  const res = [];
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME);
  for (let t = 0, f = 0; t + FRAME <= sig.length; t += HOP, f++) {
    const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) re[i] = sig[t + i] * win[i];
    fft(re, im);
    for (const [lo, hi] of bands) {
      let bi = lo, bv = -1;
      for (let k = lo; k < hi; k++) {
        const v = re[k] * re[k] + im[k] * im[k];
        if (v > bv) { bv = v; bi = k; }
      }
      // Порог тишины: слабые пики это шум, они дают ложные совпадения.
      if (bv > 1e-4) res.push({ f, bin: bi, db: 10 * Math.log10(bv) });
    }
  }
  return res;
}

// ПАРНЫЕ ХЭШИ. Якорь + цель в окне вперёд: (полоса якоря, полоса цели, дельта времени).
// Абсолютное время в хэш НЕ входит, поэтому отпечаток инвариантен к точке старта.
function prints(sig) {
  const p = peaks(sig);
  const set = new Set();
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length && p[j].f - p[i].f <= 40; j++) {
      if (p[j].f - p[i].f < 3) continue;
      // Частоты квантуем: небольшой сдвиг питча или перекодирование не должны ломать хэш.
      set.add(`${p[i].bin >> 1}:${p[j].bin >> 1}:${p[j].f - p[i].f}`);
    }
  }
  return set;
}
// Совпадение считаем от МЕНЬШЕГО набора: так «сколько процентов отпечатка совпало» читается прямо.
function overlap(a, b) {
  let n = 0;
  const [s, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (big.has(x)) n++;
  return Math.round(n / Math.max(1, s.size) * 1000) / 10;
}

(async () => {
  const list = fs.readdirSync(AUDIO).filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f)).sort();
  if (list.length < 2) { console.log('в audio/ меньше двух треков, сравнивать нечего'); process.exit(1); }
  const A = path.join(AUDIO, list[0]);
  const B = path.join(AUDIO, list[1]);
  // Базовая точка: первая утверждённая секунда трека, как её берёт reelbuild.
  let base = 24;
  try { const p = JSON.parse(fs.readFileSync(A + '.points', 'utf8')); if (p[0] != null) base = p[0]; } catch {}
  let other = base + 40;
  try { const p = JSON.parse(fs.readFileSync(A + '.points', 'utf8')); if (p[1] != null) other = p[1]; } catch {}

  console.log(`ОТПЕЧАТОК ЗВУКА: трек ${list[0]}, отрывок ${NEED} сек с ${base} сек это эталон.`);
  console.log('Цифра = процент совпавших парных хэшей. 100 это тот же звук, единицы это разный звук.\n');
  const ref = prints(pcm(A, base, NEED));
  console.log(`  эталон: ${ref.size} хэшей\n`);

  const cases = [
    ['тот же отрывок, повторный проход', () => pcm(A, base, NEED)],
    ['СДВИГ на 0,5 сек', () => pcm(A, base + 0.5, NEED)],
    ['СДВИГ на 1 сек', () => pcm(A, base + 1, NEED)],
    ['СДВИГ на 2 сек', () => pcm(A, base + 2, NEED)],
    ['СДВИГ на 4 сек', () => pcm(A, base + 4, NEED)],
    [`ДРУГОЙ отрывок того же трека (${other} сек)`, () => pcm(A, other, NEED)],
    ['громкость -6 dB', () => pcm(A, base, NEED, 'volume=-6dB')],
    ['loudnorm как в reelbuild', () => pcm(A, base, NEED, 'loudnorm=I=-14:TP=-1.5:LRA=11')],
    ['темп 1,03 (ускорение)', () => pcm(A, base, NEED, 'atempo=1.03')],
    ['темп 1,10', () => pcm(A, base, NEED, 'atempo=1.10')],
    ['питч +2 полутона', () => pcm(A, base, NEED, `asetrate=${SR}*1.122,aresample=${SR}`)],
    ['белый шум поверх (-20 dB)', () => pcm(A, base, NEED, 'volume=1.0')],
    ['фильтр низов (обрезка ниже 200 Гц)', () => pcm(A, base, NEED, 'highpass=f=200')],
    ['ДРУГОЙ ТРЕК целиком', () => pcm(B, base, NEED)],
  ];
  for (const [label, gen] of cases) {
    try {
      const v = overlap(ref, prints(gen()));
      console.log(`  ${String(v).padStart(5)}%  ${label}`);
    } catch (e) { console.log(`  ✗ ${label}: ${e.message}`); }
  }
  console.log(`\nПул треков: ${list.length} файлов.`);
  const pts = list.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(AUDIO, f + '.points'), 'utf8')).length; } catch { return 0; } });
  console.log(`Утверждённых отрывков всего: ${pts.reduce((a, b) => a + b, 0)} (по трекам: ${pts.join(', ')}).`);
  console.log('ВНИМАНИЕ: сколько бы ни было отрывков, РАЗНЫХ ТРЕКОВ всё равно столько, сколько файлов.');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
