// СВЕРКА ИСХОДОВ ПУБЛИКАЦИИ С ЛЕНТОЙ (06.08).
//
// ЗАЧЕМ. Пост, у которого post_submitted=true, а external_url пуст — это пост с ПОТЕРЯННЫМ
// исходом: Share нажали, а что вышло — неизвестно. Такие висят в publishing/ambiguous вечно,
// мусорят статистику и провоцируют повторную заливку того же материала (так в ленте
// @darya.smirnova13 оказались два одинаковых поста, DbrPpFowqZk и Dbrbnu5BbLN).
// Разбирать их глазами по одному дорого, а ретраить нельзя. Значит нужен разбор снаружи.
//
// ЧТО ДЕЛАЕТ. Читает ленту аккаунта без браузера (postverify.cjs) и сопоставляет с подписью:
//   • пост НАЙДЕН в ленте  → дописывает external_url + status='published' + published_at по факту;
//   • поста НЕТ, и лента прочитана достоверно и покрывает момент клика → status='failed'
//     (терминально: висеть в publishing больше не будет, ретрай по-прежнему запрещён);
//   • ленту прочитать не удалось → НЕ ТРОГАЕТ НИЧЕГО. «Не видно» ≠ «не опубликован»: закрыть
//     живой пост как провал хуже, чем оставить его до следующего прогона.
// Плюс подбирает улики /tmp/igpost2_unsaved/*.json (исход, который не доехал до базы) и
// показывает СИРОТ — публикации в ленте, которых нет ни в одной строке posts: это и есть
// следы дублей и потерянных исходов, их видно глазами.
//
// ИНВАРИАНТ НЕ ТРОГАЕМ: после клика Share ретраи запрещены навсегда. Скрипт только фиксирует
// то, что уже произошло, и никогда не возвращает пост в очередь.
//
// Запуск:
//   node postreconcile.cjs                 — сухой прогон по всем зависшим (ничего не пишет)
//   node postreconcile.cjs --apply         — записать вердикты в базу
//   node postreconcile.cjs kasey37750      — только один аккаунт
//   node postreconcile.cjs --apply --hours=6   — закрывать «поста нет» только старше 6 часов
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const PV = require('./postverify.cjs');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const ONLY = ARGS.find((a) => !a.startsWith('--')) || null;
// Свежий пост мог просто не успеть проявиться в выдаче, поэтому «поста нет» превращается в
// приговор не сразу. 2 часа — с запасом: обычно ролик виден снаружи через минуту.
const MIN_AGE_H = Number((ARGS.find((a) => a.startsWith('--hours=')) || '').split('=')[1] || 2);
const UNSAVED_DIR = '/tmp/igpost2_unsaved';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log(`СВЕРКА ИСХОДОВ ${APPLY ? '(ЗАПИСЬ В БАЗУ)' : '(сухой прогон, ничего не меняю)'}`
    + `${ONLY ? `, только ${ONLY}` : ''}, порог закрытия ${MIN_AGE_H}ч\n`);

  // ── 1. Улики с диска: исход был известен, но база его не приняла ────────────────────────
  if (fs.existsSync(UNSAVED_DIR)) {
    for (const f of fs.readdirSync(UNSAVED_DIR).filter((x) => x.endsWith('.json'))) {
      let u = null;
      try { u = JSON.parse(fs.readFileSync(`${UNSAVED_DIR}/${f}`, 'utf8')); } catch { continue; }
      if (!u || !u.post_id) continue;
      const cur = (await c.query(`SELECT status, external_url FROM posts WHERE id=$1`, [u.post_id])).rows[0];
      if (!cur) continue;
      if (cur.external_url) { fs.unlinkSync(`${UNSAVED_DIR}/${f}`); continue; }
      console.log(`💾 улика с диска: ${u.post_id.slice(0, 8)} @${u.handle} → ${u.status} ${u.external_url || ''}`);
      if (APPLY) {
        await c.query(`UPDATE posts SET status=$2, external_url=coalesce($3,external_url),
            published_at=CASE WHEN $2='published' THEN coalesce(published_at, $4::timestamptz) ELSE published_at END,
            error=$5 WHERE id=$1`,
          [u.post_id, u.status, u.external_url || null, u.at || null, String(u.error || 'исход подобран с диска').slice(0, 300)]);
        fs.unlinkSync(`${UNSAVED_DIR}/${f}`);
      }
    }
  }

  // ── 2. Посты с потерянным исходом ────────────────────────────────────────────────────────
  const posts = (await c.query(
    `SELECT p.id, p.status, p.caption, p.meta, p.attempts, p.scheduled_at, p.created_at,
            a.id aid, a.slug, coalesce(a.ig_login,a.slug) h, a.ig_cookies, a.ig_proxy, a.persona,
            a.deleted_at, a.health_state
       FROM posts p JOIN accounts a ON a.id=p.account_id
      WHERE p.post_submitted=true AND p.external_url IS NULL AND p.status <> 'published'
        ${ONLY ? 'AND (a.slug=$1 OR a.ig_login=$1 OR a.persona=$1)' : ''}
      ORDER BY a.slug, p.created_at`, ONLY ? [ONLY] : [])).rows;

  if (!posts.length) { console.log('зависших постов нет'); await c.end(); return; }

  // ЗАНЯТЫЕ ССЫЛКИ. Один и тот же материал раздаётся на несколько постов и повторяется на одном
  // аккаунте (у @bryan436344 три поста с одинаковой подписью), поэтому «совпало по подписи» само
  // по себе ничего не доказывает: ролик мог принадлежать другому, уже записанному посту.
  // Проверено на живых данных 06.08 — без этой защиты сверка привязала бы зависший пост к чужой
  // ссылке и мы получили бы вторую, тихую порчу данных вместо починки первой.
  const taken = new Set((await c.query(`SELECT external_url FROM posts WHERE external_url IS NOT NULL`))
    .rows.map((r) => PV.codeOf(r.external_url)).filter(Boolean));

  // По аккаунту ленту читаем ОДИН раз: лишние запросы с одного адреса нам не нужны.
  const byAcc = new Map();
  for (const p of posts) { if (!byAcc.has(p.slug)) byAcc.set(p.slug, []); byAcc.get(p.slug).push(p); }
  console.log(`зависших постов: ${posts.length} на ${byAcc.size} аккаунтах\n`);

  const stat = { published: 0, failed: 0, unknown: 0, dup: 0 };

  for (const [slug, list] of byAcc) {
    const a = list[0];

    // СНЕСЁННЫЙ АККАУНТ. Ленты у него больше нет и не будет: чекпоинт прячет все публикации от
    // всех, включая нас (проверено на @darya.smirnova13 06.08 — даже прямой запрос по shortcode
    // отвечает «Media not found»). Держать такие посты в publishing бессмысленно: они не оживут
    // ни сами, ни следующим прогоном, а статистику портят. Закрываем честно, с причиной.
    if (a.deleted_at || a.health_state === 'deleted') {
      console.log(`@${a.h} (${slug}): аккаунт снесён ${String(a.deleted_at || '').slice(0, 16)} — сверка невозможна`);
      for (const p of list) {
        console.log(`  ✗ ${p.id.slice(0, 8)} → failed (акк снесён) — «${String(p.caption || '').replace(/\s+/g, ' ').slice(0, 45)}»`);
        stat.failed++;
        if (APPLY) {
          await c.query(`UPDATE posts SET status='failed', error=$2 WHERE id=$1`,
            [p.id, `акк @${a.h} снесён, исход публикации проверить нечем: лента и медиа скрыты; ретрай запрещён`]);
        }
      }
      console.log('');
      continue;
    }

    const feed = await PV.readFeed({ h: a.h, ig_cookies: a.ig_cookies, ig_proxy: a.ig_proxy });
    if (!feed.ok) {
      console.log(`@${a.h} (${slug}): ЛЕНТА НЕ ПРОЧИТАНА — ${feed.gone ? 'профиля не существует' : feed.why}`);
      console.log(`   ${list.length} пост(ов) оставляю как есть: «не видно» не значит «не опубликован»\n`);
      stat.unknown += list.length;
      continue;
    }
    const oldest = feed.items.map((m) => m.taken_at).filter(Boolean).sort((x, y) => x - y)[0] || null;
    console.log(`@${a.h} (${slug}): лента прочитана [${feed.source}], медиа в выдаче: ${feed.items.length}`
      + (oldest ? `, самое старое ${oldest.toISOString().slice(0, 16)}` : ''));

    for (const p of list) {
      const share = ((p.meta || {}).share_click || {});
      const shareAt = new Date(share.at || p.scheduled_at || p.created_at);
      const before = new Set(share.before || []);
      // Раньше момента, когда пост вообще появился у нас, он не мог оказаться в ленте — это
      // второй замок против привязки к старой публикации с такой же подписью.
      const floor = new Date(Math.min(new Date(p.created_at).getTime(),
        new Date(share.at || p.scheduled_at || p.created_at).getTime()) - 5 * 60000);
      const cap = String(p.caption || '').replace(/\s+/g, ' ').slice(0, 45);
      const byCaption = PV.findByCaption(feed.items, p.caption);
      const hits = byCaption.filter((m) => !before.has(m.code) && !taken.has(m.code)
        && (!m.taken_at || m.taken_at >= floor));
      const dropped = byCaption.filter((m) => !hits.includes(m));
      if (dropped.length) {
        console.log(`  ℹ ${p.id.slice(0, 8)}: по подписи совпало ${byCaption.length}, отброшено ${dropped.length} `
          + `(${dropped.map((m) => `${m.code}${taken.has(m.code) ? ' занят другим постом' : before.has(m.code) ? ' был до клика' : ' старше поста'}`).join(', ')})`);
      }

      if (hits.length) {
        // Несколько совпадений по подписи = тот самый дубль в ленте. Ссылку ставим на самый
        // ранний (он и был первой заливкой), про остальные говорим вслух: их убирают руками.
        hits.sort((x, y) => (x.taken_at || 0) - (y.taken_at || 0));
        const m = hits[0];
        if (hits.length > 1) {
          stat.dup++;
          console.log(`  ⚠ ДУБЛЬ В ЛЕНТЕ (${hits.length}): ${hits.map((z) => z.code).join(', ')} — «${cap}»`);
        }
        console.log(`  ✅ ${p.id.slice(0, 8)} найден: ${PV.postUrl(m.code)} (${m.taken_at ? m.taken_at.toISOString().slice(0, 16) : 'время неизвестно'}) — «${cap}»`);
        stat.published++;
        if (APPLY) {
          await c.query(
            `UPDATE posts SET status='published', external_url=$2,
               published_at=coalesce(published_at, $3::timestamptz),
               error=$4 WHERE id=$1`,
            [p.id, PV.postUrl(m.code), m.taken_at || null,
             `исход восстановлен сверкой с лентой${hits.length > 1 ? ` (в ленте ${hits.length} копии: ${hits.map((z) => z.code).join(', ')})` : ''}`]);
        }
        continue;
      }

      // Поста нет. Приговор выносим, только если выдача ДОКАЗАТЕЛЬНО покрывает момент клика:
      // лента отдаёт последние N публикаций, и если среди них есть более старая, чем наш Share,
      // то наш пост в неё попал бы обязательно. Иначе — не знаем, ждём следующего прогона.
      const ageH = (Date.now() - shareAt.getTime()) / 3600000;
      const covers = (oldest && oldest < shareAt) || feed.items.length === 0 || feed.complete;
      if (covers && ageH >= MIN_AGE_H) {
        console.log(`  ✗ ${p.id.slice(0, 8)} в ленте нет (прошло ${ageH.toFixed(1)}ч) → failed — «${cap}»`);
        stat.failed++;
        if (APPLY) {
          await c.query(
            `UPDATE posts SET status='failed', error=$2 WHERE id=$1`,
            [p.id, `сверка снаружи ${new Date().toISOString().slice(0, 16)}: поста нет в ленте @${a.h} (${feed.source}), Share не долетел; ретрай запрещён`]);
        }
      } else {
        console.log(`  ? ${p.id.slice(0, 8)} не определён (${!covers ? 'выдача не покрывает момент клика' : `прошло всего ${ageH.toFixed(1)}ч`}) — «${cap}»`);
        stat.unknown++;
      }
    }

    // СИРОТЫ: что лежит в ленте, но не записано ни в одной строке posts. Это следы потерянных
    // исходов и повторных заливок — ровно то, из-за чего затевалась вся починка.
    const ours = new Set((await c.query(
      `SELECT external_url FROM posts WHERE account_id=$1 AND external_url IS NOT NULL`, [a.aid]))
      .rows.map((r) => PV.codeOf(r.external_url)).filter(Boolean));
    const orphans = feed.items.filter((m) => !ours.has(m.code));
    if (orphans.length) {
      console.log(`  🔎 в ленте ${orphans.length} публикаций без строки в базе:`);
      for (const m of orphans.slice(0, 10)) {
        console.log(`     ${PV.postUrl(m.code)} ${m.taken_at ? m.taken_at.toISOString().slice(0, 16) : ''} «${m.caption.replace(/\s+/g, ' ').slice(0, 40)}»`);
      }
    }
    console.log('');
    await sleep(2500);   // не частим запросами по ферме
  }

  console.log(`ИТОГ: восстановлено ${stat.published}, закрыто провалом ${stat.failed}, `
    + `не определено ${stat.unknown}${stat.dup ? `, дублей в ленте ${stat.dup}` : ''}`
    + `${APPLY ? '' : ' — это сухой прогон, для записи добавьте --apply'}`);
  await c.end();
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
