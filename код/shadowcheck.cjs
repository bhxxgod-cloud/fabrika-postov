// SHADOWCHECK — нелогиненная проверка шэдоубана. Заходим на пост АНОНИМОМ (без IG-сессии) через случайный прокси из пула,
// смотрим видны ли НАШИ комментаторы (акки, что тут комментили) постороннему. Не видны у анона, но есть у нас = шэдоубан.
// Спец-акк НЕ нужен, ничего не логиним → нечего тротлить/банить. Запуск: node shadowcheck.cjs <code1,code2,...>
const { chromium } = require('/Users/qq/Desktop/neironka-poster/node_modules/playwright-core');
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const DBURL = require('fs').readFileSync('/tmp/dburl.txt', 'utf8').trim();
let CODES = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean); // пусто → AUTO: активные посты из БД (см. ниже)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// парс прокси в {server, username, password} для Playwright (форматы: host:port:user:pass | user:pass@host:port | host:port)
function parseProxy(raw) {
  if (!raw) return null;
  let s = typeof raw === 'string' ? raw : (raw.host ? `${raw.host}:${raw.port}:${raw.username || ''}:${raw.password || ''}` : '');
  s = s.replace(/^https?:\/\//, '').replace(/^socks5:\/\//, '');
  let user, pass, host, port;
  if (s.includes('@')) { const [cred, hp] = s.split('@'); [user, pass] = cred.split(':'); [host, port] = hp.split(':'); }
  else { const p = s.split(':'); if (p.length >= 4) { [host, port, user, pass] = p; } else { [host, port] = p; } }
  if (!host || !port) return null;
  return { server: `http://${host}:${port}`, username: user || undefined, password: pass || undefined };
}

// анонимно открыть публичный рил через прокси и вытащить видимые ники комментаторов
async function anonComments(code, proxy) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, proxy: proxy ? { server: proxy.server } : undefined, args: ['--no-sandbox'] }).catch((e) => { console.log('  launch err:', e.message.slice(0, 50)); return null; });
  if (!browser) return null;
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      httpCredentials: proxy && proxy.username ? { username: proxy.username, password: proxy.password } : undefined,
    });
    const page = await ctx.newPage();
    await page.route('**/*', (r) => { const t = r.request().resourceType(); if (t === 'media' || t === 'image' || /\.(mp4|webm|jpg|png|webp)(\?|$)/i.test(r.request().url())) return r.abort().catch(() => {}); r.continue().catch(() => {}); });
    await page.goto(`https://www.instagram.com/reel/${code}/`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await sleep(4500);
    // СКРОЛЛ комментов: IG грузит их порциями. Без прокрутки анон видит только верхушку → глубокие наши комменты
    // ЛОЖНО кажутся «скрытыми» (главный источник шума: тот же акк прыгал видно/скрыто между прогонами). Крутим
    // панель вниз, догружаем весь список, растёт число ников — только потом собираем. Стоп, когда перестало расти.
    let prevN = -1;
    for (let s = 0; s < 12; s++) {
      const n = await page.evaluate(() => {
        const sc = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /Ответить|Reply|Responder|comment/i.test(e.innerText || '')).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        (sc || document.scrollingElement || document.body).scrollBy(0, 4000);
        return document.querySelectorAll('a[href*="/c/"]').length;
      }).catch(() => 0);
      await sleep(1400);
      if (n === prevN && n > 0) break; // список перестал расти — все комменты догружены
      prevN = n;
    }
    const res = await page.evaluate(() => {
      const wall = /log in|войти|sign up|page isn.t available|недоступна/i.test((document.body.innerText || '').slice(0, 200));
      const users = new Set();
      for (const cl of document.querySelectorAll('a[href*="/c/"]')) {
        let box = cl; for (let i = 0; i < 6 && box; i++) box = box.parentElement; if (!box) continue;
        const ua = box.querySelector('a[href^="/"]:not([href*="/p/"]):not([href*="/c/"]):not([href*="/explore"])');
        const m = ua && (ua.getAttribute('href') || '').match(/^\/([\w.]+)\/?$/); if (m) users.add(m[1].toLowerCase());
      }
      return { wall, users: [...users] };
    }).catch(() => ({ wall: true, users: [] }));
    await browser.close().catch(() => {});
    return res;
  } catch { await browser.close().catch(() => {}); return null; }
}

