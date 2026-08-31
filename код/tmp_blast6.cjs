// БЛАСТ 05.08 (начальник: «запости по посту с каждого акка щас»): 6 акков, 6 постов со склада,
// слоты шагом 20 минут от «сейчас», задачи в local_jobs. bryan в шэдоубане и damari с несменённым
// ником идут по прямому указанию.
// ПРЕДОХРАНИТЕЛЬ (06.08): разовый бласт по жёсткому списку — ровно тот случай, когда «я же знаю,
// что делаю» заканчивается заходами в ограниченный акк. Список остаётся, но каждый слаг проходит
// через postguard.cjs. Обход темпа (гэп/дневной лимит) — POSTGUARD_PACING_OFF=1.
'use strict';
const { Client } = require('pg');
const fs = require('fs');
const PG = require('./postguard.cjs');
const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false } });

// [slug, как ищем пост на складе]
const PLAN = [
  ['kasey37750', { persona: 'Дарья', template: 'img-beauty-guide', lux: true }],
  ['case17002', { id: 'b317a80b' }],                       // Мия, перевзведённая после ложного успеха
  ['gerardo53233', { id: '1157ea23' }],                    // дождевая Дана
  ['kade76559', { persona: 'Полина', template: 'img-makeup-colortype', lux: true }],
  ['damari1735', { id: 'd9cbf404' }],                      // дождевая Аня (уже на нём)
  ['bryan436344', { persona: 'Карина', template: 'img-makeup-colortype', lux: true }],
];

(async () => {
  await c.connect();
  let slot = 3; // минут от сейчас
  for (const [slug, sel] of PLAN) {
    const v = await PG.canPost(slug, { client: c });
    if (!v.ok) { console.log(`⛔ ${v.reason}`); continue; }
    let post;
    if (sel.id) {
      post = (await c.query("SELECT id, status FROM posts WHERE id::text LIKE $1 || '%'", [sel.id])).rows[0];
    } else {
      post = (await c.query(`SELECT id, status FROM posts WHERE status='backlog'
        AND meta->>'persona'=$1 AND meta->>'template'=$2 AND (meta->>'lux')::bool IS TRUE
        ORDER BY created_at DESC LIMIT 1`, [sel.persona, sel.template])).rows[0];
    }
    if (!post) { console.log(`✗ ${slug}: пост не найден (${JSON.stringify(sel)})`); continue; }
    const acc = (await c.query('SELECT id FROM accounts WHERE slug=$1', [slug])).rows[0];
    await c.query(`UPDATE posts SET account_id=$2, status='approved', scheduled_at=now() + ($3 || ' minutes')::interval WHERE id=$1`,
      [post.id, acc.id, String(slot)]);
    const j = await c.query(`INSERT INTO local_jobs (slug, mode, status, urls) VALUES ($1,'igpost','queued',$2) RETURNING id`,
      [slug, String(post.id)]);
    console.log(`→ ${slug}: пост ${String(post.id).slice(0, 8)}, слот +${slot} мин, job#${j.rows[0].id}`);
    slot += 20;
  }
  await c.end();
  console.log('БЛАСТ РАССТАВЛЕН');
})().catch((e) => { console.error(e.message); process.exit(1); });
