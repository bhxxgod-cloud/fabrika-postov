// ГЕЙТ ПОВТОРНОЙ ОБЛОЖКИ (06.08, ревизия начальника: один и тот же кадр стоял на 6 постах).
// Правило владельца: одна заглавная фотка (кадр 1 карусели) живёт ровно в ОДНОМ посте.
//
// Почему нельзя сверять по URL (так было раньше и защиты не давало): каждая заливка в R2 выдаёт
// файлу свой uuid, поэтому одна и та же картинка, залитая дважды, получает два разных адреса,
// и проверка по ссылке её не видит. Сверяем ПИКСЕЛИ: перцептивный dHash 16x16 = 256 бит.
//
// Почему картинка жмётся в фиксированную сетку БЕЗ сохранения пропорций: смена кропа
// (1080x1440 вместо 1080x1350) сдвигает геометрию и с «честным» аспектом хэш бы разъехался,
// то есть повтор обошёл бы гейт. Нормализуем всех к одной сетке и одному серому.
//
// Журнал covers.json лежит рядом со скриптом: { персона: [{hash, postId, at}] }. Он нужен,
// чтобы не перекачивать все обложки базы на каждом посте: докачиваем только те посты, которых
// в журнале ещё нет. Ключ персоны нормализован (lower+trim), потому что в базе одна и та же
// девочка встречается как «Дарья» и «дарья».
//
// Запуск руками:
//   node coverguard.cjs --prime            наполнить журнал по всей базе
//   node coverguard.cjs --dupes            показать посты с одинаковыми обложками
//   node coverguard.cjs --check <файл> <персона>
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const JOURNAL = path.join(__dirname, 'covers.json');
const SIDE = 16;                                          // сетка 16x16 → 256 бит хэша
// ПОРОГ ИЗМЕРЕН НА БОЕВОЙ БАЗЕ (64 обложки = 2016 пар, 06.08), а не назначен на глаз.
// Одна и та же фотка: тот же кроп 0 бит, ужатый вдвое 0, убитый jpeg 0, кроп 3:4 вместо 4:5
// 12 бит, 5:6 = 13, 1:1 = 41, 9:16 = 53. Разные фотки: НИ ОДНОЙ пары ближе 80 бит.
// Между 30 (худший реальный повтор в базе) и 80 (ближайшие разные кадры) пусто, поэтому
// 48 стоит в этом провале: смену кропа ловит с запасом, разные фотки за одну не примет.
// Порог 10 из первоначальной задумки пропускал 14 реальных повторов из 15, он слишком узкий.
// Выше 60 задирать нельзя: обложка отстоит от своего же референса из refs/ всего на 68 бит,
// значит два РАЗНЫХ рендера по одному референсу тоже могут сойтись близко и попасть под нож.
const THRESH = Number(process.env.COVER_THRESH || 48);    // порог похожести в битах из 256
// Обложка считается ЗАНЯТОЙ только если пост живой. Брак (rejected) и отменённые кадры
// освобождают картинку, их запрещать нельзя, иначе конвейер сам себя заблокирует.
// publishing тоже занят: пост прямо сейчас уходит в ленту.
const LIVE = ['backlog', 'approved', 'published', 'ambiguous', 'publishing'];

const key = (persona) => String(persona || '').trim().toLowerCase();
const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));

