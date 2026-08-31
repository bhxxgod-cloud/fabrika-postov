// СМЕНА ТОЛЬКО АВЫ (05.08). Имена и ники на мультиакках уже стоят — трогать их повторно значит
// жечь лимиты и множить действия на акке. Здесь меняется ИСКЛЮЧИТЕЛЬНО аватарка.
//
// Что ставим: РЕАЛЬНЫЕ фото наших девочек (Даша/Аня/Полина/Карина) из ~/Desktop/авы.
// История решений начальника: аниме — «пизда», абстрактная генерация и стоковый «телефон
// с кофе» — «такую хуйню стоковую не надо никогда», лицо видно — «можно чтобы читалось похуй».
// Итог: живое фото модели, у каждого акка СВОЁ (одинаковая ава на связанных = маркер сетки).
//
// Запуск: node setava.cjs <slug> <путь_к_фото>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const PHOTO = process.argv[3];

// Возвращает СТАБИЛЬНОЕ имя файла авы, а не полный URL. В ссылке CDN зашиты подписи
// (_nc_oc, _nc_gid, oh), которые меняются при КАЖДОМ запросе даже для той же картинки —
// сравнение полных URL давало «ава сменилась» всегда, то есть проверка была фиктивной
// (поймано 05.08 на carter15909: скрипт рапортовал успех, а ава осталась прежней).
function picOutside(handle) {
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '25',
      '-H', 'x-ig-app-id: 936619743392459',
      '-A', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const u = (JSON.parse(out).data || {}).user;
    if (!u) return null;
    const url = u.profile_pic_url_hd || u.profile_pic_url || '';
    if (!url) return '';
    return (url.split('?')[0].split('/').pop() || url);   // 7648176..._n.jpg
  } catch { return null; }
}

(async () => {
  if (!SLUG || !PHOTO) { console.log('usage: node setava.cjs <slug> <фото>'); process.exit(1); }
  if (!fs.existsSync(PHOTO)) { console.log(`ИТОГ: ✗ нет файла ${PHOTO}`); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const row = (await c.query(`SELECT coalesce(ig_login,slug) h, session_status FROM accounts
    WHERE slug=$1 AND deleted_at IS NULL`, [SLUG])).rows[0];
  await c.end();
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); process.exit(1); }
  if (row.session_status !== 'live') { console.log(`ИТОГ: ✗ сессия ${row.session_status}`); process.exit(0); }

  const before = picOutside(row.h);
  console.log(`СМЕНА АВЫ @${row.h} → ${path.basename(PHOTO)}`);

  const env = {
    ...process.env, DB_PUBLIC_URL: DBURL, LOCAL: '1',
    AVATAR_PATH: PHOTO, AVATAR_ONLY: '1', SKIP_BIO: '1', SKIP_NAME: '1',
  };
  delete env.DRESS_NICK; delete env.DRESS_NICK_WANT; delete env.DRESS_NAME_WANT;
  const r = spawnSync('node', [path.join(__dirname, 'dressup.cjs'), SLUG], { env, encoding: 'utf8', timeout: 900000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  console.log(`  dressup: ${(out.split('\n').filter((l) => l.startsWith('ИТОГ:')).pop() || '').slice(0, 140)}`);
  // Настоящую причину провала печатаем ТОЖЕ: раньше из вывода бралась только строка ИТОГ,
  // и «⚠ файловый инпут авы не найден» терялось, оставляя загадку вместо диагноза.
  for (const l of out.split('\n')) if (/⚠|✗|не найден|ошибк/i.test(l) && l.length < 160) console.log(`  · ${l.trim()}`);

  // Правда снаружи: сравниваем ИМЯ ФАЙЛА авы до и после.
  const after = picOutside(row.h);
  if (after && before && after !== before) console.log(`ИТОГ: ✅ ава сменилась (было ${before.slice(0, 22)}…, стало ${after.slice(0, 22)}…)`);
  else if (after && !before) console.log('ИТОГ: ✅ ава стоит (проверено снаружи)');
  else if (after && after === before) console.log(`ИТОГ: ⛔ ава НЕ сменилась — на профиле прежний файл ${after.slice(0, 30)}`);
  else console.log('ИТОГ: ⚠ профиль снаружи не прочитался — проверить глазами');
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
