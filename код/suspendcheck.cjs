// СУСПЕНД-ДЕТЕКТ: открывает акк в облаке, грузит IG-главную; если URL/текст содержит "suspended"
// (акк редиректит на /accounts/suspended/) — значит БАН. Ловит «залогинен, но забанен» — кука жива,
// ensureLoggedIn=true, а акк на деле suspended (кейс reid/slade: в базе login_ok, а реально в бане).
// Найденных метит ig_status='suspended' + status=paused + session_status=dead → Фаза-2 (maybeReplaceBlocked)
// снесёт профиль и заведёт замену из очереди. Гонит по ОДНОМУ (CONC=1), гасит cloud-сессию, режет трафик.
// usage: DB_PUBLIC_URL=<pub> node suspendcheck.cjs [slug ...]   (без slug — все live comment-акки)
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function db(q, p) {
  const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect(); const r = await c.query(q, p); await c.end(); return r.rows;
}
// ПРИГОВОР ТОЛЬКО ПО ОДНОЗНАЧНЫМ ПРИЗНАКАМ (07.08, разбор ложных вердиктов).
// Было: SUSP_URL = /\/accounts\/suspended|suspended/i и SUSP_TXT с голым «suspend». Слово ловилось
// подстрокой где угодно: в адресе вида ?next=…suspended…, в тексте справки, а главное в заглушке
// провайдера прокси или хостинга «Account suspended». Такой шум писал ig_status='suspended' +
// status='paused', а это прямая дорога под автоснос профиля GoLogin вместе с прогревом и куками.
// Теперь: в URL только реальный путь бана; в тексте только фразы, которые Instagram пишет сам.
const SUSP_URL = /\/accounts\/suspended/i;
const SUSP_TXT = /we (suspended|disabled) your account|your account has been (suspended|disabled)|account has been disabled|мы (приостановили|отключили|заблокировали) (действие )?ваш\w* аккаунт|ваш аккаунт (приостановлен|отключён|отключен|деактивирован)|нарушил(и)? (наши )?правил/i;
// Экран, который НИЧЕГО не доказывает: страница не наша (заглушка прокси или провайдера) либо
// пустая (не догрузилась). По такому экрану вердикт не выносим вообще, считаем ошибкой прогона.
const IG_HOST = /^https?:\/\/([a-z0-9-]+\.)*instagram\.com/i;

(async () => {
  const slugs = process.argv.slice(2);
  const rows = await db(
    `SELECT a.slug, a.gologin_profile_id pid, g.gologin_token tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL AND g.gologin_token IS NOT NULL
       ${slugs.length ? 'AND a.slug = ANY($1)' : "AND coalesce(a.session_status,'')='live'"}
     ORDER BY a.slug`, slugs.length ? [slugs] : []);
  console.log(`Проверяю на суспенд: ${rows.length} акк(ов) (по одному)\n`);
  let banned = 0, ok = 0, err = 0;
  for (const a of rows) {
    let b = null;
    try {
      const u = new URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', a.tok); u.searchParams.set('profile', a.pid);
      for (let k = 0; k < 4 && !b; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); } catch { await sleep(k === 0 ? 15000 : 10000); } }
      if (!b) { console.log(`  … ${a.slug}: не подключился (облако штормит?)`); err++; continue; }
      const ctx = b.contexts()[0] || (await b.newContext());
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.route('**/*', (r) => (['media', 'image', 'font'].includes(r.request().resourceType()) ? r.abort().catch(() => {}) : r.continue().catch(() => {}))).catch(() => {});
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(4000);
      const url = page.url();
      const body = (await page.evaluate(() => (document.body.innerText || '').slice(0, 800)).catch(() => '')) || '';
      // Гейт достоверности экрана: не Instagram или пустая страница = смотреть не на что.
      // Раньше такой прогон мог дать «СУСПЕНД» по слову из чужой заглушки и снести живой акк.
      if (!IG_HOST.test(url) || !body.trim()) {
        console.log(`  … ${a.slug}: экран не показал IG (${!body.trim() ? 'страница пустая' : url.slice(0, 50)}) — вердикт НЕ выношу`);
        err++; continue;
      }
      const isSusp = SUSP_URL.test(url) || SUSP_TXT.test(body);
      if (isSusp) {
        await db(`UPDATE accounts SET ig_status='suspended', status='paused', session_status='dead', session_checked_at=now() WHERE slug=$1 AND platform='comments' AND deleted_at IS NULL`, [a.slug]);
        console.log(`  ⛔ ${a.slug}: СУСПЕНД  [${url.replace('https://www.instagram.com', '')}] → помечен suspended (Фаза-2 снесёт+заменит)`);
        banned++;
      } else { console.log(`  ✓ ${a.slug}: чист`); ok++; }
    } catch (e) { console.log(`  … ${a.slug}: ошибка ${String(e.message).slice(0, 70)}`); err++; }
    finally {
      try { await b?.close(); } catch {}
      await fetch('https://api.gologin.com/browser/' + a.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.tok } }).catch(() => {}); // гасим cloud-слот
    }
    await sleep(1500);
  }
  console.log(`\n=== ИТОГ === ⛔ суспенд ${banned} · ✓ чисто ${ok} · … ошибок ${err}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('FATAL', e.message); process.exit(1); });
