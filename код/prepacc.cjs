// ПОДГОТОВКА АККА ПОД МОДЕЛЬ: один заход — ава, чистка чужих постов, ник, отметка «готов».
// Зачем появился (02.08): я завёл 6 новых акков и сразу поставил на них ролики, пропустив
// подготовку. Владелец увидел @amari277525: чужая аватарка (азиатская девушка), два чужих стоковых
// поста прежнего владельца и наш ролик между ними — профиль читается как угнанный. Гейт публикации
// проверял живость сессии и куки, но НЕ проверял, оформлен ли акк, поэтому система честно постила.
//
// Порядок внутри одного захода (важен именно такой):
//   1) чистим ЧУЖИЕ посты — их видно сразу, и они портят профиль сильнее всего;
//   2) ставим аву модели;
//   3) ник — только если он мусорный (amari277525, melvin15648): ник это логин-креденшл,
//      у IG лимит 2 смены/14 дней, поэтому трогаем лишь когда он реально позорный;
//   4) ставим dressed_at — по этой отметке гейт публикации пускает акк в постинг.
//
// ПОЧЕМУ ПО ОДНОМУ АККУ ЗА РАЗ: 02.08 мы потеряли 4 акка (обе Маши и обе Ани), оформленных
// четырьмя заходами подряд за 10 минут. Плотное оформление читается IG как перехват аккаунтов.
// Скрипт делает РОВНО ОДИН акк и выходит; пауза между запусками — на вызывающем.
//
// Запуск: node prepacc.cjs <slug> [--keep-posts] [--force-nick]
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('./iglib.cjs');

const SLUG = process.argv[2];
const KEEP_POSTS = process.argv.includes('--keep-posts');
const SHOT = process.env.SHOT_DIR || '/tmp';
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const AVA_ROOT = path.join(os.homedir(), 'Desktop', 'АВАТАРЫ ');
// персона в БД → папка на диске (те же соответствия, что в savereels.cjs)
// Имя модели в базе и имя папки в АВАТАРЫ/ расходятся — маппим явно, иначе pickAvatar молча
// возвращает null и акк остаётся без авы (05.08: «Марина» против папки «Мариша»).
const FOLDER = { 'Дарья': 'Даша', 'Анечка': 'аня', 'Марина': 'Мариша' };

global.__GL = null; let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });

