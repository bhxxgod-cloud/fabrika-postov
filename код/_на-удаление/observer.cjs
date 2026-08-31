// observer.cjs — АНОНИМ-НАБЛЮДАТЕЛЬ v1 (ядро конвейера). БЕЗ логина, через АНЛИМ-прокси. Читает ВСЕ комменты
// рила → строит ворк-лист: триггер поста (от автора) + fuzzy-матч + тир по свежести + топ/ветка + флаг языка.
// Тест: пробьёт ли аноним все комменты, не упрётся ли в логин-вол. usage: node observer.cjs <reelURL>
const fs = require('fs');
const { chromium } = require('playwright-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REEL = process.argv[2] || 'https://www.instagram.com/reel/Da5nHB4IbKf/';
const SHOT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
const OUT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/worklist.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// случайный http-прокси из анлим-списка
function pickProxy() {
  const lines = fs.readFileSync('/Users/qq/Desktop/neironka-poster/anon_proxies.txt', 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l.startsWith('http '));
  const p = lines[Math.floor(Math.random() * lines.length)].slice(5); // user:pass@host:port
  const at = p.lastIndexOf('@'); const cred = p.slice(0, at); const hp = p.slice(at + 1);
  const ci = cred.indexOf(':');
  return { server: 'http://' + hp, username: cred.slice(0, ci), password: cred.slice(ci + 1), host: hp };
}
// нормализация для fuzzy: нижний регистр, только буквы/цифры, схлопнуть повторы
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '').replace(/(.)\1{2,}/g, '$1$1');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// время IG → минуты. Поддержка ISO-datetime (<time datetime>) И относительного «1h/2d».
function ageMin(t) {
  const s = String(t || '');
  const iso = s.match(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/);
  if (iso) { const d = new Date(iso[0]).getTime(); if (d) return Math.max(0, Math.round((Date.now() - d) / 60000)); }
  const m = s.match(/(\d+)\s*(m|h|d|w|ч|мин|м|д|н)\b/i); if (!m) return 999999;
  const n = +m[1], u = m[2].toLowerCase();
  if (u === 'h' || u === 'ч') return n * 60;
  if (u === 'd' || u === 'д') return n * 1440;
  if (u === 'w' || u === 'н') return n * 10080;
  return n; // m / мин / м = минуты
}
const tier = (min) => min <= 60 ? 1 : min <= 1440 ? 2 : min <= 5760 ? 3 : 4; // час / сутки / 4 дня / старше
// грубый флаг не-русского (центр.Азия): маркеры тадж/узб. v1 (полноценно — LLM-слой)
const NONRU = /\b(парто|мекнм|бнавис|мекунам|бирар|радной|мада|ака|бро парто|лозим|мехохам|керак|ol|aka)\b/i;

