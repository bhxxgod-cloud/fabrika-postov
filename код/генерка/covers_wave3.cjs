'use strict';
// ВОЛНА-3 (22.08): по 20 обложек на 8 отобранных девочек. Приказ владельца: «на фотках они должны
// различаться и быть более милыми и еще в разных локациях».
//   · РАЗНЫЕ ЛОКАЦИИ — 20 РАЗНЫХ точек на девочку, квота 5 москва / 5 питер / 5 дубай / 5 бали;
//     порядок точек свой у каждой девочки (хеш имени), чтобы у двух девочек не совпали кадры;
//   · РАЗЛИЧАЮТСЯ — на каждый снимок своя поза+одежда+выражение из ротации (у coverPrompt есть
//     поля pose/clothes, они уходят в промпт отдельными строками);
//   · МИЛЕЕ — типаж «милая куколка» (память shablony-zaprety-17-08): мягкая улыбка, живая мимика,
//     без «взрослой дорогой» подачи. Слова про возраст/поры не трогаем — они старят (замер 18.08).
// Имена: обложка-<город>-3NN.jpg — прошлые нумерации (обложкаNN, -1N, -2N) не задеты, фильтр
// пула в assemble_girl их всё равно видит (маска ^обложка).
const path = require('path'), fs = require('fs');
process.chdir('/Users/qq/Desktop/neironka-poster');
const pk = require('/Users/qq/Desktop/neironka-poster/promptkit.cjs');
const { genToFile, spentSoFar } = require('/Users/qq/Desktop/neironka-poster/rgen.cjs');
const m = require('/Users/qq/Desktop/neironka-poster/locations-moscow.json');
const e = require('/Users/qq/Desktop/neironka-poster/locations-extra.json');
const все = Object.assign({}, m.locations, e.locations);
const годна = (k) => { try { pk.coverPrompt({ place: все[k].промпт, light: все[k].свет }); return true; } catch { return false; } };

// пулы по городам: питер/дубай/бали по префиксу, москва — всё остальное из московского файла
const пулПитер = Object.keys(все).filter((k) => /^питер/.test(k) && годна(k));
const пулДубай = Object.keys(все).filter((k) => /^дубай/.test(k) && годна(k));
const пулБали = Object.keys(все).filter((k) => /^бали/.test(k) && годна(k));
const пулМосква = Object.keys(все).filter((k) => !/^(питер|дубай|бали)/.test(k) && годна(k));
const ГОРОДА = { москва: пулМосква, питер: пулПитер, дубай: пулДубай, бали: пулБали };

// МИЛОТА: позы и одежда чередуются, чтобы 20 кадров не слиплись в один типаж
const ПОЗЫ = [
  'мягкая улыбка, голова чуть наклонена к плечу, взгляд прямо в камеру',
  'смеётся, глаза чуть прищурены, прядь волос у щеки',
  'спокойное милое лицо, губы чуть приоткрыты, смотрит снизу вверх',
  'улыбается уголками губ, подбородок чуть опущен, тёплый взгляд',
  'удивлённо приподняла брови и улыбнулась, ладонь у щеки',
  'смотрит через плечо и улыбается, волосы падают на плечо',
  'жмурится от солнца и смеётся, нос чуть морщится',
  'нежная полуулыбка, голова прямо, взгляд мягкий и открытый',
  'дует губы в шутку, глаза весёлые',
  'убирает прядь за ухо и улыбается в камеру',
];
const ОДЕЖДА = [
  'уютный светлый свитер оверсайз',
  'простой белый топ на тонких бретелях',
  'футболка пастельного цвета',
  'лёгкое летнее платье в мелкий цветок',
  'джинсовая рубашка поверх топа',
  'вязаный кроп-топ молочного цвета',
  'шёлковая блузка нежного оттенка',
  'спортивный топ и худи на плечах',
  'сарафан на тонких лямках',
  'мягкий кардиган поверх майки',
];
const МИЛО = 'ЛИЦО МИЛОЕ И НЕЖНОЕ: мягкие черты, чистая ровная кожа, живая эмоция, без строгости и без взрослой «дорогой» подачи.';

const D = process.env.HOME + '/Desktop/НЕЙРОНКА/ДОГЕН-РАБОТА';
const O = process.env.HOME + '/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН';
const ДЕВОЧКИ = (process.env.GIRLS || '').split(',').filter(Boolean);
const НАДО = Number(process.env.PER_GIRL || 20);
if (!ДЕВОЧКИ.length) { console.log('нет GIRLS'); process.exit(1); }
const h = (s) => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x >>> 0; };

const jobs = [];
for (const g of ДЕВОЧКИ) {
  const базаP = path.join(D, g + '.png'), базаJ = path.join(D, g + '.jpg');
  const база = fs.existsSync(базаP) ? базаP : базаJ;
  if (!fs.existsSync(база)) { console.log('НЕТ БАЗЫ', g); continue; }
  const od = path.join(O, g); fs.mkdirSync(od, { recursive: true });
  const наГород = Math.floor(НАДО / 4);
  let idx = 0;
  for (const [город, пул] of Object.entries(ГОРОДА)) {
    // свой порядок точек у каждой девочки: старт со сдвига по хешу, дальше по кругу
    const старт = h(g + город) % пул.length;
    for (let i = 0; i < наГород; i++) {
      const k = пул[(старт + i * 3 + Number(process.env.RETRY_SHIFT || 0)) % пул.length];
      const v = все[k];
      const n = idx++;
      const имя = 'обложка-' + город + '-3' + String(n).padStart(2, '0') + '.jpg';
      if (fs.existsSync(path.join(od, имя))) continue;
      const поза = ПОЗЫ[(h(g) + n) % ПОЗЫ.length] + '. ' + МИЛО;
      const одежда = ОДЕЖДА[(h(g + 'c') + n) % ОДЕЖДА.length];
      jobs.push(() => {
        try {
          const prompt = pk.coverPrompt({ place: v.промпт, light: v.свет, pose: поза, clothes: одежда });
          return genToFile(path.join(od, имя), { prompt, refFiles: [база], aspect: '9:16' })
            .then(() => console.log('OK', g, имя, k))
            .catch((err) => console.log('FAIL', g, имя, String(err.message || err).slice(0, 45)));
        } catch (err) { console.log('SKIP', g, имя, String(err.message || err).slice(0, 55)); return Promise.resolve(); }
      });
    }
  }
}
console.log('заказов:', jobs.length);
(async () => {
  for (let i = 0; i < jobs.length; i += 5) await Promise.all(jobs.slice(i, i + 5).map((f) => f()));
  console.log('SPENT', JSON.stringify(spentSoFar()));
})();
