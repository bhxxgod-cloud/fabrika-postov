// ИЗМЕРИТЕЛЬ УНИКАЛИЗАЦИИ (09.08). Не теория, а цифры: насколько каждый приём сдвигает
// перцептивный хэш кадра. Меряем тем же dHash 16x16 = 256 бит, что стоит в coverguard.cjs,
// то есть тем же измерителем, которым наш собственный гейт ловит повторные обложки.
//
// ЗАЧЕМ. Вопрос начальника «уникален ли пост для инстаграма» проверяется только так: берём кадр,
// применяем приём, считаем расстояние Хэмминга до исходника. Если расстояние меньше порога
// нашего же гейта (48 бит из 256), то наш собственный детектор считает это ОДНОЙ И ТОЙ ЖЕ
// картинкой, и рассчитывать, что чужой детектор окажется слабее нашего, нельзя.
//
// ВАЖНО ПРО ГРАНИЦЫ ЗАМЕРА: dHash это НЕ алгоритм Instagram. Он показывает порядок величины и
// сравнительную силу приёмов, а не пропуск/непропуск у платформы. Абсолютную гарантию он не даёт
// и дать не может, см. отчёт.
//
// Запуск: node uniqmeasure.cjs <кадр.jpg> [ещё кадры...]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const FF = require('ffmpeg-static');
const CG = require('./coverguard.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uniqm_'));

function ff(args) {
  const r = spawnSync(FF, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(String(r.stderr || '').slice(-200));
}
function apply(src, name, vf, extra = []) {
  const out = path.join(TMP, name + '.jpg');
  ff(['-i', src, '-vf', vf, '-map_metadata', '-1', ...extra, out]);
  return out;
}

// Набор приёмов из вопроса начальника, по одному, чтобы видеть вклад КАЖДОГО.
const CASES = [
  ['перекод jpeg q=3 (ничего не меняем)', 'null', ['-q:v', '3']],
  ['перекод jpeg q=8 (сильное сжатие)', 'null', ['-q:v', '8']],
  ['только яркость/контраст (как в uniqphoto)', 'eq=brightness=0.03:contrast=1.03:saturation=1.04'],
  ['только цвет сильнее (bright 0.10, contr 1.15)', 'eq=brightness=0.10:contrast=1.15:saturation=1.20'],
  ['только оттенок +6 град', 'hue=h=6'],
  ['только оттенок +25 град', 'hue=h=25'],
  ['только шум alls=5 (как в uniqphoto)', 'noise=alls=5:allf=t'],
  ['только шум alls=20', 'noise=alls=20:allf=t'],
  ['кроп 1% + возврат размера', 'crop=iw*0.98:ih*0.98,scale=783:1280'],
  ['кроп 3% + возврат размера', 'crop=iw*0.94:ih*0.94,scale=783:1280'],
  ['кроп 6% + возврат размера', 'crop=iw*0.88:ih*0.88,scale=783:1280'],
  ['кроп 12% + возврат размера', 'crop=iw*0.76:ih*0.76,scale=783:1280'],
  ['поворот 0.8 град + кроп', 'rotate=0.01396:fillcolor=none:bilinear=1,crop=iw*0.97:ih*0.97,scale=783:1280'],
  ['поворот 3 град + кроп', 'rotate=0.05236:fillcolor=none:bilinear=1,crop=iw*0.92:ih*0.92,scale=783:1280'],
  ['ЗЕРКАЛО по горизонтали', 'hflip'],
  ['зеркало + цвет + кроп 3%', 'hflip,eq=brightness=0.03:contrast=1.03,crop=iw*0.94:ih*0.94,scale=783:1280'],
  ['ВЕСЬ uniqphoto целиком (кроп1.5+пов0.5+цвет+шум)',
    'rotate=0.00873:fillcolor=none:bilinear=1,crop=iw*0.97:ih*0.97,eq=brightness=0.02:contrast=1.02:saturation=1.02,hue=h=3,noise=alls=4:allf=t,scale=783:1280', ['-q:v', '4']],
  ['сдвиг кадра на 20 px (панорама)', 'crop=iw-40:ih-40:40:20,scale=783:1280'],
];

(async () => {
  const files = process.argv.slice(2).filter((f) => fs.existsSync(f));
  if (!files.length) { console.log('usage: node uniqmeasure.cjs <кадр.jpg> [...]'); process.exit(1); }
  console.log(`ИЗМЕРИТЕЛЬ: dHash 16x16 = 256 бит (тот же, что в coverguard.cjs), порог гейта ${CG.THRESH} бит`);
  console.log('«прошёл» = расстояние ВЫШЕ порога, то есть наш собственный гейт версию за повтор не считает\n');

  const agg = new Map();
  for (const src of files) {
    const h0 = CG.hashImage(src);
    console.log(`── ${path.basename(src)}`);
    for (const [label, vf, extra] of CASES) {
      let d;
      try { d = CG.hamming(h0, CG.hashImage(apply(src, label.replace(/\W+/g, '_'), vf, extra))); }
      catch (e) { console.log(`  ✗ ${label}: ${e.message}`); continue; }
      if (!agg.has(label)) agg.set(label, []);
      agg.get(label).push(d);
      console.log(`  ${String(d).padStart(3)} бит  ${d > CG.THRESH ? 'прошёл ' : 'ПОВТОР '} ${label}`);
    }
    console.log('');
  }

  console.log('ИТОГ (среднее по кадрам, бит из 256):');
  const rows = [...agg.entries()].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length, Math.min(...v), Math.max(...v)]);
  rows.sort((a, b) => a[1] - b[1]);
  for (const [k, avg, lo, hi] of rows) {
    console.log(`  ${avg.toFixed(1).padStart(6)}  (мин ${String(lo).padStart(3)}, макс ${String(hi).padStart(3)})  ${avg > CG.THRESH ? '✅' : '⛔'}  ${k}`);
  }
  // Контроль: два РАЗНЫХ кадра. Без этой цифры любой замер бессмыслен, потому что непонятно,
  // где начинается «разные картинки».
  if (files.length > 1) {
    const hs = files.map((f) => CG.hashImage(f));
    const ds = [];
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) ds.push(CG.hamming(hs[i], hs[j]));
    console.log(`\nКОНТРОЛЬ, разные кадры между собой: ${ds.join(', ')} бит (мин ${Math.min(...ds)})`);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
