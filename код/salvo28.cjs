// ЗАЛП НА 28 ПОСТОВ (06.08, вопрос начальника «ты же заказал сразу?»).
//
// Почему залп через фабрику, а не через движок сайта: у движка кнопка генерации БЛОКИРУЕТСЯ,
// пока крутится предыдущая, то есть параллель невозможна и 28 постов растянулись бы на часы.
// Фабрика (/api/admin/promo/posts) рендерит заказы ПАРАЛЛЕЛЬНО: отдаём все заказы подряд,
// потом одним опросом собираем готовые.
//
// Сборка поста: слайд 1 это КАДР ВЛАДЕЛЬЦА как есть (приказ «выставь заглавные фото, которые я
// дал»), слайды 2 и 3 из фабричного рендера по этому же кадру, слайд 4 мой мокап телефона с
// артом плюс плашка призыва. Итого к его картинке добавляется три кадра.
//
// Запуск: node salvo28.cjs            — все кадры из /tmp/uniq_covers.txt
//         node salvo28.cjs 5          — первые 5 (проверка)
'use strict';

// ГЕЙТ ПОДТВЕРЖДЕНИЯ (06.08, после сгоревших 197 руб): это залп на 22 платных заказа. Запуск без явного
// SALVO_CONFIRM=1 запрещён: сначала ОДИН пост глазами и апрув начальника, потом пачка.
if (!/^(1|true|yes)$/i.test(String(process.env.SALVO_CONFIRM || ''))) {
  console.log('ИТОГ: ✗ массовый платный запуск без SALVO_CONFIRM=1 запрещён (правило: сначала один пост)');
  process.exit(3);
}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45, reframe, ctaSlide, lockMock, lockScenePair, factoryHook, postCaption } = require('./slidekit.cjs');
const TPL = require('./templates.cjs');
const { checkCarousel } = require('./framegate.cjs');
const { coverUsed, registerCover } = require('./coverguard.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LOCK = '/tmp/genposts.lock';
const TEMPLATE = process.env.TEMPLATE || 'img-heart-hair';
// Выключенный контрактом шаблон в пачку не идёт никогда (13.08, прецедент magazine-cover: флаг
// disabled стоял, а ротации его не читали). Залп это 20+ платных заказов, тут блок жёсткий.
if (TPL.isDisabled(TEMPLATE)) {
  console.log(`ИТОГ: ✗ шаблон «${TEMPLATE}» выключен в контракте (disabled: true), залп с ним запрещён`);
  process.exit(1);
}
const LIMIT = Number(process.argv[2] || 0);
const START_MS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ЗАЛП ТЕПЕРЬ УМЕЕТ ПОЛОСЫ (13.08). Раньше он ждал ТОЛЬКО нулевую полосу того же замка, и чужая
// пачка с OP_LANES блокировала его наглухо: сегодняшний тестовый залп простоял 13 минут, не начав.
// Полосы считаем ровно как onepost (OP_LANES, нулевая полоса = тот же файл /tmp/genposts.lock),
// поэтому взаимное исключение с соседними скриптами не теряется, а замки не разъезжаются.
const LANES = Math.max(1, Number(process.env.OP_LANES || 1));
const lanePath = (n) => (n === 0 ? LOCK : `${LOCK}.${n}`);
let myLane = null;
async function takeLock(waitMs = 90 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    for (let n = 0; n < LANES; n++) {
      const p = lanePath(n);
      // PID с переводом строки (13.08): cat по нескольким замкам слипал номера в кашу, и проверку
      // «держит ли процесс замок» это молча ломало. Сегодня за это убили две работавшие сборки.
      try { fs.writeFileSync(p, `${process.pid}\n`, { flag: 'wx' }); myLane = p; return; }
      catch {
        // Файл мог исчезнуть между «занято» и чтением: полоса свободна, пробуем её же ещё раз.
        let содержимое = null;
        try { содержимое = fs.readFileSync(p, 'utf8'); } catch { n--; continue; }
        const pid = Number(содержимое.trim() || 0);
        // pid ноль или мусор это не живой держатель: kill(0, 0) сигналит своей же группе процессов
        // и всегда отвечает «жив», пустой файл замка держал бы полосу до протухания.
        let alive = false; try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch {}
        let stale = false; try { stale = Date.now() - fs.statSync(p).mtimeMs > 45 * 60000; } catch {}
        // Полосу освобождаем, только если держатель мёртв или лок совсем старый: иначе это чужая
        // живая сборка, и лезть в неё нельзя.
        if (!alive || stale) { try { fs.unlinkSync(p); } catch {} n--; }
      }
    }
    if (Date.now() > until) throw new Error('конвейер занят больше 90 минут');
    console.log(`  ⏳ жду освобождения конвейера (полос ${LANES})…`);
    await sleep(20000);
  }
}
function freeLock() {
  if (!myLane) return;
  try { if (Number(fs.readFileSync(myLane, 'utf8').trim()) === process.pid) fs.unlinkSync(myLane); } catch {}
}
process.on('exit', freeLock);