// ХЭШ КАРТИНКИ. dHash: сравниваем соседние пиксели по горизонтали, поэтому берём сетку
// (SIDE+1) x SIDE. Разностный хэш устойчив к перегону в jpeg и к смене яркости/контраста,
// а именно так один и тот же кадр возвращается из фабрики после повторной заливки.
function hashImage(file) {
  if (!fs.existsSync(file)) throw new Error(`нет файла для хэша: ${file}`);
  const px = execFileSync(FF, ['-nostdin', '-loglevel', 'error', '-y', '-i', file,
    // scale без force_original_aspect_ratio = жёсткая сетка, аспект нарочно ломается
    '-vf', `scale=${SIDE + 1}:${SIDE}:flags=area,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1 << 20 });
  if (px.length < (SIDE + 1) * SIDE) throw new Error(`ffmpeg не отдал пиксели: ${file}`);
  let hex = '', nib = 0, bits = 0;
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const i = y * (SIDE + 1) + x;
      nib = (nib << 1) | (px[i] > px[i + 1] ? 1 : 0);
      if (++bits === 4) { hex += nib.toString(16); nib = 0; bits = 0; }
    }
  }
  return hex;                                              // 64 hex-знака = 256 бит
}

// Расстояние Хэмминга в БИТАХ. Разная длина = хэши несопоставимы, отдаём заведомо большое,
// чтобы кривая запись в журнале не выдала ложное «обложка занята».
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 9999;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15];
  return d;
}

function loadJournal() {
  try { const j = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); return (j && typeof j === 'object') ? j : {}; }
  catch { return {}; }
}
// Пишем через временный файл: обрыв процесса на середине записи не должен превращать журнал
// в мусор, иначе гейт молча забудет всю историю.
function saveJournal(j) {
  const tmp = `${JOURNAL}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 1));
  fs.renameSync(tmp, JOURNAL);
}
// Журнал общий на несколько скриптов конвейера, поэтому правим его перечитав с диска:
// свою пачку добавляем к тому, что успел записать сосед.
function patchJournal(fn) {
  const j = loadJournal();
  fn(j);
  saveJournal(j);
  return j;
}

function addEntry(j, persona, hash, postId) {
  const k = key(persona);
  j[k] = (j[k] || []).filter((e) => String(e.postId) !== String(postId));
  j[k].push({ hash, postId: String(postId), at: new Date().toISOString() });
  return j;
}

