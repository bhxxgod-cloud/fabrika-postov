// АУДИТ СКЛАДА ЖЕЛЕЗНЫМИ ПРАВИЛАМИ (09.08). Гоняет framegate по уже собранным постам и пишет
// приговор в базу, чтобы брак было видно запросом, а не пересказом.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ framesaudit.cjs. Тот проверяет ОДНУ вещь: что на экране телефона лежит наш арт,
// а не посторонняя картинка (был случай с танками). Здесь проверяются ВСЕ железные правила кадров
// сразу: размер, поля, повторы кадров, финал-не-кроп, телефон не в том шаблоне, смена цвета волос,
// хук против подписи. Правила не дублируются: они живут в framegate.cjs и templates.cjs.
//
// Ничего не удаляет и не перегенеривает: помечает meta.gate (вердикт и список причин), а починку
// делают сборщики. Метка нужна как ИНСТРУМЕНТ ПРАВДЫ: «сколько постов по правилам» это запрос к
// базе, а не строчка в логе.
//
// Запуск: node gateaudit.cjs [сколько]      MARK=1 записать в базу     STATUS=backlog,approved
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { fetchToFile } = require('./watchdog.cjs');
const { checkCarousel } = require('./framegate.cjs');
const TPL = require('./templates.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 0);
const MARK = /^(1|true|yes)$/i.test(String(process.env.MARK || ''));
const STATUSES = (process.env.STATUS || 'backlog,approved').split(',').map((s) => s.trim());
const TMP = process.env.GATE_TMP || '/tmp/gate';

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->>'hook_text' hook, caption,
           meta->'image_urls' urls,
           -- МЕТКА ФИНАЛА ЧИТАЕТСЯ ТРЕМЯ СОСТОЯНИЯМИ (09.08). Здесь стояло
           -- coalesce(meta->>'frame4_gen','') = 'true', то есть у СТАРЫХ постов, где этого ключа нет
           -- в принципе (его пишет только новый сборщик), получался false, и гейт бракова́л их как
           -- «финал выкроен». Так ложно ушли в брак 88 постов склада из 89. Теперь отсутствие ключа
           -- это NULL, то есть «сборщик не сообщил», и приговор выносят расхождения отпечатков.
           (meta->'frame4_gen')::text::boolean f4gen,
           coalesce(meta->>'frame3_phone','') = 'true' phone,
           meta->>'loc3' loc3, meta->>'loc4' loc4, meta->>'frame4_reels' f4reels
      FROM posts
     WHERE status = ANY($1) AND published_at IS NULL
       AND jsonb_array_length(meta->'image_urls') = 4
       AND ($2::text IS NULL OR meta->>'persona' LIKE $2)
     ORDER BY created_at DESC`, [STATUSES, process.env.PERSONA_LIKE || null])).rows;
  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`постов на аудит: ${work.length}\n`);

  let clean = 0;
  const byProblem = new Map();
  for (const [i, p] of work.entries()) {
    const short = String(p.id).slice(0, 8);
    try {
      const files = [];
      for (let k = 0; k < 4; k++) {
        files.push(await fetchToFile(p.urls[k], path.join(TMP, `${short}_${k + 1}.jpg`), { what: `кадр ${k + 1}`, ms: 60000, min: 3000 }));
      }
      const r = checkCarousel(files, { template: p.tpl, hook: p.hook, caption: p.caption,
        frame4gen: p.f4gen === null ? undefined : p.f4gen, phoneUsed: p.phone,
        loc3: p.loc3 || '', loc4: p.loc4 || '',
        // Варианты финала спрашиваем только у постов, которые собраны новым сборщиком: у старых
        // второго варианта нет по определению, и требовать его от них бессмысленно.
        frame4Variants: p.f4gen === true ? { tiktok: p.urls[3], reels: p.f4reels } : null });
      if (r.ok) { clean++; console.log(`  ✓ ${short} (${p.pn}, ${TPL.kindRu(p.tpl)}): чисто`); }
      else {
        console.log(`  ⚠ ${short} (${p.pn}, ${TPL.kindRu(p.tpl)}): ${r.problems.length} нарушени(й)`);
        for (const pr of r.problems) {
          console.log(`      · ${pr}`);
          // Группируем по НАЧАЛУ фразы: в конце сидят числа конкретного поста, они мешают счёту.
          const key = pr.replace(/\d+/g, 'N').replace(/^кадр N/, 'кадр');
          byProblem.set(key, (byProblem.get(key) || 0) + 1);
        }
      }
      if (MARK) {
        await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('gate',
          jsonb_build_object('ok', $2::boolean, 'problems', $3::jsonb, 'at', to_jsonb(now()))) WHERE id=$1`,
          [p.id, r.ok, JSON.stringify(r.problems)]);
      }
      for (const f of files) { try { fs.unlinkSync(f); } catch {} }
    } catch (e) { console.log(`  ✗ ${short}: ${String(e.message).slice(0, 70)}`); }
    if ((i + 1) % 10 === 0) console.log(`  … ${i + 1} из ${work.length}`);
  }
  await c.end().catch(() => {});
  console.log(`\nИТОГ: чистых ${clean} из ${work.length}${MARK ? ' (метки записаны в базу)' : ' (метки НЕ записаны, MARK=1 чтобы записать)'}`);
  if (byProblem.size) {
    console.log('\nчастота нарушений:');
    for (const [k, v] of [...byProblem.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)} × ${k}`);
  }
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
