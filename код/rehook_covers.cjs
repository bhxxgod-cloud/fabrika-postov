// НАЛОЖЕНИЕ ХУКА НА ОБЛОЖКИ (06.08, претензия начальника: «даже описания не сделал на 1 фото»).
//
// Дыра: в harvest_salvo.cjs и salvo28.cjs первый кадр брался как `to45(cover)`, то есть кадр
// владельца лился БЕЗ текста-хука. В makepost такой шаг есть (hookSoft), а в залпе и харвесте я
// его просто забыл. В итоге у 16 спасённых постов обложка пустая, без байтового текста.
//
// Что делает: берёт посты, где обложка без хука, рисует хук в НИЖНЕЙ зоне (правило: текст не на
// лице, прижат к низу), перезаливает и подменяет первый кадр в meta.image_urls. Генераций ноль.
//
// Запуск: node rehook_covers.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { to45, renderHtml, хукНизом } = require('./slidekit.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');
const { registerCover } = require('./coverguard.cjs');
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LOCK = '/tmp/genposts.lock';
const LIMIT = Number(process.argv[2] || 0);
const W = 1080, H = 1350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Пул хуков тренда: от первого лица, про боль и результат, без слова «нейросеть».
// ПУЛ ХУКОВ ДЛЯ ОБЛОЖКИ (переписан 09.08). Прежний пул был из восьми фраз, и на восьмидесяти
// постах один и тот же текст стоял на восьми обложках подряд: начальник увидел это в лентe и
// справедливо сказал, что обложки повторяются. Плюс оттуда убрана мама (аудитория подростки,
// мама для них не авторитет). Теперь хуков много, они разложены по трендам, и раздаются БЕЗ
// ПОВТОРОВ, пока пул не кончится.
const HOOKS_BY_TPL = {
  hearts: [
    'он спросил, кто снимал.\nя промолчала',
    'бывший лайкнул\nчерез год молчания',
    // ПРО САЛОН И СМЕНУ ВОЛОС В ЭТОМ ПУЛЕ НЕЛЬЗЯ (09.08): у тренда волосы складываются в сердечки,
    // а цвет и стрижка остаются свои, поэтому «где я делала волосы» обещает то, чего на кадре нет.
    'девушка в кофейне спросила,\nкак я так сфоткалась',
    'сердечки из волос,\nи это одно моё селфи',
    'сделала за минуту,\nа выглядит как со съёмки',
    'подруга не поверила,\nчто это я сама',
    'парень поставил это\nсебе на обои',
    'я себе тут нравлюсь,\nвпервые за год',
    'никогда не получалась на фото,\nа тут залипла',
    'этот кадр обошёл\nвсе мои прошлые фото',
    'сохранила себе на обои\nи не могу перестать смотреть',
    'думала, у меня не выйдет,\nа вышло с первого раза',
  ],
  card: [
    'ну и зачем я это открыла...\nсижу разглядываю свой подбородок',
    '9 из 10, а я всё равно\nне согласна с одной строкой',
    'оказалось, я красилась\nне в свои цвета',
    'теперь знаю, что мне идёт,\nа что просто носила',
    'думала напишут «средне»,\nа написали 8.6 из 10',
    'три года копила на нос,\nа мне написали, что дело не в нём',
  ],
  bw: [
    'всегда удаляла свои фото,\nа это оставила',
    'сделала в чб и впервые\nне хочу удалять',
    'я себе тут нравлюсь,\nвпервые с девятого класса',
  ],
  // НЕЙТРАЛЬНЫЙ ПУЛ (09.08). Раньше его не было, и функция выбора отдавала пул СЕРДЕЧЕК любому
  // шаблону, которого не узнала: на обложке арта или нового тренда оказывался текст про волосы,
  // то есть обложка обещала не то, что внутри. Здесь ни слова про волосы, сердечки и карточки,
  // поэтому пул безопасен для любого шаблона, включая ещё не описанный.
  neutral: [
    'обычное селфи,\nа вышло как со съёмки',
    'сделала за минуту,\nа выглядит дорого',
    'подруга не поверила,\nчто это я сама',
    'первый мой кадр,\nкоторый не хочется удалять',
    'думала, у меня не выйдет,\nа вышло с первого раза',
    'нравлюсь себе на этом фото,\nвпервые за год',
  ],
};
// Пул выбирает КОНТРАКТ (templates.cjs), своего списка шаблонов здесь больше нет: он расходился
// с остальными файлами и, главное, отдавал сердечки по умолчанию любому неизвестному шаблону.
function poolFor(tpl) {
  return HOOKS_BY_TPL[TPL.hooksKey(tpl)] || HOOKS_BY_TPL.neutral;
}
const pick = (arr, seed) => { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return arr[h % arr.length]; };

