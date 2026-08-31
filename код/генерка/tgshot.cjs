'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════
// СКРИН ПЕРЕПИСКИ ДЛЯ КАДРА 4 — ТРИ ФОРМАТА (27.08.2026, ТЗ владельца со скринами)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// ЗАЧЕМ НОВЫЙ ФАЙЛ. Старый tgreaction.cjs рисовал ОДИН формат (открытый чат) и держал в себе
// диалог с ответами девочки. Владелец прислал три референса со своего айфона и два правила,
// которые старую верстку ломают целиком, поэтому она остаётся для уже собранных постов, а новое
// живёт здесь.
//
// ДВА ПРАВИЛА ВЛАДЕЛЬЦА (нарушение = брак):
//   1. «там не должно быть ответов самой девочки, это входящее 1-2-3 сообщения».
//      Её пузырей нет. Совсем.
//   2. «нужно на генерации поменять галочки, они не реалистичные».
//      Галочки ✓✓ стоят у ОТПРАВЛЕННЫХ сообщений. Раз своих сообщений нет, то и галочек нет
//      нигде. В старой верстке они висели у её реплики в прелюдии — это он и заметил.
//
// ТРИ ФОРМАТА (по его скринам, снизу вверх по «глубине»):
//   'штора'  — баннер уведомления: ава, имя, две строки текста. Самый короткий взгляд.
//   'превью' — карточка чата под долгим нажатием, снизу меню Add to Folder / Mark as Read /
//              Pin / Mute / Delete. Фон затемнён. Самый «пойманный на живом» вид.
//   'чат'    — открытый диалог со статус-баром и полем ввода. Классика.
// Чередование форматов между постами делает ленту непохожей саму на себя.
//
// ОБОИ. На референсах владельца обои чата это РАЗМЫТАЯ ФОТОГРАФИЯ, а не узор с дудлами.
// Узор оставлен как один из вариантов, но по умолчанию идут размытые фото-обои: они и ближе
// к реальности, и не спорят с текстом.
//
// АВАТАРКА. Принимается файлом (ФОТО_АВЫ). Если файла нет, рисуется круг с инициалом: это
// заметно беднее, поэтому пул авок нужен обязательно.

const fs = require('node:fs');
const path = require('node:path');
const { renderHtml } = require(path.join(__dirname, '..', 'plates.cjs'));

// iPhone 15 Pro: рисуем в родном разрешении, потом вписываем в кадр ролика
const W = 1179, H = 2556;
const КАДР_W = 1080, КАДР_H = 1920;

const экр = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── ОБОИ ────────────────────────────────────────────────────────────────────────────────────
// Размытая фотография: несколько крупных цветовых пятен под сильным блюром плюс зерно.
// Именно так выглядят обои на референсе (голубовато-серое размытие с белёсыми разводами).
const ОБОИ = [
  { имя: 'сине-серые', пятна: ['#8fa4bb 14% 20%', '#dfe7f0 44% 44%', '#6d8299 74% 30%', '#c3d0de 32% 76%', '#4e6076 84% 88%'], фон: '#5d7186' },
  { имя: 'тёплый сумрак', пятна: ['#b09088 16% 22%', '#eddcd0 46% 46%', '#8a6a62 72% 28%', '#d9c3b4 30% 74%', '#5e4640 82% 86%'], фон: '#7d6259' },
  { имя: 'ночной город', пятна: ['#6d7bb0 12% 18%', '#c8d0ee 42% 42%', '#4a5a8c 70% 32%', '#9aa8d4 34% 72%', '#2c3558 86% 88%'], фон: '#4c5885' },
  { имя: 'зелень', пятна: ['#87a48d 15% 21%', '#dcead9 45% 45%', '#5d7a63 73% 29%', '#b6c9b2 31% 75%', '#3a5040 83% 87%'], фон: '#5a7361' },
  { имя: 'сирень', пятна: ['#9c8cc4 13% 19%', '#ddd3f0 43% 43%', '#6f5f96 71% 31%', '#c1b4dc 33% 73%', '#463a68 85% 89%'], фон: '#6a5b93' },
];

const ФАЙЛ_УЗОРА = path.join(__dirname, '..', 'brand', 'tg-pattern.svg');
const УЗОР = fs.existsSync(ФАЙЛ_УЗОРА)
  ? 'data:image/svg+xml;base64,' + fs.readFileSync(ФАЙЛ_УЗОРА).toString('base64') : '';

