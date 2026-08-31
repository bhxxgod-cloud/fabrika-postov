// ttpost.cjs — СБОРКА ТИКТОЧНОЙ КАРУСЕЛИ ПО ГОТОВОМУ ПОСТУ СО СКЛАДА (10.08).
//
// ЗАЧЕМ. ttkit.cjs умеет собирать кадры 9:16, но берёт файлы с диска, а посты живут в базе, и /tmp
// вычищается. Этот модуль соединяет одно с другим: по посту достаёт ЧИСТЫЕ кадры, отдаёт их ttkit
// и складывает готовую карусель под тикток в папку на рабочем столе плюс архив.
//
// ПОЧЕМУ ИМЕННО ЧИСТЫЕ. Кадр 1 и кадр 4 в базе лежат с уже впечатанным текстом по инстаграмной
// раскладке (хук на 84-90% высоты, плашка на 69-79%). В тиктоке это ровно под подписью и музыкой,
// то есть и хук, и слово-маркер пропадают. Перерисовать впечатанное нельзя, поэтому берём:
//   · кадр 1 — meta.source_cover_url (фото до нанесения хука), хук рисуем заново;
//   · кадр 2 — image_urls[1] как есть (карточка фабрики, вписывается в чистую зону);
//   · кадр 3 — image_urls[2] как есть (фото без наших надписей);
//   · кадр 4 — meta.frame4_raw (финал до плашки), плашку рисуем заново словом «шаблоны».
//
// СТАРЫЕ ПОСТЫ. До 10.08 чистый финал в базу не заливался, у них meta.frame4_raw пустой. Для них
// работает запасной путь: старую плашку ОТРЕЗАЕМ вместе с нижней четвертью кадра и рисуем новую.
//
// Почему отрезаем, а не закрываем. Сначала я рассчитывал, что старая плашка уедет ниже границы
// чистой зоны и её скроет интерфейс тиктока. Собрал и посмотрел глазами: видна прекрасно, на
// кадре оказалось ДВЕ плашки подряд, и это готовый брак. Область ниже 1260 закрыта не сплошной
// панелью, а полупрозрачными подписями тиктока, сквозь них всё читается. Поэтому единственный
// честный способ — убрать пиксели, а не надеяться на чужой интерфейс.
//
// Цена: теряем нижние 26% кадра, то есть одежду и пол. Лицо и локация остаются на месте.
// Запасной путь честно помечается в отчёте, чтобы такие карусели отличались от собранных как надо.
const OLD_CUT = 0.74;   // сколько высоты кадра 4 оставляем, если чистого финала нет
//
// НИЧЕГО НЕ ГЕНЕРИМ И НЕ ПУБЛИКУЕМ: только скачиваем уже оплаченные кадры и режем локально.
//
// ЗАПУСК
//   node ttpost.cjs 5                       пять свежих постов со склада
//   node ttpost.cjs 89157610 e5228c53       конкретные посты по началу id
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const tt = require('./ttkit.cjs');

