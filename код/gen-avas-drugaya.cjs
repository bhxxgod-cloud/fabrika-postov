// Разовый генератор 5 аватаров «... Я» — split-face до/после, как «ДРУГАЯ Я».
// Только картинки; текст в круг накладывается отдельно питоном.
const path = require('path');
const rgen = require('./rgen.cjs');

const OUT = '/Users/qq/Desktop/НЕЙРОНКА/ЮТУБ/АВЫ-Я';
require('fs').mkdirSync(OUT, { recursive: true });

const STYLE =
  'Flat vector pop-art illustration, bold clean outlines, cel-shaded, halftone dot shading, ' +
  'comic-book style, high contrast, centered symmetrical portrait of a young woman facing camera, ' +
  'the face is split exactly in half down the vertical center line. ' +
  'LEFT half: ordinary everyday girl, natural dark hair, muted realistic skin, plain, neutral tired look, "before". ' +
  'RIGHT half: glamorous idealized anime-glam version of the SAME face, huge sparkling stylized eye, glossy lips, ' +
  'flawless glowing skin, vivid dyed hair, confident, "after". ' +
  'Solid flat single-color bright background, no text, shoulders visible, square composition.';

// 5 вариаций: тег, цвет фона, цвет "после"-волос
const VARS = [
  { tag: 'novaya',    bg: 'hot magenta pink',      hair: 'bright pink' },
  { tag: 'krasivaya', bg: 'vivid turquoise cyan',  hair: 'sky blue' },
  { tag: 'topovaya',  bg: 'electric purple violet', hair: 'lavender purple' },
  { tag: 'dopposle',  bg: 'warm golden yellow',    hair: 'fiery orange red' },
  { tag: 'luchshaya', bg: 'lime green',            hair: 'mint platinum' },
];

(async () => {
  for (const v of VARS) {
    const prompt = STYLE
      .replace('bright background', `${v.bg} background`)
      .replace('vivid dyed hair', `vivid ${v.hair} hair`);
    const dest = path.join(OUT, `ava-${v.tag}.jpg`);
    try {
      console.log(`\n[${v.tag}] заказываю…`);
      await rgen.genToFile(dest, { prompt, model: 'nano-banana-pro', aspect: '1:1', resolution: '1K' });
      console.log(`[${v.tag}] готово -> ${dest}`);
    } catch (e) {
      console.log(`[${v.tag}] ОШИБКА: ${e.message}`);
    }
  }
  console.log('\nвсё');
})();
