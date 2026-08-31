// ПЕРЕСБОРКА ПОДПИСЕЙ ПО ПРАВИЛАМ ТЕКСТА (09.08). Только текст в базе, картинки не трогаем и
// ничего не генерируем.
//
// ЗАЧЕМ. Гейт правил (framegate) ловит в подписях старого склада два нарушения:
//   • ИИ-теги (#иитренд, #промт): такие хештеги тянут пост в техно-аудиторию и в пул ИИ-приколов,
//     а нам нужна бьюти-лента. Из пулов slidekit они уже убраны, но подписи, собранные ДО правки,
//     так и лежат на складе с этими тегами;
//   • подпись повторяет хук с первого кадра: пул подписи выбирался, не зная хука, и заголовок
//     дублировал текст на картинке.
// Обе беды лечатся пересборкой подписи тем же postCaption, но теперь он ЗНАЕТ хук поста.
//
// Запуск: node fixcaptions.cjs [сколько]     DRY=1 только показать
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const { postCaption } = require('./slidekit.cjs');
const { checkCarousel } = require('./framegate.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
const DRY = /^(1|true|yes)$/i.test(String(process.env.DRY || ''));

// Проверка ТЕКСТА без картинок: гоняем гейт по одним подписям. Файлы кадров ему не нужны, поэтому
// зовём его внутреннюю текстовую часть через checkCarousel на пустом списке нельзя — там сразу
// отказ по числу кадров. Поэтому текстовые правила спрашиваем у гейта по готовому посту, а здесь
// ищем ровно то, что можно поправить текстом.
// Фразы про «без промпта» запрещены с 09.08: они отговаривают искать наше слово-маркер, на которое
// мы и гоним трафик четвёртым кадром. Регэксп тот же, что в гейте.
const NO_PROMPT = (t) => String(t).match(
  /(без|никаких?)\s+(промпт\w*|настро\w*)|промпт\w*\s+(не\s+нужен|не\s+нужн\w+|писать\s+не\s+надо|копировать\s+не\s+надо|придумывать\s+не\s+надо)|ничего\s+не\s+надо\s+придумывать/i);

const AI_TAG = (caption) => (String(caption).match(/#\S+/g) || []).find((t) => /^#(ии|ai|aiart|нейроарт|сгенерировано)(тренд|фото|арт|art)?$/i.test(t)
  || /нейросет|midjourney|chatgpt|dalle|stablediffusion|промт|промпт/i.test(t));

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT id, caption, meta, meta->>'template' tpl, meta->>'hook_text' hook, meta->>'persona' pn
      FROM posts
     WHERE status IN ('backlog','approved') AND published_at IS NULL
     ORDER BY created_at DESC`)).rows;

  let fixed = 0, seen = 0;
  for (const p of rows) {
    const bad = [];
    const tag = AI_TAG(p.caption);
    if (tag) bad.push(`ИИ-тег ${tag}`);
    const np = NO_PROMPT(p.caption);
    if (np) bad.push(`фраза «${np[0]}»`);
    const norm = (s) => String(s || '').toLowerCase().replace(/[«»"'.,!?:;()]/g, ' ').replace(/\s+/g, ' ').trim();
    const h = norm(p.hook), cap = norm(p.caption);
    if (h && cap.includes(h)) bad.push('подпись повторяет хук');
    if (!/#/.test(String(p.caption))) bad.push('нет хештегов');
    if (!bad.length) continue;
    seen++;
    if (LIMIT && fixed >= LIMIT) continue;
    // ПОДПИСЬ СОБИРАЕТСЯ ИЗ ФАКТОВ ПОСТА (11.08). Передаём meta и id: по ним captions.cjs берёт
    // локации кадров, тему шаблона, тир образа и подтверждённую смену цвета волос, а выбор внутри
    // блоков идёт по хэшу поста. Поэтому попытка ровно ОДНА: пересборка того же поста даёт тот же
    // текст, и три круга «а вдруг повезёт» здесь больше не имеют смысла.
    let cand = null;
    try {
      const t = postCaption(p.tpl, { hook: p.hook || '', meta: p.meta || {}, seed: p.id });
      if (!AI_TAG(t) && !NO_PROMPT(t) && /#/.test(t) && !(h && norm(t).includes(h))) cand = t;
    } catch (e) {
      console.log(`  ⚠ ${String(p.id).slice(0, 8)} (${p.pn}): подпись не собралась, ${e.message}`);
      continue;
    }
    if (!cand) { console.log(`  ⚠ ${String(p.id).slice(0, 8)} (${p.pn}): подпись собралась, но не прошла проверки текста`); continue; }
    console.log(`  ${DRY ? '(сухо) ' : ''}${String(p.id).slice(0, 8)} (${p.pn}, ${p.tpl}): ${bad.join(', ')}`);
    if (!DRY) {
      await c.query('UPDATE posts SET caption=$2, meta = meta || jsonb_build_object(\'caption_fixed_at\', to_jsonb(now())) WHERE id=$1', [p.id, cand]);
      fixed++;
    }
  }
  await c.end().catch(() => {});
  console.log(`\nИТОГ: подписей с нарушением ${seen}, ${DRY ? 'исправлено 0 (сухой прогон)' : `исправлено ${fixed}`}`);
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
