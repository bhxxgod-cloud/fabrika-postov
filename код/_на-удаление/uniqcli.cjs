// РУЧНОЙ УНИКАЛИЗАТОР: 1 видео на входе → N разных на выходе (по умолчанию 5).
// Каждая копия визуально та же, но с другим перцептивным хэшем, отпечатком звука и метаданными —
// чтобы один ролик можно было выложить с РАЗНЫХ аккаунтов без склейки в сетку и без реза охвата.
// Логика та же, что у постера (uniq.cjs) — второй реализации не заводим.
//
// usage:  node uniqcli.cjs <видео> [сколько] [папка-выхода]
// пример: node uniqcli.cjs ~/Desktop/video.mp4 5
// env:    UNIQ_LEVEL=max      сильнее (добавляет отражение по горизонтали + виньетку)
//         VIDEO_MAX_WIDTH=720 ширина кадра (по умолчанию 720 — вертикальные рилсы)
//         VIDEO_CRF=28        качество/вес (меньше = лучше и тяжелее)
const path = require('node:path');
const fs = require('node:fs');
const U = require('./uniq.cjs');

(async () => {
  const src = process.argv[2];
  const n = Math.max(1, Math.min(20, Number(process.argv[3] || 5)));
  if (!src || !fs.existsSync(src)) {
    console.log('usage: node uniqcli.cjs <видео> [сколько=5] [папка]');
    console.log('пример: node uniqcli.cjs ~/Desktop/video.mp4 5');
    process.exit(1);
  }
  const outDir = process.argv[4] || path.join(path.dirname(src), 'uniq');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(src).replace(/\.[^.]+$/, '');
  const level = process.env.UNIQ_LEVEL || 'medium';
  const srcMb = (fs.statSync(src).size / 1048576).toFixed(1);
  console.log(`УНИКАЛИЗАЦИЯ: ${path.basename(src)} (${srcMb} МБ) → ${n} копий, уровень ${level}`);
  console.log(`папка: ${outDir}\n`);

  const done = [];
  for (let i = 1; i <= n; i++) {
    const out = path.join(outDir, `${base}_v${i}.mp4`);
    try {
      // сид = имя файла + номер копии: одинаковый вызов даст одинаковый результат (воспроизводимо),
      // а каждая копия при этом своя.
      const r = await U.uniquifyFile({ inPath: src, outPath: out, seedKey: `${base}#${i}`, level });
      done.push(out);
      const p = r.params;
      console.log(`  ✅ v${i}: ${(r.size / 1048576).toFixed(1)} МБ · зум ${p.scale.toFixed(3)} · скорость ${p.speed.toFixed(3)} · оттенок ${p.hue.toFixed(1)}°${p.flip ? ' · зеркало' : ''}`);
    } catch (e) {
      console.log(`  ✗ v${i}: ${String(e.message).slice(0, 120)}`);
    }
  }
  console.log(`\nГОТОВО: ${done.length}/${n} копий в ${outDir}`);
  if (done.length > 1) {
    // Доказательство, что файлы РАЗНЫЕ (а не «вроде обработали»): сверяем контрольные суммы.
    const { execFileSync } = require('node:child_process');
    const sums = done.map((f) => { try { return execFileSync('md5', ['-q', f]).toString().trim(); } catch { return ''; } });
    console.log(`контрольные суммы уникальны: ${new Set(sums).size === sums.length ? 'ДА ✅' : 'НЕТ ✗ (файлы совпали)'}`);
  }
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
