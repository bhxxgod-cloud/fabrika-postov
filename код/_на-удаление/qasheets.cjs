// ОТДЕЛ КАЧЕСТВА, ШАГ 1: ЛИСТЫ ДЛЯ ПРОСМОТРА ГЛАЗАМИ (09.08).
//
// ЗАЧЕМ. Приказ начальника: «там нейронка про при генере дала брак, нужен отдел качества». Наши
// автоматические проверки по хэшам уже показали себя ненадёжными (framesaudit пометил браком всё),
// а поле validation в базе пустое, потому что ключа для внешней модели нет. Единственная рабочая
// проверка это ГЛАЗА: кадры смотрит агент и выносит приговор.
//
// ЧТО ДЕЛАЕТ ЭТОТ СКРИПТ. Скачивает все четыре кадра поста и клеит их в ОДИН лист два на два с
// подписями «1 хук», «2 результат», «3 образ», «4 финал», чтобы контролёр видел пост целиком и
// сразу ловил дубли кадров, поля по краям, телефон не в том шаблоне и обрезанные карточки.
// Ничего не генерирует и не платит: только скачивание уже готовых кадров и склейка.
//
// Запуск: node qasheets.cjs [сколько]        STATUS=backlog,approved   PERSONA_LIKE=нов%
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('ffmpeg-static');
const { fetchToFile } = require('./watchdog.cjs');
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
const OUT = process.env.QA_DIR || '/tmp/qa';
const STATUSES = (process.env.STATUS || 'backlog,approved').split(',').map((s) => s.trim());
// Карточные шаблоны: у них второй кадр это инфографика, а телефона в посте быть не должно.
// Своей копии списка тут больше нет (и была она без флага /i, то есть шаблон в другом регистре
// читался как арт): правда одна, в templates.cjs.

