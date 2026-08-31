// Шедоубан-чек: заходим ДРУГИМ акком, открываем рилс, скроллим, считаем сколько НАШИХ ответов («нейронка про») ВИДНО.
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const SHOT = process.env.SHOT_DIR;
const SLUG = process.argv[2]; const URL = process.argv[3]; const TARGET = (process.argv[4] || '').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loadDb() {
  for (let k = 0; k < 5; k++) { const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); const a = (await c.query(`SELECT a.gologin_profile_id, g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.platform='comments'`, [SLUG])).rows[0]; await c.end(); return a; } catch { await c.end().catch(()=>{}); await sleep(2500); } }
  throw new Error('db');
}
(async () => {
  const a = await loadDb(); const tok = a.gologin_token || process.env.GOLOGIN_API_TOKEN;
  const u = new global.URL('wss://cloudbrowser.gologin.com/connect'); u.searchParams.set('token', tok); u.searchParams.set('profile', a.gologin_profile_id);
  let b; for (let k = 0; k < 5; k++) { try { b = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }); break; } catch { console.log('коннект try' + k); await sleep(k===0?22000:14000); } }
  if (!b) { console.log('НЕ ПОДКЛЮЧИЛСЯ'); return; }
  const ctx = b.contexts()[0] || await b.newContext(); const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.route('**/*', r => { const t=r.request().resourceType(); if (t==='media'||/\.(mp4|webm|mov)/i.test(r.request().url())) return r.abort().catch(()=>{}); r.continue().catch(()=>{}); }).catch(()=>{});
    await page.setViewportSize({ width: 1280, height: 900 }).catch(()=>{});
    await page.goto(URL + '?hl=ru', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await sleep(4000);
    await page.mouse.click(600, 450).catch(()=>{}); await sleep(1500);
    // открыть панель
    const sel = 'svg[aria-label*="omment" i], svg[aria-label*="оммент" i], svg[aria-label*="omentar" i]';
    const ic = page.locator(sel).first(); if (await ic.isVisible().catch(()=>false)) { const btn = ic.locator('xpath=ancestor::*[self::button or @role="button" or self::a][1]'); await (await btn.count().catch(()=>0)?btn.first():ic).click({timeout:4000}).catch(()=>{}); } else { await page.mouse.click(882,582).catch(()=>{}); }
    await sleep(4000);
    let foundTarget = false, brandSeen = 0;
    for (let s = 0; s < 10; s++) {
      const stat = await page.evaluate((tgt) => {
        const txt = document.body.innerText.toLowerCase();
        const brand = (txt.match(/нейронка про/g) || []).length;
        const tgtHit = tgt ? txt.includes(tgt.toLowerCase()) : false;
        return { brand, tgtHit };
      }, TARGET).catch(()=>({brand:0,tgtHit:false}));
      brandSeen = Math.max(brandSeen, stat.brand); if (stat.tgtHit) foundTarget = true;
      // скролл панели
      await page.evaluate(() => { const els=[...document.querySelectorAll('div')].filter(e=>e.scrollHeight>e.clientHeight+200&&/Ответить|Reply/i.test(e.innerText||'')).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]; if(els) els.scrollTop=els.scrollHeight; }).catch(()=>{});
      await sleep(1500);
    }
    if (SHOT) require('fs').writeFileSync(`${SHOT}/shadow_${SLUG.replace(/\s+/g,'_')}.png`, await page.screenshot({type:'png',timeout:12000}).catch(()=>Buffer.alloc(0)));
    console.log(`АКК ${SLUG} видит: «нейронка про» упоминаний = ${brandSeen}${TARGET?`, коммент @${TARGET} найден: ${foundTarget}`:''}`);
  } catch (e) { console.log('ОШИБКА', String(e.message).slice(0,60)); }
  finally { await fetch('https://api.gologin.com/browser/'+a.gologin_profile_id+'/web',{method:'DELETE',headers:{Authorization:'Bearer '+tok}}).catch(()=>{}); await b.close().catch(()=>{}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); setTimeout(() => process.exit(1), 60); });
