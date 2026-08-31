'use strict';
// reelbatch.cjs — ПОРЦИИ РИЛСОВ ПОД ЗАЛИВ С РЕЕСТРОМ ИЗРАСХОДОВАННОГО (15.08).
//
// ЗАЧЕМ. Задача владельца: «выложить сегодня 700 рилсов, можно по 3 с акка раз в 6-8 часов».
// 700 рилсов = 700 УНИКАЛЬНЫХ файлов: один файл на два аккаунта не кладём никогда, это след для
// связывания сетки. Магос просит порциями по 150, чтобы владелец не таскал один гигантский архив.
//
// ГЛАВНОЕ — РЕЕСТР ИЗРАСХОДОВАННОГО ЖИВЁТ ЗДЕСЬ. Магос в логе пишет «account <ник> succes», но
// имя файла НЕ показывает, поэтому связку «какой ролик кому» с его стороны не восстановить.
// Значит правда о том, что ушло, должна писаться на нашей стороне В МОМЕНТ СБОРКИ АРХИВА: каждая
// порция получает номер, каждый файл в ней — позицию, и это записывается в реестр ДО того, как
// архив уехал. Магос раздаёт файлы по порядку, так что «порция 3, файл 047» и есть связка с
// 47-м аккаунтом этой задачи. Без реестра третий залив начал бы слать людям то же самое.
//
// КАК ВЫБИРАЕМ. Из сокровищницы, исключая всё, что уже в реестре, — и по имени файла, и по ID
// поста (один пост у нас нарезан двумя слотами в два разных файла: одинаковое видео под разными
// именами). Разводим по девочкам по кругу: сначала по одному ролику с каждой, потом по второму.
// Приоритет новой схеме (с плитками и хуками из пула), внутри — свежие.
//
// Запуск:
//   node reelbatch.cjs <сколько> [имя-порции]   → архив на столе + запись в реестр
//   node reelbatch.cjs --остаток                → сколько свободных осталось
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const м = require('./места.cjs');

const РЕЕСТР = path.join(os.homedir(), '.neironka', 'reels', 'израсходовано.jsonl');
fs.mkdirSync(path.dirname(РЕЕСТР), { recursive: true });

// Реестр — по строке на файл: {порция, позиция, файл, id_поста, девочка, когда}
function реестр() {
  // БИТАЯ СТРОКА ≠ ПУСТОЙ РЕЕСТР (аудит 15.08). Было: любая ошибка парсинга → [] → все ролики
  // «свободны» → следующая порция шлёт людям уже ушедшие. Ровно тот дубль, от которого реестр
  // заводили. Теперь: нет файла — пусто (честно); есть файл, но строка не парсится — это
  // обрезанный хвост после падения (одна последняя строка) либо чужой мусор. Последнюю битую
  // строку отбрасываем с криком, любую другую — СТОП, руками разбирать, а не гадать.
  if (!fs.existsSync(РЕЕСТР)) return [];
  const строки = fs.readFileSync(РЕЕСТР, 'utf8').split('\n').filter(Boolean);
  const из = [];
  строки.forEach((s, i) => {
    try { из.push(JSON.parse(s)); }
    catch {
      if (i === строки.length - 1) { console.log(`  ⚠ реестр: последняя строка обрезана (падение при записи), отброшена: ${s.slice(0, 60)}`); return; }
      console.error(`СТОП: реестр ${РЕЕСТР} битый на строке ${i + 1} — чинить руками, иначе порция уйдёт с дублями`);
      process.exit(2);
    }
  });
  return из;
}
const pid = (f) => { const m = f.match(/_([0-9a-f]{8})\.mp4$/); return m ? m[1] : null; };
function девочка(f) {
  const m = f.match(/^reel_\d+[a-z0-9]*_(.+?)(?:_[0-9a-f]{8})?\.mp4$/);
  if (m) return m[1].replace(/^[a-z]\d_/, '').replace(/-(img|doodle|hearts|face|brow|lip|nose|sketch|bw|canon|double|fantasy|beauty|boyfriend|rain|haircut|makeup|new|glow|magazine|photo).*$/, '');
  const m2 = f.match(/^(.+?)-(anime|pixar-3d|lip-guide|brow-map|nose-verdict|haircut-match|makeup-colortype|face-report|new-forms|[a-z0-9-]+)-p\d\.mp4$/);
  return m2 ? m2[1] : f;
}

