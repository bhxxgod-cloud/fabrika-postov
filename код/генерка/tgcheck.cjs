// ПРИЁМКА СГЕНЕРЁННЫХ СКРИНОВ ТЕЛЕГРАМА (27.08.2026).
//
// ЗАЧЕМ. Модель рисует скрин чисто примерно в четырёх случаях из пяти, но пятый уходит в брак:
// поплывший текст («отпустил🙂устил»), вернувшиеся галочки, английские подписи «Back» и «Today»
// вопреки прямому запрету в промпте. Глазами тридцать штук не пересмотришь, и брак уедет в ленту.
//
// КАК. Текст со скрина снимается через macOS Vision (~/.neironka/bin/textbox — родня facebox,
// которым чинили детектор лиц, когда не встал cv2). Дальше сверка с тем, что заказывали.
//
// ЧТО ЛОВИТ:
//   • реплики нет или она искажена — главный брак, ради него всё и затевалось;
//   • английские подписи в русском интерфейсе;
//   • ник не тот, что заказывали;
//   • подозрение на дубль слова (склейка вида «отпустилустил»).
// Галочки Vision не видит, поэтому они остаются на глаз — но их видно на превью сразу.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const TEXTBOX = process.env.HOME + '/.neironka/bin/textbox';
const АНГЛИЦИЗМЫ = ['back', 'today', 'last seen', 'message', 'yesterday', 'online'];

const норм = (s) => String(s).toLowerCase().replace(/[^a-zа-яё0-9?]+/gi, ' ').trim();

function читать(файл) {
  try {
    return execFileSync(TEXTBOX, [файл], { encoding: 'utf8', timeout: 60000 })
      .split('\n').filter(Boolean)
      .map((l) => { const [c, ...t] = l.split('\t'); return { c: Number(c), т: t.join('\t') }; });
  } catch (e) { return null; }
}

/** @returns {{ок:boolean, беды:string[], текст:string}} */
function принять(файл, { сообщения = [], имя = '' } = {}) {
  const строки = читать(файл);
  if (!строки) return { ок: false, беды: ['vision не прочитал файл'], текст: '' };
  const всё = строки.map((s) => s.т).join(' | ');
  const плоско = норм(всё);
  const беды = [];

  // 1) реплики на месте? сверяем по словам: OCR может слепить строки, но слова обязаны быть
  for (const м of сообщения) {
    const слова = норм(м).split(' ').filter((w) => w.length > 2);
    const нет = слова.filter((w) => !плоско.includes(w));
    if (нет.length) беды.push(`нет слов из реплики: ${нет.join(', ')}`);
  }

  // 2) английские подписи в русском интерфейсе
  for (const а of АНГЛИЦИЗМЫ) if (плоско.includes(а)) беды.push(`английская подпись «${а}»`);

  // 3) ник
  if (имя) {
    const чистое = норм(имя.replace(/[^\p{L}\s]/gu, ''));
    if (чистое && !плоско.includes(чистое)) беды.push(`ник «${имя}» не найден`);
  }

  // 4) склейка слова: «отпустилустил». Ищем внутри слова повтор хвоста длиной 4+
  for (const s of строки) {
    for (const w of норм(s.т).split(' ')) {
      if (w.length < 9) continue;
      for (let k = 4; k <= Math.floor(w.length / 2); k++) {
        if (w.slice(-k) === w.slice(-2 * k, -k)) { беды.push(`похоже на склейку: «${w}»`); break; }
      }
    }
  }
  return { ок: беды.length === 0, беды: [...new Set(беды)], текст: всё };
}

if (require.main === module) {
  const папка = process.argv[2];
  const реестр = process.argv[3];  // json: [{файл, сообщения, имя}]
  if (!папка) { console.log('приём: node tgприем.cjs <папка> [реестр.json]'); process.exit(1); }
  const мета = реестр && fs.existsSync(реестр) ? JSON.parse(fs.readFileSync(реестр, 'utf8')) : {};
  const файлы = fs.readdirSync(папка).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  let годных = 0;
  for (const f of файлы) {
    const м = мета[f] || {};
    const р = принять(path.join(папка, f), м);
    if (р.ок) { годных++; console.log('OK  ', f); }
    else console.log('БРАК', f, '|', р.беды.join('; '));
  }
  console.log(`\nгодных: ${годных}/${файлы.length}`);
}

module.exports = { принять, читать };
