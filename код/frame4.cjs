// ЧЕТВЁРТЫЙ КАДР КАРУСЕЛИ: ПЛАШКА С ПРОМПТОМ (05.08, новая логика начальника).
//
// Карусель теперь из 4 кадров: 1) фото девушки с хуком, 2) плашка результата, 3) как выглядит
// с трендом, 4) ЭТО — промпт + логотип + строка «можно сделать на neironka.pro».
// Первые три рисует фабрика, четвёртый наш.
//
// Рендерим через headless Chrome (HTML → скриншот): в проекте нет ни одного текстового
// рендерера, а ffmpeg drawtext даёт кривой перенос кириллицы и не умеет нормальную типографику.
// Размер 1080×1350 (4:5) — как остальные кадры, иначе карусель поедет.
//
// Запуск: node frame4.cjs <ключ_шаблона|--text "промпт"> <выходной.jpg>
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.argv[3] || '/tmp/frame4.jpg';
const arg = process.argv[2] || '';
const LOGO = path.join(__dirname, 'brand', 'logo_transparent.png');

function promptText() {
  if (arg === '--text') return process.argv[3] ? process.argv[3] : '';
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'tplprompts.json'), 'utf8'));
    return cache[arg] || '';
  } catch { return ''; }
}

(async () => {
  const textArg = process.argv.indexOf('--text');
  const prompt = textArg >= 0 ? String(process.argv[textArg + 1] || '') : promptText();
  const out = textArg >= 0 ? (process.argv[textArg + 2] || OUT) : OUT;
  if (!prompt || prompt.length < 20) { console.log('ИТОГ: ✗ пустой промпт'); process.exit(1); }

  // БЕЗ РЕКЛАМЫ (правка начальника 06.08: «и 2 картинка фиолетовая с рекламой и последняя тоже»).
  // Два промо-слайда из четырёх — пост читается как реклама и режется в охватах. Поэтому слайд 2
  // теперь просто ЗАПИСКА С ПРОМПТОМ: светлая бумага, никакого логотипа, домена и призывов.
  // Единственный рекламный кадр в карусели — финальный.
  const size = prompt.length > 1400 ? 21 : prompt.length > 900 ? 25 : prompt.length > 500 ? 29 : 33;
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:1080px;height:1350px;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;
      background:#f7f5f1;color:#1d1a17;display:flex;flex-direction:column;padding:76px 66px}
    .ttl{font-size:46px;font-weight:800;letter-spacing:-1px}
    .sub{margin-top:10px;font-size:27px;color:#8a8378}
    .box{margin-top:38px;flex:1;background:#fff;border:1px solid #e7e2d9;border-radius:24px;
      padding:38px 34px;overflow:hidden}
    .box p{font-size:${size}px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#2a2622}
  </style>
  <div class="ttl">промпт из этого поста</div>
  <div class="sub">копируй и вставляй целиком</div>
  <div class="box"><p></p></div>`;

  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const b = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const page = await b.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    // Текст вставляем как textContent, а не в разметку: в промптах есть < > & и кавычки,
    // которые иначе поломали бы вёрстку.
    // АВТОПОДБОР КЕГЛЯ (06.08). Была лесенка с минимумом 21px и overflow:hidden, из-за чего
    // промпты длиннее ~2400 знаков ОБРЕЗАЛИСЬ на полуслове — 16 постов на складе с браком.
    // Теперь уменьшаем шрифт, пока текст не влезет целиком.
    await page.evaluate((t) => {
      const box = document.querySelector('.box');
      const el = document.querySelector('.box p');
      el.textContent = t;
      let size = parseInt(getComputedStyle(el).fontSize, 10) || 32;
      while (el.scrollHeight > box.clientHeight - 20 && size > 11) {
        size -= 1;
        el.style.fontSize = size + 'px';
        el.style.lineHeight = '1.38';
      }
    }, prompt);
    await page.waitForTimeout(400);
    const png = out.replace(/\.jpe?g$/i, '.png');
    await page.screenshot({ path: png });
    // JPEG — как остальные кадры карусели.
    if (png !== out) {
      const { execFileSync } = require('node:child_process');
      execFileSync(require('ffmpeg-static'), ['-y', '-i', png, '-q:v', '2', out], { stdio: 'ignore' });
      fs.unlinkSync(png);
    }
    console.log(`ИТОГ: ✅ ${out} (${Math.round(fs.statSync(out).size / 1024)} КБ, промпт ${prompt.length} зн.)`);
  } finally { await b.close().catch(() => {}); }
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