// Ава: берём фото из папки модели. Приоритет — файлы фабрики (neironka.pro-gen*), затем исходник.
// РАЗНЫЕ АВЫ РАЗНЫМ АККАМ ОДНОЙ МОДЕЛИ. Раньше бралась просто первая картинка из папки, поэтому
// у всех акков Полины стояло одно и то же фото — а одинаковая ава на связанных акках это готовый
// признак сетки для IG (склеивает по перцептивному хэшу ровно как одинаковые ролики).
// Выбор детерминированный от id аккаунта: повторный прогон не меняет аву, а разные акки берут
// разные файлы. Кандидаты сортируются, чтобы порядок чтения папки не влиял на результат.
function pickAvatar(persona, accId, accIndex) {
  const dir = path.join(AVA_ROOT, FOLDER[persona] || persona);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  // Приоритет был слишком жёстким: если находились файлы фабрики, остальные фото (photo_*, model_*)
  // выбрасывались, и пул схлопывался — у Даши из 18 файлов в выбор шли 7. Берём ВСЕ подходящие,
  // просто ставим вперёд сгенерированные и снимки модели.
  const good = files.filter((f) => /neironka\.pro-gen|^image-|^model_|^photo_/i.test(f));
  const pool = good.length ? [...good, ...files.filter((f) => !good.includes(f))] : files;
  if (!pool.length) return null;
  // РАЗДАЧА БЕЗ КОЛЛИЗИЙ. Раньше индекс брался как хэш id по модулю — и у Карины все три акка
  // получили одно фото (03.08). Теперь позиция акка среди акков СВОЕЙ модели: пока фото хватает,
  // совпадений не будет вовсе. accIndex передаёт вызывающий, у него есть список акков модели.
  let idx;
  if (Number.isInteger(accIndex)) idx = accIndex % pool.length;
  else {
    let h = 0;
    for (const ch of String(accId || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    idx = h % pool.length;
  }
  const pick = pool[idx];
  if (pool.length < 2) console.log(`  ⚠ в папке модели всего ${pool.length} фото — акки получат ОДИНАКОВУЮ аву (риск склейки), добавь ещё`);
  return path.join(dir, pick);
}

function isJunkNick(h) {
  const s = String(h || '').trim();
  if (!s) return true;
  if (/^(FOL|TT)[\s_]/i.test(s) || /^акк\s/i.test(s)) return true;
  if (/^[a-z]+\d{4,}$/i.test(s)) return true;
  if (/\d{4,}/.test(s)) return true;
  if (maleName(s)) return true;              // мужское имя в нике женского аккаунта — меняем
  return false;
}

// ПРАВИЛА ВЛАДЕЛЬЦА ПО ИМЕНАМ (03.08):
//   • мужское имя в нике → ник меняем;
//   • женское имя, пусть и не совпадающее с нашей моделью → ник ОСТАВЛЯЕМ, а девочку на этом
//     аккаунте зовём так, как в нике (легенда подстраивается под акк, а не наоборот);
//   • мужское имя профиля («Braylen» на аккаунте books.by.nastya) — убираем всегда.
const MALE = /(?:^|[^a-z])(bryan|braylen|jaylon|landen|oliver|rylan|hassan|miguel|tristen|alfonso|christian|amari|kasey|case|riley|zander|carter|savion|tyree|darius|ivan|maxim|artem|dmitry|sergey|andrew|john|mike|alex)(?![a-z])/i;
const FEMALE = /(?:^|[^a-z])(nastya|nastia|anastasia|sofia|sofya|sonya|julia|yulia|polina|karina|darya|dasha|anya|ulyana|liza|masha|maria|marina|alina|kristina|vika|lera|nika|sabina|arina|kira|milana|ева|eva|mila)(?![a-z])/i;
function maleName(s) { return MALE.test(String(s || '')); }
// Достаёт женское имя из ника: books.by.nastya → Настя. Нужно, чтобы имя профиля совпадало с ником.
const RU = { nastya: 'Настя', nastia: 'Настя', anastasia: 'Настя', sofia: 'София', sofya: 'Софья', sonya: 'Соня',
  julia: 'Юля', yulia: 'Юля', polina: 'Полина', karina: 'Карина', darya: 'Дарья', dasha: 'Даша', anya: 'Аня',
  ulyana: 'Ульяна', liza: 'Лиза', masha: 'Маша', maria: 'Мария', marina: 'Марина', alina: 'Алина',
  kristina: 'Кристина', vika: 'Вика', lera: 'Лера', nika: 'Ника', sabina: 'Сабина', arina: 'Арина',
  kira: 'Кира', milana: 'Милана', eva: 'Ева', mila: 'Мила' };
function nameFromNick(nick) {
  const m = String(nick || '').toLowerCase().match(FEMALE);
  const n = m ? m[1] : null;
  return n ? (RU[n] || (n[0].toUpperCase() + n.slice(1))) : null;
}

(async () => {
  if (!SLUG) { console.log('usage: node prepacc.cjs <slug> [--keep-posts]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT a.id, a.gologin_profile_id pid, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies,
            a.dressed_at, g.gologin_token tok
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
  if (!row.persona) { console.log('ИТОГ: ✗ акк не привязан к модели'); await c.end(); process.exit(1); }

  // Позиция акка среди акков своей модели — чтобы авы раздавались без повторов.
  const sibs = await c.query(
    `SELECT id FROM accounts WHERE persona=$1 AND deleted_at IS NULL ORDER BY id`, [row.persona]);
  const accIndex = sibs.rows.findIndex((x) => x.id === row.id);
  let ava = pickAvatar(row.persona, row.id, accIndex >= 0 ? accIndex : undefined);
  // ЗАПАСНОЙ ИСТОЧНИК АВЫ: первый кадр карусели фабрики — это исходное фото самой модели.
  // 03.08 у Карины в папке лежало только видео, и подготовка вставала намертво («класть на
  // профиль нечего»). Берём кадр из её же постов: лицо то самое, а разным аккам достаются
  // разные посты, так что одинаковых ав не будет.
  if (!ava) {
    const shots = await c.query(
      // ПОСЛЕДНИЙ кадр карусели, не первый: первый — это фото «до» с наложенным текстом-хуком
      // («Девочки, чат собрал мне стиль-гайд…»), и такая ава выглядит дико. Последний кадр это
      // чистый портрет «после», ровно то, что нужно на аватарку.
      `SELECT meta->'image_urls'->>-1 u FROM posts
        WHERE meta->>'persona'=$1 AND meta ? 'image_urls' ORDER BY created_at DESC LIMIT 8`, [row.persona]);
    const list = shots.rows.map((x) => x.u).filter(Boolean);
    if (list.length) {
      let h = 0; for (const ch of String(row.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const url = list[h % list.length];
      const dest = path.join('/tmp', `ava_${row.persona}_${row.id.slice(0, 8)}.jpg`);
      try {
        // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): fetch без сигнала висит вечно.
        await require('./watchdog.cjs').fetchToFile(url, dest, { what: 'ава', ms: 60000 });
        if (fs.statSync(dest).size > 10000) { ava = dest; console.log(`  ава взята из поста модели (в папке фото нет)`); }
      } catch {}
    }
  }
  console.log(`ПОДГОТОВКА @${row.h} (${row.persona})`);
  console.log(`  ава: ${ava || 'НЕ НАЙДЕНА в папке модели'}`);
  if (!ava) { console.log('ИТОГ: ✗ нет фото модели — класть на профиль нечего'); await c.end(); process.exit(1); }

  const { default: GoLogin } = await import('gologin');
  // БЕЗ ОКНА (правило начальника 06.08: окна не открывать). Тот же приём, что в dressup/chlogin/
  // igsnapcookies: '--headless=new' в extra_params Orbita. Чистка сетки — работа сетевая и по DOM,
  // экран для неё не нужен, а лишнее окно Orbita мешает другим чатам в общей папке.
  // SHOW=1 — вернуть окно, если надо посмотреть глазами.
  const extra = process.env.SHOW === '1' ? [] : ['--headless=new'];
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid, extra }));
  let deleted = 0, avaOk = false, nickOk = false, note = '';

  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    await page.goto(`https://www.instagram.com/${row.h}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(5000); await L.clearOverlays(page);
    const cls = await L.classifyScreen(ctx, page);
    if (cls.state !== 'logged_in') throw new Error(`не залогинены: ${cls.state} (${cls.evidence})`);

    // --- 1. ЧУЖИЕ ПОСТЫ ---
    // getShortcodes бросает исключение, если профиль не отрисовался: пустой список не должен
    // молча означать «постов нет» — иначе решим, что чистить нечего, и оставим чужое в сетке.
    // getShortcodes отдаёт Set → у него .size, не .length. На .length тут молча получалось undefined,
    // чистка пропускалась, а итог честно врал «удалено 0» (так @amari277525 ушёл в постинг с чужими постами).
    // СВОИ публикации НЕ трогаем: 03.08 чистка снесла наш вчерашний ролик Полины (DbjN7kRyQ5J),
    // потому что «чужим» считалось всё подряд. Чужое = чего нет в наших posts.external_url.
    const oursQ = await c.query(
      `SELECT external_url FROM posts WHERE account_id=$1 AND external_url IS NOT NULL`, [row.id]);
    const ours = new Set(oursQ.rows.map((x) => (String(x.external_url).match(/\/(p|reel)\/([^/]+)/) || [])[2]).filter(Boolean));
    const codes = [...await L.getShortcodes(page, row.h)].filter((sc) => !ours.has(sc));
    if (ours.size) console.log(`  наших публикаций в сетке (не трогаем): ${ours.size}`);
    console.log(`  чужих постов на профиле: ${codes.length}`);
    if (codes.length && !KEEP_POSTS) {
      for (const code of codes) {
        try {
          await page.goto(`https://www.instagram.com/p/${code}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await L.sleep(3000); await L.clearOverlays(page);
          const more = page.locator('svg[aria-label="More options"], svg[aria-label="Ещё"]').first();
          if (!(await more.isVisible({ timeout: 6000 }).catch(() => false))) { console.log(`    ${code}: меню «…» не найдено`); continue; }
          await L.clickSafe(page, more, 'меню поста');
          await L.sleep(1500);
          const del = page.getByRole('button', { name: /^(Delete|Удалить)$/i }).first();
          if (!(await del.isVisible({ timeout: 5000 }).catch(() => false))) { console.log(`    ${code}: нет пункта Delete`); continue; }
          await L.clickSafe(page, del, 'Delete', { skipClear: true });
          await L.sleep(1500);
          const conf = page.getByRole('button', { name: /^(Delete|Удалить)$/i }).first();
          if (await conf.isVisible({ timeout: 5000 }).catch(() => false)) await L.clickSafe(page, conf, 'подтвердить Delete', { skipClear: true });
          await L.sleep(3500);
          deleted++;
          console.log(`    ✓ удалён чужой пост ${code}`);
        } catch (e) { console.log(`    ${code}: не удалился — ${String(e.message).slice(0, 80)}`); }
      }
    }

    // --- 2. АВА и 3. НИК: отдаём проверенному dressup, чтобы не плодить вторую реализацию ---
    await b.close().catch(() => {});
    await closeLocal('перед оформлением');
    await L.sleep(4000);

    // CLEAN_ONLY=1 — только чистка сетки, оформление НЕ трогаем. Появился 04.08: prepacc одевает
    // акк под модель поста (лицо+имя), а мультиакки (постят разных девочек) обязаны держать
    // нейтральную аву без лица — чистка на них переодевала акк во вред. Ава считается «в порядке»,
    // раз акк уже был оформлен раньше (dressed_at стоит), и dressed_at НЕ пере-ставится, чтобы
    // не сдвигать 6-часовой гейт постинга.
    if (process.env.CLEAN_ONLY === '1') {
      console.log('  CLEAN_ONLY=1: оформление пропускаю (ава/ник/имя не трогаю)');
      avaOk = !!row.dressed_at;
      throw { cleanOnly: true };
    }

    // РАЗНЕСЕНИЕ ПО ДНЯМ (правило владельца 03.08). Пять акков сгорели на том, что чистка, ава,
    // смена ника и первый пост делались за одну минуту — IG читает такой набор как перехват.
    // Поэтому в ПЕРВЫЙ заход только чистка и ава; ник меняем СЛЕДУЮЩИМ заходом, на другой день.
    // SAME_DAY_NICK=1 — сделать всё сразу (осознанный риск, например на расходном акке).
    const firstVisit = !row.dressed_at;
    const nickAllowed = process.env.SAME_DAY_NICK === '1' || !firstVisit;

    const junk = isJunkNick(row.h);
    const nickName = nameFromNick(row.h);          // женское имя, зашитое в нике
    const nickNow = junk && nickAllowed;
    console.log(`  ник «${row.h}»: ${junk
      ? (nickNow ? 'мусорный → меняем' : 'мусорный → меняем СЛЕДУЮЩИМ заходом (сегодня только ава и чистка)')
      : (nickName ? `нормальный (женское имя «${nickName}») → не трогаем` : 'нормальный → не трогаем')}`);

    const { spawnSync } = require('node:child_process');
    const env = { ...process.env, DB_PUBLIC_URL: DBURL, LOCAL: '1', AVATAR_PATH: ava, SKIP_BIO: '1' };
    // Имя модели идёт в генератор ника: у «Анечки» должен быть ник про Аню, а не про Соню.
    env.PERSONA_NAME = row.persona;

    // ИМЯ ПРОФИЛЯ. Купленные акки приходят с мужским именем от прошлого владельца («Braylen» на
    // аккаунте books.by.nastya) — это сразу выдаёт перекупленный акк. Ставим женское:
    // если в нике есть имя, берём его (легенда подстраивается под ник), иначе имя модели.
    const wantName = nickName || String(row.persona || '').replace(/^Анечка$/, 'Аня');
    if (wantName) {
      env.DRESS_NAME_WANT = wantName;
      console.log(`  имя профиля → «${wantName}»`);
    } else env.SKIP_NAME = '1';

    if (nickNow) env.DRESS_NICK = '1'; else env.AVATAR_ONLY = '1';
    const r = spawnSync('node', [path.join(__dirname, 'dressup.cjs'), SLUG], { env, encoding: 'utf8', timeout: 600000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    avaOk = /ава загружена|ава:\s*да/i.test(out);
    nickOk = /ник сменён|ник изменён|ник:\s*да/i.test(out);
    note = (out.split('\n').find((l) => l.startsWith('ИТОГ:')) || '').slice(0, 200);
    console.log(`  оформление: ${note || 'без итога'}`);
  } catch (e) {
    // Маркер cleanOnly — не ошибка, а штатный выход из блока оформления (см. CLEAN_ONLY выше).
    if (!e || !e.cleanOnly) console.log(`  ⛔ ошибка: ${String(e && e.message).slice(0, 160)}`);
  }
  await closeLocal('finish');

  // Отметку «готов» ставим ТОЛЬКО если ава реально встала: иначе гейт пустит акк с чужим лицом.
  if (avaOk) {
    if (process.env.CLEAN_ONLY !== '1')
      await c.query(`UPDATE accounts SET dressed_at=now(), avatar_set=true WHERE id=$1`, [row.id]).catch(() => {});
    // и возвращаем в очередь то, что снимали до подготовки
    const back = await c.query(
      `UPDATE posts SET status='approved', error=NULL, scheduled_at=now() + interval '10 minutes'
        WHERE account_id=$1 AND status='draft' AND post_submitted=false RETURNING id`, [row.id]).catch(() => ({ rowCount: 0 }));
    console.log(`ИТОГ: ✅ готов (чужих постов удалено ${deleted}, ава да, ник ${nickOk ? 'сменён' : 'не трогали'}), вернули в очередь: ${back.rowCount}`);
  } else {
    console.log(`ИТОГ: ✗ НЕ готов — ава не встала (чужих постов удалено ${deleted}); в постинг не пускаю`);
  }
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
