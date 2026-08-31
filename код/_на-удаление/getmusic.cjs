// ПОПОЛНЕНИЕ ПУЛА МУЗЫКИ ДЛЯ РИЛСОВ.
//
// Зачем много треков: Instagram склеивает аккаунты в сетку не только по картинке, но и по
// ОТПЕЧАТКУ ЗВУКА. Пять файлов на всю ферму = пять аудио-кластеров, в каждом сидят все наши
// акки, и это готовый признак сети. Нужны десятки разных дорожек.
//
// Почему берём только свободные лицензии, а не «что угодно»: Instagram глушит звук и режет охват
// постам с чужим копирайтом, а повторные срабатывания дают страйк аккаунту. На молодой ферме это
// дороже любой экономии времени. Поэтому источник — Creative Commons коллекции archive.org.
//
// Запуск:  node getmusic.cjs [сколько]      (по умолчанию 50)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, 'audio');
const WANT = Number(process.argv[2] || 50);
const MIN_BYTES = 400 * 1024;      // короче ~30 сек нам не подходит: рилс 10-15 сек, нужен запас
const MAX_BYTES = 12 * 1024 * 1024; // огромные файлы качать незачем

// ЖАНР ВАЖЕН НЕ МЕНЬШЕ ЛИЦЕНЗИИ. Первый пул набрался инди-роком с нетлейблов — под бьюти-ленту
// это мимо: рилсы про макияж и разбор внешности живут на мягком лоу-фае, чиллхопе и дрим-попе,
// как в тиктоке. Треки из самого тиктока брать нельзя (коммерческий копирайт: IG глушит звук,
// режет охват, при повторах прилетает страйк), поэтому берём то же ЗВУЧАНИЕ под свободной лицензией.
const QUERIES = [
  'lofi hip hop', 'chillhop', 'dream pop', 'ambient chill',
  'chillout beats', 'soft piano', 'downtempo', 'lo-fi beats',
];
// Прямые коллекции, которые уже проверены руками.
const COLLECTIONS = ['auboutdufil-archives'];

const curl = (url, args = []) => execFileSync('curl', ['-sL', '--max-time', '90', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', '-e', 'https://ccmixter.org/', ...args, url],
  { maxBuffer: 64 * 1024 * 1024 });

// ccMixter — каталог музыки под Creative Commons с внятными жанровыми тегами и прямыми mp3.
// Архив по тем же запросам отдавал экспериментальный эмбиент и инди-рок: формально свободно,
// но под бьюти-ленту не годится. Здесь теги честные, поэтому чилл получается чиллом.
const CCM_TAGS = ['chill', 'lofi', 'chillout', 'downtempo', 'ambient', 'mellow', 'dreamy', 'relaxing'];
function ccmixter(tag, limit = 12) {
  try {
    const j = JSON.parse(curl(`http://ccmixter.org/api/query?f=json&limit=${limit}&tags=${encodeURIComponent(tag)}`).toString());
    const out = [];
    for (const item of (Array.isArray(j) ? j : [])) {
      for (const f of (item.files || [])) {
        const url = f.download_url || '';
        if (/\.mp3$/i.test(url)) { out.push({ url, name: url.split('/').pop(), size: Number(f.file_size || 0) }); break; }
      }
    }
    return out;
  } catch { return []; }
}

// Ищем айтемы по жанровым запросам: так пул набирается нужным настроением, а не чем попало.
function searchItems(query, rows = 6) {
  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}`
      + `+AND+mediatype%3Aaudio+AND+format%3A%22VBR+MP3%22&fl%5B%5D=identifier`
      + `&rows=${rows}&sort%5B%5D=downloads+desc&output=json`;
    const j = JSON.parse(curl(url).toString());
    return (j.response?.docs || []).map((d) => d.identifier);
  } catch { return []; }
}


function listTracks(item) {
  try {
    const meta = JSON.parse(curl(`https://archive.org/metadata/${item}`).toString());
    const server = meta.server || 'archive.org';
    const dir = meta.dir || '';
    return (meta.files || [])
      .filter((f) => /\.mp3$/i.test(f.name) && Number(f.size) > MIN_BYTES && Number(f.size) < MAX_BYTES)
      .map((f) => ({ url: `https://${server}${dir}/${encodeURI(f.name)}`, name: f.name, size: Number(f.size) }));
  } catch { return []; }
}

// Имя файла делаем плоским и безопасным: в архиве встречаются вложенные пути и пробелы.
function safeName(item, name) {
  const base = path.basename(name).replace(/[^\w.\-]+/g, '_').slice(-60);
  return `${item.slice(0, 12)}_${base}`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const have = fs.readdirSync(OUT).filter((f) => /\.(mp3|m4a|wav)$/i.test(f)).length;
  console.log(`в пуле сейчас ${have} треков, добираю до ${WANT}`);

  // СНАЧАЛА ccMixter: там теги честные и музыка нужного настроения.
  let added = 0;
  for (const tag of CCM_TAGS) {
    if (have + added >= WANT) break;
    const tracks = ccmixter(tag);
    if (!tracks.length) continue;
    console.log(`  ccMixter/${tag}: ${tracks.length} треков`);
    for (const t of tracks) {
      if (have + added >= WANT) break;
      const dest = path.join(OUT, `ccm_${tag}_${t.name}`.replace(/[^\w.\-]+/g, '_').slice(-70));
      if (fs.existsSync(dest)) continue;
      try {
        curl(t.url, ['-o', dest]);
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        if (size < MIN_BYTES) { try { fs.unlinkSync(dest); } catch {} continue; }
        added++; process.stdout.write(`\r    скачано ${added}`);
      } catch { try { fs.unlinkSync(dest); } catch {} }
    }
    console.log('');
  }

  // Если ccMixter не добрал — идём в архив по жанровым запросам.
  const items = [];
  for (const q of QUERIES) { for (const id of searchItems(q)) if (!items.includes(id)) items.push(id); }
  for (const id of COLLECTIONS) if (!items.includes(id)) items.push(id);
  console.log(`  источников найдено: ${items.length}`);

  for (const item of items) {
    if (have + added >= WANT) break;
    const tracks = listTracks(item);
    if (!tracks.length) { console.log(`  ${item}: mp3 не нашлось, пропускаю`); continue; }
    console.log(`  ${item}: ${tracks.length} треков`);
    for (const t of tracks) {
      if (have + added >= WANT) break;
      const dest = path.join(OUT, safeName(item, t.name));
      if (fs.existsSync(dest)) continue;
      try {
        curl(t.url, ['-o', dest]);
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        // Битую закачку не оставляем: пустой файл в пуле = рилс без звука.
        if (size < MIN_BYTES) { try { fs.unlinkSync(dest); } catch {} continue; }
        added++;
        process.stdout.write(`\r    скачано ${added}`);
      } catch { try { fs.unlinkSync(dest); } catch {} }
    }
    console.log('');
  }

  const total = fs.readdirSync(OUT).filter((f) => /\.(mp3|m4a|wav)$/i.test(f)).length;
  console.log(`ИТОГ: добавлено ${added}, всего в пуле ${total} треков`);
  if (total < 12) console.log('⚠ мало: при таком пуле акки рискуют склеиться по отпечатку звука');
})();
