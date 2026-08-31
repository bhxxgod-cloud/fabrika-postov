// Проба: принимает ли RenderGrid исходное фото как основу (image-to-image).
// Без этого генерация даёт ДРУГОЕ лицо, и «10 образов модели» превращаются в 10 разных девушек.
//
// ВНИМАНИЕ, ЭТА ПРОБА УЖЕ ОДИН РАЗ СОВРАЛА (09.08). Она останавливалась на первом ответе с r.ok и
// объявляла поле рабочим, а API отвечает 202 на ЛЮБОЕ тело: незнакомые поля он молча выбрасывает.
// Так поле `images` попало в проект как рабочее, хотя его не существует, и все образы две недели
// генерились без референса. Правильный ответ: поле `image_urls` с настоящей публичной http-ссылкой,
// а честный признак того, что поле знакомо API, это осмысленный 400 на заведомо негодное значение.
// Поэтому проба теперь идёт до конца, проверяет поля мусорным значением и НЕ считает 202 успехом.
const fs = require('node:fs');
const KEY = fs.readFileSync('/tmp/.rgkey', 'utf8').trim();
const BASE = 'https://api.rendergrid.io/api/public/v1';
const SRC = process.argv[2];
const b64 = fs.readFileSync(SRC).toString('base64');
const dataUrl = `data:image/jpeg;base64,${b64}`;

// Мусорное значение специально не похоже ни на файл, ни на ссылку: знакомое полю API ответит 400
// с именем поля, незнакомое проглотит и ответит 202.
const JUNK = ['zzz-not-an-image'];
const FIELDS = ['image_urls', 'images', 'reference_images', 'input_images', 'zzz_unknown'];

(async () => {
  console.log(`исходник: ${SRC} (${(b64.length / 1365).toFixed(0)} КБ в base64, в пробу не уходит)`);
  console.log('Проверяем ИМЕНА полей мусорным значением. 400 с именем поля = поле знакомо API,');
  console.log('202 = поле выброшено и референса у модели не будет.\n');
  const known = [];
  for (const name of FIELDS) {
    const body = { model: 'nano-banana-2', prompt: 'probe', aspect_ratio: '1:1', [name]: JUNK };
    const r = await fetch(`${BASE}/images/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    }).catch((e) => ({ ok: false, status: 0, _e: e.message }));
    const txt = r.text ? await r.text().catch(() => '') : (r._e || '');
    const verdict = r.status === 400 && txt.includes(name) ? 'ЗНАКОМО API' : 'выброшено (референса не будет)';
    if (r.status === 400 && txt.includes(name)) known.push(name);
    console.log(`  ${name.padEnd(18)} → HTTP ${r.status} ${verdict}`);
    // Код 202 это поставленная задача, то есть уже потраченные деньги. Предупреждаем вслух.
    if (r.status === 202) console.log(`  ${''.padEnd(18)}   внимание: заказ поставлен, деньги списаны`);
  }
  console.log(`\nполя, которые API действительно знает: ${known.join(', ') || 'ни одного'}`);
  console.log('дальше проверять УЖЕ ГЛАЗАМИ: годное значение в знакомое поле и сверка лица с исходником.');
})();
