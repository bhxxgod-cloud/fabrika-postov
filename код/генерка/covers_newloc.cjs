'use strict';
// ОБЛОЖКИ ПО НОВЫМ ЛОКАЦИЯМ (волна 22.08, приказ «150 постов с новыми локами»).
// По 8 на девочку: 2 на город из НОВЫХ точек (террасы/качели/пляжный клуб, пустыня/JBR/фонтаны,
// Дворцовая/Севкабель, Зарядье/Патрики). Имена обложка-<город>-2N.jpg — старая нумерация 1N не задета.
// Идемпотентно. Гейт транспорта фильтруется заранее (см. память promptkit-geyt-transporta).
const path = require('path'), fs = require('fs');
process.chdir('/Users/qq/Desktop/neironka-poster');
const pk = require('/Users/qq/Desktop/neironka-poster/promptkit.cjs');
const { genToFile, spentSoFar } = require('/Users/qq/Desktop/neironka-poster/rgen.cjs');
const e = require('/Users/qq/Desktop/neironka-poster/locations-extra.json');
const все = e.locations;
const НОВЫЕ = {
  бали: ['бали-рисовые-террасы', 'бали-качели-джунгли', 'бали-пляжный-клуб'],
  дубай: ['дубай-пустыня-закат', 'дубай-пляж-джибиар', 'дубай-фонтаны-вечером'],
  питер: ['питер-дворцовая-вечер', 'питер-севкабель'],
  москва: ['москва-зарядье-набережная', 'москва-патрики-кафе'],
};
const годна = (k) => { try { pk.coverPrompt({ place: все[k].промпт, light: все[k].свет }); return true; } catch { return false; } };
for (const c of Object.keys(НОВЫЕ)) НОВЫЕ[c] = НОВЫЕ[c].filter((k) => все[k] && годна(k));
const D = process.env.HOME + '/Desktop/НЕЙРОНКА/ДОГЕН-РАБОТА';
const O = process.env.HOME + '/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН';
const ДЕВОЧКИ = (process.env.GIRLS || '').split(',').filter(Boolean);
if (!ДЕВОЧКИ.length) { console.log('нет GIRLS'); process.exit(1); }
const h = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x >>> 0; };
const jobs = [];
for (const g of ДЕВОЧКИ) {
  const базаP = path.join(D, g + '.png'), базаJ = path.join(D, g + '.jpg');
  const база = fs.existsSync(базаP) ? базаP : базаJ;
  if (!fs.existsSync(база)) { console.log('НЕТ БАЗЫ', g); continue; }
  const od = path.join(O, g); fs.mkdirSync(od, { recursive: true });
  for (const [город, пул] of Object.entries(НОВЫЕ)) for (let i = 0; i < 2; i++) {
    const сдвиг = Number(process.env.RETRY_SHIFT || 0);
    const k = пул[(h(g + город) + i + сдвиг) % пул.length]; const v = все[k];
    const имя = 'обложка-' + город + '-2' + i + '.jpg';
    if (fs.existsSync(path.join(od, имя))) continue;
    jobs.push(() => {
      try {
        return genToFile(path.join(od, имя), { prompt: pk.coverPrompt({ place: v.промпт, light: v.свет }), refFiles: [база], aspect: '9:16' })
          .then(() => console.log('OK', g, город, i, k))
          .catch((err) => console.log('FAIL', g, город, String(err.message || err).slice(0, 50)));
      } catch (err) { console.log('SKIP', g, город, String(err.message || err).slice(0, 60)); return Promise.resolve(); }
    });
  }
}
console.log('заказов:', jobs.length);
(async () => {
  for (let i = 0; i < jobs.length; i += 5) await Promise.all(jobs.slice(i, i + 5).map((f) => f()));
  console.log('SPENT', JSON.stringify(spentSoFar()));
})();
