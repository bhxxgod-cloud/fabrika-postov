// ВОЛНА ПОСТОВ НА СКЛАД (09.08, задача начальника «собери 50 постов»).
//
// ЗАЧЕМ ЕЩЁ ОДИН ЗАПУСКАТОР. Волны у нас собирались шелл-скриптами (fabwave, cover_wave,
// devochki_wave), и каждый нёс свой список фотографий, свою нумерацию персон и свою чересполосицу
// шаблонов. Из этого выросли два живых бага: одна и та же фотография уходила в два поста (обложка
// повторялась), и вся волна собиралась одним шаблоном, потому что список шаблонов был захардкожен
// строкой. Здесь и то и другое считается из БАЗЫ, а не из строки в скрипте:
//   • фотография берётся только та, которой ещё нет в meta.source_cover ни у одного поста, а
//     окончательное слово всё равно за гейтом обложек (он сравнивает перцептивные отпечатки, и
//     именно он ловит «то же фото другим файлом»);
//   • номер персоны продолжает нумерацию из базы, а не начинается с единицы;
//   • шаблоны идут по кругу из списка, и каждый шаблон обязан быть описан в templates.cjs.
//
// Сборку делает onepost.cjs, здесь только раскладка работы по полосам (OP_LANES) и счёт по базе.
// В телеграм ничего не уходит: у onepost свой рубильник /tmp/NO_TG, и волна его не обходит.
//
// Запуск: node postwave.cjs [сколько] [полос]
//   TEMPLATES=img-beauty-guide,img-face-report   какие шаблоны крутить (по умолчанию три карточных)
//   PHOTOS=inbox_0808,refs                      где искать исходники
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const TPL = require('./templates.cjs');
const srcbad = require('./srcbad.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const WANT = Number(process.argv[2] || 10);
const LANES = Number(process.argv[3] || process.env.OP_LANES || 3);
// По умолчанию три карточных шаблона: это рабочие шаблоны начальника (бьюти-гайд, оценка внешности,
// макияж по цветотипу), и именно у них правило смены цвета волос и догенерации финала работает
// целиком на нашей стороне.
// МАКИЯЖ ВЫКЛЮЧЕН 10.08: брак карточки гайда по макияжу, приказ начальника «пока макияж не делать».
// Комментарий стоит ЗДЕСЬ, а не в конце строки: внутри выражения он съедал перенос и файл не читался.
const TEMPLATES = (process.env.TEMPLATES || 'img-beauty-guide,img-face-report')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DIRS = (process.env.PHOTOS || 'inbox_0808,refs').split(',').map((s) => s.trim());

for (const t of TEMPLATES) {
  if (!TPL.isKnown(t)) throw new Error(`шаблон «${t}» не описан в templates.cjs, волну не запускаю`);
  // Выключенный контрактом шаблон не берём даже по явной просьбе: «выключен» значит выключен
  // (13.08, прецедент magazine-cover: флаг стоял, а ротация его не читала).
  if (TPL.isDisabled(t)) throw new Error(`шаблон «${t}» выключен в контракте (disabled: true), волну с ним не запускаю`);
}

// Слова, по которым узнаём выход прошлого заказа в имени файла: имена шаблонов и их семьи из
// контракта. Список сам растёт вместе с templates.cjs, руками его не поддерживаем.
const TEMPLATE_WORDS = [...new Set(TPL.list().flatMap((t) => {
  const fam = TPL.get(t).family;
  return [t.replace(/^img-/, ''), fam].filter(Boolean);
}))].map((s) => String(s).toLowerCase());

/**
 * Кандидаты в исходники: только файлы верхнего уровня перечисленных папок, без служебных имён.
 * PHOTOS_FILE отдаёт готовый список путей (по одному в строке) и отключает автоподбор: список
 * нужен потому, что «годная обложка» это решение ГЛАЗАМИ. Автоподбор тянет в волну и мусор,
 * который правилам не соответствует: скриншот интерфейса инстаграма, зеркальное селфи С ТЕЛЕФОНОМ
 * в кадре, кадр с сигаретой, полуобнажённый кадр (риск блокировки) и общий план, где лицо размером
 * с ноготь и разбирать на нём нечего.
 */
function candidates() {
  const listFile = process.env.PHOTOS_FILE;
  if (listFile) {
    return fs.readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }
  const out = [];
  for (const d of DIRS) {
    const dir = path.join(__dirname, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.(jpe?g|png)$/i.test(f)) continue;
      // Выходы наших же шаблонов обложкой быть не могут (правило стандарта): отсекаем по имени.
      if (/report_|_rain_reels_|_hearts_|_doodle_|_glam_|_art|lockscreen|_brand|slide4|canon|neironka\.pro-gen|_orig/i.test(f)) continue;
      // Список слов для этой проверки НЕ пишем руками: берём имена шаблонов и семей из контракта.
      // Иначе в исходники пролезает файл вида «д50_beauty-guide.jpg», то есть готовая КАРТОЧКА
      // прошлого заказа, и обложкой поста встаёт инфографика вместо домашнего фото.
      if (TEMPLATE_WORDS.some((w) => f.toLowerCase().includes(w))) continue;
      out.push(path.join(d, f));
    }
  }
  return out;
}