(async () => {
  // ЧП-ГЕЙТ (правило владельца 23.07): локальный Chrome на ноуте владельца — только в ЧП (CHP=1). Дефолт = облачный SCAN.
  if (process.env.CHP !== '1') { console.log('⛔ observer: локальный анон на ноуте владельца ЗАПРЕЩЁН без CHP=1 (правило 23.07). Тиры бери из облачного SCAN.'); process.exit(2); }
  const px = pickProxy();
  console.log(`наблюдатель (АНОНИМ) через прокси ${px.host}`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: false, proxy: { server: px.server, username: px.username, password: px.password }, args: ['--no-first-run', '--no-default-browser-check'] });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  try {
    await page.goto(REEL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    // закрыть гостевые попапы (cookies / «Not now» / крестик модалки)
    for (const t of ['Decline optional cookies', 'Allow all cookies', 'Not Now', 'Not now']) {
      const b = page.getByRole('button', { name: new RegExp('^' + t + '$', 'i') }).first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(800); }
    }
    const closeX = page.locator('svg[aria-label="Close" i]').first();
    if (await closeX.isVisible().catch(() => false)) { await closeX.click().catch(() => {}); await sleep(800); }

    const finalUrl = page.url();
    const walled = /accounts\/login|\/login/.test(finalUrl);
    // подпись поста (для триггера) — берём из og или видимого текста автора
    const caption = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:description"]');
      return (og && og.content) || (document.querySelector('h1, article')?.innerText || '').slice(0, 300);
    }).catch(() => '');
    // ТРИГГЕР: из инструкции автора «напиши(те)/пиши(те)/в комент(ы) X»
    let trigger = null;
    const tm = String(caption).match(/(?:напиш\w*|пиш\w*|коммент\w*|в\s+комент\w*|comment)\s+[«"']?([a-zа-яё]{3,20})/i);
    if (tm) trigger = tm[1];
    console.log(`подпись: "${String(caption).replace(/\s+/g, ' ').slice(0, 120)}"`);
    console.log(`ТРИГГЕР поста: ${trigger || '(не извлёкся, дефолт промпт)'}`);
    const trigNorm = norm(trigger || 'промпт');

    // ДОГРУЗКА всех комментов: скроллим панель комментов, пока растёт
    const countComments = () => page.evaluate(() => document.querySelectorAll('ul ul, [role="button"] + *').length || document.querySelectorAll('li').length);
    let prev = -1, stable = 0, iter = 0;
    while (stable < 3 && iter < 50) {
      iter++;
      await page.evaluate(() => {
        // ищем самый «комментоёмкий» скроллируемый контейнер и мотаем вниз; фолбэк — окно
        const els = [...document.querySelectorAll('div,ul')].filter(e => e.scrollHeight > e.clientHeight + 200 && e.querySelectorAll('a[href^="/"]').length > 3);
        const c = els.sort((a, b) => b.querySelectorAll('a').length - a.querySelectorAll('a').length)[0];
        if (c) c.scrollTop = c.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
      }).catch(() => {});
      await sleep(1400);
      const cur = await countComments().catch(() => 0);
      if (cur === prev) stable++; else { stable = 0; prev = cur; }
    }
    // раскрыть ветки
    for (let i = 0; i < 10; i++) {
      const vr = page.getByText(/View (all |)\d+ repl|Смотреть( все|) ответ|Показать ответ/i).first();
      if (!(await vr.isVisible().catch(() => false))) break;
      await vr.click().catch(() => {}); await sleep(1000);
    }

    // ЭКСТРАКТ комментов
    const raw = await page.evaluate(() => {
      const seen = new Set(); const out = [];
      const nodes = [...document.querySelectorAll('li, div')].filter((el) => {
        const t = el.innerText || ''; return /(\bReply\b|\bОтветить\b)/.test(t) && t.length < 400 && el.querySelector('a[href^="/"]');
      });
      const leaf = nodes.filter((el) => !nodes.some((o) => o !== el && el.contains(o)));
      for (const el of leaf) {
        const link = el.querySelector('a[href^="/"]');
        const author = link ? link.getAttribute('href').replace(/\//g, '') : '?';
        const time = (el.querySelector('time')?.getAttribute('datetime')) || (el.innerText.match(/\b(\d+)\s*(m|h|d|w)\b/) || [])[0] || '';
        let txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        const key = author + '|' + txt.slice(0, 50); if (seen.has(key)) continue; seen.add(key);
        const left = Math.round(el.getBoundingClientRect().left);
        out.push({ author, txt: txt.slice(0, 160), time, left });
      }
      return out;
    }).catch(() => []);

    const minLeft = Math.min(...raw.map((d) => d.left).filter((n) => n > 0), 9999);
    // очистка: убрать префикс автора, время, кнопки Like/Reply/See translation/N likes/Edited → чистый контент
    const clean = (txt, author) => {
      let t = String(txt).replace(new RegExp('^\\s*' + author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
      t = t.replace(/\b\d+\s*(m|h|d|w)\b/i, '');
      t = t.replace(/\b(Like|Reply|Ответить|See translation|Hide|Edited|\d+\s*likes?|likes?)\b/gi, '');
      return t.replace(/·/g, ' ').replace(/\s+/g, ' ').trim();
    };
    // ТРИГГЕР по ЧАСТОТЕ комментов (устойчивее подписи): самый частый короткий контент-токен (fuzzy-бакет ≤1)
    const STOP = new Set(['the', 'and', 'you', 'для', 'как', 'что', 'это', 'not', 'log']);
    const freq = {};
    for (const d of raw) for (const tok of clean(d.txt, d.author).split(/\s+/).map(norm).filter((x) => x.length >= 3 && x.length <= 12 && !STOP.has(x))) {
      let key = tok; for (const k of Object.keys(freq)) if (lev(k, tok) <= 1) { key = k; break; }
      freq[key] = (freq[key] || 0) + 1;
    }
    const topTok = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    if (topTok && topTok[1] >= 2) trigger = topTok[0];
    const trigN = norm(trigger || 'промпт');
    console.log(`ТРИГГЕР (по частоте комментов): ${trigger} (×${topTok ? topTok[1] : 0})`);
    // классификация
    const items = raw.map((d) => {
      const core = clean(d.txt, d.author);
      const isReply = d.left > minLeft + 20;
      const toks = core.split(/\s+/).map(norm).filter(Boolean);
      const hitTrigger = toks.some((t) => t && lev(t, trigN) <= 2);
      const isPlus = core === '+' || /^\++$/.test(core.replace(/\s/g, '')); // «+» = заявка на CTA-посту
      const min = ageMin(d.time || d.txt);
      const nonRu = NONRU.test(core);
      const target = (hitTrigger || isPlus) && !isReply && !nonRu;
      return { author: d.author, core, isReply, hitTrigger, isPlus, ageMin: min, tier: tier(min), nonRu, target };
    });
    const targets = items.filter((x) => x.target).sort((a, b) => a.tier - b.tier || a.ageMin - b.ageMin);

    await page.screenshot({ path: `${SHOT}/observer.png` }).catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify({ reel: REEL, url: finalUrl, trigger, total: items.length, targets: targets.length, items }, null, 2));

    console.log(`\n=== НАБЛЮДАТЕЛЬ: ${walled ? '⚠ ЛОГИН-ВОЛ (аноним загейтен)' : 'аноним прошёл'} ===`);
    console.log(`url: ${finalUrl.slice(0, 70)}`);
    console.log(`извлечено комментов: ${items.length} (топ ${items.filter(x => !x.isReply).length} / ветки ${items.filter(x => x.isReply).length})`);
    const byT = [1, 2, 3, 4].map((t) => `тир${t}:${targets.filter(x => x.tier === t).length}`).join(' · ');
    console.log(`ЦЕЛЕВЫХ (триггер+топ+рус): ${targets.length}  [${byT}]`);
    console.log(`отсеяно: не-триггер ${items.filter(x => !x.hitTrigger).length} · ветки ${items.filter(x => x.isReply).length} · не-рус ${items.filter(x => x.nonRu).length}`);
    console.log('\nТОП-10 целевых (кому отвечать):');
    for (const x of targets.slice(0, 10)) console.log(`  [тир${x.tier} ${x.ageMin}м] @${x.author}: ${x.core.slice(0, 40)}`);
    console.log(`\nворк-лист: ${OUT} · скрин: observer.png`);
    await sleep(1500);
  } finally { await browser.close().catch(() => {}); }
  process.exit(0);
})().catch((e) => { console.log('FATAL', String(e.message).slice(0, 200)); process.exit(1); });
