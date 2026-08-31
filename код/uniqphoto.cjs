// УНИКАЛИЗАТОР ФОТО (карусели фотопостов).
// Зачем отдельно от видео: фотопост из фабрики — это 3 готовые картинки, одинаковые для всех наших
// аккаунтов. Если выложить их как есть на 4 акка одной модели, Instagram склеит и посты (по хэшу
// изображения), и сами аккаунты в сетку — ровно та же беда, что была с одинаковыми роликами.
//
// Что меняем (всё незаметно глазу, но ломает хэш):
//   • микро-кроп краёв 0.5–2% и возврат к исходному размеру — сдвигает всю сетку пикселей;
//   • поворот на 0.2–0.8° с кропом под рамку — ломает попиксельное совпадение;
//   • ±яркость/контраст/насыщенность/оттенок в пределах, не портящих картинку;
//   • слабый шум;
//   • перекодирование JPEG со «своим» качеством 88–95 и полной зачисткой метаданных.
// Сид — от аккаунта, поэтому у каждой девочки СВОЙ стабильный вариант, а повторный прогон
// не плодит новые версии.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { rng, seedFrom } = require('./uniq.cjs');

function buildPhotoArgs({ seed, inPath, outPath }) {
  const r = rng(seed);
  const cropPct = 0.005 + r() * 0.015;          // 0.5–2% с каждой стороны
  const angle = (r() - 0.5) * 1.6;              // ±0.8°
  const bright = (r() - 0.5) * 0.06;
  const contrast = 0.98 + r() * 0.05;
  const sat = 0.97 + r() * 0.08;
  const hue = (r() - 0.5) * 6;
  const noise = 3 + Math.floor(r() * 4);        // 3–6
  const q = 3 + Math.floor(r() * 3);            // качество JPEG (2 — лучшее, 5 — хуже)

  // Порядок важен: сначала поворот (с расширением), затем кроп внутрь, затем возврат размера.
  const vf = [
    `rotate=${(angle * Math.PI / 180).toFixed(5)}:fillcolor=none:bilinear=1`,
    `crop=iw*${(1 - cropPct * 2).toFixed(4)}:ih*${(1 - cropPct * 2).toFixed(4)}`,
    `eq=brightness=${bright.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${sat.toFixed(4)}`,
    `hue=h=${hue.toFixed(2)}`,
    `noise=alls=${noise}:allf=t`,
    // ФОРМАТ. Для КАРУСЕЛИ приводили к 1080×1350 центр-кропом: IG в посте даёт максимум 4:5 и
    // резал сам. Но с переходом на РИЛС этот кроп стал вредом — он срезал 90 px плашки ещё до
    // сборки видео, ровно ту инфографику, ради которой рилс и затевался. В режиме рилса пропорции
    // НЕ трогаем, кадр целиком укладывает reelbuild в свою безопасную зону.
    ...(process.env.REEL_OFF === '1'
      ? ['scale=1080:1350:force_original_aspect_ratio=increase', 'crop=1080:1350']
      : ['scale=1080:-2']),
  ].join(',');

  return {
    args: ['-y', '-i', inPath, '-vf', vf, '-map_metadata', '-1', '-q:v', String(q), outPath],
    params: { cropPct, angle, bright, contrast, sat, hue, noise, q },
  };
}

function run(bin, args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg таймаут')); }, timeoutMs);
    p.on('close', (c) => { clearTimeout(to); c === 0 ? resolve() : reject(new Error(`ffmpeg код ${c}: ${err.slice(-200)}`)); });
    p.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Уникализирует ВСЕ фото карусели под конкретный аккаунт. Возвращает пути готовых файлов.
async function uniquifyPhotos({ files, outDir, seedKey }) {
  const bin = require('ffmpeg-static');
  if (!bin || !fs.existsSync(bin)) throw new Error('ffmpeg-static не найден');
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const [i, f] of files.entries()) {
    if (!fs.existsSync(f)) throw new Error(`нет файла: ${f}`);
    // свой сид на КАЖДЫЙ кадр карусели: иначе три картинки получат одинаковые правки
    const { args, params } = buildPhotoArgs({
      seed: seedFrom(`${seedKey}#${i}`),
      inPath: f,
      outPath: path.join(outDir, `${String(i + 1).padStart(2, '0')}.jpg`),
    });
    await run(bin, args);
    const dest = args[args.length - 1];
    const size = fs.statSync(dest).size;
    if (!size) throw new Error('ffmpeg отдал пустой файл');
    out.push({ path: dest, size, params });
  }
  return out;
}

module.exports = { buildPhotoArgs, uniquifyPhotos };
