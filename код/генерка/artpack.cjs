'use strict';
// АРТ/ФОТО-ПАК на девочку: 14 шаблонов, кадр2 = арт, кадр3 = второй арт (другая поза), для бьюти-гайда — образ.
// Запуск: node artpack.cjs <имя>
const path = require('node:path'); const fs = require('node:fs');
const { genToFile, spentSoFar } = require('/Users/qq/Desktop/neironka-poster/rgen.cjs');
const TPL = require('/Users/qq/Desktop/neironka-poster/tplprompts.json');
const H = process.env.HOME + '/Desktop/НЕЙРОНКА'; const БАЗЫ = H + '/ДОГЕН-РАБОТА', ВЫХ = H + '/ОБРАЗЫ/по-девочке';
const ИМЯ = process.argv[2];
const ЯКОРЯ = ' ЯКОРЯ УЗНАВАЕМОСТИ ПЕРЕНЕСИ ТОЧНО: цвет и длину волос, причёску, черты лица, одежду и украшения с фото. Без надписей и текста на картинке.';
const KEEP = 'ОТРЕДАКТИРУЙ ПРИЛОЖЕННОЕ ФОТО: та же взрослая девушка 25 лет, черты лица, глаза, овал, тон кожи, волосы прядь в прядь. Без надписей.';
const f = (k, доб = '') => String(TPL[k] || '').slice(0, 3400) + доб + ЯКОРЯ;
const ПОЗА2 = 'Тот же стиль и та же героиня, но СОВСЕМ ДРУГОЙ КАДР: другая поза (вполоборота или сидит), другой ракурс, другая крупность, взгляд в сторону, лёгкая улыбка. Один цельный кадр, без коллажей и надписей.';

const ШАБЛОНЫ = {
  'img-bw-editorial':     [f('img-bw-editorial'), ПОЗА2],
  'img-golden-portrait':  [f('img-golden-portrait'), ПОЗА2],
  'img-retro-90s':        [f('img-retro-90s'), ПОЗА2],
  'img-double-exposure':  [f('img-double-exposure'), ПОЗА2 + ' Тот же приём двойной экспозиции.'],
  'img-doodle-watercolor':[f('img-doodle-watercolor'), ПОЗА2 + ' Те же акварельные дудлы поверх.'],
  'img-popart':           [f('img-popart'), ПОЗА2 + ' Тот же поп-арт стиль.'],
  'img-winx-fairy':       [f('img-winx-fairy', ' ОДИН персонаж, одно имя, один костюм.'), ПОЗА2 + ' Та же фея, тот же костюм и крылья.'],
  'img-gta':              [f('img-gta'), ПОЗА2 + ' Тот же стиль обложки GTA.'],
  'img-fantasy-char':     [f('img-fantasy-char', ' ОДИН персонаж, один костюм.'), ПОЗА2 + ' Тот же персонаж и костюм.'],
  'img-plush-toy':        [KEEP.replace('ОТРЕДАКТИРУЙ ПРИЛОЖЕННОЕ ФОТО: ', 'Сделай из девушки с приложенного фото ПЛЮШЕВУЮ ИГРУШКУ: мягкая кукла в её стиле — ') + ' Игрушка сидит на полке в её комнате, мягкий свет, узнаваемые волосы, одежда и черты. Милая, аккуратная, одета.', 'Та же плюшевая игрушка, ДРУГОЙ кадр: лежит на кровати, крупнее, чуть сбоку. Без надписей.'],
  'img-boyfriend-match':  [f('img-boyfriend-match'), ПОЗА2 + ' Та же пара, он и она.'],
  'img-business-portrait':[f('img-business-portrait'), ПОЗА2 + ' Тот же деловой стиль.'],
  'img-tryon':            [KEEP + ' ЗАДАЧА: примерь на неё другой образ одежды: чёрное платье-комбинация на тонких бретелях и лёгкий пиджак, минимальные украшения. Та же комната и свет.', ПОЗА2 + ' То же платье и пиджак.'],
  'img-beauty-guide':     [KEEP + ' ЗАДАЧА: салонный образ по бьюти-гайду: смена цвета волос (светлые → шоколадно-чёрный, тёмные → холодный блонд, никакого рыжего), другая длина и укладка, макияж визажиста. Свет как на фото.', ПОЗА2 + ' Тот же новый цвет и укладка, тот же макияж.'],
};

const базаДля = (имя) => { const x = fs.readdirSync(БАЗЫ).find((y) => y.replace(/\.[^.]+$/, '') === имя); if (!x) throw new Error('нет базы ' + имя); return path.join(БАЗЫ, x); };
const gen = (out, prompt, ref) => fs.existsSync(out) ? Promise.resolve() : genToFile(out, { prompt, refFiles: [ref], aspect: '4:5' });
(async () => {
  const база = базаДля(ИМЯ);
  const ш1 = [], ш2 = [];
  for (const [tpl, [p1, p2]] of Object.entries(ШАБЛОНЫ)) {
    const d = path.join(ВЫХ, ИМЯ, tpl); fs.mkdirSync(d, { recursive: true });
    const арт = tpl !== 'img-beauty-guide';
    const k1 = path.join(d, арт ? 'кадр2.png' : 'кадр3.png'), k2 = path.join(d, арт ? 'кадр3.png' : 'кадр4.png');
    ш1.push(() => gen(k1, p1, база).then(() => console.log('OK', tpl, '1')).catch((e) => console.log('FAIL', tpl, '1', String(e.message || e).slice(0, 90))));
    ш2.push(() => fs.existsSync(k1) ? gen(k2, p2, k1).then(() => console.log('OK', tpl, '2')).catch((e) => console.log('FAIL', tpl, '2', String(e.message || e).slice(0, 90))) : Promise.resolve());
    if (арт) ш2.push(() => fs.existsSync(k1) ? gen(path.join(d, 'кадр4.png'), ПОЗА2 + ' Крупный портрет по плечи.', k1).then(() => console.log('OK', tpl, '3')).catch((e) => console.log('FAIL', tpl, '3', String(e.message || e).slice(0, 90))) : Promise.resolve());
  }
  const пачками = async (a, n = 7) => { for (let i = 0; i < a.length; i += n) await Promise.all(a.slice(i, i + n).map((x) => x())); };
  await пачками(ш1); await пачками(ш2);
  console.log('SPENT:', JSON.stringify(spentSoFar()));
})();
