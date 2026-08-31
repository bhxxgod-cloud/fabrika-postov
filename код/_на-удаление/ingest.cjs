// ПРИЁМ СЫРЬЯ ОТ ЧАТОВ-ГЕНЕРАТОРОВ (05.08). Постер владеет сборкой, генераторы дают материал.
//
// Вход: json-манифест в inbox/, формат:
// {
//   "batch": "seo-2026-08-05",
//   "items": [{
//     "persona": "Полина",
//     "template": "img-beauty-guide",
//     "slide1":  "/путь/живой_лайфстайл.jpg",     // ТОЛЬКО лайфстайл, не выход шаблона
//     "results": ["/путь/результат1.jpg", "/путь/результат2.jpg"],  // 1-й → слайд 3, 2-й → слайд 4
//     "hook":    "текст хука"                      // опционально, иначе берём из пула
//   }]
// }
//
// Что делает: проверяет файлы и запрещённые маски, собирает карусель по СТАНДАРТУ
// (1 хук · 2 промпт · 3 результат · 4 результат+призыв), режет всё в 4:5, заливает,
// кладёт на склад и шлёт карточку в ТГ. Ничего не публикует сам — этим занят postdaemon.
//
// Запуск: node ingest.cjs <манифест.json>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45, hookSlide, ctaSlide } = require('./slidekit.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const MANIFEST = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Слайд 1 — только живой кадр: выходы шаблонов сюда не пускаем (правило начальника 05.08).
const TEMPLATE_OUT = /report_|_rain_reels_|_hearts_|_doodle_|_glam_|_art|lockscreen|_brand|slide4|canon|neironka\.pro-gen/i;

const HOOKS = [
  'сделала себе такой кадр\nза пару минут в нейросети',
  'не могу перестать делать\nэто со своими фото 🥹',
  'нашла шаблон, который\nделает вот такое из обычного фото',
  'просто закинула своё фото\nи получила вот это',
];
const pickHook = (seed) => { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return HOOKS[h % HOOKS.length]; };

async function takeLock(waitMs = 25 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      // Лок держит СМОТРИТЕЛЬ окна (правило начальника 06.08: хром с нейронкой всегда открыт,
      // когда конвейер свободен) — просим его уступить и ждём.
      try { if (String(pid) === fs.readFileSync('/tmp/genkeeper.pid','utf8').trim()) fs.writeFileSync('/tmp/genkeeper.stop',''); } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      // TTL: генерация не живёт дольше 45 минут, всё старше = зависший лок (06.08 конвейер
      // дважды вставал из-за вечного лока после жёсткого убийства процесса).
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('админ-профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);

(async () => {
  if (!MANIFEST || !fs.existsSync(MANIFEST)) { console.log('usage: node ingest.cjs <манифест.json>'); process.exit(1); }
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const items = man.items || [];
  console.log(`манифест «${man.batch || path.basename(MANIFEST)}»: ${items.length} позиций`);

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'tplprompts.json'), 'utf8')); } catch {}

  // Готовим кадры локально: проверки + рендер надписей + приведение к 4:5.
  const built = [];
  for (const [i, it] of items.entries()) {
    const tag = `${(it.persona || 'x').toLowerCase()}_${i}`;
    try {
      if (!it.slide1 || !fs.existsSync(it.slide1)) throw new Error('нет слайда 1');
      if (TEMPLATE_OUT.test(path.basename(it.slide1))) throw new Error(`слайд 1 — выход шаблона (${path.basename(it.slide1)})`);
      const res = (it.results || []).filter((f) => f && fs.existsSync(f));
      if (!res.length) throw new Error('нет ни одного результата');
      const prompt = cache[it.template];
      if (!prompt) throw new Error(`нет промпта шаблона ${it.template} в кэше`);

      const s1 = await hookSlide(it.slide1, `/tmp/ing_${tag}_1.jpg`, it.hook || pickHook(tag));
      const s2 = `/tmp/ing_${tag}_2.jpg`;
      execFileSync('node', [path.join(__dirname, 'frame4.cjs'), '--text', prompt, s2], { encoding: 'utf8', timeout: 150000 });
      const s3 = to45(res[0], `/tmp/ing_${tag}_3.jpg`);
      const s4 = await ctaSlide(res[1] || res[0], `/tmp/ing_${tag}_4.jpg`);
      built.push({ ...it, files: [s1, s2, s3, s4], hookText: it.hook || pickHook(tag) });
      console.log(`  ✓ ${it.persona}/${it.template}: 4 кадра готовы`);
    } catch (e) { console.log(`  ✗ ${it.persona}/${it.template}: ${String(e.message).slice(0, 70)}`); }
  }
  if (!built.length) { console.log('ИТОГ: собирать нечего'); return; }

  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1200, height: 860 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let ok = 0;
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (const b of built) {
      try {
        const urls = [];
        for (const f of b.files) {
          const b64 = fs.readFileSync(f).toString('base64');
          urls.push(await page.evaluate(async ({ b64, name }) => {
            const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
            const fd = new FormData();
            fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
            const x = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
            const j = await x.json().catch(() => ({}));
            if (!x.ok || !j.url) throw new Error(j.error || `HTTP ${x.status}`);
            return j.url;
          }, { b64, name: path.basename(f) }));
          await sleep(900);
        }
        const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
          AND deleted_at IS NULL AND slug NOT LIKE 'FOL%' ORDER BY random() LIMIT 1`)).rows[0];
        const ins = await c.query(
          `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
           VALUES ($1,'instagram','promo','backlog',$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
          [acc.id, b.hookText, urls[0], 'https://neironka.pro',
           JSON.stringify({ template: b.template, persona: b.persona, image_urls: urls,
             frame4: true, refit4: true, manual_ok: true, from_batch: man.batch || null })]);
        const id = ins.rows[0].id;
        execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...b.files, '--carousel',
          '--key', String(id), '--persona', b.persona, '--type', String(b.template).replace('img-', ''),
          '--template', b.template, '--note', b.hookText], { cwd: __dirname, encoding: 'utf8' });
        ok++;
        console.log(`  → склад+ТГ: ${b.persona}/${b.template} (${String(id).slice(0, 8)})`);
      } catch (e) { console.log(`  ✗ ${b.persona}: ${String(e.stdout || e.message).slice(-70)}`); }
      await sleep(18000);   // пауза против флуд-лимита ТГ
    }
  } finally { await ctx.close().catch(() => {}); freeLock(); await c.end(); }
  console.log(`ИТОГ: принято ${ok} из ${items.length}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
