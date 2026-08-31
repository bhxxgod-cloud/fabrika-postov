// ЛЮКС-РЕФЕРЕНСЫ ДЕВОЧЕК (запрос владельца 05.08: «девочки в серых футболках, хочется закос
// под гуччи и баленсиагу»). Переодеваем каждую в дорогой образ ЧЕРЕЗ ДВИЖОК САЙТА
// (/generate/image): их пайплайн держит лицо с референса, мой прямой RenderGrid-вызов — нет
// (проверено 04.08: из Ани в парке вышел мужик). Результаты → /tmp/luxrefs/<имя>.jpg,
// дальше они идут референсами в genref-заказы шаблонов.
// Запуск: node luxrefs.cjs [Имя]
//   без имени — добираем всех, у кого в /tmp/luxrefs ещё нет файла;
//   с именем  — ПЕРЕЗАКАЗ ровно этой девочки (существующий файл игнорируется).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LOCK = '/tmp/genposts.lock';
const OUT = '/tmp/luxrefs';
const ONLY = process.argv[2] || '';   // имя одной девочки (по образцу heartstrend.cjs)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEEP = 'ГЛАВНОЕ ПРАВИЛО: то же лицо,那 же девушка, та же причёска и цвет волос, та же поза и ракурс, тот же фон и свет с фото. Меняется ТОЛЬКО одежда и аксессуары. Фотореализм, качество живого фото на телефон, без пластикового ретуша.'
  .replace('那', 'та'); // защита от опечатки
const GIRLS = [
  ['Полина', '/Users/qq/Desktop/АВАТАРЫ /Полина/model_02.jpg',
    'Переодень девушку с фото в дорогой дизайнерский образ в духе люксовых модных домов: чёрный оверсайз-блейзер с широкими плечами на шёлковый топ, массивная золотая цепь, тонкие золотые кольца. ' + KEEP],
  // 06.08: был model_04.jpg — а это НЕ фото модели, а нарисованный чарник «фея АСТРА»
  // (блондинка с высоким пучком и карими глазами). Реф Карины унаследовал лицо мультика.
  // model_06.jpg — настоящая Карина: анфас, крупно, ничем не перекрыта, волосы распущены
  // на обе стороны (нужно для тренда «волосы сердечками»), ровный пасмурный свет.
  ['Карина', '/Users/qq/Desktop/АВАТАРЫ /Карина/model_06.jpg',
    'Переодень девушку с фото в дорогой дизайнерский образ в духе люксовых модных домов: бежевый твидовый жакет с золотыми пуговицами поверх кремового шёлкового топа, серьги-кольца золото. ' + KEEP],
  ['Дарья', '/Users/qq/Desktop/АВАТАРЫ /Даша/neironka.pro-gen4232100.png',
    'Переодень девушку с фото в дорогой дизайнерский образ в духе люксовых модных домов: чёрный кожаный тренч поверх белой рубашки, тонкая золотая цепочка, строгий дорогой минимализм. ' + KEEP],
  ['Анечка', '/Users/qq/Desktop/АВАТАРЫ /аня/anya_canon_916.jpg',
    'Переодень девушку с фото в дорогой дизайнерский образ в духе люксовых модных домов: total black, тонкая водолазка под жакет с широкими плечами, золотые серьги-капли. ' + KEEP],
  ['Мия', '/Users/qq/Downloads/146A1503_копия_2_(cropped)-2.jpg',
    'Переодень девушку с фото в дорогой дизайнерский образ в духе люксовых модных домов: чёрный корсетный топ под жакет с атласными лацканами, золотое колье-цепь. ' + KEEP],
  ['Тати', '/Users/qq/Desktop/АВАТАРЫ /Тати/00_исходник.jpeg',
    'Переодень девушку с фото в дорогой дизайнерский образ в духе люксовых модных домов: чёрный шёлковый топ на бретелях под удлинённый жакет с широкими плечами, тонкое золотое колье и серьги-кольца. ' + KEEP],
];

async function takeLock(waitMs = 20 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const list = ONLY ? GIRLS.filter(([n]) => n === ONLY) : GIRLS;
  if (!list.length) { console.error(`нет такой девочки: ${ONLY}. Есть: ${GIRLS.map(([n]) => n).join(', ')}`); process.exit(1); }
  await takeLock();
  // Окно НЕ открываем (правило начальника «не трогай хром»): работаем во вкладке статичного
  // headless-браузера с админ-профилем.
  const { openAdmin } = require('./adminbrowser.cjs');
  const { siteGenerate } = require('./sitegen.cjs');
  const { page, done } = await openAdmin();
  try {
    for (const [name, src, prompt] of list) {
      const dest = path.join(OUT, `${name}.jpg`);
      if (!ONLY && fs.existsSync(dest) && fs.statSync(dest).size > 30000) { console.log(`  · ${name}: уже есть`); continue; }
      if (!fs.existsSync(src)) { console.log(`  ✗ ${name}: нет исходника ${src}`); continue; }
      try {
        console.log(`  → ${name}: генерится из ${path.basename(src)}…`);
        // Через sitegen: он опознаёт СВОЮ генерацию по id и метке в промпте. Прошлый вариант
        // брал «первую новую картинку в галерее» и мог утащить параллельную генерацию начальника.
        await siteGenerate(page, { prompt, refFile: src, out: dest });
        console.log(`  ✓ ${name} (${Math.round(fs.statSync(dest).size / 1024)} КБ) → ${dest}`);
      } catch (e) { console.log(`  ✗ ${name}: ${String(e.message).slice(0, 120)}`); }
      await sleep(4000);
    }
  } finally { await done().catch(() => {}); }
  console.log('ИТОГ: люкс-референсы в ' + OUT);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
