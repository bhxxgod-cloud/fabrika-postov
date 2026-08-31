'use strict';
// ПАКЕТНАЯ ТЕЛЕФОННАЯ ПЛЁНКА ПО ГОТОВЫМ ПОСТАМ. Ничего не заказывает и ничего не публикует: берёт
// уже собранные кадры с диска, кладёт на кадры 3 и 4 плёнку и делает склейку всех четырёх для
// осмотра глазами. Кадр 1 и карточка кадра 2 не трогаются никогда, это правило начальника.
//
// ДВА РЕЖИМА:
//   · --вайб (по умолчанию) кадры 3 и 4 подгоняются под ВАЙБ КАДРА 1, то есть под живое фото с
//     пинтереста: цвет, насыщенность, контраст и сжатие берутся замером с него.
//   · --пресет=5c|11 запасной вариант: фиксированный характер камеры и сила от руки.
//
// ГДЕ ИЩЕТ КАДРЫ. Папка с файлами вида «<пост>_кадр1.jpg … _кадр4.jpg» (так лежит склад эталонов),
// либо папка поста с файлами 1.jpg…4.jpg, либо явные четыре пути.
//
// ЗАПУСК
//   node phonebatch.cjs --из=/Users/qq/Desktop/КАЧЕСТВО-ЛУЧШИЕ-10.08 --куда=/Users/qq/Desktop/ТЕСТ-ВАЙБ-КАДРА1
//   node phonebatch.cjs --из=… --куда=… --посты=P13_566883fb,P11_d01c49a5
//   node phonebatch.cjs --из=… --куда=… --пресет=5c --сила=1.2
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const FF = require('ffmpeg-static');
const pl = require('./phonelook.cjs');

/** Собрать посты из папки: имя поста это всё до «_кадрN». */
function посты(из) {
  const по = new Map();
  for (const f of fs.readdirSync(из)) {
    const m = f.match(/^(.+?)_кадр([1-4])\.(jpe?g|png)$/i);
    if (!m) continue;
    if (!по.has(m[1])) по.set(m[1], {});
    по.get(m[1])[m[2]] = path.join(из, f);
  }
  // Берём только полные посты: склейка из трёх кадров бесполезна для осмотра.
  return [...по.entries()].filter(([, к]) => к['1'] && к['2'] && к['3'] && к['4']);
}

/** Склейка четырёх кадров в одну картинку, как файлы ВСЕ4 в складе эталонов: 2 на 2. */
function склейка(к, выход) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const n of ['1', '2', '3', '4']) args.push('-i', к[n]);
  args.push('-filter_complex',
    '[0]scale=540:-1[a];[1]scale=540:-1[b];[2]scale=540:-1[c];[3]scale=540:-1[d];'
    + '[a][b]hstack[в];[c][d]hstack[н];[в][н]vstack',
    '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3', выход);
  const r = spawnSync(FF, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`склейка не собралась: ${String(r.stderr).slice(-300)}`);
  return выход;
}

function главное() {
  const арг = process.argv.slice(2);
  const знач = (и, п) => { const a = арг.find((s) => s.startsWith(`--${и}=`)); return a ? a.split('=').slice(1).join('=') : п; };
  const из = знач('из');
  const куда = знач('куда', '/Users/qq/Desktop/ТЕЛЕФОННАЯ-ПЛЁНКА-11.08');
  const пресет = знач('пресет', null);
  const сила = Number(знач('сила', 1));
  const только = (знач('посты', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!из || !fs.existsSync(из)) {
    console.log('нужна папка с готовыми кадрами: node phonebatch.cjs --из=<папка> [--куда=<папка>] [--посты=a,b] [--пресет=5c|11 --сила=1]');
    process.exit(1);
  }
  fs.mkdirSync(куда, { recursive: true });
  let список = посты(из);
  if (только.length) список = список.filter(([имя]) => только.includes(имя));
  if (!список.length) { console.log('в папке нет полных постов из четырёх кадров'); process.exit(1); }

  const отчёт = [];
  for (const [имя, к] of список) {
    const свои = { 1: к['1'], 2: к['2'] };
    // Кадры 1 и 2 переносим байт в байт: копией, без единого пережатия.
    for (const n of ['1', '2']) fs.copyFileSync(к[n], path.join(куда, `${имя}_кадр${n}.jpg`));
    const новые = { 1: path.join(куда, `${имя}_кадр1.jpg`), 2: path.join(куда, `${имя}_кадр2.jpg`) };
    const строка = { пост: имя };
    for (const n of ['3', '4']) {
      const выход = path.join(куда, `${имя}_кадр${n}.jpg`);
      try {
        if (пресет) {
          pl.телефонный(к[n], выход, { пресет, сила, надПлашкой: true });
          строка[`кадр${n}`] = `пресет ${пресет} x${сила}`;
        } else {
          const r = pl.подВайб(к[n], выход, { эталон: к['1'], надПлашкой: true });
          строка[`кадр${n}`] = r.примененo;
          строка.эталон = { зерно: r.эталон.зерно, нас: r.эталон.насыщенность, тепло: r.эталон.тепло, блоч: r.эталон.блочность };
        }
        новые[n] = выход;
      } catch (e) {
        console.log(`  ⚠ ${имя} кадр ${n}: ${String(e.message).slice(0, 120)}`);
        fs.copyFileSync(к[n], выход); новые[n] = выход;
      }
    }
    склейка(новые, path.join(куда, `${имя}_ВСЕ4.jpg`));
    // Склейка «до и после» по кадру 4: слева исходник, справа с плёнкой. Именно её смотрит отдел
    // качества, разницу по одному файлу глазами не поймать.
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', к['4'], '-i', новые['4'],
      '-filter_complex', '[0]scale=640:-1[a];[1]scale=640:-1[b];[a][b]hstack', '-frames:v', '1',
      '-c:v', 'mjpeg', '-q:v', '3', path.join(куда, `${имя}_ДО-ПОСЛЕ-кадр4.jpg`)];
    spawnSync(FF, args);
    отчёт.push(строка);
    console.log(`✓ ${имя}: ${JSON.stringify(строка.кадр4)}`);
    void свои;
  }
  fs.writeFileSync(path.join(куда, 'отчёт.json'), JSON.stringify(отчёт, null, 1));
  console.log(`\nготово, ${отчёт.length} постов в ${куда}`);
}

if (require.main === module) главное();
module.exports = { склейка, посты };