function label(src, out, text) {
  // Подпись поверх кадра, чтобы контролёр не путал порядок кадров.
  const t = text.replace(/:/g, '\\:').replace(/'/g, '');
  spawnSync(FF, ['-y', '-i', src, '-vf',
    `scale=460:575,drawtext=text='${t}':fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=8:x=8:y=8`,
    '-frames:v', '1', out], { stdio: 'ignore' });
  return fs.existsSync(out) ? out : null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' persona, meta->>'template' tpl, meta->>'hook_text' hook, meta->'image_urls' urls,
           meta->>'frame4_reels' reels4
      FROM posts
     WHERE status = ANY($1) AND published_at IS NULL
       AND jsonb_array_length(meta->'image_urls') = 4
       AND ($2::text IS NULL OR meta->>'persona' LIKE $2)
     ORDER BY created_at DESC`, [STATUSES, process.env.PERSONA_LIKE || null])).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`постов на контроль: ${work.length}`);

  const index = [];
  for (const [i, p] of work.entries()) {
    const short = String(p.id).slice(0, 8);
    const sheet = path.join(OUT, `${short}_${(p.persona || 'без-персоны').replace(/[^\wа-яА-ЯёЁ-]/g, '')}.jpg`);
    if (fs.existsSync(sheet)) { index.push({ id: p.id, short, sheet, persona: p.persona, tpl: p.tpl, hook: p.hook }); continue; }
    try {
      // ПЯТАЯ ПЛИТКА: ВАРИАНТ ФИНАЛА ДЛЯ РИЛСА (09.08 ночью). Начальник ДВА РАЗА сказал про слово на
      // плашке («под тикток шаблоны, а под инстаграм промпты только»), и оба раза потому, что на листе
      // он видел только карусельный кадр 4, то есть тикточный вариант со словом «шаблоны». Вариант для
      // инстаграма лежит отдельно (meta.frame4_reels, из него монтируется рилс), но на лист не попадал
      // вовсе, и проверить слово глазами было НЕЧЕМ. Теперь на листе оба финала, подписаны площадками.
      // Подписи КОРОТКИЕ: drawtext не переносит строку, и подпись длиннее плитки уезжает за край
      // (первая версия «4 финал тикток - шаблоны» обрезалась на «ша»).
      const names = ['1 хук', '2 результат', '3 образ', '4 тикток шаблоны'];
      const tiles = [];
      for (let k = 0; k < 4; k++) {
        const raw = await fetchToFile(p.urls[k], path.join(OUT, `.tmp_${short}_${k}.jpg`), { what: `кадр ${k + 1}`, ms: 60000, min: 3000 });
        const t = label(raw, path.join(OUT, `.tile_${short}_${k}.jpg`), names[k]);
        if (t) tiles.push(t);
      }
      if (tiles.length !== 4) throw new Error('не собрал все четыре кадра');
      let reelsTile = null;
      if (p.reels4) {
        try {
          const raw = await fetchToFile(p.reels4, path.join(OUT, `.tmp_${short}_r.jpg`), { what: 'финал для рилса', ms: 60000, min: 3000 });
          reelsTile = label(raw, path.join(OUT, `.tile_${short}_r.jpg`), '4 рилс промпты');
        } catch { reelsTile = null; }
      }
      if (reelsTile) {
        // Шесть клеток при пяти кадрах: шестая это чёрная заливка. Делаем её ЗАКРАШИВАНИЕМ УЖЕ
        // ГОТОВОЙ ПЛИТКИ, а не генератором lavfi. Причина замерена: lavfi color=460x575 отдаёт jpg
        // 460x574 (mjpeg требует чётную высоту), и hstack падает с «input 1 height 574 does not match
        // input 0 height 575», то есть лист молча не склеивается. Копия плитки этого не допускает
        // по построению: у неё ровно те же размеры и тот же пиксельный формат.
        const black = path.join(OUT, `.tile_${short}_x.jpg`);
        spawnSync(FF, ['-y', '-i', tiles[0], '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill',
          '-frames:v', '1', black], { stdio: 'ignore' });
        spawnSync(FF, ['-y', '-i', tiles[0], '-i', tiles[1], '-i', tiles[2], '-i', tiles[3], '-i', reelsTile, '-i', black,
          '-filter_complex', '[0:v][1:v]hstack[t];[2:v][3:v]hstack[m];[4:v][5:v]hstack[b];[t][m]vstack[tm];[tm][b]vstack',
          '-frames:v', '1', sheet], { stdio: 'ignore' });
        try { fs.unlinkSync(black); } catch {}
      } else {
        spawnSync(FF, ['-y', '-i', tiles[0], '-i', tiles[1], '-i', tiles[2], '-i', tiles[3],
          '-filter_complex', '[0:v][1:v]hstack[t];[2:v][3:v]hstack[b];[t][b]vstack', '-frames:v', '1', sheet], { stdio: 'ignore' });
      }
      if (!fs.existsSync(sheet)) throw new Error('лист не склеился');
      index.push({ id: p.id, short, sheet, persona: p.persona, tpl: p.tpl, hook: p.hook, card: TPL.isCard(p.tpl),
        тип: TPL.kindRu(p.tpl), финал_рилс: p.reels4 ? 'есть' : 'НЕТ (в инстаграм уйдёт слово «шаблоны»)' });
      for (const f of tiles) { try { fs.unlinkSync(f); } catch {} }
      if (reelsTile) { try { fs.unlinkSync(reelsTile); } catch {} try { fs.unlinkSync(path.join(OUT, `.tmp_${short}_r.jpg`)); } catch {} }
      for (let k = 0; k < 4; k++) { try { fs.unlinkSync(path.join(OUT, `.tmp_${short}_${k}.jpg`)); } catch {} }
      if ((i + 1) % 10 === 0) console.log(`  … готово ${i + 1} из ${work.length}`);
    } catch (e) {
      console.log(`  ✗ ${short} (${p.persona}): ${String(e.message).slice(0, 70)}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  await c.end().catch(() => {});
  console.log(`\nИТОГ: листов ${index.length}, папка ${OUT}, список ${path.join(OUT, 'index.json')}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