// Скачивание кадра ВСЕГДА с таймаутом (07.08): fetch без сигнала висит вечно.
const grab = (url, out) => fetchToFile(url, out, { what: 'кадр', ms: 90000, min: 20000 });

// СТОРОЖ (07.08). Залп это заказы плюс 40 минут опроса плюс сборка: общий лимит 100 минут, но
// главный предохранитель тут «шаг не менялся 10 минут». Именно в фазе опроса залп 06.08 простоял
// молча, печатая «готов девочкаNN», и 197 руб ушли в оплаченные, но не собранные заказы.
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 100), stallMinutes: 10,
  label: 'залп постов через фабрику' });

(async () => {
  let covers = fs.readFileSync('/tmp/uniq_covers.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  covers = covers.filter((f) => fs.existsSync(f));
  if (LIMIT > 0) covers = covers.slice(0, LIMIT);
  console.log(`ЗАЛП: ${covers.length} кадров владельца, шаблон ${TEMPLATE}`);
  // Число полос обязано быть видно в логе, а не угадываться (13.08, правило как в onepost).
  console.log(process.env.OP_LANES
    ? `  полос конвейера: ${LANES} (OP_LANES=${process.env.OP_LANES})`
    : '  полос конвейера: 1 (OP_LANES не задан: жду нулевую полосу замка, как раньше)');

  wd.stage('беру лок конвейера');
  await takeLock();
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  const orders = [];
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    // ФАЗА 1: заливаем кадры и отдаём ВСЕ заказы подряд, не дожидаясь рендеров.
    for (const [i, f] of covers.entries()) {
      const name = `девочка${String(i + 1).padStart(2, '0')}`;
      wd.stage(`отдаю заказ ${i + 1} из ${covers.length} (${name})`);
      try {
        const b64 = fs.readFileSync(f).toString('base64');
        const refUrl = await page.evaluate(async ({ b64, fname }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const fd = new FormData();
          fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
          const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.url) throw new Error(j.error || `upload HTTP ${r.status}`);
          return j.url;
        }, { b64, fname: `${name}.jpg` });

        const fallbackHook = factoryHook(TEMPLATE);
        const res = await page.evaluate(async ({ refUrl, template, fallbackHook }) => {
          const t = await (await fetch('/api/admin/promo/posts', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ templateId: template }),
          })).json().catch(() => ({}));
          let hookText = String(t.hookText || t.hook || '').trim();
          if (hookText.length < 20 || hookText.length > 140) hookText = fallbackHook;
          const r = await fetch('/api/admin/promo/posts', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ customPhotoUrl: refUrl, templateId: template, hookText,
              captionText: t.captionText || t.caption || '' }),
          });
          const j = await r.json().catch(() => ({}));
          // ХУК ВОЗВРАЩАЕМ НАРУЖУ (09.08). Он выбирается ЗДЕСЬ, внутри страницы, а нужен ниже,
          // в фазе 3 (подпись поста и гейт). Раньше наружу отдавался только id, и фаза 3 читала
          // необъявленный `hook` — под 'use strict' это ReferenceError на КАЖДОМ посте, залп ловил
          // его в общий catch и собирал НОЛЬ постов, уже оплатив все рендеры (тот самый инцидент
          // на 197 руб из шапки файла). Пул хуков один и тот же — factoryHook выше.
          return r.ok ? { id: j.id || j.postId || (j.post && j.post.id), hook: hookText }
                      : { err: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 120)}` };
        }, { refUrl, template: TEMPLATE, fallbackHook });
        if (!res || res.err || !res.id) { console.log(`  ✗ ${name}: ${(res && res.err) || 'нет id'}`); continue; }
        orders.push({ id: res.id, name, cover: f, hook: res.hook || fallbackHook });
        console.log(`  → заказан ${name}`);
      } catch (e) { console.log(`  ✗ ${name}: ${String(e.message).slice(0, 70)}`); }
      await sleep(1500);
    }
    console.log(`ЗАЛП ОТДАН: ${orders.length} заказов, рендерятся параллельно`);

    // ФАЗА 2: один общий опрос готовности на все заказы.
    const until = Date.now() + 40 * 60000;
    const ready = new Map();
    wd.stage(`жду рендеры: 0 из ${orders.length}`);
    while (Date.now() < until && ready.size < orders.length) {
      await sleep(15000);
      wd.poke(`жду рендеры: ${ready.size} из ${orders.length}, до конца опроса ${Math.max(0, Math.round((until - Date.now()) / 60000))} мин`);
      const list = await page.evaluate(async () => {
        const r = await fetch('/api/admin/promo/posts');
        return r.ok ? (await r.json()).posts || [] : [];
      });
      for (const o of orders) {
        if (ready.has(o.id)) continue;
        const p = list.find((x) => x.id === o.id);
        if (p && p.status === 'done' && (p.imageUrls || []).length >= 2) {
          ready.set(o.id, p.imageUrls);
          // ЧЕСТНАЯ ФОРМУЛИРОВКА (07.08). Здесь стояло «✓ готов девочкаNN», и это стоило владельцу
          // 197 руб: залп напечатал «готов» 17 раз, процесс сняли в фазе опроса, а постов собрано
          // было НОЛЬ. «Готов» в этой фазе значит только «фабрика отрендерила и деньги списаны»,
          // сборка поста идёт ниже, в фазе 3, и может не состояться вовсе.
          console.log(`  ⧗ ОПЛАЧЕН рендер ${o.name} (${ready.size}/${orders.length}), пост ещё НЕ собран`);
        } else if (p && p.status === 'error') {
          ready.set(o.id, null);
          console.log(`  ✗ упал ${o.name}`);
        }
      }
    }

    // ФАЗА 3: сборка постов. Обложка это КАДР ВЛАДЕЛЬЦА, дальше три кадра от нас.
    const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
    c.on('error', () => {});
    // Закрытие базы ГАРАНТИРОВАНО: живой сокет pg держит процесс так же, как сокет playwright.
    process.on('exit', () => { try { c.end(); } catch {} });
    await c.connect();
    let ok = 0, bad = 0;
    for (const [oi, o] of orders.entries()) {
      wd.stage(`собираю пост ${oi + 1} из ${orders.length} (${o.name})`);
      const urls = ready.get(o.id);
      if (!urls) { bad++; continue; }
      try {
        const tag = `${o.name}_${process.pid}`;
        // Хук ИМЕННО ЭТОГО заказа: он напечатан на кадре 1, поэтому подпись и гейт ниже должны
        // сверяться с ним, а не с чужим или пустым текстом.
        const hook = o.hook || '';
        const s1 = to45(o.cover, `/tmp/sv_${tag}_1.jpg`);                          // его кадр как есть
        const art = await grab(urls[1] || urls[0], `/tmp/sv_${tag}_art.jpg`);      // ч/б арт с сердцами
        const s2 = to45(art, `/tmp/sv_${tag}_2.jpg`);
        // МОКАПЫ СЛАЙДОВ 3 И 4 — РАЗНЫЕ СЦЕНЫ (06.08). Раньше оба собирались одной вёрсткой из
        // одного арта и отличались только временем на часах и наклоном на 12°: в карусели это
        // читалось как один кадр, продублированный дважды.
        // ТЕЛЕФОН ТОЛЬКО ТАМ, ГДЕ ОН РАЗРЕШЁН КОНТРАКТОМ (09.08). Здесь мокап локскрина ставился
        // БЕЗУСЛОВНО на кадры 3 и 4, а шаблон приходит из переменной окружения: запусти залп с
        // карточным шаблоном, и телефон уезжал в бьюти-гайд, где ему делать нечего. Ровно этот брак
        // начальник ловил четыре раза. Разрешение спрашиваем у templates.cjs (phoneOk).
        const PHONE_OK = TPL.phoneOk(TEMPLATE);
        const [sc3, sc4] = lockScenePair(o.name);
        const s3 = urls[2]
          ? to45(await grab(urls[2], `/tmp/sv_${tag}_3src.jpg`), `/tmp/sv_${tag}_3.jpg`)
          : PHONE_OK
            ? to45(await lockMock(s2, `/tmp/sv_${tag}_3mock.jpg`, { scene: sc3, seed: o.name + '-3' }), `/tmp/sv_${tag}_3.jpg`)
            : reframe(s2, `/tmp/sv_${tag}_3.jpg`, o.name + '-3');
        const s4raw = PHONE_OK
          ? to45(await lockMock(s2, `/tmp/sv_${tag}_4mock.jpg`, { scene: sc4, seed: o.name + '-4' }), `/tmp/sv_${tag}_4raw.jpg`)
          : reframe(s2, `/tmp/sv_${tag}_4raw.jpg`, o.name + '-4');
        const s4 = (await ctaSlide(s4raw, `/tmp/sv_${tag}_4.jpg`, { seed: o.name })).out || `/tmp/sv_${tag}_4.jpg`;
        const files = [s1, s2, s3, s4];

        const cu = await coverUsed(s1, o.name);
        if (cu.used) { console.log(`  ⛔ ${o.name}: обложка уже использована в посте ${String(cu.postId).slice(0, 8)}`); bad++; continue; }

        const up = [];
        for (const f of files) {
          const b64f = fs.readFileSync(f).toString('base64');
          up.push(await page.evaluate(async ({ b64f, fname }) => {
            const bin = Uint8Array.from(atob(b64f), (ch) => ch.charCodeAt(0));
            const fd = new FormData();
            fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
            const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.url) throw new Error('кадр не залился');
            return j.url;
          }, { b64f, fname: path.basename(f) }));
          await sleep(700);
        }

        let verdict = 'unknown', problems = [];
        try {
          const vr = await require('./validatepost.cjs').validateCarousel(files, { template: TEMPLATE, coverRef: true });
          verdict = vr.verdict; problems = vr.problems || [];
        } catch {}

        const capText = postCaption(TEMPLATE, { hook });
        // ГЕЙТ ЖЕЛЕЗНЫХ ПРАВИЛ (09.08). Раньше этот путь записи шёл МИМО проверки: правила
        // существовали в framegate, а сюда никто их не звал, и брак ложился на склад молча.
        // Гейт считает сам и не зависит от сети: размеры, поля, повторы кадров, финал-не-кроп,
        // телефон не в том шаблоне, смена цвета волос, хук против подписи.
        const gate = checkCarousel(files, { template: TEMPLATE, hook, caption: capText, phoneUsed: PHONE_OK });
        if (!gate.ok) for (const pr of gate.problems) console.log(`  ⛔ гейт ${o.name}: ${pr}`);
        const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
          AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
        const ins = await c.query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
           VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
          [acc.id, capText, up[0], 'https://neironka.pro',
           JSON.stringify({ template: TEMPLATE, persona: o.name, image_urls: up, frame4: true, refit4: true,
             cover_from_owner: true, salvo: true, source_cover: o.cover, frame3_phone: PHONE_OK,
             validation: { verdict, problems, at: new Date().toISOString() },
             gate: { ok: gate.ok, problems: gate.problems, numbers: gate.numbers, at: new Date().toISOString() } }),
           (verdict === 'reject' || !gate.ok) ? 'rejected' : 'backlog']);
        await registerCover(s1, o.name, ins.rows[0].id).catch(() => {});
        console.log(`  ${verdict === 'reject' ? '⛔' : '✅'} ${o.name} — пост ${String(ins.rows[0].id).slice(0, 8)}${problems.length ? ' (' + problems[0].slice(0, 50) + ')' : ''}`);
        if (verdict !== 'reject' && gate.ok && !/^(1|true|yes)$/i.test(String(process.env.TG_OFF || '')) && !fs.existsSync('/tmp/NO_TG')) {
          try {
            execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
              '--key', String(ins.rows[0].id), '--persona', o.name, '--type', 'сердечки · твой кадр',
              '--note', capText], { cwd: __dirname, encoding: 'utf8', timeout: 2 * 60000 });
          } catch {}
        }
        ok++;
      } catch (e) { console.log(`  ✗ ${o.name}: ${String(e.message).slice(0, 70)}`); bad++; }
    }
    await c.end();
    console.log(`ИТОГ ЗАЛПА: собрано ${ok}, не вышло ${bad} (оплачено рендеров ${[...ready.values()].filter(Boolean).length})`);
  } finally { wd.poke('отцепляюсь от хрома'); await done(); freeLock(); }
  // ЯВНЫЙ ВЫХОД: сокеты playwright после CDP не дают ноде завершиться самой (инцидент 07.08).
  wd.done(0);
})().catch((e) => { freeLock(); wd.fail(e); });
