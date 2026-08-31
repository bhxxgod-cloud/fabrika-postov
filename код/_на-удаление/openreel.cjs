// openreel.cjs — открыть 1 акк ЛОКАЛЬНО (Orbita), навигировать на рил, открыть комменты, снять скрин + дамп
// структуры комментов (автор / текст / это ответ-в-ветке?). Держит окно открытым (правила: не pkill, stopLocal).
// Запуск: OPEN_URL=<reel> node openreel.cjs <slug>   Останов: kill <pid этого процесса> (закроет через stopLocal).
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const URL = process.env.OPEN_URL || 'https://www.instagram.com/reel/Da5nHB4IbKf/';
const SHOT = process.env.SHOT_DIR || '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { default: GoLogin } = await import('gologin');
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  const a = (await c.query(
    `SELECT a.slug, a.gologin_profile_id pid, coalesce(g.gologin_token,(SELECT gologin_token FROM account_groups WHERE name='РАБОТЯГИ' LIMIT 1)) tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE lower(a.slug)=lower($1) AND a.gologin_profile_id IS NOT NULL`, [SLUG])).rows[0];
  await c.end();
  if (!a) { console.log('акк не найден'); return; }
  console.log(`открываю ЛОКАЛЬНО: ${a.slug} (профиль ${String(a.pid).slice(0, 8)})`);
  await fetch('https://api.gologin.com/browser/' + a.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.tok } }).catch(() => {});
  await sleep(3000);
  const gl = new GoLogin({ token: a.tok, profile_id: a.pid, resolution: { width: 1280, height: 900 } });
  const st = await gl.startLocal();
  const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
  const page = b.contexts()[0].pages()[0] || await b.contexts()[0].newPage();
  console.log('навигирую на рил…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000);
  await page.screenshot({ path: `${SHOT}/reel_${a.slug}_open.png` }).catch(() => {});
  console.log('url:', page.url());

  // дамп структуры комментов: ищем блоки коммента (аватар-ссылка + текст + Reply). Эвристика по DOM.
  const dump = await page.evaluate(() => {
    const out = [];
    // комментарии на реле лежат в списке; берём элементы, где есть ссылка на профиль + текст + кнопка Reply/лайк
    const nodes = Array.from(document.querySelectorAll('div,li')).filter((el) => {
      const t = el.innerText || '';
      return /(^|\s)(Reply|Ответить)(\s|$)/.test(t) && t.length < 400 && el.querySelector('a[href^="/"]');
    });
    for (const el of nodes.slice(0, 25)) {
      const a = el.querySelector('a[href^="/"]');
      const author = a ? a.getAttribute('href').replace(/\//g, '') : '?';
      const txt = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
      // отступ слева = вложенность (ответ в ветке)
      const indent = el.getBoundingClientRect().left;
      out.push({ author, txt, indent: Math.round(indent) });
    }
    return out;
  }).catch(() => []);
  console.log(`\n=== НАЙДЕНО коммент-блоков: ${dump.length} ===`);
  for (const d of dump) console.log(`  [left=${d.indent}] @${d.author}: ${d.txt}`);
  await page.screenshot({ path: `${SHOT}/reel_${a.slug}_comments.png`, fullPage: false }).catch(() => {});
  console.log(`\nскрины: reel_${a.slug}_open.png / _comments.png. Окно оставляю открытым.`);
  const stop = async () => { try { await gl.stopLocal(); } catch {} try { await b.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  setInterval(() => {}, 1 << 30);
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 160)));
