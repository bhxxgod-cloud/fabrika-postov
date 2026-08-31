// Догон упавших пересылок (телеграм флуд-лимит): те же посты, паузы 30с, ошибки печатаем целиком.
//
// ПОЧЕМУ БЕЗ --force (правка 06.08): раньше догон шёл с --force и БЕЗ --key, то есть слал
// заново ВСЁ из списка, включая посты, которые в прошлый раз дошли. Именно так в группу
// владельца улетела пачка одинаковых карточек. Догон обязан быть догоном: с --key <id поста>
// дошедшие пропускаются сами, уходит только то, чего в группе нет.
'use strict';
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const IDS = ['7df4e8a6', 'e79d39af', '563fab0d', '03b2b012', 'b46bcfb2', '92acf3c3', 'b2d2b4ad', '7a340106', 'a4cb395a', '75388d28'];
const c = new Client({ connectionString: fs.readFileSync('/tmp/dburl.txt', 'utf8').trim(), ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  for (const id of IDS) {
    const r = await c.query("SELECT id, caption, meta->>'persona' p, meta->>'template' t, meta->'image_urls' u FROM posts WHERE id::text LIKE $1 || '%'", [id]);
    if (!r.rows[0]) { console.log('нет поста', id); continue; }
    const row = r.rows[0];
    const d = '/tmp/tgr_' + id;
    fs.mkdirSync(d, { recursive: true });
    const files = [];
    for (const [i, url] of row.u.entries()) {
      const f = path.join(d, (i + 1) + '.jpg');
      if (!fs.existsSync(f)) { const rr = await fetch(url); fs.writeFileSync(f, Buffer.from(await rr.arrayBuffer())); }
      files.push(f);
    }
    try {
      const out = execFileSync('node', ['tgsend.cjs', ...files, '--carousel',
        '--key', String(row.id),
        '--persona', row.p, '--type', String(row.t || '').replace('img-', ''),
        '--template', row.t || '', '--note', row.caption || ''],
        { cwd: '/Users/qq/Desktop/neironka-poster', encoding: 'utf8' });
      console.log('→', row.p, row.t, '|', out.trim().split('\n').pop());
    } catch (e) {
      console.log('✗', row.p, row.t, '|', String(e.stdout || e.message).trim().slice(-160));
    }
    await new Promise((res) => setTimeout(res, 30000));
  }
  await c.end();
  console.log('ДОГОН ГОТОВ');
})().catch((e) => { console.error(e.message); process.exit(1); });