const DBURL = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();
const OUT_ROOT = process.env.TT_OUT || `${process.env.HOME}/Desktop/ТТ-посты`;
const args = process.argv.slice(2);
const N = args.length === 1 && /^\d{1,3}$/.test(args[0]) ? Number(args[0]) : null;
const IDS = N ? [] : args;

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// Скачивание с таймаутом: fetch без сигнала к r2.dev умеет ждать вечно (грабли 07.08).
async function grab(url, dest) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 5000) throw new Error(`подозрительно мало байт (${b.length})`);
    fs.writeFileSync(dest, b);
    return dest;
  } finally { clearTimeout(t); }
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();

  // Берём только посты по действующему стандарту: 4 кадра, финал догенерирован, не брак.
  let rows;
  if (IDS.length) {
    rows = (await c.query(
      `SELECT id, caption, meta FROM posts WHERE ${IDS.map((_, i) => `id::text LIKE $${i + 1}`).join(' OR ')}`,
      IDS.map((s) => `${s}%`))).rows;
  } else {
    rows = (await c.query(`
      SELECT id, caption, meta FROM posts
       WHERE status IN ('backlog','approved') AND published_at IS NULL
         AND jsonb_array_length(meta->'image_urls') = 4
         AND meta->>'frame4_art' = 'true'
         AND coalesce(meta->>'look_missing','') <> 'true'
         AND coalesce(meta->'validation'->>'verdict','') <> 'reject'
       ORDER BY created_at DESC LIMIT $1`, [N || 5])).rows;
  }
  await c.end().catch(() => {});
  console.log(`постов к сборке: ${rows.length}`);

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const done = [];
  for (const p of rows) {
    const m = p.meta || {};
    const short = String(p.id).slice(0, 8);
    const persona = m.persona || 'без-персоны';
    const dir = path.join(OUT_ROOT, `${persona}_${short}`);
    const tmp = path.join('/tmp', `ttp_${short}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const urls = m.image_urls || [];
      if (urls.length !== 4) throw new Error(`кадров ${urls.length}, а нужно 4`);
      // Обложка: сначала чистое фото, и только если его нет — кадр с хуком (тогда хук не рисуем).
      const coverUrl = m.source_cover_url || urls[0];
      const coverClean = !!m.source_cover_url;
      const rawUrl = m.frame4_raw || null;
      const f0 = await grab(coverUrl, path.join(tmp, 'f0.jpg'));
      const f1 = await grab(urls[1], path.join(tmp, 'f1.jpg'));
      const f2 = await grab(urls[2], path.join(tmp, 'f2.jpg'));
      let f3 = await grab(rawUrl || urls[3], path.join(tmp, 'f3.jpg'));
      if (!rawUrl) {
        // Срезаем низ вместе со старой плашкой. Высоту делаем чётной: ffmpeg не любит нечётные.
        const cut = path.join(tmp, 'f3cut.jpg');
        const h = Math.round((1350 * OLD_CUT) / 2) * 2;
        execFileSync(require('ffmpeg-static'), ['-y', '-i', f3, '-vf', `crop=1080:${h}:0:0`,
          '-q:v', '2', cut], { stdio: 'ignore' });
        f3 = cut;
      }

      const res = await tt.buildPostTT([f0, f1, f2, f3], dir, {
        hook: coverClean ? (m.hook_text || '').replace(/,\s+а\s/, ',\nа ') : null,
        cards: [1],
      });
      // Подпись кладём рядом текстом: в тиктоке она вставляется руками при загрузке.
      fs.writeFileSync(path.join(dir, 'подпись.txt'),
        `${p.caption || ''}\n\n--- служебное ---\nпост ${short}, персона ${persona}\n`
        + `слово-маркер на плашке: шаблоны (тикток)\n`
        + `обложка: ${coverClean ? 'чистая, хук нарисован заново' : 'С ХУКОМ ИЗ ИНСТАГРАМА, новый хук не рисовался'}\n`
        + `финал: ${rawUrl ? 'чистый, плашка нарисована заново' : 'ЗАПАСНОЙ ПУТЬ, старая плашка под интерфейсом'}\n`);
      const sizes = res.map((r, i) => `${i + 1}:${Math.round(fs.statSync(r.out).size / 1024)}КБ`).join(' ');
      console.log(`  ✅ ${persona} ${short}: ${dir.replace(process.env.HOME, '~')} (${sizes})`
        + `${rawUrl ? '' : ' ⚠ финал по запасному пути'}${coverClean ? '' : ' ⚠ обложка с инстаграмным хуком'}`);
      done.push({ dir, persona, post: short, clean: !!rawUrl && coverClean });
    } catch (e) {
      console.log(`  ✗ ${persona} ${short}: ${String(e.message).slice(0, 100)}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  if (!done.length) { console.log('ИТОГ: ни одной карусели не собрано'); process.exit(1); }
  const zip = path.join(OUT_ROOT, 'тикток-карусели.zip');
  try { fs.unlinkSync(zip); } catch {}
  try {
    execFileSync('zip', ['-r', '-q', zip, ...done.map((d) => path.basename(d.dir))],
      { cwd: OUT_ROOT, stdio: 'ignore' });
  } catch {}
  const clean = done.filter((d) => d.clean).length;
  console.log(`\nИТОГ: карусели ${done.length} (собраны как надо ${clean}, запасным путём ${done.length - clean})`);
  console.log(`папка ${OUT_ROOT.replace(process.env.HOME, '~')}, архив ${path.basename(zip)}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', String(e.message).slice(0, 160)); process.exit(1); });
