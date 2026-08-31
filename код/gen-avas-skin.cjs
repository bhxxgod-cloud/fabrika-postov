// 10 аватаров split-face до/после. Акцент на КОЖУ: слева уставшая с прыщами,
// справа красавица. Волосы НАТУРАЛЬНЫЕ (не крашеные) на обеих половинах.
const path = require('path');
const rgen = require('./rgen.cjs');
const fs = require('fs');
const OUT = '/Users/qq/Desktop/НЕЙРОНКА/ЮТУБ/АВЫ-Я';
fs.mkdirSync(OUT, { recursive: true });

const base = (bg, hair) =>
  'Flat vector pop-art illustration, bold clean outlines, cel-shaded, halftone dot shading, ' +
  'comic-book style, high contrast, centered symmetrical portrait of a young woman facing camera, ' +
  'the face is split exactly in half down the vertical center line. ' +
  `The woman has natural ${hair} hair on BOTH halves (NOT dyed, natural everyday hair color). ` +
  'LEFT half "before": simply tired sleepy girl, slightly dull skin, mild under-eye tiredness, ' +
  'plain flat hair, no makeup, calm tired low-energy expression. Clean skin, NO acne, NO pimples, ' +
  'NO dirt, not ugly, just visibly tired and low-key. ' +
  'RIGHT half "after": the SAME girl now energetic, cheerful and healthy, big warm genuine smile, ' +
  'glowing fresh skin, sparkling lively happy eyes, light pretty makeup, neat shiny bouncy hair, radiant and full of energy. ' +
  `Solid flat single-color ${bg} background, no text, shoulders visible, square composition.`;

// 10 вариаций: тег, надпись, яркий фон, натуральный цвет волос
const VARS = [
  { tag: 's01', label: 'НАСТОЯЩАЯ Я', bg: 'bright coral orange', hair: 'dark brown' },
  { tag: 's02', label: 'КРАСИВАЯ Я',  bg: 'vivid aqua teal',     hair: 'black' },
  { tag: 's03', label: 'НОВАЯ Я',     bg: 'lime green',          hair: 'chestnut brown' },
  { tag: 's04', label: 'ТОПОВАЯ Я',   bg: 'hot magenta',         hair: 'dark blonde' },
  { tag: 's05', label: 'ЛУЧШАЯ Я',    bg: 'electric blue',       hair: 'auburn' },
  { tag: 's06', label: 'ИДЕАЛЬНАЯ Я', bg: 'sunny yellow',        hair: 'light brown' },
  { tag: 's07', label: 'СИЯЮ Я',      bg: 'deep purple',         hair: 'black' },
  { tag: 's08', label: 'ДРУГАЯ Я',    bg: 'raspberry red',       hair: 'brown' },
  { tag: 's09', label: 'Я ДО / ПОСЛЕ', bg: 'turquoise cyan',     hair: 'dark brown' },
  { tag: 's10', label: 'МОЯ ВЕРСИЯ',  bg: 'bright orange',       hair: 'honey blonde' },
];

(async () => {
  for (const v of VARS) {
    const dest = path.join(OUT, `skin-${v.tag}.jpg`);
    try {
      console.log(`\n[${v.tag}] ${v.label} — заказываю…`);
      await rgen.genToFile(dest, { prompt: base(v.bg, v.hair), model: 'nano-banana-pro', aspect: '1:1', resolution: '1K' });
      console.log(`[${v.tag}] готово`);
    } catch (e) {
      console.log(`[${v.tag}] ОШИБКА: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'skin-labels.json'), JSON.stringify(Object.fromEntries(VARS.map(v => [v.tag, v.label])), null, 2));
  console.log('\nвсё');
})();
