'use strict';
// АВТО-ОБНОВЛЕНИЕ ТОКЕНА ВК (24.08).
// Пользовательский токен ВК живёт ровно сутки, а video.save работает только с ним.
// Скрипт держит свой профиль Chrome (~/.neironka/vkprofile), где ВК залогинен один раз руками.
// Дальше сам открывает authorize, забирает токен из адреса редиректа, кладёт в базу
// и поднимает задачи канала из ошибок «User authorization failed».
//
//   node vktoken.cjs            один прогон (тихо, окно скрыто за экраном)
//   node vktoken.cjs --login    открыть окно, чтобы залогиниться в ВК руками (первый раз)
//   node vktoken.cjs loop       крутиться и обновлять раз в 12 часов
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright-core');
const { Client } = require('pg');

const PROFILE = path.join(os.homedir(), '.neironka', 'vkprofile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_ID = '54728511';
// SCOPE. Пробовал добавить offline ради бессрочного токена (29.08) — ВК отвечает invalid scope,
// он его больше не принимает. Токен живёт сутки, поэтому обновлялку крутим по расписанию.
const SCOPE = 'video,wall,groups';
const AUTH = `https://oauth.vk.com/authorize?client_id=${APP_ID}&display=page`
  + `&redirect_uri=https://oauth.vk.com/blank.html&scope=${SCOPE}&response_type=token&v=5.199`;
const DBURL = () => fs.readFileSync(path.join(os.homedir(), '.neironka_dburl'), 'utf8').trim();
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ru-RU')}]`, ...a);

async function grab({ visible = false } = {}) {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: false, viewport: { width: 1100, height: 800 },
    // окно уводим за пределы экрана, чтобы не мешало владельцу работать
    args: visible ? [] : ['--window-position=-2400,-2400'],
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(AUTH, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // ВК уже знает про выданный доступ: редиректит на blank.html#access_token=...
    try {
      await page.waitForURL(/blank\.html#.*access_token=/, { timeout: visible ? 300000 : 25000 });
    } catch {
      const u = page.url();
      if (/error=/.test(u)) throw new Error('ВК отказал: ' + decodeURIComponent(u.split('error_description=')[1] || u).slice(0, 120));
      throw new Error('НУЖЕН ВХОД: залогинься в ВК один раз — node vktoken.cjs --login');
    }
    const m = page.url().match(/access_token=([^&]+).*?expires_in=(\d+)/);
    if (!m) throw new Error('в адресе нет токена');
    return { token: m[1], expires: Number(m[2]) };
  } finally { await ctx.close().catch(() => {}); }
}

async function save(tok, expires) {
  const chk = await (await fetch(`https://api.vk.com/method/users.get?access_token=${tok}&v=5.199`)).json();
  if (chk.error) throw new Error('токен не рабочий: ' + chk.error.error_msg);
  const c = new Client({ connectionString: DBURL(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const cur = (await c.query(`SELECT auth FROM yt_channels WHERE slug='vk_neironka'`)).rows[0]?.auth || {};
    cur.access_token = tok; cur.token_at = new Date().toISOString();
    cur.expires_at = new Date(Date.now() + expires * 1000).toISOString();
    await c.query(`UPDATE yt_channels SET auth=$1::jsonb WHERE slug='vk_neironka'`, [JSON.stringify(cur)]);
    // задачи, которые упали именно из-за протухшего токена, возвращаем в очередь
    const r = await c.query(`UPDATE yt_queue SET status='queued', error=NULL, locked_at=NULL
      WHERE channel_id=(SELECT id FROM yt_channels WHERE slug='vk_neironka')
        AND status='error' AND error ILIKE '%authorization failed%'`);
    return { who: chk.response[0].first_name + ' ' + chk.response[0].last_name, revived: r.rowCount, hours: Math.round(expires / 3600) };
  } finally { await c.end(); }
}

async function once(opts) {
  const { token, expires } = await grab(opts);
  const r = await save(token, expires);
  log(`токен обновлён (${r.who}), живёт ${r.hours} ч | поднято из ошибок: ${r.revived}`);
}

(async () => {
  const mode = process.argv[2] || '';
  if (mode === '--login') {
    log('открываю окно ВК: залогинься и нажми «Разрешить», окно закроется само');
    await once({ visible: true });
    return;
  }
  if (mode === 'loop') {
    log('слежу за токеном ВК, обновление каждые 12 часов');
    for (;;) {
      try { await once({}); } catch (e) { log('НЕ ВЫШЛО:', e.message); }
      await new Promise((r) => setTimeout(r, 12 * 3600 * 1000));
    }
  }
  await once({});
})().catch((e) => { log('ОШИБКА:', e.message); process.exit(1); });
