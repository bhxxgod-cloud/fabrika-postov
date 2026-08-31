// УНИКАЛИЗАТОР ВИДЕО — ОДНА реализация параметров для обеих веток проекта:
//   • .cjs-конвейер (igpost2 на маке, ffmpeg из node_modules/ffmpeg-static);
//   • src/uniquify.ts (web-воркер на Railway, системный ffmpeg) — импортирует buildUniqArgs отсюда.
// Зачем: один и тот же ролик, выложенный с ДВУХ аккаунтов, IG ловит по перцептивному хэшу и отпечатку
// звука → копию режет в охвате как неоригинал, а сами акки склеивает в сетку (решение владельца 01.08:
// личный акк модели + брендовый акк нейронки должны получать РАЗНЫЕ файлы).
// Правки видны только машине: микро-зум, ±яркость/контраст/насыщенность, сдвиг оттенка, скорость
// (со встречной компенсацией звука, чтобы не «плыл»), шум, полная зачистка метаданных.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Детерминированный ГСЧ (mulberry32): один сид → один и тот же результат. Сид от аккаунта, поэтому
// у каждой модели СВОЙ стабильный вариант ролика, а повтор прогона не плодит новые версии.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Сид из любой строки (id аккаунта/slug) — чтобы не заводить отдельное поле в БД.
function seedFrom(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Собирает аргументы ffmpeg. level: 'medium' | 'max'. Возвращает {args, argsNoAudio, params}.
function buildUniqArgs({ seed, level = 'medium', inPath, outPath, maxW, crf, audioBr }) {
  const r = rng(seed);
  const max = level === 'max';
  const scale = 0.965 + r() * 0.03;
  const bright = (r() - 0.5) * 0.06;
  const contrast = 0.98 + r() * 0.06;
  const sat = 0.96 + r() * 0.1;
  const hue = (r() - 0.5) * 8;
  const speed = 0.97 + r() * 0.06;
  const atempo = 1 / speed;
  const noise = max ? 12 : 5;
  const flip = max && r() > 0.5;
  const MAXW = Number(maxW) || 720;
  const CRF = Number(crf) || 28;
  const ABR = audioBr || '96k';
  // СДВИГ НАЧАЛА (02.08). Обложка рилса = ПЕРВЫЙ кадр: механизм выбора обложки в мастере IG у нас
  // не находится («выбор обложки не найден»), поэтому превью нельзя чинить через интерфейс.
  // Ролики одной съёмки начинаются одинаково, и в сетке два разных ролика выглядели одним и тем же
  // (владелец поймал 02.08: два рилса с идентичным превью на одном профиле). Режем от 0.2 до 1.4 с
  // от старта: превью становится другим кадром, а речь в начале почти не страдает.
  const startCut = 0.2 + r() * 1.2;

  const vf = [
    `setpts=${speed.toFixed(4)}*PTS`,
    `scale=w='min(${MAXW},trunc(iw*${scale.toFixed(4)}/2)*2)':h=-2`,
    flip ? 'hflip' : '',
    `eq=brightness=${bright.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${sat.toFixed(4)}`,
    `hue=h=${hue.toFixed(2)}`,
    `noise=alls=${noise}:allf=t`,
    max ? 'vignette=PI/5' : '',
  ].filter(Boolean).join(',');

  const common = [
    // -ss ДО -i: обрезаем от начала, чтобы первый кадр (и обложка) отличались у роликов одной съёмки
    '-y', '-ss', startCut.toFixed(2), '-i', inPath,
    '-vf', vf,
    '-map_metadata', '-1',
    '-metadata', `title=v${Math.floor(r() * 1e9).toString(36)}`,
    '-metadata', `comment=${Math.floor(r() * 1e9)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(CRF), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  ];
  return {
    args: [...common, '-af', `atempo=${atempo.toFixed(4)}`, '-c:a', 'aac', '-b:a', ABR, outPath],
    argsNoAudio: [...common, '-an', outPath], // фолбэк: исходник без звука / atempo ругнулся
    params: { scale, bright, contrast, sat, hue, speed, noise, flip, startCut },
  };
}

function runFfmpeg(bin, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg таймаут')); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(`ffmpeg код ${code}: ${err.slice(-300)}`)); });
    p.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Уникализирует файл НА МЕСТЕ (возвращает путь результата). Ошибка ffmpeg не должна ронять публикацию:
// вызывающий решает сам — но факт «уникализация не прошла» обязан быть в логе (не молча).
async function uniquifyFile({ inPath, outPath, seedKey, level = 'medium' }) {
  const bin = require('ffmpeg-static');
  if (!bin || !fs.existsSync(bin)) throw new Error('ffmpeg-static не найден (npm i ffmpeg-static)');
  const { args, argsNoAudio, params } = buildUniqArgs({
    seed: seedFrom(seedKey), level, inPath, outPath,
    maxW: process.env.VIDEO_MAX_WIDTH, crf: process.env.VIDEO_CRF, audioBr: process.env.VIDEO_AUDIO_BR,
  });
  try { await runFfmpeg(bin, args); }
  catch { try { fs.unlinkSync(outPath); } catch {} await runFfmpeg(bin, argsNoAudio); }
  const size = fs.statSync(outPath).size;
  if (!size) throw new Error('ffmpeg отдал пустой файл');
  return { path: outPath, size, params };
}

module.exports = { rng, seedFrom, buildUniqArgs, runFfmpeg, uniquifyFile };
