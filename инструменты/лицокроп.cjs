'use strict';
// НОРМАЛИЗАТОР ПОРТРЕТА ДЛЯ КАРТОЧЕК (24.08). Обложки волны-3 — общий план в локации, лицо мелкое
// и смещено; cardgen режет плитки лица фикс-позициями CSS (26%/58%) и попадает в небо/волосы/пальмы.
// Здесь детектим лицо (macOS Vision, ~/.neironka/bin/facebox) и режем ТЕСНЫЙ портрет, где глаза
// встают на EYE_Y, лицо по центру — тогда фикс-кропы вёрстки попадают в реальные части лица.
// Откат: если лица нет — вернуть исходник (карточка не хуже прежней).
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const FB = path.join(os.homedir(), '.neironka', 'bin', 'facebox');
// целевая рамка (подобрана под object-position cardgen): глаза на 0.40 высоты, лицо ~46% ширины
const EYE_Y = 0.40, FACE_W_FRAC = 0.46, OUT_W = 1040, ASPECT = 1.42;
function детект(src) {
  try { const s = execFileSync(FB, [src], { encoding: 'utf8', maxBuffer: 1 << 22 });
    const line = s.trim().split('\n').filter((x) => x.startsWith('{')).pop();
    const j = JSON.parse(line); return j && j.face ? j : null; } catch { return null; }
}
// хукСнизу=true — источник это кадр1 (обложка+хук, хук на ~82% низа). Портрет не должен опускаться
// в зону хука, иначе текст «...не прошла» лезет в «твоё фото» (поймано 25.08 на смеющемся селфи).
function лицокроп(src, out, { хукСнизу = false } = {}) {
  const j = детект(src);
  if (!j) { fs.copyFileSync(src, out); return false; }
  const OUT_H = Math.round(OUT_W * ASPECT);
  const eyeX = j.eyeX != null ? j.eyeX : (j.face.x + j.face.w / 2);
  const eyeY = j.eyeY != null ? j.eyeY : (j.face.y + j.face.h * 0.42);
  // масштаб: лицо должно занять FACE_W_FRAC ширины выходного кадра
  const scale = (OUT_W * FACE_W_FRAC) / j.face.w;
  const AR = OUT_W / OUT_H;                 // соотношение сторон окна (держим всегда)
  const низПредел = хукСнизу ? j.h * 0.74 : j.h;   // низ не заходит в зону хука кадр1 (3-строчные хуки начинаются с ~75%)
  const доступВыс = низПредел;              // сколько высоты доступно от 0 до предела
  // окно кропа не должно вылезать за кадр (иначе PIL добьёт ЧЁРНЫМ — баг 25.08 на близких/лежачих
  // селфи). Ограничиваем ширину кадром, высоту — доступной высотой, соотношение сохраняем.
  let cropW = OUT_W / scale, cropH = OUT_H / scale;
  if (cropW > j.w) { cropW = j.w; cropH = cropW / AR; }
  if (cropH > доступВыс) { cropH = доступВыс; cropW = cropH * AR; }
  if (cropW > j.w) { cropW = j.w; cropH = cropW / AR; }
  // позиционируем: глаза в (0.5*OUT_W, EYE_Y*OUT_H), но окно целиком внутри [0..j.w]×[0..низПредел]
  let left = eyeX - 0.5 * cropW;
  let top = eyeY - EYE_Y * cropH;
  left = Math.max(0, Math.min(left, j.w - cropW));
  top = Math.max(0, Math.min(top, низПредел - cropH));
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(src)}).convert('RGB')
c = im.crop((${Math.round(left)}, ${Math.round(top)}, ${Math.round(left + cropW)}, ${Math.round(top + cropH)}))
c = c.resize((${OUT_W}, ${OUT_H}), Image.LANCZOS)
c.save(${JSON.stringify(out)}, quality=92)
`;
  execFileSync('python3', ['-c', py]);
  return true;
}
module.exports = { лицокроп, детект };
if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  console.log(лицокроп(src, out || src.replace(/(\.\w+)$/, '.крп$1')) ? 'OK' : 'ОТКАТ(нет лица)');
}
