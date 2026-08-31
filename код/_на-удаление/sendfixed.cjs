// ОТПРАВКА ПЕРЕСОБРАННЫХ ПОСТОВ НАЧАЛЬНИКУ (07.08).
//
// Зачем: финалы пересобрал по новому стандарту (кадр 4 = арт с сердцами, повёрнутый и приближенный,
// плюс фирменный блок), но карточки в группу не ушли, и начальник справедливо спросил «а посты
// когда будут с 4 изображением». Кадры в базе новые, а он видит старые карточки.
//
// Дедуп tgsend по id поста эти карточки отклонит (пост уже отправлялся), поэтому идём с честным
// --force и причиной: это ровно тот случай, под который причину и вводили, замена кадров.
// Анти-лавина tgsend (5 карточек за 10 минут) НЕ обходится: по умолчанию берём 5 самых свежих,
// чтобы начальник посмотрел новый стандарт, а не получил стену из 43 карточек.
//
// Запуск: node sendfixed.cjs [сколько]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 5);

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
    SELECT id, meta->>'persona' pn, meta->>'template' tpl, meta->'image_urls' urls, caption
      FROM posts
     WHERE status='backlog' AND published_at IS NULL
       AND coalesce(meta->>'frame4_art','')='true'
     ORDER BY created_at DESC LIMIT $1`, [LIMIT])).rows;
  console.log(`отправляю карточек: ${rows.length}`);
  let ok = 0, bad = 0;
  for (const p of rows) {
    const short = String(p.id).slice(0, 8);
    try {
      const files = [];
      for (const [i, u] of (p.urls || []).entries()) {
        files.push(await grab(u, `/tmp/sf_${short}_${i + 1}.jpg`));
      }
      if (files.length < 4) throw new Error('кадров меньше четырёх');
      execFileSync('node', [path.join(__dirname, 'tgsend.cjs'), ...files, '--carousel',
        '--key', String(p.id), '--persona', p.pn || '—',
        '--type', `${p.tpl || 'сердечки'} · новый финал`,
        '--note', p.caption || '',
        '--force', 'финал пересобран: кадр 4 это арт с поворотом и фирменным блоком'],
        { cwd: __dirname, encoding: 'utf8', stdio: 'inherit' });
      console.log(`  ✅ ${short} (${p.pn}) отправлен`);
      ok++;
    } catch (e) { console.log(`  ✗ ${short}: ${String(e.message).slice(0, 80)}`); bad++; }
  }
  console.log(`ИТОГ: отправлено ${ok}, ошибок ${bad}`);
  await c.end();
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
