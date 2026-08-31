// СПАСЕНИЕ ОПЛАЧЕННОГО (06.08). Залп отдал 22 заказа, 17 отрендерились и были ОПЛАЧЕНЫ, но
// сборка постов не дошла: процесс убили в фазе опроса, и всё оплаченное осталось бесхозным
// (ревизия: 197 руб потрачено, 0 постов собрано).
//
// Что делает: берёт готовые заказы фабрики по шаблону за окно залпа, сопоставляет их с кадрами
// владельца ПО ПОРЯДКУ (заказы отдавались строго в порядке /tmp/uniq_covers.txt), собирает посты
// и кладёт на склад. Ничего нового НЕ заказывает: только забирает уже оплаченное.
//
// Запуск: node harvest_salvo.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45, reframe, ctaSlide, lockMock, lockScenePair, postCaption } = require('./slidekit.cjs');
const TPL = require('./templates.cjs');
const { checkCarousel } = require('./framegate.cjs');
const { coverUsed, registerCover } = require('./coverguard.cjs');
const { armWatchdog, fetchToFile } = require('./watchdog.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LOCK = '/tmp/genposts.lock';
const TEMPLATE = process.env.TEMPLATE || 'img-heart-hair';
const SINCE = process.env.SINCE || '2026-08-06T15:00:00.000Z';   // старт залпа
const LIMIT = Number(process.argv[2] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 30 * 60000) {
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

// Скачивание кадра ВСЕГДА с таймаутом (07.08): fetch без сигнала висит вечно, и это тот же тихий
// висяк, из-за которого прогон «шёл» 45 минут вместо работы.
const grab = (url, out) => fetchToFile(url, out, { what: 'кадр', ms: 90000, min: 20000 });

// СТОРОЖ (07.08). Харвест это ПАЧКА: общий лимит считаем от числа постов, но главный предохранитель
// тут «шаг не менялся 8 минут» — один пост столько не собирается, значит мы висим.
const wd = armWatchdog({ minutes: Number(process.env.WD_MINUTES || 60), stallMinutes: 8,
  label: 'харвест оплаченных заказов' });

(async () => {
  wd.stage('читаю список кадров владельца');
  const covers = fs.readFileSync('/tmp/uniq_covers.txt', 'utf8').split('\n').map((s) => s.trim()).filter((f) => f && fs.existsSync(f));
  await takeLock();
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, keepAlive: true });
  c.on('error', () => {});
  await c.connect();
  let ok = 0, skip = 0, bad = 0;
  try {
    wd.stage('спрашиваю фабрику про оплаченные заказы');
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3500);
    const list = await page.evaluate(async ({ tpl, since }) => {
      const r = await fetch('/api/admin/promo/posts');
      if (!r.ok) return [];
      return ((await r.json()).posts || [])
        .filter((p) => p.templateId === tpl && p.createdAt >= since && p.status === 'done' && (p.imageUrls || []).length >= 2)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map((p) => ({ id: p.id, urls: p.imageUrls, at: p.createdAt, cost: p.providerCostKopecks || 0 }));
    }, { tpl: TEMPLATE, since: SINCE });
    console.log(`оплаченных готовых заказов: ${list.length}, кадров владельца: ${covers.length}`);
    const work = LIMIT > 0 ? list.slice(0, LIMIT) : list;

    for (const [i, o] of work.entries()) {
      const name = `девочка${String(i + 1).padStart(2, '0')}`;
      wd.stage(`собираю пост ${i + 1} из ${work.length} (${name})`);
      const cover = covers[i];
      if (!cover) { console.log(`  ⚠ ${name}: нет парного кадра владельца, пропуск`); skip++; continue; }
      try {
        const tag = `hv_${name}`;
        const s1 = to45(cover, `/tmp/${tag}_1.jpg`);
        const cu = await coverUsed(s1, name);
        if (cu.used) { console.log(`  ⚠ ${name}: обложка уже в посте ${String(cu.postId).slice(0, 8)}, пропуск`); skip++; continue; }
        const art = await grab(o.urls[1] || o.urls[0], `/tmp/${tag}_art.jpg`);
        const s2 = to45(art, `/tmp/${tag}_2.jpg`);
        // Слайды 3 и 4 — РАЗНЫЕ сцены мокапа, а не один кадр с другим временем на часах (06.08).
        // ТЕЛЕФОН ТОЛЬКО ПО КОНТРАКТУ (09.08), см. тот же разбор в salvo28: мокап ставился
        // безусловно, а шаблон берётся из переменной окружения, и телефон уезжал в карточные посты.
        const PHONE_OK = TPL.phoneOk(TEMPLATE);
        const [sc3, sc4] = lockScenePair(name);
        const s3 = o.urls[2]
          ? to45(await grab(o.urls[2], `/tmp/${tag}_3src.jpg`), `/tmp/${tag}_3.jpg`)
          : PHONE_OK
            ? to45(await lockMock(s2, `/tmp/${tag}_3mock.jpg`, { scene: sc3, seed: name + '-3' }), `/tmp/${tag}_3.jpg`)
            : reframe(s2, `/tmp/${tag}_3.jpg`, name + '-3');
        const base4 = PHONE_OK
          ? to45(await lockMock(s2, `/tmp/${tag}_4mock.jpg`, { scene: sc4, seed: name + '-4' }), `/tmp/${tag}_4raw.jpg`)
          : reframe(s2, `/tmp/${tag}_4raw.jpg`, name + '-4');
        const s4 = (await ctaSlide(base4, `/tmp/${tag}_4.jpg`, { seed: name })).out || `/tmp/${tag}_4.jpg`;
        const files = [s1, s2, s3, s4];

        const urls = [];
        for (const f of files) {
          const b64f = fs.readFileSync(f).toString('base64');
          urls.push(await page.evaluate(async ({ b64f, fname }) => {
            const bin = Uint8Array.from(atob(b64f), (ch) => ch.charCodeAt(0));
            const fd = new FormData();
            fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
            const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.url) throw new Error('кадр не залился');
            return j.url;
          }, { b64f, fname: path.basename(f) }));
          await sleep(600);
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
        if (!gate.ok) for (const pr of gate.problems) console.log(`  ⛔ гейт ${name}: ${pr}`);
        const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
          AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
        const ins = await c.query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
           VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
          [acc.id, capText, urls[0], 'https://neironka.pro',
           JSON.stringify({ template: TEMPLATE, persona: name, image_urls: urls, frame4: true, refit4: true,
             cover_from_owner: true, harvested: true, factory_order: o.id, source_cover: cover,
             frame3_phone: PHONE_OK,
             validation: { verdict, problems, at: new Date().toISOString() },
             gate: { ok: gate.ok, problems: gate.problems, numbers: gate.numbers, at: new Date().toISOString() } }),
           (verdict === 'reject' || !gate.ok) ? 'rejected' : 'backlog']);
        try { await registerCover(s1, name, ins.rows[0].id); } catch {}
        console.log(`  ${verdict === 'reject' ? '⛔' : '✅'} ${name} — пост ${String(ins.rows[0].id).slice(0, 8)} (спасён заказ ${String(o.id).slice(0, 8)}, ${(o.cost / 100).toFixed(2)} руб)`);
        ok++;
      } catch (e) { console.log(`  ✗ ${name}: ${String(e.message).slice(0, 70)}`); bad++; }
    }
  } finally { wd.poke('отцепляюсь от хрома и от базы'); await done(); await c.end().catch(() => {}); freeLock(); }
  // ЯВНЫЙ ВЫХОД: сокеты playwright после CDP не дают ноде завершиться самой (инцидент 07.08).
  wd.done(0, `ИТОГ ХАРВЕСТА: спасено ${ok}, пропущено ${skip}, ошибок ${bad}`);
})().catch((e) => { freeLock(); wd.fail(e); });
