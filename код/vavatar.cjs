// Ставит реалистичную аву (ИИ-лицо) IG-аккаунту, У КОТОРОГО АВЫ НЕТ. Скачиваем лицо локально → грузим в edit profile.
// usage: node vavatar.cjs "<slug>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const SHOT = process.env.SHOT_DIR;
const SLUG = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loadDb() {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect();
      const a = (await c.query(`SELECT a.gologin_profile_id, g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0];
      await c.end(); return a;
    } catch (e) { await c.end().catch(() => {}); await sleep(2500); }
  }
  throw new Error('db');
}
async function getFace(path) {
  // this-person-does-not-exist.com — API отдаёт уникальное ИИ-лицо (young female). Пара ретраев.
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  for (let k = 0; k < 5; k++) {
    try {
      const meta = await fetch('https://this-person-does-not-exist.com/new?time=' + Date.now() + k + '&gender=female&etnic=all&age=19-25', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
      if (meta && meta.src) {
        const im = await fetch('https://this-person-does-not-exist.com' + meta.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
        const buf = Buffer.from(await im.arrayBuffer());
        if (buf.length > 10000) { fs.writeFileSync(path, buf); return true; }
      }
    } catch {}
    await sleep(2000);
  }
  return false;
}
(async () => {
  if (!SLUG) { console.log('usage: <slug>'); return; }
  const facePath = `${SHOT || '/tmp'}/face_${SLUG.replace(/\s+/g, '_')}.jpg`;
  if (!await getFace(facePath)) { console.log('НЕ скачал лицо'); return; }
  console.log('лицо скачано:', fs.statSync(facePath).size, 'байт');
  const a = await loadDb(); const tok = a.gologin_token || process.env.GOLOGIN_API_TOKEN;
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', a.gologin_profile_id);
  let b; for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch (e) { console.log('коннект try' + k); await sleep(k === 0 ? 22000 : 14000); } }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  const snap = async (n) => { try { if (SHOT) fs.writeFileSync(`${SHOT}/av_${SLUG.replace(/\s+/g, '_')}_${n}.png`, await page.screenshot({ type: 'png', timeout: 15000 })); } catch {} };
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    // грузим edit-профиль (hl=en для стабильного текста), с ретраем — KZ-прокси иногда вешает загрузку
    for (let g = 0; g < 3; g++) {
      await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(6000);
      if ((await page.locator('input[type="file"]').count().catch(() => 0)) || (await page.getByText(/Change (profile )?photo|Изменить фото/i).count().catch(() => 0))) break;
      console.log('edit не догрузился, релоад ' + g);
    }
    await snap('0_edit');
    // Аватар меняется ТОЛЬКО через кнопку «Change photo» → модалка загрузки. Жмём её ВСЕГДА (на странице есть посторонний
    // input[type=file], который к аве не относится — нельзя лить в первый попавшийся).
    const inputsBefore = await page.locator('input[type="file"]').count().catch(() => 0);
    const change = page.getByText(/^(Change photo|Change Profile Photo|Изменить фото|New photo)$/i).first();
    if (await change.isVisible().catch(() => false)) { await change.click().catch(() => {}); await sleep(2500); await snap('0b_menu'); }
    // В модалке может быть промежуточная кнопка «Upload photo/Загрузить» с input внутри — или сразу input.
    // Берём НОВЫЙ input (появившийся после клика) — это инпут аватара.
    let fileInput = page.locator('input[type="file"]').last();
    const inputsAfter = await page.locator('input[type="file"]').count().catch(() => 0);
    if (inputsAfter <= inputsBefore && inputsBefore > 0) {
      // новый инпут не появился — попробуем через «Upload photo»
      const up = page.getByText(/^(Upload [Pp]hoto|Загрузить фото)$/i).first();
      if (await up.isVisible().catch(() => false)) { await up.click().catch(() => {}); await sleep(1500); }
      fileInput = page.locator('input[type="file"]').last();
    }
    if (!(await fileInput.count().catch(() => 0))) { console.log('НЕ нашёл файловый инпут аватара'); await snap('nofile'); return; }
    await fileInput.setInputFiles(facePath).catch((e) => console.log('setInputFiles:', String(e.message).slice(0, 50)));
    await sleep(4500); await snap('1_uploaded');
    // Возможен диалог кадрирования/подтверждения → жмём Apply/Save/Готово. Иногда применяется сразу.
    for (const rx of [/^(Apply|Применить|Save|Сохранить|Done|Готово|Set as profile photo|Confirm)$/i]) {
      const btn = page.getByText(rx).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(3000); console.log('нажал подтверждение'); break; }
    }
    await sleep(3000); await snap('2_done');
    // Проверка: у аватара в шапке edit-страницы больше не дефолтная иконка (грубо — по наличию img в кнопке фото).
    console.log('готово (проверь скрины av_*_2_done)');
  } catch (e) { console.log('ОШИБКА', String(e.message).slice(0, 80)); await snap('err'); }
  finally { await fetch('https://api.gologin.com/browser/' + a.gologin_profile_id + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {}); await b.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
