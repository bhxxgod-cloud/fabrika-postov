'use strict';
// ПОДПИСИ + ТЕГИ ИЗ УТВЕРЖДЁННОГО МД (разделы ПОДПИСИ / ХЕШТЕГИ). Пара «хук → первая строка» берётся
// точно, если есть; иначе правило «что было после + где взяла» по шаблону. Тире нигде.
const fs = require('node:fs');
const txt = fs.readFileSync(process.env.HOME + '/Desktop/НЕЙРОНКА/ЛОГИКА-ХУКОВ-НОВАЯ-15-08.md', 'utf8');
const ПАРЫ = {}; for (const m of txt.matchAll(/^- (.+?) → (.+?)$/gm)) ПАРЫ[m[1].trim()] = m[2].replace(/…\s*$/, '').trim();
const ТЕГИ_МД = txt.split('## ХЕШТЕГИ')[1] || '';
const ТЕГИ = {}; for (const m of ТЕГИ_МД.matchAll(/([а-яёa-z0-9-]+(?: [а-яё-]+)?) ((?:#[^\s·]+\s*){3})/gi)) ТЕГИ[m[1].trim().toLowerCase()] = m[2].trim().split(/\s+/);
const КЛЮЧ = { 'img-lip-guide': 'губы', 'img-brow-map': 'брови', 'img-nose-verdict': 'нос', 'img-haircut-match': 'стрижка', 'img-makeup-colortype': 'мейк', 'img-face-report': 'оценка', 'img-beauty-guide': 'гайд общий', 'img-new-forms': 'new-forms', 'img-anime': 'аниме', 'img-pixar-3d': 'пиксар', 'img-popart': 'попарт', 'img-fantasy-char': 'фэнтези', 'img-gta': 'gta', 'img-sketch-collage': 'скетч', 'img-avatar': 'аватар', 'img-winx-fairy': 'винкс', 'img-plush-toy': 'плюш', 'img-heart-hair': 'сердечки', 'img-bw-fingers': 'bw-fingers', 'img-bw-editorial': 'bw-editorial', 'img-canon-g7x': 'canon', 'img-retro-90s': 'retro', 'img-golden-portrait': 'golden', 'img-double-exposure': 'double', 'img-rain-look': 'rain', 'img-medieval-photo': 'medieval', 'img-flower-cloud': 'flowers', 'img-doodle-watercolor': 'doodle', 'img-photo-restore': 'restore', 'img-business-portrait': 'business', 'img-tryon': 'tryon', 'img-rolls-selfie': 'rolls', 'img-bmw-photo': 'bmw', 'img-pilot-girl': 'pilot', 'img-boyfriend-match': 'boyfriend' };
const НАЗВАНИЕ = { 'img-lip-guide': 'гайд по губам', 'img-brow-map': 'карта бровей', 'img-nose-verdict': 'разбор носика', 'img-haircut-match': 'подбор стрижки', 'img-makeup-colortype': 'макияж по цветотипу', 'img-face-report': 'оценка внешности', 'img-beauty-guide': 'бьюти-гайд', 'img-new-forms': 'твой лучший размер', 'img-anime': 'аниме-версия', 'img-pixar-3d': 'мультяшная версия', 'img-popart': 'поп-арт постер', 'img-fantasy-char': 'фэнтези-персонаж', 'img-gta': 'обложка gta', 'img-winx-fairy': 'фея винкс', 'img-plush-toy': 'плюшевая версия', 'img-bw-editorial': 'чб портрет', 'img-retro-90s': 'фото из 90-х', 'img-golden-portrait': 'золотой час', 'img-double-exposure': 'двойная экспозиция', 'img-doodle-watercolor': 'акварельный портрет', 'img-business-portrait': 'деловое фото', 'img-tryon': 'примерка образа', 'img-boyfriend-match': 'подбор парня по типажу' };
const ОБЩИЕ_IG = ['#нейросеть', '#тренд', '#гайд', '#ии', '#промпт'], ОБЩИЕ_TT = ['#рек', '#fyp', '#нейросеть'];
const h32 = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h >>> 0; };
const rot = (arr, n) => arr.slice(n % arr.length).concat(arr.slice(0, n % arr.length));
const ПОСЛЕ = (tpl, хук) => {
  if (ПАРЫ[хук]) return ПАРЫ[хук];
  const n = НАЗВАНИЕ[tpl] || 'тренд'; const подп = /подписчиц/i.test(хук);
  if (подп) return 'она попросила честно, я честно) следующую беру из комментов. хочешь такой же ' + n + ': ';
  const карт = /guide|map|verdict|match|colortype|report|forms/.test(tpl);
  return карт ? 'сделала ' + n + ' по одной фотке и теперь смотрю на себя иначе. если тоже хочешь проверить, вот где брала: '
              : 'одна фотка, минута, и у меня ' + n + '. если тоже хочешь, вот где: ';
};
function теги(tpl, seed, платформа, подписчица) {
  let т = (ТЕГИ[КЛЮЧ[tpl]] || ['#нейронка', '#тренд', '#эстетика']).slice(0, 3);
  if (подписчица) т = ['#разборвнешности', ...т.slice(0, 2)];
  const общ = rot(платформа === 'tt' ? ОБЩИЕ_TT : ОБЩИЕ_IG, h32(seed)).slice(0, 2);
  return [...т, ...общ].join(' ');
}
function подписи(tpl, хук, seed) {
  const подп = /подписчиц/i.test(хук); const после = ПОСЛЕ(tpl, хук); const n = НАЗВАНИЕ[tpl] || 'этот тренд';
  const ig = `${после}${/: $/.test(после) ? '' : ' '}набери в яндексе «нейронка про промпты», загрузи одно селфи и выбери «${n}»\n\n${теги(tpl, seed, 'ig', подп)}`;
  const tt = `${хук.toUpperCase().replace(/[)(]+$/, '')}\n1. набери в яндексе «нейронка про шаблоны»\n2. загрузи одно селфи\n3. выбери «${n}» и жди минуту\n\n${теги(tpl, seed, 'tt', подп)}`;
  return { ig, tt };
}
module.exports = { подписи, теги, ПАРЫ, ТЕГИ };
if (require.main === module) { console.log('пар:', Object.keys(ПАРЫ).length, 'тегов:', Object.keys(ТЕГИ).length); console.log(подписи('img-lip-guide', 'после гайда по губам меня спросили, где делала))', 'x')); console.log(подписи('img-nose-verdict', 'теперь я больше не хочу сделать себе нос))', 'y')); }