async function hashUrl(url) {
  // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): гейт обложки зовут ВСЕ сборщики постов, и висяк здесь вешает
  // любую сборку намертво.
  const buf = await require('./watchdog.cjs').fetchBuf(url, { what: 'обложка', ms: 60000 });
  const tmp = path.join(os.tmpdir(), `cg_${crypto.randomBytes(6).toString('hex')}.jpg`);
  fs.writeFileSync(tmp, buf);
  try { return hashImage(tmp); } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function dbUrl() {
  return process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
}
async function withDb(client, fn) {
  if (client) return fn(client);
  const { Client } = require('pg');
  const c = new Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  try { return await fn(c); } finally { try { await c.end(); } catch {} }
}

// ДОКАЧКА ИСТОРИИ. Гейт обязан видеть посты, созданные не этим скриптом (руками с панели,
// другим чатом, старым конвейером) и те, чья запись в журнал не удалась. Тянем из базы только
// те id, которых в журнале нет, поэтому обычный прогон качает ноль файлов.
// persona = null означает «все персоны» (нужно для сверки по всей базе).
async function syncPersona(persona, opts = {}) {
  const k = persona == null ? null : key(persona);
  let added = 0;
  const known = new Set(Object.values(loadJournal()).flat().map((e) => String(e.postId)));
  const rows = await withDb(opts.client, async (c) => (await c.query(
    `SELECT id::text AS id, coalesce(meta->>'persona','?') AS persona, meta->'image_urls'->>0 AS url
       FROM posts WHERE meta->'image_urls'->>0 IS NOT NULL AND status = ANY($2)
        AND ($1::text IS NULL OR lower(btrim(coalesce(meta->>'persona',''))) = $1)`, [k, LIVE])).rows);
  for (const r of rows.filter((x) => !known.has(x.id))) {
    try {
      const h = await hashUrl(r.url);
      patchJournal((j) => addEntry(j, r.persona, h, r.id));
      added++;
    } catch (e) { console.log(`  ⚠ обложка поста ${r.id.slice(0, 8)} не посчиталась: ${String(e.message).slice(0, 60)}`); }
  }
  return { added, total: rows.length };
}

// ГЛАВНАЯ ПРОВЕРКА: файл кадра 1 против обложек живых постов.
// Возвращает {used, postId?, dist}. Асинхронная, потому что подтягивает историю из базы.
//
// Сверяем ПО ВСЕЙ БАЗЕ, а не только внутри персоны: ревизия 06.08 показала, что тот самый
// кадр стоял на постах Мии И Дарьи, то есть проверка внутри одной персоны его бы пропустила.
// Правило начальника «одна фотка = один пост» не про персону, а про фотку. Сузить обратно
// можно через COVER_SCOPE=persona.
async function coverUsed(file, persona, opts = {}) {
  const h = hashImage(file);
  const scope = opts.scope || (process.env.COVER_SCOPE === 'persona' ? 'persona' : 'all');
  // Синк вспомогательный. Если база недоступна, гейт всё равно работает по журналу:
  // падать из-за сетевого сбоя незачем, а молча пропускать повтор мы и не начинаем.
  if (!opts.noDb && process.env.COVER_NO_DB !== '1') {
    try { await syncPersona(scope === 'all' ? null : persona, opts); }
    catch (e) { console.log('  ⚠ история обложек из базы не подтянулась: ' + String(e.message).slice(0, 70)); }
  }
  const j = loadJournal();
  const mine = key(persona);
  const buckets = scope === 'all' ? Object.keys(j) : [mine];
  let best = null;
  for (const b of buckets) for (const e of j[b] || []) {
    const d = hamming(h, e.hash);
    if (!best || d < best.dist) best = { dist: d, postId: e.postId, persona: b };
  }
  if (best && best.dist <= THRESH) {
    return { used: true, postId: best.postId, dist: best.dist, hash: h,
      persona: best.persona, crossPersona: best.persona !== mine };
  }
  return { used: false, dist: best ? best.dist : null, hash: h };
}

// ЗАПИСЬ В ЖУРНАЛ после того, как пост реально создан. Зовём только для живых постов:
// у брака обложка остаётся свободной.
function registerCover(file, persona, postId) {
  const hash = hashImage(file);
  patchJournal((j) => addEntry(j, persona, hash, postId));
  return hash;
}

// ── CLI ──
async function prime() {
  const rows = await withDb(null, async (c) => (await c.query(
    `SELECT id::text AS id, coalesce(meta->>'persona','?') AS persona, meta->'image_urls'->>0 AS url, status
       FROM posts WHERE meta->'image_urls'->>0 IS NOT NULL AND status = ANY($1)
       ORDER BY created_at`, [LIVE])).rows);
  const have = loadJournal();
  const known = new Set(Object.values(have).flat().map((e) => String(e.postId)));
  let ok = 0, skip = 0, bad = 0;
  for (const r of rows) {
    if (known.has(r.id)) { skip++; continue; }
    try {
      const h = await hashUrl(r.url);
      patchJournal((j) => addEntry(j, r.persona, h, r.id));
      ok++;
      console.log(`  + ${r.id.slice(0, 8)} ${r.persona} (${r.status}) ${h.slice(0, 16)}…`);
    } catch (e) { bad++; console.log(`  ✗ ${r.id.slice(0, 8)} ${r.persona}: ${String(e.message).slice(0, 70)}`); }
  }
  console.log(`ИТОГ наполнения: занесено ${ok}, уже было ${skip}, не вышло ${bad}, всего живых постов ${rows.length}`);
}

// Поиск уже существующих совпадений: сколько постов сидят на одной обложке прямо сейчас.
// Группируем ПО ВСЕЙ БАЗЕ, потому что повтор гуляет между персонами (Мия и Дарья на одном кадре).
function dupes() {
  const j = loadJournal();
  const all = [];
  for (const [p, list] of Object.entries(j)) for (const e of list) all.push({ p, id: e.postId, hash: e.hash });
  const seen = [];
  for (const e of all) {
    const g = seen.find((s) => hamming(s.hash, e.hash) <= THRESH);
    if (g) g.items.push(e); else seen.push({ hash: e.hash, items: [e] });
  }
  let groups = 0;
  for (const s of seen) if (s.items.length > 1) {
    groups++;
    console.log(`  ${s.items.length} постов на одной обложке: ${s.items.map((x) => `${x.id.slice(0, 8)}/${x.p}`).join(', ')}`);
  }
  console.log(groups ? `ИТОГ: групп-дублей ${groups}` : 'ИТОГ: дублей обложек нет');
  return groups;
}

module.exports = { hashImage, hamming, coverUsed, registerCover, syncPersona, loadJournal, JOURNAL, THRESH, LIVE };

if (require.main === module) (async () => {
  const a = process.argv.slice(2);
  if (a[0] === '--prime') await prime();
  else if (a[0] === '--dupes') dupes();
  else if (a[0] === '--check') {
    const r = await coverUsed(a[1], a[2]);
    console.log(`${a[1]} / ${a[2]}: used=${r.used}${r.postId ? ' пост ' + r.postId.slice(0, 8) : ''} (ближайшее расхождение ${r.dist} бит из 256, порог ${THRESH})`);
  } else console.log('usage: node coverguard.cjs --prime | --dupes | --check <файл> <персона>');
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
