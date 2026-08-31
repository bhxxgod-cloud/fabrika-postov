'use strict';
// ВЕРНУТЬ В РАБОТУ ПОСТЫ С ОБРЕЗАННОЙ КАРТОЧКОЙ.
//
// ЧТО СЛУЧИЛОСЬ (разбор 11.08, ошибка наша, не партнёра).
// Фабрика отдаёт кадры 1080x1440. Наш slidekit.to45smart для карточки шёл веткой to45top: обрезка
// до 1080x1350 ОТ ВЕРХА, то есть снизу срезалось 90 пикселей. У шаблона «оценка внешности» ровно там
// стоит блок РЕКОМЕНДАЦИИ и подпись, поэтому текст резался по строке. Замер: 42 поста из 142
// проверенных по этому шаблону, то есть каждый третий. У бьюти-гайда карточка ниже, и он не страдал.
// Я сначала обвинил партнёра, потому что смотрел на кадр ИЗ ГОТОВОГО ПОСТА, а он уже прошёл нашу
// обрезку. Сырой кадр у партнёра целый, это проверено: 1080x1440 и весь текст на месте.
//
// ЧТО ДЕЛАЕТ ЭТОТ СКРИПТ. Берёт посты, забракованные по «карточка обрезана», находит ИСХОДНЫЙ заказ
// фабрики, качает сырую карточку 1080x1440, приводит её к 4:5 НОВЫМ способом (вписывание целиком,
// поля цвета собственного края), заливает обратно в наше хранилище и подменяет второй кадр поста.
// Вердикт качества снимается, пост возвращается в работу. Новых заказов фабрике НЕ делает: карточка
// уже оплачена, платить второй раз не за что.
//
// Запуск: node fixcard.cjs [сколько]   (по умолчанию все)
//         node fixcard.cjs --сухой     показать, что будет сделано, ничего не менять
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { openAdmin } = require('./adminbrowser.cjs');
const { to45smart } = require('./slidekit.cjs');
const { fetchToFile } = require('./watchdog.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const СУХОЙ = process.argv.includes('--сухой');
// Хранилище кадров фабрики: адрес постоянный, по нему лежат сырые кадры каждого заказа.
const ХРАНИЛИЩЕ = process.env.PROMO_CDN || 'https://pub-6cb735c651e94f699c677473614deadd.r2.dev';
const СКОЛЬКО = Number(process.argv.find((a) => /^\d+$/.test(a)) || 0) || 999;

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(
    `SELECT id, meta->>'persona' persona, meta->>'factory_order' ord, meta->'image_urls' urls
       FROM posts
      WHERE (meta->'qa'->>'clean') = 'false'
        AND meta->'qa'->>'reasons' ILIKE '%обрезан%'
      ORDER BY created_at DESC LIMIT $1`, [СКОЛЬКО]);
  console.log(`постов с обрезанной карточкой: ${r.rows.length}`);
  if (!r.rows.length) { await c.end(); process.exit(0); }

  const { page, done } = await openAdmin();
  // Список заказов фабрики читаем ОДИН раз: там лежат сырые кадры 1080x1440 по каждому заказу.
  const заказы = await page.evaluate(async () => {
    const x = await fetch('/api/admin/promo/posts').then((z) => z.json());
    const по = {};
    for (const z of (x.posts || [])) по[String(z.id)] = z.imageUrls || [];
    return по;
  });
  console.log(`заказов на фабрике видно: ${Object.keys(заказы).length}`);

  let починено = 0, нет_заказа = 0, ошибок = 0;
  for (const п of r.rows) {
    // АДРЕС СЫРОЙ КАРТОЧКИ СОБИРАЕМ ПО НОМЕРУ ЗАКАЗА, а не только из списка фабрики: список отдаёт
    // последние полсотни заказов, а чинить надо и старые. Проверено: файлы лежат по постоянному
    // адресу promo-posts/<номер заказа>/2.jpg и отдаются даже когда заказ из списка уже вытеснен.
    const кадры = заказы[String(п.ord)] || [];
    const сырая = кадры[1] || кадры[0]
      || (п.ord ? `${ХРАНИЛИЩЕ}/promo-posts/${п.ord}/2.jpg` : null);
    if (!сырая) { нет_заказа++; console.log(`  ⏭ ${п.persona}: номера заказа нет, чинить нечем`); continue; }
    if (СУХОЙ) { console.log(`  (сухой) ${п.persona}: взял бы ${сырая.slice(-24)}`); починено++; continue; }
    try {
      const tmp = `/tmp/fixcard_${String(п.id).slice(0, 8)}.jpg`;
      await fetchToFile(сырая, tmp, { what: 'сырая карточка', ms: 90000, min: 20000 });
      const готово = to45smart(tmp, `/tmp/fixcard_${String(п.id).slice(0, 8)}_45.jpg`, { topBias: true });
      const b64 = fs.readFileSync(готово).toString('base64');
      // Заливаем в то же хранилище, откуда конвейер берёт кадры постов.
      const url = await page.evaluate(async ({ b64, fname }) => {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new File([bin], fname, { type: 'image/jpeg' }));
        const r = await fetch('/api/admin/promo/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error(j.error || `upload HTTP ${r.status}`);
        return j.url;
      }, { b64, fname: `card_${String(п.id).slice(0, 8)}.jpg` });

      const кадрыПоста = Array.isArray(п.urls) ? [...п.urls] : [];
      кадрыПоста[1] = url;
      // Вердикт снимаем целиком: пусть отдел качества посмотрит пост заново на общих основаниях.
      await c.query(
        `UPDATE posts SET meta = jsonb_set(meta, '{image_urls}', $2::jsonb) - 'qa' WHERE id = $1`,
        [п.id, JSON.stringify(кадрыПоста)]);
      починено++;
      console.log(`  ✅ ${п.persona}: карточка перерисована и вердикт снят`);
      try { fs.unlinkSync(tmp); fs.unlinkSync(готово); } catch {}
    } catch (e) {
      ошибок++;
      console.log(`  ✗ ${п.persona}: ${String(e.message).slice(0, 90)}`);
    }
  }
  await done().catch(() => {});
  await c.end().catch(() => {});
  console.log(`\nИТОГ: починено ${починено}, без исходного заказа ${нет_заказа}, ошибок ${ошибок}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
