// СВЕРКА ЛИЧНОСТИ СЕССИЙ (08.08). Кому на самом деле принадлежат куки, записанные в базе.
//
// ЗАЧЕМ. 08.08 выяснилось: в строке ai.promt.mood лежала сессия ДРУГОГО акка (skaksnaowkgyx).
// Это худший вид поломки: скрипты честно «заходят в акк», а работают под чужим профилем, поэтому
// правки профиля и посты уезжают не туда, а лог при этом зелёный. Проверять надо СНАРУЖИ, из самой
// сессии, а не по нашей же записи в базе.
//
// Что делаем: по каждому акку с сохранёнными куками поднимаем профиль, подставляем куки, читаем,
// под кем мы, и сверяем с ig_login. Расхождение записываем в health_note и в журнал блокеров.
// Ничего не меняем в самих акках: только читаем.
//
// Запуск: node sessionwho.cjs [сколько]     ONLY=slug1,slug2 — только эти
'use strict';
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const L = require('./iglib.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function whoAmI(a) {
  let b = null, gl = null;
  try {
    L.dropBrokenProfileZip(a.pid);
    const { default: GoLogin } = await import('gologin');
    gl = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: false, extra_params: ['--headless=new'] });
    const r = await gl.startLocal();
    b = await chromium.connectOverCDP(r.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0] || await b.newContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    const raw = typeof a.ig_cookies === 'string' ? JSON.parse(a.ig_cookies) : a.ig_cookies;
    const cks = (Array.isArray(raw) ? raw : []).filter((x) => x && x.name && x.value).map((x) => ({
      name: x.name, value: String(x.value), domain: x.domain || '.instagram.com', path: x.path || '/',
      httpOnly: !!x.httpOnly, secure: x.secure !== false,
    }));
    await ctx.addCookies(cks).catch(() => {});
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4500);
    const st = await L.classifyScreen(ctx, page);
    if (st.state !== 'logged_in') return { real: null, state: st.state };
    const real = await page.evaluate(() => {
      const link = [...document.querySelectorAll('a[href^="/"]')].map((x) => x.getAttribute('href'))
        .find((h) => /^\/[A-Za-z0-9._]{3,30}\/$/.test(h) && !/\/(explore|reels|direct|accounts|about)\//.test(h));
      return link ? link.replace(/\//g, '') : null;
    }).catch(() => null);
    return { real, state: 'logged_in', ds: (cks.find((x) => x.name === 'ds_user_id') || {}).value || null };
  } catch (e) {
    return { real: null, state: 'ошибка: ' + String(e.message).slice(0, 60) };
  } finally {
    try { if (b) await b.close(); } catch {}
    try { if (gl) { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); } } catch {}
  }
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  let q = `SELECT a.slug, coalesce(a.ig_login,a.slug) h, a.gologin_profile_id pid, a.ig_cookies, g.gologin_token tok
             FROM accounts a JOIN account_groups g ON g.id = a.group_id
            WHERE a.deleted_at IS NULL AND a.ig_cookies IS NOT NULL AND a.gologin_profile_id IS NOT NULL`;
  if (ONLY.length) q += ` AND (a.slug = ANY($1) OR coalesce(a.ig_login,a.slug) = ANY($1))`;
  q += ` ORDER BY a.slug`;
  const rows = (await c.query(q, ONLY.length ? [ONLY] : [])).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`акков с сохранённой сессией: ${work.length}\n`);
  const out = [];
  for (const [i, a] of work.entries()) {
    process.stdout.write(`${i + 1}/${work.length} ${a.h} … `);
    const w = await whoAmI(a);
    const same = w.real && w.real.toLowerCase() === a.h.toLowerCase();
    const verdict = !w.real ? `сессия не открылась (${w.state})` : same ? 'совпадает' : `ЧУЖАЯ СЕССИЯ: ${w.real}`;
    console.log(verdict);
    out.push({ акк: a.h, реально: w.real || '—', итог: verdict });
    if (w.real && !same) {
      await c.query(
        `UPDATE accounts SET health_note = coalesce(health_note,'') || $2 WHERE slug = $1`,
        [a.slug, ` | 08.08 СВЕРКА: в базе лежала сессия акка ${w.real}, а не своя`]).catch(() => {});
      try { await require('./blockers.cjs').add({ slug: a.slug, kind: 'need_login', detail: `куки в базе принадлежат ${w.real}, своей сессии нет`, blocks: ['post', 'bio', 'nick'] }); } catch {}
    }
  }
  await c.end().catch(() => {});
  console.log('');
  console.table(out);
  const bad = out.filter((x) => x.итог.startsWith('ЧУЖАЯ'));
  console.log(`ИТОГ: чужих сессий ${bad.length} из ${out.length}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