function фонCSS(вариант) {
  if (вариант === 'узор' && УЗОР) {
    return `background:#0d0d12;`
      + `--узор:url(${УЗОР});`;
  }
  const о = ОБОИ[вариант] || ОБОИ[0];
  const слои = о.пятна.map((п) => {
    const [цвет, x, y] = п.split(' ');
    return `radial-gradient(60% 46% at ${x} ${y}, ${цвет}, transparent 78%)`;
  }).join(',');
  return `background:${слои},${о.фон};`;
}

// ─── ИМЕНА КОНТАКТОВ ─────────────────────────────────────────────────────────────────────────
// Референс владельца: «Андрей Полуфабрикат». Живой телефон подписывает бывшего не по паспорту,
// а как запомнилось: кличка, ярлык, обстоятельство. Половина пула именно такая.
// Прозвища («Витя Токсик», «Саня Мимо») владелец завернул 27.08: подпись должна быть обычной,
// как в настоящем телефоне. Остаются имена и нейтральное «бывший».
const ИМЕНА = [
  'Андрей', 'Дима', 'Витя', 'Саша', 'Никита', 'Рома', 'Артём', 'Макс', 'Кирилл', 'Влад',
  'Егор', 'Тимур', 'Данил', 'Лёша', 'Гоша', 'Стас', 'Костя', 'Ваня', 'Серёжа', 'бывший',
];


// ─── ПОЛОСЫ ИЗ ГЕНЕРАЦИИ (идея владельца 27.08: «возьми себе верх и низ скрина + фон что я
// скинул, и у тебя норм будет получаться») ───────────────────────────────────────────────────
// Статус-бар и панель ввода вырезаны из удачной генерации (проба-02) и кладутся как картинки:
// это живой айфонный хром, который вёрсткой рисуется бедно. Имени в них нет, поэтому одни и те
// же полосы годятся на все скрины.
// ШАПКУ С НИКОМ НЕ БЕРЁМ: в генерации она вышла отдельной серой плашкой-капсулой, а владелец
// назвал это «окошко не реальное» — в настоящем клиенте шапка сливается с фоном. Рисуем сами,
// плоской, и заодно получаем сменное имя и аву.
const ЧАСТИ = process.env.HOME + '/Desktop/НЕЙРОНКА/ТГ-ЧАСТИ';
const дата = (ф) => {
  const п = path.join(ЧАСТИ, ф);
  if (!fs.existsSync(п)) return '';
  return 'data:image/png;base64,' + fs.readFileSync(п).toString('base64');
};
const ПОЛОСА_ВЕРХ = дата('статусбар.png');
const ПОЛОСА_НИЗ = дата('низ.png');
const АВЫ = (() => {
  try { return fs.readdirSync(ЧАСТИ).filter((f) => /^ава-.*\.(png|jpe?g)$/i.test(f)).sort(); }
  catch { return []; }
})();

const СТАТУСЫ = ['online', 'last seen recently', 'last seen just now', 'last seen 5 minutes ago'];

// ─── ЭЛЕМЕНТЫ ────────────────────────────────────────────────────────────────────────────────
const время12 = (м) => {
  const ч24 = Math.floor(м / 60) % 24, мм = м % 60;
  return `${((ч24 + 11) % 12) + 1}:${String(мм).padStart(2, '0')} ${ч24 >= 12 ? 'PM' : 'AM'}`;
};

const ава = (фото, имя, размер) => фото
  ? `<div class="ава" style="width:${размер}px;height:${размер}px;background-image:url(${фото})"></div>`
  : `<div class="ава пустая" style="width:${размер}px;height:${размер}px;font-size:${Math.round(размер * 0.42)}px">${экр(имя.trim()[0].toUpperCase())}</div>`;

const статусБар = (время, батарея, зарядка) => `<div class="статус">
  <div class="ст-время">${время}</div>
  <div class="ст-право">
    <svg width="34" height="22" viewBox="0 0 30 20"><g fill="#fff">
      <rect x="0" y="12" width="4" height="8" rx="1.2"/><rect x="6.5" y="9" width="4" height="11" rx="1.2"/>
      <rect x="13" y="5.5" width="4" height="14.5" rx="1.2"/><rect x="19.5" y="2" width="4" height="18" rx="1.2"/></g></svg>
    <svg width="30" height="22" viewBox="0 0 26 20"><path fill="#fff" d="M13 17l-4-4.6a6 6 0 018 0L13 17zM5.2 8.4a12 12 0 0115.6 0l-2.4 2.5a8.6 8.6 0 00-10.8 0L5.2 8.4z"/></svg>
    <div class="бат ${зарядка ? 'заряд' : ''}"><span>${батарея}</span></div>
  </div>
</div>`;

