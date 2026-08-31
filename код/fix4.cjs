// ПЕРЕСБОРКА ЧЕТВЁРТОГО КАДРА ПО СТАНДАРТУ 07.08 (бесплатно, только вёрстка).
//
// Зачем: в залпе 07.08 четвёртый кадр собирался из ПЕРВОГО фабричного кадра, а на нём уже
// напечатан хук, поэтому фирменный блок ложился на текст. Стандарт начальника: четвёртый кадр это
// ОБЫЧНОЕ ФОТО (не телефон) с перекадрировкой (другой зум, поворот, центр) и фирменным блоком.
// Исходник берём чистый: кадр начальника из refs/<персона>.jpg или meta.source_cover.
//
// Генераций ноль: скачиваем только уже готовые кадры, режем и заливаем.
// Запуск: node fix4.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45, to45smart, reframe, ctaSlide } = require('./slidekit.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
// Пересборка это чистая вёрстка, фабрика тут не участвует, поэтому её можно гнать в несколько
// потоков: SHARD=<n> берёт каждый n-й пост по остатку от деления (SHARD_OF задаёт число потоков).
const SHARD = Number(process.env.SHARD || 0);
const SHARD_OF = Number(process.env.SHARD_OF || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Пересборка это чистая вёрстка без генераций, поэтому лимит короткий: 10 минут на весь прогон
// и не больше 4 минут на одном посте. Сторож нужен ровно потому, что этот скрипт уже висел
// 45 минут молча (07.08), и снаружи это читалось как «работа идёт».
const wd = armWatchdog({ minutes: 10, stallMinutes: 4, label: 'пересборка финального кадра' });

(async () => {
  wd.stage('читаю склад');
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  // Берём посты сегодняшнего залпа: персоны девочкаNN, склад, 4 кадра, фирменный блок не пересобран.
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->>'source_cover' src, meta->'image_urls' urls,
           coalesce(meta->>'look_missing','') = 'true' look_missing,
           coalesce(meta->'validation'->>'verdict','') verdict
      FROM posts
     WHERE status IN ('backlog','approved') AND published_at IS NULL
       AND jsonb_array_length(meta->'image_urls') = 4
       AND ($1::text IS NULL OR meta->>'persona' = ANY(string_to_array($1, ',')))
       AND (coalesce(meta->>'frame4_art','') <> 'true' OR $1::text IS NOT NULL)
     ORDER BY created_at DESC`, [process.env.ONLY_PERSONAS || null])).rows;
  const mine = SHARD_OF > 1 ? rows.filter((_, i) => i % SHARD_OF === SHARD) : rows;
  const work = LIMIT > 0 ? mine.slice(0, LIMIT) : mine;
  console.log(`постов к пересборке финала: ${work.length}`);

  wd.stage(`беру вкладку в статичном хроме, постов ${work.length}`);
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  let ok = 0, bad = 0;
  try {
    // ЗАГРУЗКА ПАНЕЛИ С РЕТРАЯМИ (09.08). Пересборка должна идти ПАРАЛЛЕЛЬНО фабрике, а когда рядом
    // работают onepost.cjs в том же headless-хроме, вкладка не успевает открыть админку за 60 секунд,
    // и весь прогон падал на первом же шаге. Теперь 3 попытки по 120 секунд с паузой 5 секунд:
    // фабрика отпускает процессор, и вторая-третья попытка проходит.
    let opened = false;
    for (let att = 1; att <= 3 && !opened; att++) {
      try {
        await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 120000 });
        opened = true;
      } catch (e) {
        console.log(`  ⚠ попытка ${att} из 3: админка не открылась за 120с (${String(e.message).slice(0, 60)})`);
        if (att === 3) throw new Error('админка не открылась за 3 попытки, рядом работает фабрика');
        console.log('     пауза 5 секунд и пробую снова');
        await sleep(5000);
      }
    }
    await sleep(3000);
    for (const [i, p] of work.entries()) {
      const short = String(p.id).slice(0, 8);
      wd.stage(`пост ${i + 1} из ${work.length} (${short}, ${p.pn})`);
      try {
        // ИСТОЧНИК ФИНАЛА = ВТОРОЙ КАДР ПОСТА, то есть арт с сердцами (07.08, приказ начальника:
        // «меняй 2 фото под 4 кадр, а не 1, там текст уже есть»). Первый кадр не годится: на нём
        // напечатан хук, и фирменный блок ложился на текст, плюс финал выходил дублем обложки.
        const urls0 = p.urls || [];
        if (urls0.length < 2) { console.log(`  ⚠ ${short} (${p.pn}): нет второго кадра`); bad++; continue; }
        // Скачивание С ТАЙМАУТОМ (07.08): fetch без сигнала к r2.dev висит бесконечно, и это тот
        // же тихий висяк, только внутри шага.
        // ОСНОВА ЧЕТВЁРТОГО КАДРА (09.08, правило начальника, окончательно).
        // Порядок кадров у тренда такой: 1) фото начальника с хуком, 2) сам гайд или арт,
        // 3) УЖЕ СГЕНЕРИРОВАННЫЙ ОБРАЗ в другой локации, 4) фирменная плашка.
        // Плашку кладём на ТРЕТИЙ кадр, то есть на второй сгенерированный образ: тогда четвёртый
        // кадр не повторяет ни обложку, ни гайд. Раньше я брал арт (плашка легла на данные гайда),
        // потом чистое фото (четвёртый кадр стал копией обложки) — оба варианта начальник забраковал.
        // ПРАВИЛО ИСТОЧНИКА ЧЕТВЁРТОГО КАДРА (09.08, приказ начальника: «4 кадр должен был быть 2,
        // а у нас 3 и 4 один кропленный кадр»). Четвёртый кадр НИКОГДА не делаем из третьего, это и
        // был брак. Если второй кадр это АРТ (обработанное фото девушки: bw-fingers, heart-hair и
        // прочие не-карточные), берём ЕГО. Если второй кадр это КАРТОЧКА с инфографикой (beauty-guide,
        // face-report, makeup-colortype, nose-verdict), карточку в финал не ставим, берём ЧИСТОЕ
        // первое фото девушки без напечатанного хука.
        // Источник финала спрашиваем у КОНТРАКТА (templates.cjs), своей копии списка тут больше
        // нет: она была четвёртой одинаковой копией в проекте и расходилась с makepost.
        const CARD = TPL.frame4Source(p.tpl) === 'cleanphoto';
        // frame4source: 'look2' вёрсткой не пересобирается (13.08, пункт 9): у таких шаблонов
        // (new-forms) кадр 2 это инфографика с сеткой превью, реframe по ней даёт кусок таблицы,
        // а реframe по кадру 3 повторит пойманный начальником брак «3 и 4 один кропленный кадр».
        // Честный финал тут только ДОГЕНЕРАЦИЕЙ по второму образу, это умеет onepost, а не fix4.
        if (TPL.frame4Source(p.tpl) === 'look2') {
          console.log(`  ⚠ ${short} (${p.pn}): у шаблона «${p.tpl}» финал собирается только `
            + 'догенерацией по второму образу (frame4source=look2), вёрсткой не пересобираю');
          bad++; continue;
        }
        // ОБРАЗА НЕТ = ФИНАЛ СОБРАТЬ НЕЧЕМ (09.08). У поста с look_missing фабрика не отдала
        // сгенерированный ОБРАЗ, и кадры 3 и 4 стоят на обложке или на карточке. Если такому посту
        // пересобрать финал из чистого фото, кадры 1 и 4 станут одной фотографией с разным кропом:
        // это и есть брак «одно фото на весь пост» (живой пример c7f1a7a4, нов02). Такой пост ждёт
        // догенерации образа, а не вёрстки. FIX_LOOK_MISSING=1 пересоберёт плашку принудительно, но
        // метку «по стандарту» пост всё равно НЕ получит.
        if (p.look_missing && !/^(1|true|yes)$/i.test(String(process.env.FIX_LOOK_MISSING || ''))) {
          console.log(`  ⚠ ${short} (${p.pn}): образа нет (look_missing), финал не пересобираю — пост ждёт догенерации образа`);
          bad++; continue;
        }
        // ПУТЬ ИСХОДНИКА МОЖЕТ БЫТЬ ОТНОСИТЕЛЬНЫМ (09.08). В базе source_cover лежит как
        // «inbox_0808/in05.jpg», то есть относительно папки проекта. Проверка fs.existsSync по
        // такой строке зависит от текущего каталога процесса: из другой папки файл «исчезал», и
        // карточные посты молча уходили в «нет чистого фото». Разрешаем путь от каталога скрипта.
        const abs = (f) => { const s = String(f || ''); return !s ? '' : (path.isAbsolute(s) ? s : path.join(__dirname, s)); };
        const srcAbs = abs(p.src);
        const ownRef = srcAbs && fs.existsSync(srcAbs) ? srcAbs
          : (fs.existsSync(path.join(__dirname, 'refs', `${p.pn}.jpg`)) ? path.join(__dirname, 'refs', `${p.pn}.jpg`) : null);
        let src;
        if (CARD) {
          if (ownRef) { src = ownRef; console.log(`     карточка «${p.tpl}»: финал из чистого первого фото`); }
          else { console.log(`  ⚠ ${short} (${p.pn}): карточка без чистого фото, финал не пересобираю`); bad++; continue; }
        } else {
          // арт: второй кадр это обработанное фото, из него и лепим финал
          src = await fetchToFile(urls0[1], `/tmp/f4_${short}_src.jpg`, { what: 'арт кадр 2', ms: 60000, min: 10000 });
          console.log(`     арт «${p.tpl}»: финал из второго кадра`);
        }
        const flat = to45smart(src, `/tmp/f4_${short}_base.jpg`);
        const base = reframe(flat, `/tmp/f4_${short}_raw.jpg`, `${p.pn}_4`);
        console.log(`     ${CARD ? 'карточка' : 'фото'} «${p.tpl}»: плашка идёт на сгенерированный образ (кадр 3)`);
        const cta = await ctaSlide(base, `/tmp/f4_${short}_4.jpg`, { seed: `${p.pn}_4` });
        const out = (cta && cta.out) || `/tmp/f4_${short}_4.jpg`;
        // ФИНАЛ «ПО СТАНДАРТУ» ЭТО ФАКТ, А НЕ НАДЕЖДА (09.08). Раньше frame4_art ставился в true
        // безусловно, поэтому метку получал даже пост, у которого образа нет вовсе: брак «одно фото
        // на весь пост» проходил гейт телеграма и уезжал в рилсы (c7f1a7a4). Стандарт считаем
        // выдержанным, только если: образ есть (look_missing нет), плашка реально легла (ctaSlide
        // вернул свой стиль) и файл финала не пустой.
        let plankKb = 0; try { plankKb = Math.round(fs.statSync(out).size / 1024); } catch {}
        const standard = !p.look_missing && !!(cta && cta.style) && plankKb >= 10;
        if (!standard) console.log(`  ⚠ ${short} (${p.pn}): финал НЕ по стандарту `
          + `(образ ${p.look_missing ? 'отсутствует' : 'есть'}, плашка ${cta && cta.style ? 'легла' : 'не легла'}, `
          + `файл ${plankKb} КБ) — метку frame4_art не ставлю, в ТГ не отправляю`);

        const b64 = fs.readFileSync(out).toString('base64');
        const url = await page.evaluate(async ({ b64, fname }) => {
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const fd = new FormData();
          fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
          const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.url) throw new Error('кадр не залился');
          return j.url;
        }, { b64, fname: path.basename(out) });

        const urls = [...(p.urls || [])];
        urls[3] = url;
        await c.query(`UPDATE posts SET media_url=$3,
            meta = meta || jsonb_build_object('image_urls', $2::jsonb, 'frame4_art', $4::boolean,
                             'frames_changed_at', to_jsonb(now()))
          WHERE id=$1`, [p.id, JSON.stringify(urls), urls[0], standard]);
        console.log(`  ${standard ? '✅' : '⚠'} ${short} (${p.pn}): финал пересобран из чистого кадра`
          + `${standard ? '' : ', но по стандарту НЕ прошёл'}`);
        // ПРАВКА КАДРОВ = ПОКАЗ НАЧАЛЬНИКУ (07.08). Раньше это были два отдельных шага, и я
        // пересобрал 50 финалов, а карточки не отправил: начальник полчаса смотрел старые кадры
        // и справедливо спросил «а посты когда будут с 4 изображением». Теперь отправка идёт
        // тем же проходом, а метка frames_changed_at позволяет сторожу догнать пропущенное.
        // TG_OFF=1 отключает отправку, когда пересборка идёт массово и её показывают partiями.
        // ОБЩИЙ РУБИЛЬНИК /tmp/NO_TG (09.08). Пока файл существует, НИ ОДИН сборщик ничего не
        // отправляет: так велел начальник, пока посты не проверены по всем правилам. Раньше эта
        // пересборка рубильника не знала и отправляла с --force, то есть общий стоп обходился
        // простой пересборкой финала, да ещё и в обход дедупа по ключу поста.
        // Гейт показа тот же, что в onepost: без стандарта и с браком валидатора молчим.
        if (fs.existsSync('/tmp/NO_TG')) {
          console.log(`  → ${short}: в ТГ не отправляю, включён общий стоп отправки (/tmp/NO_TG)`);
        } else if (!standard) {
          console.log(`  → ${short}: в ТГ не отправляю, финал не по стандарту`);
        } else if (p.verdict === 'reject') {
          console.log(`  → ${short}: в ТГ не отправляю, валидатор забраковал пост`);
        } else if (!/^(1|true|yes)$/i.test(String(process.env.TG_OFF || ''))) {
          try {
            execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), out, '--persona', p.pn || '—',
              '--type', 'новый финал', '--key', String(p.id),
              '--force', 'финал пересобран: кадр 4 это арт с поворотом и фирменным блоком'],
              { cwd: __dirname, encoding: 'utf8', stdio: 'ignore' });
          } catch { console.log(`  ⚠ ${short}: карточка в ТГ не ушла, догонит tgcatchup.cjs`); }
        }
        ok++;
        await sleep(400);
      } catch (e) { console.log(`  ✗ ${short}: ${String(e.message).slice(0, 70)}`); bad++; }
    }
  } finally { wd.poke('отцепляюсь от хрома и от базы'); await done(); await c.end().catch(() => {}); }
  // ВЫХОД ЯВНЫЙ (07.08): после отцепления от CDP в процессе остаются живые сокеты playwright, и
  // нода не завершается сама. Прошлый прогон отработал свой пост и ВИСЕЛ 45 минут, из-за чего
  // казалось, что пересборка идёт, а она стояла. Та же грабля уже была в vcomment (stopLocal).
  wd.done(0, `ИТОГ: пересобрано ${ok}, ошибок ${bad}`);
})().catch((e) => wd.fail(e));
