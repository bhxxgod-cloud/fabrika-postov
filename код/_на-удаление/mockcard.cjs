// ВАРИАНТ 8 ФИНАЛЬНОГО СЛАЙДА: «МАКЕТ ШАБЛОНА» (05.08, образец показал начальник).
//
// Идея варианта: вместо фото — схема-черновик того, что шаблон соберёт из твоего фото,
// и главное сообщение «промпт писать не нужно, он уже внутри шаблона, нужно только твоё фото».
// Снимает главный барьер: человек думает, что надо уметь писать промпты.
//
// Делается на 4 наших рабочих шаблона (бьюти-гайд, оценка внешности, макияж, ч/б сквозь пальцы).
// Запуск: node mockcard.cjs [папка_вывода]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const FF = require('ffmpeg-static');
const W = 1080, H = 1350;
const OUT = process.argv[2] || '/tmp/var8';
const LOGO = path.join(__dirname, 'brand', 'logo_transparent.png');

// Схема каждого шаблона: заголовок + блоки-заглушки. Кол-во ячеек = как в реальном выводе.
const TPL = {
  'бьюти-гайд': { title: 'ТВОЙ ЛУЧШИЙ ОБРАЗ · BEAUTY GUIDE', left: [['твоё фото', 'photo', 1]],
    right: [['ВОЛОСЫ', 'row', 3], ['ОТТЕНОК', 'row', 5], ['БРОВИ', 'row', 2], ['ГЛАЗА', 'row', 5], ['ГУБЫ', 'row', 5]],
    bottom: ['ЛУЧШИЕ ОБРАЗЫ', 5] },
  'оценка внешности': { title: 'ОЦЕНКА ВНЕШНОСТИ · РАЗБОР', left: [['твоё фото', 'photo', 1]],
    right: [['ЛИЦО', 'row', 3], ['ГЛАЗА', 'row', 2], ['ГУБЫ', 'row', 2], ['КОЖА', 'row', 3], ['ИТОГ', 'row', 4]],
    bottom: ['РЕКОМЕНДАЦИИ', 4] },
  'макияж по цветотипу': { title: 'ТВОЙ ЦВЕТОТИП · МАКИЯЖ', left: [['твоё фото', 'photo', 1]],
    right: [['ПАЛИТРА', 'row', 6], ['ТОН', 'row', 4], ['РУМЯНА', 'row', 3], ['ТЕНИ', 'row', 5], ['ПОМАДА', 'row', 5]],
    bottom: ['ГОТОВЫЕ ОБРАЗЫ', 4] },
  'ч/б сквозь пальцы': { title: 'Ч/Б ПОРТРЕТ · СКВОЗЬ ПАЛЬЦЫ', left: [['твоё фото', 'photo', 1]],
    right: [['СВЕТ', 'row', 2], ['РАКУРС', 'row', 3], ['КАДР', 'row', 2]],
    bottom: ['ВАРИАНТЫ КАДРА', 4] },
};

const cells = (n) => Array.from({ length: n }, () => '<div class="c"></div>').join('');

function html(name, t, logo) {
  const right = t.right.map(([lab, , n]) => `<div class="grp"><div class="lab">${lab}</div><div class="row">${cells(n)}</div></div>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${W}px;height:${H}px;background:#f4f2fb;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;
      color:#1b1630;padding:44px 44px 36px;display:flex;flex-direction:column}
    .top{display:flex;align-items:center;gap:16px}
    .top img{width:56px;height:56px}
    .top .a{font-size:31px;font-weight:800;letter-spacing:-.5px}
    .top .b{margin-top:4px;font-size:23px;color:#6c4fd0;font-weight:600}
    .card{margin-top:26px;flex:1;background:#fff;border-radius:26px;padding:30px 28px;
      box-shadow:0 8px 30px rgba(60,40,120,.08)}
    .ttl{text-align:center;font-size:30px;font-weight:800;letter-spacing:-.3px}
    .sub{text-align:center;margin-top:6px;font-size:20px;color:#8b83a6}
    .hr{margin:18px 0;height:1px;background:#e9e6f4}
    .body{display:flex;gap:22px}
    .left{width:38%}
    .ph{height:300px;border-radius:16px;background:#eceaf6;display:flex;align-items:center;
      justify-content:center;color:#9a92b8;font-size:22px;font-weight:600}
    .right{flex:1}
    .grp{margin-bottom:16px}
    .lab{font-size:19px;font-weight:800;letter-spacing:.3px;margin-bottom:8px}
    .row{display:flex;gap:10px}
    .c{flex:1;height:62px;border-radius:10px;background:#eceaf6;
      background-image:linear-gradient(45deg,transparent 47%,#ddd8ef 47%,#ddd8ef 53%,transparent 53%),
        linear-gradient(-45deg,transparent 47%,#ddd8ef 47%,#ddd8ef 53%,transparent 53%)}
    .bot{margin-top:14px}
    .foot{margin-top:22px;background:#ece7fd;border-radius:20px;padding:22px;text-align:center}
    .foot .a{font-size:31px;font-weight:900;color:#6c4fd0;letter-spacing:-.4px}
    .foot .b{margin-top:8px;font-size:22px;color:#5b5372}
  </style>
  <div class="top">${logo ? `<img src="${logo}">` : ''}
    <div><div class="a">бесплатно сделать можно на neironka.pro</div>
    <div class="b">ищите в яндексе: нейронка про</div></div></div>
  <div class="card">
    <div class="ttl">${t.title}</div><div class="sub">макет шаблона · ${name}</div>
    <div class="hr"></div>
    <div class="body">
      <div class="left"><div class="ph">твоё фото</div>
        <div class="grp" style="margin-top:16px"><div class="lab">ДО / ПОСЛЕ</div><div class="row">${cells(2)}</div></div>
      </div>
      <div class="right">${right}</div>
    </div>
    <div class="bot"><div class="lab">${t.bottom[0]}</div><div class="row">${cells(t.bottom[1])}</div></div>
  </div>
  <div class="foot"><div class="a">ПРОМПТ ПИСАТЬ НЕ НУЖНО</div>
    <div class="b">он уже внутри шаблона, нужно только твоё фото</div></div>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const logo = fs.existsSync(LOGO) ? `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}` : '';
  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const b = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    for (const [name, t] of Object.entries(TPL)) {
      const page = await b.newPage({ viewport: { width: W, height: H } });
      await page.setContent(html(name, t, logo), { waitUntil: 'load' });
      await page.waitForTimeout(350);
      const safe = name.replace(/[^\wа-яё]+/gi, '_');
      const png = path.join(OUT, `8_макет_${safe}.png`);
      const out = png.replace(/\.png$/, '.jpg');
      await page.screenshot({ path: png });
      execFileSync(FF, ['-y', '-i', png, '-q:v', '2', out], { stdio: 'ignore' });
      fs.unlinkSync(png);
      await page.close();
      console.log(`  ✓ ${name}`);
    }
  } finally { await b.close().catch(() => {}); }
  console.log(`ИТОГ: макеты в ${OUT}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