// ЗАСЕВ РЕЕСТРА из уже ушедших архивов (один раз): до этого файла израсходованное жило в zip-ах на
// столе и в архиве, и сверять приходилось по ним. Переносим их в реестр, чтобы источник был один.
function засеять() {
  const есть = new Set(реестр().map((r) => r.файл));
  const источники = [
    ['15-08-старые285', 'НЕЙРОНКА/ЗАЛИВЫ-АРХИВ/15-08/ЗАЛИВ-15-08-РИЛСЫ.zip'],
    ['15-08-новые100', 'НЕЙРОНКА/ЗАЛИВЫ-АРХИВ/15-08/ЗАЛИВ-15-08-РИЛСЫ-НОВЫЕ100.zip'],
    ['15-08-старым95', 'ЗАЛИВ-15-08-РИЛСЫ-СТАРЫМ95.zip'],
    ['15-08-IAM126', 'ЗАЛИВ-15-08-РИЛСЫ-IAM126.zip'],
  ];
  let n = 0;
  for (const [порция, rel] of источники) {
    const z = path.join(os.homedir(), 'Desktop', rel);
    if (!fs.existsSync(z)) continue;
    const список = execFileSync('unzip', ['-Z1', z], { encoding: 'utf8' }).split('\n').filter((s) => s.endsWith('.mp4'));
    список.forEach((имяВАрхиве, i) => {
      const f = path.basename(имяВАрхиве).replace(/^[a-z]?\d+_/, '');
      if (есть.has(f)) return;
      fs.appendFileSync(РЕЕСТР, JSON.stringify({ порция, позиция: i + 1, файл: f, id_поста: pid(f), девочка: девочка(f), когда: 'засев' }) + '\n');
      есть.add(f); n++;
    });
  }
  if (n) console.log(`реестр засеян из прежних архивов: +${n}`);
}

function свободные() {
  const р = реестр();
  const заняты = new Set(р.map((r) => r.файл));
  const занятыеИд = new Set(р.map((r) => r.id_поста).filter(Boolean));
  const годные = м.годные();
  return fs.readdirSync(годные)
    .filter((f) => f.endsWith('.mp4') && м.нашРилс(f) && !заняты.has(f) && !(pid(f) && занятыеИд.has(pid(f))))
    .map((f) => ({ f, путь: path.join(годные, f), д: девочка(f), новая: /-p\d\.mp4$/.test(f), t: fs.statSync(path.join(годные, f)).mtimeMs }));
}

(function main() {
  засеять();
  if (process.argv.includes('--остаток')) {
    const св = свободные();
    console.log(`израсходовано: ${реестр().length} · свободных: ${св.length} · девочек среди свободных: ${new Set(св.map((x) => x.д)).size}`);
    return;
  }
  const N = Number(process.argv[2]);
  if (!N) { console.log('usage: node reelbatch.cjs <сколько> [имя-порции] | --остаток'); process.exit(1); }
  const имя = process.argv[3] || `порция-${new Date().toISOString().slice(5, 16).replace(/[T:]/g, '-')}`;
  const св = свободные();
  const поДев = new Map();
  for (const x of св) { if (!поДев.has(x.д)) поДев.set(x.д, []); поДев.get(x.д).push(x); }
  for (const сп of поДев.values()) сп.sort((a, b) => (a.новая === b.новая ? b.t - a.t : (a.новая ? -1 : 1)));
  const девочки = [...поДев.entries()].sort((a, b) => b[1].length - a[1].length);
  const выбор = [];
  for (let круг = 0; выбор.length < N; круг++) {
    let добавили = false;
    for (const [, сп] of девочки) { if (круг < сп.length && выбор.length < N) { выбор.push(сп[круг]); добавили = true; } }
    if (!добавили) break;
  }
  const папка = м.вЗалив(`ЗАЛИВ-${имя}`);
  fs.rmSync(папка, { recursive: true, force: true }); fs.mkdirSync(папка);
  выбор.forEach((x, i) => {
    fs.copyFileSync(x.путь, path.join(папка, `${String(i + 1).padStart(3, '0')}_${x.f}`));
    // В РЕЕСТР — ДО отправки архива, а не после: если архив уехал, а запись не сделана, файл уйдёт
    // второй раз в следующей порции.
    fs.appendFileSync(РЕЕСТР, JSON.stringify({ порция: имя, позиция: i + 1, файл: x.f, id_поста: pid(x.f), девочка: x.д, когда: new Date().toISOString() }) + '\n');
  });
  const zip = `${папка}.zip`;
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-j', zip, ...fs.readdirSync(папка).map((f) => path.join(папка, f))]);
  const мб = (fs.statSync(zip).size / 1048576).toFixed(0);
  const кругов = Math.max(...[...поДев.values()].map((сп) => сп.filter((x) => выбор.includes(x)).length));
  console.log(`порция «${имя}»: ${выбор.length} роликов, ${new Set(выбор.map((x) => x.д)).size} девочек, до ${кругов} на девочку`);
  console.log(`архив: ${zip} (${мб} МБ) · записано в реестр · свободных осталось ${св.length - выбор.length}`);
})();
