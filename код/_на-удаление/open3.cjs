// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
// Открыть N наших акков ЛОКАЛЬНО (Orbita на этом компе) и ОСТАВИТЬ открытыми для ручной проверки.
// Запуск: node open3.cjs [slug1 slug2 slug3]   (по умолчанию chace6561 reid16884 slade882173)
// Останов: kill $(cat /tmp/open3.pid)  — браузеры закроются.
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUGS = process.argv.slice(2).length ? process.argv.slice(2) : ['chace6561', 'reid16884', 'slade882173'];
const URL = process.env.OPEN_URL || 'https://www.instagram.com/reel/DZQe5pIIP-C/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { default: GoLogin } = await import('gologin');
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  // LEFT JOIN + фолбэк токена: акки без группы тоже открываем (иначе тихо пропускались).
  const rows = (await c.query(
    `SELECT a.slug, a.gologin_profile_id AS pid,
            coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОТЯГИ' LIMIT 1)) AS tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.slug = ANY($1) AND a.gologin_profile_id IS NOT NULL`, [SLUGS])).rows;
  if (!rows.length) console.log('НЕ НАЙДЕНО ни одного акка из:', SLUGS.join(', '));
  await c.end();

  const opened = [];
  for (const r of rows) {
    try {
      // Гасим возможную облачную сессию профиля, чтобы локальная поднялась чисто.
      await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {});
      await sleep(3000);
      const gl = new GoLogin({ token: r.tok, profile_id: r.pid, resolution: { width: 1280, height: 900 } });
      const st = await gl.startLocal();
      const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
      const page = b.contexts()[0].pages()[0] || await b.contexts()[0].newPage();
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      opened.push({ slug: r.slug, gl, b });
      console.log(`✅ ОТКРЫТ: ${r.slug}  (${st.wsUrl.slice(0, 34)}…)`);
    } catch (e) {
      console.log(`❌ ${r.slug}: ${String(e.message).slice(0, 90)}`);
    }
  }
  console.log(`\nОткрыто браузеров: ${opened.length}. Смотри окна Orbita на экране.`);
  console.log('Оставляю открытыми. Закрыть все:  kill $(cat /tmp/open3.pid)');

  // Держим процесс живым, чтобы браузеры не закрылись.
  const stopAll = async () => {
    for (const o of opened) { await o.gl.stopLocal().catch(() => {}); await o.b.close().catch(() => {}); }
    process.exit(0);
  };
  process.on('SIGTERM', stopAll); process.on('SIGINT', stopAll);
  setInterval(() => {}, 1 << 30);
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 140)));
