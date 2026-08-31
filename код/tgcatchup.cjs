// СТОРОЖ ПОКАЗА: догоняет посты, кадры которых правили ПОСЛЕ отправки карточки (07.08).
//
// ЗАЧЕМ. Правка кадров и показ начальнику были двумя отдельными шагами, и я пересобрал 50 финалов,
// не отправив ни одной карточки: начальник полчаса смотрел старые кадры. Отправку я вшил в fix4,
// но одного этого мало: любой будущий скрипт правки кадров (rehook, refit, swapslide, замена
// обложки) повторит ту же ошибку. Поэтому здесь ВНЕШНЯЯ сверка: что изменилось после показа,
// то досылаем, кто бы это ни изменил.
//
// Как понимаем «изменилось после показа»: скрипты правки пишут в meta метку frames_changed_at,
// а tgsend пишет время отправки в свой журнал tg_journal.json. Сравниваем эти два времени.
// Колонки updated_at в posts нет, поэтому метка в meta это единственный честный источник.
//
// Анти-лавину tgsend НЕ обходим: по умолчанию досылаем 5 карточек за прогон, остальное следующим.
// Запуск: node tgcatchup.cjs [сколько]   (в цикле: tgcatchuploop.sh)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 5);
const JOURNAL = path.join(__dirname, 'tg_journal.json');

function sentAt(postId) {
  try {
    const j = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    const e = (j.sent || {})[`post:${postId}`];
    if (!e) return null;
    const raw = typeof e === 'object' ? (e.at || e.lastAt) : null;
    return raw ? new Date(raw).getTime() : 0;   // 0 = отправляли, но времени нет (старая запись)
  } catch { return null; }
}

async function grab(url, out) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`кадр не скачался: HTTP ${r.status}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return out;
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls, caption,
           meta->>'frames_changed_at' changed
      FROM posts
     WHERE status IN ('backlog','approved') AND published_at IS NULL
       AND meta->>'frames_changed_at' IS NOT NULL
     ORDER BY meta->>'frames_changed_at' DESC`)).rows;

  const todo = [];
  for (const p of rows) {
    const at = sentAt(p.id);
    const changed = new Date(p.changed).getTime();
    // Не показывали вовсе, либо показывали ДО правки кадров: досылаем.
    if (at === null || at < changed) todo.push(p);
  }
  console.log(`постов с правкой кадров: ${rows.length}, требуют показа: ${todo.length}`);

  let ok = 0, bad = 0;
  for (const p of todo.slice(0, LIMIT)) {
    const short = String(p.id).slice(0, 8);
    try {
      const files = [];
      for (const [i, u] of (p.urls || []).entries()) files.push(await grab(u, `/tmp/cu_${short}_${i + 1}.jpg`));
      if (!files.length) throw new Error('нет кадров');
      execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files,
        ...(files.length > 1 ? ['--carousel'] : []),
        '--key', String(p.id), '--persona', p.pn || '—',
        '--type', `${p.tpl || 'пост'} · кадры обновлены`,
        '--note', p.caption || '',
        '--force', `кадры правились ${String(p.changed).slice(0, 16)}, показываю новую версию`],
        { cwd: __dirname, encoding: 'utf8', stdio: 'inherit' });
      console.log(`  ✅ ${short} (${p.pn}) показан`);
      ok++;
    } catch (e) { console.log(`  ✗ ${short}: ${String(e.message).slice(0, 80)}`); bad++; }
  }
  console.log(`ИТОГ: показано ${ok}, ошибок ${bad}, осталось ${Math.max(0, todo.length - LIMIT)}`);
  await c.end();
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