// НОМЕР РОТОРА ЛОКАЦИЙ РАЗДАЁТ ВОЛНА, А НЕ КАЖДЫЙ ПОСТ СЕБЕ САМ (09.08 вечер).
// Почему так: onepost при отсутствии PLACE_ROTOR читает счётчик из rotors.json и увеличивает его.
// Полосы работают одновременно, читают файл в один момент и получают ОДНО И ТО ЖЕ число, то есть
// вся пачка выходит в одной и той же паре локаций. На пятидесяти постах это видно сразу: полоса
// одинаковых кадров у Москва-Сити. Здесь номер выдаётся из счётчика волны, гонки нет по построению.
// База номеров считается от количества уже собранных постов, чтобы новая волна не начинала фон
// заново и не повторяла локации предыдущей.
const run = (photo, persona, template, placeRotor) => new Promise((resolve) => {
  const p = spawn('node', [path.join(__dirname, 'onepost.cjs'), photo, persona],
    { cwd: __dirname, env: { ...process.env, TEMPLATE: template, OP_LANES: String(LANES),
      PLACE_ROTOR: String(placeRotor) } });
  let tail = '';
  const eat = (b) => { tail = (tail + b.toString()).slice(-4000); };
  p.stdout.on('data', eat); p.stderr.on('data', eat);
  p.on('close', (code) => {
    const line = (tail.match(/ИТОГ:.*/g) || []).pop() || (tail.match(/упал на шаге.*/g) || []).pop() || `код ${code}`;
    // КОД 3 = «СБОЙ ИНФРАСТРУКТУРЫ ДО ЗАКАЗА», ЭТО НЕ БРАК И НЕ ПОТРАЧЕННЫЙ ИСХОДНИК (11.08).
    // onepost выходит так, когда служебный Chrome не поднялся или страница не достучалась до
    // админки, а денег ещё не потратил (см. шапку сбойИнфраструктуры в onepost.cjs). В /tmp/wave7.log
    // таких было 66 из 82 «браков»: они сожгли 66 фотографий из очереди волны ни за что.
    resolve({ ok: code === 0 && /ГОТОВО/.test(line), отложить: code === 3,
      line: line.slice(0, 160), persona, photo, template });
  });
});

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  const used = new Set((await c.query(`SELECT DISTINCT meta->>'source_cover' s FROM posts WHERE meta->>'source_cover' IS NOT NULL`))
    .rows.map((r) => path.basename(String(r.s))));
  // Нумерация персон продолжается из базы: «нов21» после «нов20», а не сначала.
  const maxNo = (await c.query(`SELECT max((regexp_replace(meta->>'persona','\\D','','g'))::int) n
     FROM posts WHERE meta->>'persona' ~ '^нов[0-9]+$'`)).rows[0].n || 0;
  // КАРАНТИН ВЫРЕЗАЕТСЯ ОТДЕЛЬНО ОТ БАЗЫ, И ЭТО НЕ ПРИДИРКА (11.08, разбор канала-референса).
  // База знает только про ГОТОВЫЕ посты: файл, на котором пост УМЕР, в meta.source_cover не
  // попадает, поэтому used его не отсекает и следующая волна берёт его снова. Ровно так файл
  // 033_аутфит_девушка_лето трижды платил за отказ модерации RenderGrid по $0.03 за заход. Список
  // ведёт srcbad.cjs (туда же уезжает брак отдела качества обложки), сверяем по имени файла — тем
  // же ключом, что и used, иначе одна и та же фотография из двух папок считалась бы разной.
  const карантин = srcbad.вКарантине();
  const свежие = candidates().filter((f) => !used.has(path.basename(f)));
  const pool = свежие.filter((f) => !карантин.has(path.basename(f)));
  if (свежие.length !== pool.length) {
    console.log(`в карантине ${свежие.length - pool.length} исходник(ов): их волна не берёт `
      + '(отказ модерации по фотографии или брак отдела качества обложки)');
  }
  // ЖИВА ЛИ ФАБРИКА, СПРАШИВАЕМ ДО СТАРТА (11.08). Волна на 160 постов молотила час и дала ноль:
  // провайдер партнёра отвечал на каждый заказ «Exhausted balance», а внутри поста это видно только
  // через 10-25 минут ожидания рендера. Проверка бесплатная, читает историю заказов и ничего не
  // заказывает. FACTORY_CHECK=0 отключает её на случай, когда историю читать нельзя, а пускать надо.
  if (process.env.FACTORY_CHECK !== '0') {
    try {
      const { можноПускать } = require('./factorycheck.cjs');
      const в = await можноПускать();
      console.log(`фабрика: ${JSON.stringify(в.с.по)}, свежих ${в.с.свежих}, отказов ${в.с.отказов}`);
      if (!в.можно) {
        console.log(`\n⛔ ВОЛНА НЕ ЗАПУЩЕНА: ${в.почему}`);
        console.log('Это не поломка кода: пока причина не устранена, любой заказ вернётся отказом.');
        process.exit(2);
      }
    } catch (e) {
      console.log(`⚠ проверку фабрики выполнить не удалось (${String(e.message).slice(0, 90)}), иду дальше`);
    }
  }
  console.log(`исходников свободно ${pool.length}, шаблоны: ${TEMPLATES.join(', ')}, полос ${LANES}`);
  console.log(`персоны продолжают нумерацию с нов${String(maxNo + 1).padStart(2, '0')}\n`);
  if (pool.length < WANT) console.log(`⚠ исходников меньше, чем постов в задании (${pool.length} < ${WANT}): соберу столько, сколько хватит фотографий`);

  const before = Number((await c.query(`SELECT count(*) n FROM posts WHERE status='backlog' AND published_at IS NULL`)).rows[0].n);
  // База ротора локаций: сколько постов нашей сборки уже есть. Так новая волна продолжает ротацию
  // фона с того места, где остановилась прошлая, и локации не повторяются между волнами.
  const rotorBase = Number((await c.query(`SELECT count(*) n FROM posts WHERE meta->>'onepost'='true'`)).rows[0].n) || 0;
  let no = maxNo, idx = 0, done = 0, fail = 0, отложено = 0;
  const results = [];
  // ОЧЕРЕДЬ ОТЛОЖЕННЫХ: задания, вернувшиеся из-за сбоя инфраструктуры (код выхода 3). Возвращаем
  // ТО ЖЕ САМОЕ задание, а не новое: номер персоны, шаблон и номер ротора локаций сохраняются, иначе
  // повтор сдвинул бы нумерацию и ротацию фона всей волны.
  // ПАУЗА ПЕРЕД ПОВТОРОМ обязательна: сбой обычно общий на все полосы (браузер лежит), и мгновенный
  // повтор просто сожжёт попытки. Минуты хватает, чтобы сторож chromeguard.cjs поднял Chrome.
  const ПАУЗА_ПОВТОРА_МС = Number(process.env.WAVE_RETRY_MS || 60000);
  const ПОПЫТОК_МАКС = Number(process.env.WAVE_RETRY_TRIES || 3);
  const отложенные = [];
  const nextJob = () => {
    // Сначала то, что уже отлежалось в очереди: оно старше всего в волне.
    for (let i = 0; i < отложенные.length; i++) {
      if (отложенные[i].неРаньше <= Date.now()) return отложенные.splice(i, 1)[0];
    }
    while (idx < pool.length && done + fail < WANT) {
      const photo = pool[idx++];
      no++;
      return { photo, persona: `нов${String(no).padStart(2, '0')}`, template: TEMPLATES[(no - 1) % TEMPLATES.length],
        placeRotor: rotorBase + no, попыток: 0 };
    }
    return null;
  };
  const lane = async (n) => {
    for (;;) {
      const j = nextJob();
      if (!j) {
        // Пула больше нет, но в очереди лежат отложенные и их время ещё не пришло: ждём их, а не
        // выходим. Иначе полоса уходит домой, и отложенные посты не собирает никто.
        if (отложенные.length) { await new Promise((r) => setTimeout(r, 10000)); continue; }
        return;
      }
      const t0 = Date.now();
      const r = await run(j.photo, j.persona, j.template, j.placeRotor);
      j.попыток++;
      results.push(r);
      if (r.отложить && j.попыток < ПОПЫТОК_МАКС) {
        j.неРаньше = Date.now() + ПАУЗА_ПОВТОРА_МС;
        отложенные.push(j);
        отложено++;
        console.log(`  [полоса ${n + 1}] ⏳ ${j.persona} ${path.basename(j.photo)} возвращён в очередь `
          + `(попытка ${j.попыток} из ${ПОПЫТОК_МАКС}, повтор через ${Math.round(ПАУЗА_ПОВТОРА_МС / 1000)} с, `
          + `готово ${done}, брак ${fail}, отложено ${отложено}) — ${r.line}`);
        continue;
      }
      if (r.ok) done++; else fail++;
      console.log(`  [полоса ${n + 1}] ${r.ok ? '✅' : '✗'} ${j.persona} ${path.basename(j.photo)} ${j.template} `
        + `(${Math.round((Date.now() - t0) / 1000)} с, готово ${done}, брак ${fail}) — ${r.line}`);
    }
  };
  await Promise.all(Array.from({ length: LANES }, (_, n) => lane(n)));

  // ИТОГ СЧИТАЕМ ЗАПРОСОМ К БАЗЕ, А НЕ СВОИМ СЧЁТЧИКОМ (правило доклада: прогресс только цифрой
  // из базы). Свой счётчик врёт при падении процесса, а база знает, что реально легло на склад.
  const after = Number((await c.query(`SELECT count(*) n FROM posts WHERE status='backlog' AND published_at IS NULL`)).rows[0].n);
  const gateOk = Number((await c.query(`SELECT count(*) n FROM posts WHERE status='backlog' AND published_at IS NULL
     AND coalesce(meta->'gate'->>'ok','') = 'true'`)).rows[0].n);
  await c.end().catch(() => {});
  console.log(`\nИТОГ ВОЛНЫ: попыток ${done + fail}, склад был ${before}, стал ${after} (+${after - before}), `
    + `из них с чистым гейтом ${gateOk}`
    // Отложенные показываем ОТДЕЛЬНОЙ цифрой: это не брак и не готовые, это работа инфраструктуры.
    // Если цифра большая, значит служебный Chrome лежал, и смотреть надо /tmp/chromeguard.log.
    + (отложено ? `\nОТЛОЖЕНО из-за сбоев инфраструктуры (Chrome, сеть до админки): ${отложено} возврат(ов) `
      + 'в очередь; исходники не израсходованы, деньги за них не платились' : ''));
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
