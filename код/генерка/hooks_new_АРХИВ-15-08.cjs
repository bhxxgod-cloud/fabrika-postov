'use strict';
// ХУКИ ИЗ УТВЕРЖДЁННОГО ФАЙЛА ВЛАДЕЛЬЦА (ЛОГИКА-ХУКОВ-НОВАЯ-15-08.md), пока пул не вшит в hooks.cjs.
// Дословно, без сочинений. Правила: без длинного тире; оценка без цифр; 25% про подписчицу
// (детерминированно по id, каждый 4-й) только у разборов/перерисовок; арты без «авы».
const fs = require('node:fs');
const MD = process.env.HOME + '/Desktop/НЕЙРОНКА/ЛОГИКА-ХУКОВ-НОВАЯ-15-08.md';
const txt = fs.readFileSync(MD, 'utf8');
const секция = (заголовокRe) => { const m = txt.match(new RegExp(заголовокRe + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##|\\n[А-ЯA-Za-z-]+:|$)')); return m ? m[1] : ''; };
const строка = (имяRe) => { const m = txt.match(new RegExp('^' + имяRe + ':\\s*([^\\n]+)', 'm')); return m ? m[1] : ''; };
const split = (s) => s.replace(/\n/g, ' ').split('·').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && !/^\+/.test(x));
const УНИВЕРС = split(секция('## Универсальные'));
const АРТЫ = split(секция('## Во все арт-тренды'));
const СНИМКИ = split(секция('## Во все тренды со снимками'));
const ПО = {
  'img-lip-guide': split(строка('ГУБЫ')), 'img-brow-map': split(строка('БРОВИ')), 'img-nose-verdict': split(строка('НОС')),
  'img-haircut-match': split(строка('СТРИЖКА')), 'img-makeup-colortype': split(строка('МЕЙК/ЦВЕТА')), 'img-face-report': split(строка('ОЦЕНКА \\(без цифры\\)')),
  'img-beauty-guide': [], 'img-heart-hair': split(строка('heart-hair')), 'img-tryon': split(строка('tryon')), 'img-new-forms': split(строка('new-forms')),
  'img-bw-fingers': split(строка('bw-fingers')), 'img-bw-editorial': split(строка('bw-editorial')), 'img-canon-g7x': split(строка('canon-g7x')),
  'img-retro-90s': split(строка('retro-90s')), 'img-golden-portrait': split(строка('golden-portrait')), 'img-double-exposure': split(строка('double-exposure')),
  'img-flower-cloud': split(строка('flower-cloud')), 'img-rain-look': split(строка('rain-look')), 'img-medieval-photo': split(строка('medieval')),
  'img-doodle-watercolor': split(строка('doodle-watercolor')), 'img-photo-restore': split(строка('photo-restore')), 'img-business-portrait': split(строка('business-portrait')),
  'img-winx-fairy': split(строка('winx-fairy')), 'img-anime': split(строка('anime')), 'img-pixar-3d': split(строка('pixar-3d')), 'img-popart': split(строка('popart')),
  'img-fantasy-char': split(строка('fantasy-char')), 'img-gta': split(строка('gta')).map((x) => x.replace(/\s*\(ротация:.*$/, '')), 'img-sketch-collage': split(строка('sketch-collage')),
  'img-avatar': split(строка('avatar')), 'img-plush-toy': split(строка('plush-toy')), 'img-rolls-selfie': split(строка('rolls-selfie')), 'img-bmw-photo': split(строка('bmw-photo')),
  'img-pilot-girl': split(строка('pilot-girl')), 'img-boyfriend-match': split(строка('boyfriend-match')),
};
const КАРТОЧНЫЕ = new Set(['img-lip-guide', 'img-brow-map', 'img-nose-verdict', 'img-haircut-match', 'img-makeup-colortype', 'img-face-report', 'img-beauty-guide', 'img-new-forms']);
const ПЕРЕРИСОВКИ = new Set(['img-anime', 'img-pixar-3d', 'img-doodle-watercolor', 'img-popart', 'img-sketch-collage', 'img-fantasy-char', 'img-winx-fairy', 'img-gta', 'img-avatar', 'img-plush-toy']);
const СНИМОЧНЫЕ = new Set(['img-retro-90s', 'img-canon-g7x', 'img-bw-editorial', 'img-bw-fingers', 'img-golden-portrait', 'img-double-exposure', 'img-rain-look', 'img-medieval-photo', 'img-flower-cloud', 'img-rolls-selfie', 'img-bmw-photo', 'img-pilot-girl']);
const ГОРОДА = ['уфе', 'челябе', 'нн', 'питере', 'казани', 'лефортово', 'бирюлёво', 'омске', 'краснодаре'];
const h32 = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h >>> 0; };
const проПодписчицу = (id) => (h32(id) >>> 24) % 4 === 0;
const оПодписчице = (t) => /подписчиц|заявка из комментов/i.test(t);
function pool(tpl) {
  let p = [...(ПО[tpl] || [])];
  if (КАРТОЧНЫЕ.has(tpl)) p = p.concat(УНИВЕРС);
  if (ПЕРЕРИСОВКИ.has(tpl)) p = p.concat(АРТЫ);
  if (СНИМОЧНЫЕ.has(tpl)) p = p.concat(СНИМКИ);
  if (tpl === 'img-face-report') p = p.filter((t) => !/\d/.test(t));
  p = p.filter((t) => !/—/.test(t) && !(!КАРТОЧНЫЕ.has(tpl) && /\bав[ауы]\b/i.test(t)));
  return [...new Set(p)];
}
function pick(tpl, { seed, avoidSet = [], подписчица = null } = {}) {
  let p = pool(tpl).filter((t) => !/красивее меня/i.test(t)); if (!p.length) return null;
  const sub = (подписчица == null ? проПодписчицу(seed) : !!подписчица) && (КАРТОЧНЫЕ.has(tpl) || ПЕРЕРИСОВКИ.has(tpl));
  const выбор = p.filter((t) => oПодп(t) === sub); if (выбор.length) p = выбор; else p = p.filter((t) => !oПодп(t));
  const своб = p.filter((t) => !avoidSet.includes(t)); const use = своб.length ? своб : p;
  let t = use[h32(seed) % use.length];
  if (tpl === 'img-gta') t = t.replace(/уфе/, ГОРОДА[h32(seed + 'g') % ГОРОДА.length]);
  return t;
}
function oПодп(t) { return оПодписчице(t); }
module.exports = { pick, pool, проПодписчицу };
if (require.main === module) { for (const k of Object.keys(ПО)) console.log(k, pool(k).length); }