const пузырь = (текст, время) => `<div class="ряд">
  <div class="пузырь"><span class="тек">${экр(текст).replace(/\n/g, '<br>')}</span><span class="мета">${время}</span></div>
</div>`;

// ─── ОБЩИЙ CSS ───────────────────────────────────────────────────────────────────────────────
const СТИЛЬ = (фон) => `
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;overflow:hidden;color:#fff;position:relative;
  font-family:-apple-system,"SF Pro Text","Helvetica Neue","Segoe UI",Roboto,Arial,sans-serif;
  ${фон}}
/* зерно поверх обоев: без него размытие выглядит нарисованным градиентом, а не фото */
body::after{content:'';position:absolute;inset:0;pointer-events:none;opacity:.22;z-index:0;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/></filter><rect width='140' height='140' filter='url(%23n)' opacity='.5'/></svg>")}
.узорслой{position:absolute;inset:0;background:var(--узор) repeat;background-size:760px auto;opacity:.30;z-index:0}
body>*:not(.узорслой){position:relative;z-index:1}
.ава{border-radius:50%;background-size:cover;background-position:center;flex:0 0 auto}
.ава.пустая{display:flex;align-items:center;justify-content:center;font-weight:600;
  background:linear-gradient(160deg,#7d6cf0,#5a49c8);color:#fff}
.статус{height:96px;display:flex;align-items:center;justify-content:space-between;
  padding:0 52px 0 58px;font-size:36px;font-weight:600;letter-spacing:.3px}
.ст-право{display:flex;align-items:center;gap:15px}
.бат{width:68px;height:33px;border-radius:10px;background:#fff;color:#000;display:flex;
  align-items:center;justify-content:center;font-size:24px;font-weight:600}
.бат.заряд{background:#3ad35f;color:#0b2b13}
.ряд{display:flex;padding:0 26px 14px}
.пузырь{max-width:76%;background:rgba(28,28,32,.92);border-radius:26px;padding:22px 30px 18px;
  display:flex;align-items:flex-end;gap:16px;position:relative}
.пузырь::after{content:'';position:absolute;left:-10px;bottom:0;width:26px;height:26px;
  background:rgba(28,28,32,.92);clip-path:path('M26 26C13 26 4 18 0 0v26z')}
.тек{font-size:40px;line-height:1.28;letter-spacing:-.2px}
.мета{font-size:26px;color:#9a9aa2;white-space:nowrap;padding-bottom:5px}
.день{align-self:center;margin:0 auto 26px;background:rgba(0,0,0,.42);border-radius:22px;
  padding:9px 26px;font-size:28px;font-weight:600}
`;

