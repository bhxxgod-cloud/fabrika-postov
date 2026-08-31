// ВАРИАНТЫ ОФОРМЛЕНИЯ ФИНАЛЬНОГО СЛАЙДА (05.08, задание начальника: «давай 7 вариантов»).
// Все — наложение текста рендером, никакой генерации: текст должен быть чистым.
// Один и тот же кадр во всех вариантах, чтобы сравнивать именно оформление.
// Запуск: node variants4.cjs <фото> [папка_вывода]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const FF = require('ffmpeg-static');
const W = 1080, H = 1350;
const SRC = process.argv[2];
const OUT = process.argv[3] || '/tmp/var4';

async function render(html, out) {
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const b = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const page = await b.newPage({ viewport: { width: W, height: H } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    const png = out.replace(/\.jpe?g$/i, '.png');
    await page.screenshot({ path: png });
    execFileSync(FF, ['-y', '-i', png, '-q:v', '2', out], { stdio: 'ignore' });
    fs.unlinkSync(png);
  } finally { await b.close().catch(() => {}); }
  return out;
}

const base = (extraCss, block, b64, mime) => `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0}
  body{width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#000;
    font-family:-apple-system,'Helvetica Neue','Arial Black',Arial,sans-serif}
  img{width:${W}px;height:${H}px;object-fit:cover;display:block}
  ${extraCss}
</style><img src="data:${mime};base64,${b64}">${block}`;

(async () => {
  if (!SRC || !fs.existsSync(SRC)) { console.log('нет исходного фото'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const b64 = fs.readFileSync(SRC).toString('base64');
  const mime = /\.png$/i.test(SRC) ? 'image/png' : 'image/jpeg';

  const V = [];

  // 1. РИЛСОВЫЙ: тот же шрифт и обводка, что на первом слайде рилса — максимально нативно.
  V.push(['1_рилсовый', base(`
    .t{position:absolute;left:0;right:0;bottom:120px;padding:0 60px;text-align:center;color:#fff;
      font-size:52px;font-weight:800;line-height:1.22;letter-spacing:-.5px;
      -webkit-text-stroke:8px rgba(0,0,0,.55);paint-order:stroke fill}
  `, `<div class="t">хочешь так же?<br>пиши «нейронка про шаблоны» в яндекс</div>`, b64, mime)]);

  // 2. УЛУЧШЕННЫЙ ШРИФТ: чуть продающе, но всё ещё по-человечески.
  V.push(['2_продающий', base(`
    .box{position:absolute;left:56px;right:56px;bottom:96px;padding:34px 30px;border-radius:26px;
      background:rgba(12,10,20,.72);backdrop-filter:blur(8px);text-align:center;color:#fff}
    .box .a{font-size:46px;font-weight:800;letter-spacing:-.6px;line-height:1.2}
    .box .b{margin-top:14px;font-size:30px;color:#d8cfff;font-weight:600}
  `, `<div class="box"><div class="a">сделай себе такой же</div>
      <div class="b">бесплатно · «нейронка про шаблоны» в яндексе</div></div>`, b64, mime)]);

  // 3. АКЦЕНТ НА «МОЖНО СДЕЛАТЬ»: главное слово выделено цветом.
  V.push(['3_акцент', base(`
    .t{position:absolute;left:0;right:0;bottom:110px;padding:0 56px;text-align:center;color:#fff;
      text-shadow:0 3px 16px rgba(0,0,0,.8)}
    .t .big{font-size:60px;font-weight:900;letter-spacing:-1px;line-height:1.1}
    .t .big span{color:#c9a4ff}
    .t .sm{margin-top:16px;font-size:30px;font-weight:600;opacity:.95}
  `, `<div class="t"><div class="big">это можно <span>бесплатно</span></div>
      <div class="sm">просто напиши «нейронка про шаблоны» в яндексе</div></div>`, b64, mime)]);

  // 4. МОЙ ВАРИАНТ: «стикер-подсказка» — как будто девочка сама подписала кадр от руки.
  V.push(['4_стикер', base(`
    .st{position:absolute;left:64px;bottom:132px;transform:rotate(-3deg);
      background:#fff;color:#141018;padding:22px 30px;border-radius:18px;
      box-shadow:0 14px 40px rgba(0,0,0,.42);max-width:640px}
    .st .a{font-size:38px;font-weight:800;letter-spacing:-.4px;line-height:1.18}
    .st .b{margin-top:8px;font-size:26px;color:#6b5a8a;font-weight:600}
    .pin{position:absolute;left:96px;bottom:250px;width:22px;height:22px;border-radius:50%;
      background:#a06cff;box-shadow:0 3px 10px rgba(0,0,0,.4)}
  `, `<div class="pin"></div><div class="st"><div class="a">сделала бесплатно<br>в нейронка про</div>
      <div class="b">в яндексе: нейронка про шаблоны</div></div>`, b64, mime)]);

  // 6. ПЕЧАТЬ: круглый штамп по окружности, как «сделано на …».
  const stampText = 'НЕЙРОНКА ПРО · СДЕЛАНО В НЕЙРОСЕТИ · ';
  const letters = stampText.split('').map((ch, i, arr) => {
    const step = 360 / arr.length;
    return `<span style="position:absolute;left:50%;top:50%;transform-origin:0 0;
      transform:rotate(${i * step}deg) translate(0,-146px) rotate(0deg);font-size:22px;
      font-weight:800;letter-spacing:1px">${ch === ' ' ? '&nbsp;' : ch}</span>`;
  }).join('');
  V.push(['6_печать', base(`
    .stamp{position:absolute;right:62px;bottom:120px;width:300px;height:300px;border-radius:50%;
      border:5px double rgba(255,255,255,.9);color:rgba(255,255,255,.95);
      transform:rotate(-9deg);opacity:.93;filter:drop-shadow(0 4px 14px rgba(0,0,0,.55))}
    .stamp .in{position:absolute;inset:34px;border-radius:50%;border:2px solid rgba(255,255,255,.75);
      display:flex;align-items:center;justify-content:center;text-align:center}
    .stamp .in b{font-size:30px;font-weight:900;line-height:1.1;letter-spacing:-.4px}
    .ring{position:absolute;inset:0}
  `, `<div class="stamp"><div class="ring">${letters}</div>
      <div class="in"><b>сделано<br>бесплатно</b></div></div>`, b64, mime)]);

  // 7. ДОМЕН: чистая подпись с адресом сайта.
  V.push(['7_домен', base(`
    .bar{position:absolute;left:0;right:0;bottom:0;padding:30px 40px 40px;text-align:center;color:#fff;
      background:linear-gradient(to top,rgba(0,0,0,.88) 0%,rgba(0,0,0,.55) 60%,rgba(0,0,0,0) 100%)}
    .bar .d{font-size:54px;font-weight:900;letter-spacing:-1px}
    .bar .s{margin-top:8px;font-size:28px;color:#dcdcdc}
  `, `<div class="bar"><div class="d">neironka.pro</div>
      <div class="s">бесплатные шаблоны · ищи «нейронка про» в яндексе</div></div>`, b64, mime)]);

  for (const [name, html] of V) {
    const out = path.join(OUT, `${name}.jpg`);
    await render(html, out);
    console.log(`  ✓ ${name}`);
  }
  console.log(`ИТОГ: варианты в ${OUT}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
