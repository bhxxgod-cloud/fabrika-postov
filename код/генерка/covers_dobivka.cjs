'use strict';
// ДОБИВКА ГОРОДСКИХ ОБЛОЖЕК МИЛ (21.08): по 2 на город (москва/питер/дубай/бали), имена
// обложка-<город>-1N.jpg. Идемпотентно: готовые пропускает. Гейт транспорта фильтруется
// заранее (иначе coverPrompt кидает синхронно и валит весь цикл — так умерли два прогона).
const path = require('path'), fs = require('fs');
process.chdir('/Users/qq/Desktop/neironka-poster');
const pk = require('/Users/qq/Desktop/neironka-poster/promptkit.cjs');
const { genToFile, spentSoFar } = require('/Users/qq/Desktop/neironka-poster/rgen.cjs');
const m = require('/Users/qq/Desktop/neironka-poster/locations-moscow.json');
const e = require('/Users/qq/Desktop/neironka-poster/locations-extra.json');
const все = Object.assign({}, m.locations, e.locations);
const годна = (k) => { try { pk.coverPrompt({ place: все[k].промпт, light: все[k].свет }); return true; } catch { return false; } };
const ПУЛЫ = {
  москва: Object.keys(m.locations).filter(годна).slice(0, 8),
  питер: Object.keys(все).filter((k) => /^питер/.test(k) && годна(k)),
  дубай: Object.keys(все).filter((k) => /^дубай/.test(k) && годна(k)),
  бали: Object.keys(все).filter((k) => /^бали/.test(k) && годна(k)),
};
const D = process.env.HOME + '/Desktop/НЕЙРОНКА/ДОГЕН-РАБОТА';
const O = process.env.HOME + '/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН';
const девочки = fs.readdirSync(D).filter((f) => /^мила-/.test(f) && !/p06/.test(f)).map((f) => f.replace(/\.[^.]+$/, ''));
const h = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x >>> 0; };
const jobs = [];
for (const g of девочки) {
  const база = path.join(D, g + '.png'); const od = path.join(O, g);
  for (const [город, пул] of Object.entries(ПУЛЫ)) for (let i = 0; i < 2; i++) {
    // при ретрае берём соседнюю локацию из пула (сдвиг на номер попытки из env), чтобы
    // упавшая по таймауту локация не долбилась вечно
    const сдвиг = Number(process.env.RETRY_SHIFT || 0);
    const k = пул[(h(g + город) + i + сдвиг) % пул.length]; const v = все[k];
    const имя = 'обложка-' + город + '-1' + i + '.jpg';
    if (fs.existsSync(path.join(od, имя))) continue;
    jobs.push(() => {
      try {
        return genToFile(path.join(od, имя), { prompt: pk.coverPrompt({ place: v.промпт, light: v.свет }), refFiles: [база], aspect: '9:16' })
          .then(() => console.log('OK', g, город, i))
          .catch((err) => console.log('FAIL', g, город, String(err.message || err).slice(0, 50)));
      } catch (err) { console.log('SKIP', g, город, String(err.message || err).slice(0, 50)); return Promise.resolve(); }
    });
  }
}
console.log('заказов:', jobs.length);
(async () => {
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map((f) => f()));
  console.log('SPENT', JSON.stringify(spentSoFar()));
})();