// ─── ФОРМАТ 1: ОТКРЫТЫЙ ЧАТ ──────────────────────────────────────────────────────────────────
function htmlЧат(о) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${СТИЛЬ(о.фон)}
  body{display:flex;flex-direction:column}
  .полоса{width:100%;display:block;flex:0 0 auto}
  /* ШАПКА ПЛОСКАЯ. Никакой капсулы вокруг ника: панель во всю ширину, чуть темнее фона,
     с размытием под собой — так это выглядит в клиенте. */
  .шапка{flex:0 0 132px;display:flex;align-items:center;gap:20px;padding:0 30px;
    background:rgba(20,22,28,.86);backdrop-filter:blur(30px);
    border-bottom:1px solid rgba(255,255,255,.06)}
  .назад{font-size:62px;color:#3f8ae0;line-height:1;padding-bottom:10px;font-weight:300}
  .кто{flex:1 1 auto;min-width:0;text-align:center}
  .кто .имя{font-size:38px;font-weight:700;line-height:1.12;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  .кто .был{font-size:28px;color:#8d93a1;margin-top:4px}
  .чат{flex:1 1 auto;display:flex;flex-direction:column;padding-top:26px}
  </style></head><body>
  ${о.узор ? '<div class="узорслой"></div>' : ''}
  ${ПОЛОСА_ВЕРХ ? `<img class="полоса" src="${ПОЛОСА_ВЕРХ}">` : статусБар(о.времяБара, о.батарея, о.зарядка)}
  <div class="шапка">
    <div class="назад">‹</div>
    <div class="кто"><div class="имя">${экр(о.имя)}</div><div class="был">${о.статус}</div></div>
    ${ава(о.фото, о.имя, 96)}
  </div>
  <div class="чат"><div class="день">Today</div>${о.пузыри}</div>
  ${ПОЛОСА_НИЗ ? `<img class="полоса" src="${ПОЛОСА_НИЗ}">` : ''}
  </body></html>`;
}

// ─── ФОРМАТ 2: ПРЕВЬЮ ПОД ДОЛГИМ НАЖАТИЕМ ────────────────────────────────────────────────────
// Референс владельца: карточка чата всплыла над затемнённым списком, снизу контекстное меню.
const ПУНКТЫ = [
  ['M9 4h6l2 3h4a1 1 0 011 1v11a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h6z', 'Add to Folder'],
  ['M4 12l5 5L20 6', 'Mark as Read'],
  ['M12 3v12m0 6l-4-6h8l-4 6z', 'Pin'],
  ['M18 8a6 6 0 00-12 0v5l-2 3h16l-2-3V8zM3 3l18 18', 'Mute'],
  ['M6 7h12l-1 13H7L6 7zm3-3h6l1 3H8l1-3z', 'Delete'],
];

function htmlПревью(о) {
  const меню = ПУНКТЫ.map(([d, т], i) => `<div class="пункт ${т === 'Delete' ? 'красный' : ''}">
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="${d}"/></svg>
    <span>${т}</span></div>${i < ПУНКТЫ.length - 1 ? '<div class="делитель"></div>' : ''}`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${СТИЛЬ(о.фон)}
  /* затемнение: карточку выхватили из списка, остальное ушло в тень.
     Кладём слоем ПОД содержимым (z-index:0), иначе оно накрывает карточку и меню. */
  body::before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:0}
  body{display:flex;flex-direction:column;justify-content:center;padding:0 44px}
  .карточка{border-radius:38px;overflow:hidden;${о.фон};height:1000px;flex:0 0 auto;
    display:flex;flex-direction:column;box-shadow:0 40px 90px rgba(0,0,0,.55);margin-bottom:44px}
  .кшапка{flex:0 0 118px;display:flex;align-items:center;gap:20px;padding:0 26px}
  .кназад{font-size:56px;color:#8f8fe0;line-height:1;padding-bottom:6px}
  .кпилюля{flex:1 1 auto;min-width:0;background:rgba(38,38,44,.78);border-radius:30px;
    padding:14px 26px;text-align:center}
  .кпилюля .имя{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .кпилюля .имя{font-size:36px;font-weight:700;line-height:1.1}
  .кпилюля .был{font-size:26px;color:#7fb3e8;margin-top:3px}
  .ктело{flex:1 1 auto;display:flex;flex-direction:column;padding-top:22px}
  .меню{margin-left:210px;flex:0 0 auto;
    background:rgba(38,38,42,.94);border-radius:30px;overflow:hidden;backdrop-filter:blur(30px)}
  .пункт{display:flex;align-items:center;gap:26px;padding:30px 34px;font-size:38px;color:#fff}
  .пункт.красный{color:#ff453a}
  .делитель{height:1px;background:rgba(255,255,255,.10);margin-left:100px}
  </style></head><body>
  ${о.узор ? '<div class="узорслой"></div>' : ''}
  <div class="карточка">
    ${о.узор ? '<div class="узорслой"></div>' : ''}
    <div class="кшапка">
      <div class="кназад">‹</div>
      <div class="кпилюля"><div class="имя">${экр(о.имя)}</div><div class="был">${о.статус}</div></div>
      ${ава(о.фото, о.имя, 88)}
    </div>
    <div class="ктело"><div class="день">Today</div>${о.пузыри}</div>
  </div>
  <div class="меню">${меню}</div>
  </body></html>`;
}

// ─── ФОРМАТ 3: БАННЕР-ШТОРКА ─────────────────────────────────────────────────────────────────
// Референс владельца: узкая карточка уведомления, ава слева, имя жирным, текст в две строки.
function htmlШтора(о) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${СТИЛЬ(о.фон)}
  body{display:flex;align-items:flex-start;justify-content:center;padding-top:210px}
  .баннер{width:1080px;background:rgba(38,38,42,.93);border-radius:44px;padding:34px 40px;
    display:flex;gap:28px;align-items:flex-start;backdrop-filter:blur(40px);
    box-shadow:0 26px 60px rgba(0,0,0,.5)}
  .бтекст{flex:1 1 auto;min-width:0}
  .бимя{font-size:38px;font-weight:700;margin-bottom:8px}
  .бтело{font-size:38px;line-height:1.3;color:#f2f2f5}
  </style></head><body>
  <div class="баннер">
    ${ава(о.фото, о.имя, 92)}
    <div class="бтекст"><div class="бимя">${экр(о.имя)}</div><div class="бтело">${экр(о.текст).replace(/\n/g, '<br>')}</div></div>
  </div>
  </body></html>`;
}

/**
 * Собрать скрин переписки.
 * @param {string} out куда положить jpg 1080x1920
 * @param {object} п параметры
 * @param {string[]} п.сообщения 1-3 ВХОДЯЩИХ сообщения (свои реплики запрещены)
 * @param {string} [п.формат] 'чат' | 'превью' | 'штора'; по умолчанию выбирается по ключу
 * @param {string} [п.ключ] id поста: от него детерминированно берутся имя, обои, время, батарея
 * @param {string} [п.имя] имя контакта; по умолчанию из пула
 * @param {string} [п.фото] путь к аватарке (jpg/png)
 */
async function собрать(out, п = {}) {
  const сообщения = (п.сообщения || []).filter(Boolean).slice(0, 3);
  if (!сообщения.length) throw new Error('tgshot: нужно хотя бы одно входящее сообщение');
  const ключ = String(п.ключ || out);
  const хэш = [...ключ].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  const форматы = ['чат', 'превью', 'штора'];
  const формат = п.формат && форматы.includes(п.формат) ? п.формат : форматы[хэш % форматы.length];
  const имя = п.имя || ИМЕНА[(хэш >>> 3) % ИМЕНА.length];
  const статус = СТАТУСЫ[(хэш >>> 5) % СТАТУСЫ.length];
  // Владелец прислал ссылку на стандартные обои телеграма со словами «вот фон»: дудл-узор
  // теперь основной, размытое фото остаётся редким разнообразием.
  const узор = ((хэш >>> 7) % 4) !== 0 && !!УЗОР;
  const фон = фонCSS(узор ? 'узор' : ((хэш >>> 9) % ОБОИ.length));
  const час = 9 + ((хэш >>> 11) % 13);
  const мин = (хэш >>> 13) % 60;
  const минуты = час * 60 + мин;
  const батарея = 24 + ((хэш >>> 17) % 70);
  const зарядка = ((хэш >>> 19) % 3) === 0;

  let фото = '';
  if (!п.фото && АВЫ.length) п.фото = path.join(ЧАСТИ, АВЫ[(хэш >>> 21) % АВЫ.length]);
  if (п.фото && fs.existsSync(п.фото)) {
    const тип = /\.png$/i.test(п.фото) ? 'png' : 'jpeg';
    фото = `data:image/${тип};base64,` + fs.readFileSync(п.фото).toString('base64');
  }

  const пузыри = сообщения.map((т, i) => пузырь(т, время12(минуты + i))).join('');
  const о = { имя, статус, фон, узор, пузыри, фото,
    времяБара: время12(минуты + сообщения.length).replace(/\s?[AP]M$/, ''),
    батарея, зарядка, текст: сообщения.join('\n') };

  const html = формат === 'чат' ? htmlЧат(о) : формат === 'превью' ? htmlПревью(о) : htmlШтора(о);
  const сырой = out.replace(/(\.\w+)$/, '.экран$1');
  await renderHtml(html, сырой, W, H);

  const { execFileSync } = require('node:child_process');
  const FF = require(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static'));
  // вписываем айфонные пропорции в кадр ролика: по высоте, поля по бокам под цвет обоев
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', сырой,
    '-vf', `scale=-2:${КАДР_H},pad=${КАДР_W}:${КАДР_H}:(ow-iw)/2:0:color=0x16181d`,
    '-q:v', '2', out]);
  try { fs.unlinkSync(сырой); } catch {}
  return { формат, имя, статус, сообщения, обои: узор ? 'узор' : 'фото' };
}

module.exports = { собрать, ИМЕНА, ОБОИ, W, H };