async function takeLock(waitMs = 40 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('конвейер занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);

// Хук прижат к низу и с мягкой подложкой: на светлой одежде без подложки текст тонул, а в центре
// кадра он ложился на лицо (обе претензии начальника 06.08).
// ЗДЕСЬ БЫЛА КОПИЯ (до 14.08), и разъехалась она сильнее всех: bottom:96px (хук уходил под
// интерфейс рилса), поля 90px (текст упирался в край при заливке в 9:16) и подложка .34, хотя её
// подняли до .45 ещё 11.08. Этот скрипт ПЕРЕРИСОВЫВАЕТ обложки старого склада, то есть чинил один
// брак и тут же вносил другой. Теперь вёрстка одна на всех, в slidekit.
const drawHook = (src, out, text) => хукНизом(src, out, text);

// Скачивание с таймаутом (07.08): fetch без сигнала висит вечно и выглядит как «работа идёт».
const grab = (url, out) => fetchToFile(url, out, { what: 'обложка', ms: 60000, min: 10000 });

// СТОРОЖ (07.08). Здесь только вёрстка, генераций ноль: 15 минут на пачку и 4 минуты на один пост.
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 15), stallMinutes: 4,
  label: 'наложение хука на обложки' });

(async () => {
  wd.stage('читаю склад');
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  // Берём посты, собранные залпом и харвестом: именно у них обложка без хука.
  const rows = (await c.query(`
    -- ИСТОЧНИК ТОЛЬКО source_cover (09.08). Раньше здесь стоял coalesce(cleanplate, source_cover),
    -- но cleanplate это ФЛАГ «true», а не путь к файлу: в src попадала строка «true», файла с таким
    -- именем нет, и код ниже молча брал ТЕКУЩУЮ обложку, на которой хук уже напечатан. Второй хук
    -- ложился поверх первого, начальник получил пачку с перебитым текстом. Флаг источником быть не
    -- может, поэтому берём только source_cover, а если его нет, ищем оригинал в refs/<персона>.jpg.
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls,
           meta->>'source_cover' src, meta->>'hook_text' hook_text
      FROM posts
     WHERE status IN ('backlog','approved') AND published_at IS NULL
       -- FORCE=1 переписывает хук даже там, где он уже стоял: нужно, когда пул сменился и надо
       -- разогнать повторы. Текст рисуется НА ЧИСТОМ кадре, поэтому наложения текста на текст нет.
       AND ($1::boolean OR coalesce(meta->>'cover_hooked','') <> 'true')
     ORDER BY created_at`, [/^(1|true|yes)$/i.test(String(process.env.FORCE || ''))])).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`постов с обложкой владельца: ${rows.length}, обрабатываю ${work.length}`);

  await takeLock();
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  let ok = 0, bad = 0;
  const counters = {};
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    for (const [i, p] of work.entries()) {
      const short = String(p.id).slice(0, 8);
      wd.stage(`обложка ${i + 1} из ${work.length} (${short}, ${p.pn})`);
      try {
        const urls = [...(p.urls || [])];
        if (!urls.length) { console.log(`  ⚠ ${short}: нет кадров`); bad++; continue; }
        // ИСХОДНИК ОБЛОЖКИ ТОЛЬКО ЧИСТЫЙ. Приоритет: source_cover, затем оригинал начальника в
        // refs/<персона>.jpg. ТЕКУЩУЮ ОБЛОЖКУ КАК ИСХОДНИК БРАТЬ НЕЛЬЗЯ: на ней уже напечатан хук, и
        // мы получим текст поверх текста (пачка 09.08). Нет чистого кадра, значит пост пропускаем, а
        // не портим: лучше не тронуть, чем перебить надпись.
        // ПУТЬ МОЖЕТ БЫТЬ ОТНОСИТЕЛЬНЫМ (09.08). В базе source_cover лежит как «inbox_0808/in05.jpg»,
        // то есть относительно папки проекта, а fs.existsSync по такой строке зависит от текущего
        // каталога процесса: запуск из другой папки (например через конвейер) «терял» файл, и посты
        // с живым чистым исходником уходили в «нет чистого исходника». Разрешаем от каталога скрипта.
        const refFile = path.join(__dirname, 'refs', `${p.pn}.jpg`);
        const srcAbs = p.src ? (path.isAbsolute(p.src) ? p.src : path.join(__dirname, p.src)) : '';
        const base = srcAbs && fs.existsSync(srcAbs) ? srcAbs
          : (fs.existsSync(refFile) ? refFile : null);
        if (!base) { console.log(`  ⚠ ${short} (${p.pn}): нет чистого исходника, обложку не трогаю`); bad++; continue; }
        const flat = to45(base, `/tmp/rh_${short}_flat.jpg`);
        // KEEP_HOOK=1 — ПЕРЕРИСОВАТЬ ТОТ ЖЕ ТЕКСТ, А НЕ ВЫДАТЬ НОВЫЙ (14.08, приказ владельца
        // «пересобери посты с текстом который внизу»).
        // ЗАЧЕМ ОТДЕЛЬНЫЙ РЕЖИМ. Этот скрипт задуман раздавать хуки постам, у которых их нет, и
        // поэтому всегда берёт фразу из своего пула. Для переезда текста вниз это разрушительно:
        // у постов хук уже роздан общим пулом (hooks.cjs, там же обход занятых фраз, починенный
        // 14.08), а здешний счётчик считает в пределах ОДНОГО прогона и про занятое в базе не
        // знает — 91 пост получил бы новые фразы с повторами, которые ночью и чинили.
        // Пустой hook_text откатывает на обычную раздачу: пост без текста надо чем-то наполнить.
        const держатьХук = /^(1|true|yes)$/i.test(String(process.env.KEEP_HOOK || ''));
        let hook = держатьХук ? String(p.hook_text || '').trim() : '';
        if (!hook) {
          // Раздача без повторов: пул тренда прокручиваем по кругу, счётчик свой на каждый тренд.
          const key = TPL.hooksKey(p.tpl);
          const pool = poolFor(p.tpl);
          counters[key] = (counters[key] || 0);
          hook = pool[counters[key]++ % pool.length];
        }
        const withHook = await drawHook(flat, `/tmp/rh_${short}_1.jpg`, hook);

        const b64 = fs.readFileSync(withHook).toString('base64');
        const url = await page.evaluate(async ({ b64, fname }) => {
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const fd = new FormData();
          fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
          const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.url) throw new Error('обложка не залилась');
          return j.url;
        }, { b64, fname: path.basename(withHook) });

        urls[0] = url;
        await c.query(`UPDATE posts SET media_url=$3,
            meta = meta || jsonb_build_object('image_urls', $2::jsonb, 'hook_text', $4::text, 'cover_hooked', true)
          WHERE id=$1`, [p.id, JSON.stringify(urls), url, hook.replace(/\n/g, ' ')]);
        // ЖУРНАЛ ОБЛОЖЕК ОБНОВЛЯЕМ ТУТ ЖЕ (09.08). Гейт дублей обложек (coverguard) сверяет пиксели
        // по своему журналу covers.json. onepost после вставки поста журнал пополняет, а подмена
        // обложки этого не делала: в журнале оставался хэш СТАРОЙ картинки, поэтому новая обложка
        // для гейта не существовала (её можно было поставить второму посту), а старая занимала место
        // навсегда. Пишем новый кадр в журнал сразу после успешной подмены.
        try { registerCover(withHook, p.pn, p.id); }
        catch (e) { console.log(`  ⚠ ${short}: журнал обложек не обновлён (${String(e.message).slice(0, 50)})`); }
        console.log(`  ✅ ${short} (${p.pn}): хук нанесён — «${hook.split('\n')[0]}…»`);
        ok++;
        await sleep(500);
      } catch (e) { console.log(`  ✗ ${short}: ${String(e.message).slice(0, 70)}`); bad++; }
    }
  } finally { wd.poke('отцепляюсь от хрома и от базы'); await done(); await c.end().catch(() => {}); freeLock(); }
  // ЯВНЫЙ ВЫХОД: сокеты playwright после CDP не дают ноде завершиться самой (инцидент 07.08).
  wd.done(0, `ИТОГ: обложек с хуком ${ok}, ошибок ${bad}`);
})().catch((e) => { freeLock(); wd.fail(e); });
