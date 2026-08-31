// ПОДГОНКА СКРИНА ПОД КАДР РОЛИКА 1080x1920 (27.08.2026, владелец: «размер скрина должен быть
// как экран айфона 9 на 16»).
//
// Модель отдаёт 1536x2752, это 9:16.12 — промах на 0.12. При вписывании по высоте оставались
// поля по четыре пикселя с каждой стороны: мелочь, но на чёрном фоне ролика видно кант.
//
// РЕШЕНИЕ. Не обрезаем, а тянем: разница 0.7 процента, глазом не различима, зато на экране
// не теряется ни статус-бар сверху, ни поле ввода снизу. Обрезка съела бы пятнадцать пикселей
// с краёв, а там как раз то, что делает скрин настоящим.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const FF = require(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static'));

const W = 1080, H = 1920;

/** Привести скрин к ровному 1080x1920. @returns {string} путь готового файла */
function подогнать(вход, выход = null) {
  const out = выход || вход.replace(/(\.\w+)$/, '.916$1');
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', вход,
    '-vf', `scale=${W}:${H}:flags=lanczos`, '-q:v', '2', out]);
  return out;
}

if (require.main === module) {
  const цель = process.argv[2];
  if (!цель) { console.log('подгонка: node tgfit.cjs <файл|папка>'); process.exit(1); }
  const файлы = fs.statSync(цель).isDirectory()
    ? fs.readdirSync(цель).filter((f) => /\.(jpe?g|png)$/i.test(f) && !/\.916\./.test(f)).map((f) => path.join(цель, f))
    : [цель];
  for (const f of файлы) {
    подогнать(f, f.replace(/\.(\w+)$/, '.916.jpg'));
    console.log('OK', path.basename(f), '→ 1080x1920');
  }
  console.log(`подогнано: ${файлы.length}`);
}

module.exports = { подогнать, W, H };
