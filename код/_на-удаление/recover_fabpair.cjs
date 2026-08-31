// СБОРКА ПОСТА ИЗ УЖЕ ОПЛАЧЕННЫХ РЕНДЕРОВ ФАБРИКИ (06.08). Когда factorypost упал ПОСЛЕ
// заказа (кейс to45fit: Тати и Мия), заказы лежат на фабрике готовые: пересобираем из них,
// не тратя деньги на перезаказ. Это factorypost без шага заказа.
// Запуск: node recover_fabpair.cjs <Имя> <шаблон> <id_заказа_А> <id_заказа_Б>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { to45, to45smart, ctaSlide, postCaption } = require('./slidekit.cjs');
const { coverUsed, registerCover } = require('./coverguard.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const [PERSONA, TEMPLATE, ID_A, ID_B] = process.argv.slice(2);
const START_MS = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 40 * 60000) {
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
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('админ-профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);

async function waitDone(page, id) {
  for (let i = 0; i < 100; i++) {
    const p = await page.evaluate(async (id) => {
      const r = await fetch('/api/admin/promo/posts');
      if (!r.ok) return null;
      const x = ((await r.json()).posts || []).find((z) => z.id === id);
      return x ? { st: x.status, urls: x.imageUrls || [] } : null;
    }, id);
    if (p && p.st === 'done' && p.urls.length >= 3) return p.urls;
    if (p && p.st === 'error') throw new Error(`рендер ${id.slice(0, 8)} упал на фабрике`);
    await sleep(6000);
  }
  throw new Error('таймаут ожидания рендера');
}

async function grab(url, out) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`кадр не скачался: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 20000) throw new Error('кадр подозрительно мал');
  fs.writeFileSync(out, buf);
  return out;
}

(async () => {
  if (!PERSONA || !TEMPLATE || !ID_A || !ID_B) { console.log('usage: node recover_fabpair.cjs <Имя> <шаблон> <idA> <idB>'); process.exit(1); }
  // Имя файлов с PID: две параллельные сборки одной персоны писали в ОДНИ /tmp-файлы и
  // подменяли друг другу кадры (06.08: у постов Дарьи и Полины совпали кадры побитово).
  const tag = `${PERSONA.toLowerCase()}_${TEMPLATE.replace('img-', '')}_${process.pid}`;
  const capText = postCaption(TEMPLATE);

  await takeLock();
  // Статичный хром начальника: работаем СВОЕЙ вкладкой в постоянном окне, браузер не трогаем.
  const { openAdmin } = require('./adminbrowser.cjs');
  const { page, done } = await openAdmin();
  let files = [], urls = [];
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    console.log(`${PERSONA}: жду готовности рендеров ${ID_A.slice(0, 8)} и ${ID_B.slice(0, 8)}`);
    const ua = await waitDone(page, ID_A);
    const ub = await waitDone(page, ID_B);

    const f1 = await grab(ua[0], `/tmp/fp_${tag}_1src.jpg`);
    const f2 = await grab(ua[1], `/tmp/fp_${tag}_2src.jpg`);
    const f3 = await grab(ua[2], `/tmp/fp_${tag}_3src.jpg`);
    const f4 = await grab(ub[2], `/tmp/fp_${tag}_4src.jpg`);
    const s1 = to45(f1, `/tmp/fp_${tag}_1.jpg`);
    // ПОЛЯ НЕ БЕЛЫЕ (09.08): to45fit клал белый letterbox по краям, это запрещено. to45smart
    // вписывает карточку с полями под цвет её же бумаги, а обычное фото режет без полей.
    const s2 = to45smart(f2, `/tmp/fp_${tag}_2.jpg`, { topBias: true });
    const s3 = to45(f3, `/tmp/fp_${tag}_3.jpg`);
    const s4 = (await ctaSlide(to45(f4, `/tmp/fp_${tag}_4raw.jpg`), `/tmp/fp_${tag}_4.jpg`)).out || `/tmp/fp_${tag}_4.jpg`;
    files = [s1, s2, s3, s4];

    // ГЕЙТ ОБЛОЖКИ (тот же, что в factorypost). Пересборка из старых заказов особенно легко
    // повторяет кадр: заказ уже отдавал эту обложку в прошлый раз. Ловим ДО заливки.
    const cu = await coverUsed(s1, PERSONA);
    if (cu.used && cu.crossPersona) console.log(`  ⚠ обложка занята другой персоной (${cu.persona})`);
    if (cu.used) throw new Error(`ГЕЙТ: обложка уже использована в посте ${String(cu.postId).slice(0, 8)}, нужен другой кадр`);
    console.log(`  ✓ обложка новая (ближайшая чужая на ${cu.dist} бит из 256)`);

    for (const f of files) {
      const b64f = fs.readFileSync(f).toString('base64');
      urls.push(await page.evaluate(async ({ b64f, name }) => {
        const bin = Uint8Array.from(atob(b64f), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], name, { type: 'image/jpeg' }));
        const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error('кадр не залился');
        return j.url;
      }, { b64f, name: path.basename(f) }));
      await sleep(900);
    }
  } finally { await done(); freeLock(); }

  const crypto = require('node:crypto');
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  if (new Set(files.map(md5)).size !== 4) throw new Error('ГЕЙТ: дубли кадров');
  for (const f of files) if (fs.statSync(f).mtimeMs < START_MS) throw new Error(`ГЕЙТ: старый файл ${f}`);
  console.log('  ✓ гейт кадров пройден');

  let verdict = 'unknown', problems = [];
  try {
    const vr = await require('./validatepost.cjs').validateCarousel(files, { template: TEMPLATE });
    verdict = vr.verdict; problems = vr.problems || [];
    console.log(`  проверка: ${verdict}${problems.length ? ' — ' + problems.slice(0, 2).join('; ') : ''}`);
  } catch (e) { console.log('  ⚠ валидатор не отработал: ' + String(e.message).slice(0, 60)); }

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Привязываем пост к акку СВОЕЙ модели (06.08): раньше был ORDER BY random(), и посты
  // расползались по чужим аккам, ломая легенду. Если своего акка нет, вешаем на любой живой,
  // но публиковать его планировщик не даст: там жёсткий гейт персоны.
  const acc = (await c.query(`SELECT id FROM accounts WHERE session_status='live' AND ig_status='login_ok'
    AND deleted_at IS NULL AND slug NOT LIKE 'FOL%'
    ORDER BY (persona = $1) DESC, random() LIMIT 1`, [PERSONA])).rows[0];
  if (!acc) { await c.end(); throw new Error('нет живого аккаунта'); }
  const ins = await c.query(
    `INSERT INTO posts (account_id, platform, kind, status, caption, media_url, media_type, reply_text, meta)
     VALUES ($1,'instagram','promo',$6,$2,$3,'CAROUSEL',$4,$5::jsonb) RETURNING id`,
    [acc.id, capText, urls[0], 'https://neironka.pro',
     JSON.stringify({ template: TEMPLATE, persona: PERSONA, image_urls: urls,
       frame4: true, refit4: true, cleanplate: true, factory_build: true, recovered: true,
       validation: { verdict, problems, at: new Date().toISOString() } }),
     verdict === 'reject' ? 'rejected' : 'backlog']);
  const id = ins.rows[0].id;
  await c.end();
  // Закрепляем обложку за постом (брак кадр не занимает).
  if (verdict !== 'reject') {
    try { registerCover(files[0], PERSONA, id); }
    catch (e) { console.log('  ⚠ обложка не записалась в журнал: ' + String(e.message).slice(0, 60)); }
  }
  console.log(`ИТОГ: ${verdict === 'reject' ? '⛔ БРАК' : '✅'} ${PERSONA}/${TEMPLATE} — пост ${String(id).slice(0, 8)}`);
  if (verdict !== 'reject') {
    try {
      execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
        '--key', String(id), '--persona', PERSONA, '--type', TEMPLATE.replace('img-', '') + ' · фабрика',
        '--template', TEMPLATE, '--note', capText], { cwd: __dirname, encoding: 'utf8', stdio: 'inherit' });
    } catch { console.log('  ⚠ в ТГ не ушло'); }
  }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