(async () => {
  // ЧП-ГЕЙТ (правило владельца 23.07): анон-шэдоучек = локальный Chrome на ноуте владельца → только CHP=1. Перенести в cloud (logged-out профиль).
  if (process.env.CHP !== '1') { console.log('⛔ shadowcheck: локальный анон на ноуте владельца ЗАПРЕЩЁН без CHP=1 (правило 23.07). Нужен cloud logged-out профиль.'); process.exit(2); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  // МЕТКИ шэдоубана: пер-связка (code+акк) — т.к. шб у нас ПЕР-КОММЕНТ (один акк виден на посту А, скрыт на Б).
  await c.query(`CREATE TABLE IF NOT EXISTS post_shadow (code text, username text, hidden boolean, checked_at timestamptz DEFAULT now(), PRIMARY KEY(code, username))`).catch(() => {});
  await c.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shadow_at timestamptz`).catch(() => {});
  // AUTO-режим (вотчер, без argv): активные посты = где НАШИ комментили за последние 12ч (лог постинга account_post_done).
  if (!CODES.length) {
    // источник = post_answered (vcomment пишет туда всегда); account_post_done не заполняется. Свежесть окна регулируется SHADOW_WINDOW_H.
    const winH = Number(process.env.SHADOW_WINDOW_H || 24);
    CODES = (await c.query(`SELECT code, count(*) n FROM post_answered WHERE ts > now()-($1||' hours')::interval GROUP BY code ORDER BY n DESC LIMIT ${Math.max(1, Number(process.env.SHADOW_MAX || 5))}`, [winH]).catch(() => ({ rows: [] }))).rows.map((r) => r.code).filter(Boolean);
    console.log(`AUTO: активных постов (наши комментили /12ч): ${CODES.length}${CODES.length ? ' — ' + CODES.slice(0, 8).join(', ') : ' (нет — нечего чекать)'}`);
  }
  // прокси-пул (живые акки)
  const px = (await c.query(`SELECT ig_proxy FROM accounts WHERE platform='comments' AND ig_proxy IS NOT NULL`)).rows.map((r) => parseProxy(r.ig_proxy)).filter(Boolean);
  console.log(`SHADOWCHECK: прокси в пуле ${px.length}, постов ${CODES.length} (нелогин, анон)`);
  for (const code of CODES) {
    // НАШИ комментаторы на этом посту (ig_login акков, что тут комментили)
    // «наши» на посту берём из post_answered.slug (vcomment пишет slug при клейме) — account_post_done не заполняется.
    const ours = (await c.query(`SELECT DISTINCT lower(a.ig_login) u FROM post_answered p JOIN accounts a ON a.slug=p.slug WHERE p.code=$1 AND a.ig_login IS NOT NULL`, [code])).rows.map((r) => r.u).filter(Boolean);
    // до 3 попыток с разными прокси (против тротла/стены даже анону)
    let seen = null, wall = true, tries = 0;
    for (let k = 0; k < 3 && wall; k++) {
      const proxy = px.length ? px[Math.floor((Date.now() / 1000 + k) % px.length)] : null; // ротация без Math.random (детерминированно)
      const r = await anonComments(code, proxy); tries++;
      console.log(`  попытка ${tries}: ${r ? 'wall=' + r.wall + ' ников=' + r.users.length : 'null'}`);
      if (r && r.users.length) { seen = r.users; wall = false; break; } // ники есть = комменты видны (даже если есть текст «войти»)
      await sleep(3000);
    }
    if (!seen) { console.log(`\n[${code}] ⚠ анон-вид не получить (стена/пусто за ${tries} попыток) — прокси не пробили или пост закрыт`); continue; }
    const visible = ours.filter((u) => seen.includes(u));
    const hidden = ours.filter((u) => !seen.includes(u));
    console.log(`\n[${code}] наших комментаторов: ${ours.length} | видно анону: ${seen.length} чел всего`);
    console.log(`  ✅ ВИДНЫ (не в тени): ${visible.length}${visible.length ? ' — ' + visible.slice(0, 8).join(', ') : ''}`);
    console.log(`  🚫 НЕ видны (шэдоубан?): ${hidden.length}${hidden.length ? ' — ' + hidden.slice(0, 8).join(', ') : ''}`);
    console.log(`  вердикт: ${ours.length === 0 ? 'нет наших на посту' : hidden.length > visible.length ? '⚠ БОЛЬШИНСТВО В ТЕНИ — тормозим тут' : visible.length ? '🟢 в основном видны' : '🚫 все в тени'}`);
    // ПИШЕМ метки в БД — только при полученном анон-виде (seen!=null, иначе выше continue). visible=не в тени, hidden=шэдоубан коммента.
    for (const u of visible) await c.query(`INSERT INTO post_shadow(code,username,hidden,checked_at) VALUES($1,$2,false,now()) ON CONFLICT(code,username) DO UPDATE SET hidden=false, checked_at=now()`, [code, u]).catch(() => {});
    for (const u of hidden) {
      await c.query(`INSERT INTO post_shadow(code,username,hidden,checked_at) VALUES($1,$2,true, now()) ON CONFLICT(code,username) DO UPDATE SET hidden=true,  checked_at=now()`, [code, u]).catch(() => {});
      // ПЕРЕОТКРЫВАЕМ лиды, что закрыл скрытый акк: снимаем post_answered по (code, его slug) → дедуп больше не блокирует,
      // следующий прогон ответит с ДРУГОГО (не-теневого) акка. Работает только для ответов, записанных с slug (новых).
      // ОПАСНО для ВЛОЖЕННЫХ ответов: anon-чтение мелкое (IG режет анону комменты, «Смотреть ответы» не разворачивается)
      // → вложенный ответ ложно «скрыт» → ложное переоткрытие → ДУБЛИ лидам. Держим OPT-IN (SHADOW_REOPEN=1), пока
      // anon-чтение не углублено. Надёжно только для ТОП-ЛЕВЕЛ (бренд): их анон видит. См. память neironka-shadowban.
      if (process.env.SHADOW_REOPEN === '1') {
        const rr = await c.query(`DELETE FROM post_answered WHERE code=$1 AND slug IN (SELECT slug FROM accounts WHERE lower(ig_login)=$2) RETURNING username`, [code, u]).catch(() => ({ rows: [] }));
        if (rr.rows.length) console.log(`  ♻ переоткрыто лидов (скрытый @${u}): ${rr.rows.length} — ${rr.rows.map((x) => x.username).slice(0, 6).join(', ')}`);
      }
    }
  }
  // АКК-уровень: скрыт на >=2 РАЗНЫХ постах И не виден НИГДЕ (свежие метки) → вероятно аккаунт в тени, не только коммент → метим
  // shadow_at для вывода из ротации. Условие vis=0 защищает пер-коммент случай (odie виден на А → не метим целиком).
  const acc = await c.query(`SELECT username, count(*) FILTER (WHERE hidden) hid, count(*) FILTER (WHERE NOT hidden) vis
     FROM post_shadow WHERE checked_at > now()-interval '2 days' GROUP BY username`).catch(() => ({ rows: [] }));
  for (const r of acc.rows) {
    if (Number(r.hid) >= 2 && Number(r.vis) === 0) {
      await c.query(`UPDATE accounts SET shadow_at=now() WHERE lower(ig_login)=$1`, [r.username]).catch(() => {});
      console.log(`  🚫 АКК В ТЕНИ (скрыт на ${r.hid} постах, виден 0) → shadow_at помечен: ${r.username}`);
    } else if (Number(r.vis) > 0) {
      await c.query(`UPDATE accounts SET shadow_at=NULL WHERE lower(ig_login)=$1 AND shadow_at IS NOT NULL`, [r.username]).catch(() => {}); // снова виден — снимаем метку
    }
  }
  await c.end();
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('FATAL', e.message); process.exit(1); });
