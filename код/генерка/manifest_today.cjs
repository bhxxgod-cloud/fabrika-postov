'use strict';
// МАНИФЕСТ СЕГОДНЯШНЕЙ ГОРОДСКОЙ ВОЛНЫ для ютуб-постера (запрос чата «ПОСТИНГ ЮТ» 21.08).
// Формат строки: путь;шаблон;статус. Статусы: готов | пересборка (не брать) | ожидается.
const fs = require('fs'), path = require('path');
const OUT = process.env.HOME + '/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ';
const МАНИФЕСТ = process.env.HOME + '/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/манифест-сегодня.txt';
const ДЕВОЧКИ = ['мила-d01','мила-p01','мила-p02','мила-p03','мила-p04','мила-p05','мила-p07','мила-p08','мила-p09','мила-p10','мила-n01','мила-n02','мила-n03','мила-n04'];
const ШАБЛОНЫ = ['beauty-guide','nose-verdict','haircut-match','brow-map','makeup-colortype','boyfriend-match'];
// пересборка: у n02-beauty-guide-p2 старый хук запечён на кадре, файл заменяется на месте.
// Считаем пересобранным, когда в журнале сборки последняя OK-строка этого id уже без старого хука.
const жур = fs.existsSync(path.join(OUT, '_сборка.log')) ? fs.readFileSync(path.join(OUT, '_сборка.log'), 'utf8') : '';
const послOK = жур.split('\n').filter((s) => s.startsWith('OK мила-n02-beauty-guide-p2')).pop() || '';
const ПЕРЕСБОРКА = new Set(послOK.includes('носила не своё') || !послOK ? ['мила-n02-beauty-guide-p2.mp4'] : []);
const строки = [];
for (const g of ДЕВОЧКИ) for (const t of ШАБЛОНЫ) {
  const f = `${g}-${t}-p2.mp4`; const p = path.join(OUT, g, f);
  const статус = ПЕРЕСБОРКА.has(f) ? 'пересборка (не брать)' : fs.existsSync(p) ? 'готов' : 'ожидается';
  строки.push(`${p};${t};${статус}`);
}
fs.writeFileSync(МАНИФЕСТ, строки.join('\n') + '\n');
const готово = строки.filter((s) => s.endsWith(';готов')).length;
console.log(`манифест: ${готово} готов, ${строки.length - готово} прочих из ${строки.length}`);
