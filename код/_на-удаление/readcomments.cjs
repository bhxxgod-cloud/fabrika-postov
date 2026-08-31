// ЧТЕНИЕ КОММЕНТАРИЕВ ПОД НАШИМ ЖЕ ПОСТОМ (10.08, приказ начальника «какие там комментарии скинь мне»).
//
// ЗАЧЕМ. На части постов при 130-200 просмотрах стоит по 26-32 комментария. Для свежих аккаунтов
// это ненормально много, и надо своими глазами понять, что это: живой интерес, спам-ферма или
// боты. Если мусор, комментарии лучше чистить: инстаграм считает спамным сам аккаунт, а не гостей.
//
// ПОЧЕМУ НЕ АНОНИМНО. Публичная страница поста отдаёт пустую JS-оболочку, комментариев в ней нет,
// а embed их не содержит вовсе. Поэтому читаем мобильной ручкой от имени САМОГО аккаунта: сессия
// лежит в accounts.ig_cookies (base64 с полями authorization, ds_user_id, mid, csrf, www_claim).
// Это чтение своего же поста, ничего не публикуем и не меняем.
//
// СЕКРЕТЫ НЕ ПЕЧАТАЕМ: токен и куки в вывод не попадают ни при какой ошибке.
//
// Запуск: node readcomments.cjs <ник> <шорткод> [ещё шорткоды...]
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const NICK = process.argv[2];
const CODES = process.argv.slice(3);
const DBURL = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// Шорткод это тот же id медиа, записанный своим алфавитом base64. Переводим сами, чтобы не тратить
// лишний запрос: у мобильной ручки комментариев на входе именно числовой id.
function shortcodeToId(code) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = 0n;
  for (const ch of code) {
    const i = A.indexOf(ch);
    if (i < 0) return null;
    n = n * 64n + BigInt(i);
  }
  return n.toString();
}

function proxy() {
  for (const f of ['/tmp/px/kz_magos_100.txt', '/tmp/px/kz_sous_100.txt']) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().split(':').length === 4);
      if (lines.length) {
        const p = lines[Math.min(7, lines.length - 1)].trim().split(':');
        return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;
      }
    } catch {}
  }
  return null;
}

(async () => {
  if (!NICK || !CODES.length) { console.log('usage: node readcomments.cjs <ник> <шорткод> [...]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  const r = await c.query('SELECT ig_cookies FROM accounts WHERE ig_login = $1 LIMIT 1', [NICK]);
  await c.end().catch(() => {});
  if (!r.rows[0]) { console.log('акк не найден в базе'); process.exit(1); }

  let raw = r.rows[0].ig_cookies;
  if (typeof raw !== 'string') raw = (raw && raw.raw) || JSON.stringify(raw);
  raw = String(raw).replace(/^\{"raw":"/, '').replace(/"\}$/, '');
  let s;
  try { s = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { console.log('сессию не разобрал'); process.exit(1); }
  // Токен лежит вложенно: session.authorization, а device и app рядом. Разложил по факту структуры.
  const S = s.session || {};
  if (!S.authorization) { console.log('в сессии нет мобильного токена, читать нечем'); process.exit(1); }

  const px = proxy();
  const H = [
    '-H', `Authorization: ${S.authorization}`,
    '-H', 'User-Agent: Instagram 269.0.0.18.75 Android (30/11; 420dpi; 1080x2260; samsung; SM-A515F; a51; exynos9611; ru_RU; 314665256)',
    '-H', 'X-IG-App-ID: 567067343352427',
    '-H', `X-IG-WWW-Claim: ${S.www_claim || '0'}`,
    '-H', `X-CSRFToken: ${S.csrf || ''}`,
    '-H', `X-MID: ${S.mid || ''}`,
    '-H', 'Accept-Language: ru-RU, ru',
    '-H', 'X-IG-Capabilities: 3brTv10=',
  ];

  for (const code of CODES) {
    const id = shortcodeToId(code);
    console.log(`\n=== пост ${code} (медиа ${id ? id.slice(0, 6) + '…' : '?'}) ===`);
    if (!id) { console.log('  шорткод не разобрал'); continue; }
    const args = ['-s', '--max-time', '35', ...H, `https://i.instagram.com/api/v1/media/${id}/comments/?can_support_threading=true&permalink_enabled=false`];
    if (px) args.push('--proxy', px);
    const out = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 24 }).stdout || '';
    let j = null;
    try { j = JSON.parse(out); } catch {}
    if (!j) { console.log('  ответ не разобрал (возможно, требуется вход заново)'); continue; }
    if (j.message) { console.log(`  инстаграм ответил: ${j.message}`); continue; }
    const cs = j.comments || [];
    console.log(`  комментариев в ответе: ${cs.length}${j.comment_count != null ? `, всего по счётчику: ${j.comment_count}` : ''}`);
    for (const k of cs) {
      const u = (k.user && k.user.username) || '?';
      const followers = k.user && k.user.follower_count;
      console.log(`   @${u}${followers != null ? ` (подписчиков ${followers})` : ''}: ${String(k.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
})().catch((e) => { console.error('ОШИБКА:', String(e.message).slice(0, 120)); process.exit(1); });
