// ОФОРМЛЕНИЕ МУЛЬТИ-АККА (05.08, решение начальника: «все акки будут мультиакк, разные девочки
// на разных акках, акки типа обучалки по аи промптам»).
//
// Отличие от prepacc.cjs: тот одевает акк ПОД МОДЕЛЬ (лицо девочки + её имя). Мультиакку так
// нельзя — он публикует разных девочек, и лицо на аве привязывает его к одной персоне.
// Поэтому здесь: ава БЕЗ ЛИЦА из ~/Desktop/авы, нейтральное имя про ИИ-промпты, нейтральный ник.
// Поле persona у акка остаётся, но это только маршрутизация постов, не оформление.
//
// Проверяем СНАРУЖИ: самоотчёту dressup не верим (05.08 все пять акков врали про био).
// Запуск: node dressmulti.cjs <slug>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const AVA_DIR = path.join(os.homedir(), 'Desktop', 'авы');
const SLUG = process.argv[2];

// Имя профиля: тема канала, а НЕ имя девочки. Ставим то, что объясняет, зачем на нас подписаться.
const NAMES = ['нейро промпты', 'ии-шаблоны', 'промпты и тренды', 'нейросети для фото',
  'ai промпты', 'нейро тренды', 'шаблоны нейросети', 'промпты для себя'];
// Ник в стиле уже работающих (cherry.mood59, vibe.mood.daily): человечный, без спам-слов.
const NICKS = ['ai.promt.vibe', 'neuro.promt.daily', 'promt.mood.club', 'ai.tricks.daily',
  'neuro.vibe.club', 'promt.daily.mood', 'ai.photo.vibe', 'neuro.mood.daily',
  'promt.club.vibe', 'ai.mood.tricks'];

function pickBy(list, seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}
function bioOutside(handle) {
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '25',
      '-H', 'x-ig-app-id: 936619743392459',
      '-A', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const u = (JSON.parse(out).data || {}).user;
    return u ? { name: u.full_name || '', pic: u.profile_pic_url || '' } : null;
  } catch { return null; }
}

(async () => {
  if (!SLUG) { console.log('usage: node dressmulti.cjs <slug>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const row = (await c.query(`SELECT id, coalesce(ig_login,slug) h, session_status, persona
    FROM accounts WHERE slug=$1 AND deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
  if (row.session_status !== 'live') { console.log(`ИТОГ: ✗ сессия ${row.session_status}`); await c.end(); process.exit(0); }

  // Ава: разная у разных акков — одинаковая картинка на связанных профилях читается как сетка.
  const pool = fs.existsSync(AVA_DIR)
    ? fs.readdirSync(AVA_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort() : [];
  if (!pool.length) { console.log('ИТОГ: ✗ пул ав пуст — сначала node genavas.cjs'); await c.end(); process.exit(1); }
  const ava = path.join(AVA_DIR, pickBy(pool, row.id));
  const name = pickBy(NAMES, row.id);
  // Ник не должен совпасть с уже занятым в базе — берём следующий свободный из пула.
  const taken = new Set((await c.query(`SELECT lower(coalesce(ig_login,'')) n FROM accounts WHERE deleted_at IS NULL`)).rows.map((r) => r.n));
  let nick = pickBy(NICKS, row.id);
  if (taken.has(nick)) nick = NICKS.find((n) => !taken.has(n)) || `${nick}${String(row.id).slice(0, 2)}`;
  await c.end();

  console.log(`МУЛЬТИ-ОФОРМЛЕНИЕ @${row.h} (постит: ${row.persona || 'разных'})`);
  console.log(`  ава: ${path.basename(ava)} (без лица)`);
  console.log(`  имя: «${name}»`);
  console.log(`  ник: @${nick}`);

  const env = {
    ...process.env, DB_PUBLIC_URL: DBURL, LOCAL: '1',
    AVATAR_PATH: ava, SKIP_BIO: '1',
    DRESS_NAME_WANT: name,
    DRESS_NICK: '1', DRESS_NICK_WANT: nick,
  };
  delete env.PERSONA_NAME;   // иначе dressup соберёт ник из имени модели
  const r = spawnSync('node', [path.join(__dirname, 'dressup.cjs'), SLUG], { env, encoding: 'utf8', timeout: 900000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const itog = out.split('\n').filter((l) => l.startsWith('ИТОГ:')).pop() || '';
  console.log(`  dressup: ${itog.slice(0, 160)}`);

  // ПРАВДА СНАРУЖИ — по ФАКТИЧЕСКИ применённому нику, а не по задуманному. IG молча добавляет
  // суффикс, если ник занят (05.08: планировали neuro.vibe.club, получили neuro.vibe.club54),
  // и проверка задуманного ника показывала «профиль не читается» на успешно оформленном акке.
  const c2 = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c2.connect();
  const real = (await c2.query('SELECT coalesce(ig_login, $2) h FROM accounts WHERE slug=$1', [SLUG, nick])).rows[0];
  await c2.end();
  const actual = (real && real.h) || nick;
  if (actual !== nick) console.log(`  ник по факту: @${actual} (задуманный @${nick} был занят)`);
  const after = bioOutside(actual) || bioOutside(nick) || bioOutside(row.h);
  if (!after) { console.log(`ИТОГ: ⚠ профиль @${actual} снаружи не читается, проверь вручную`); return; }
  const noAva = !after.pic || /anonymousUser|profilePicDefault/i.test(after.pic);
  console.log(`ИТОГ: снаружи — имя «${after.name}», ава ${noAva ? 'ДЕФОЛТНАЯ' : 'своя'}`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
