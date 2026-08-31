// СОХРАНЕНИЕ РОЛИКОВ МОДЕЛЕЙ В ПАПКИ ДЕВОЧЕК (~/Desktop/АВАТАРЫ /<девочка>/).
// Зачем: ролики живут только по ссылке в фабрике, а на диске у владельца их нет. Скачиваем
// по media_url из очереди постера и кладём под номерами: 01.mp4, 02.mp4 — по порядку выхода.
// Имя файла несёт дату и id поста, чтобы ролик можно было связать с постом, не открывая базу.
//
// Соответствие персоны и папки задаётся ЯВНО: папки названы по-домашнему («Даша», «аня»),
// и угадывать, что «Мариша» это Маша, а «Дана» кто-то ещё, нельзя — разложить ролики не по
// тем девочкам хуже, чем не разложить вовсе. Персоны без записи в таблице получают свою
// папку с именем персоны, и скрипт об этом честно сообщает.
// Запуск: node savereels.cjs [--apply]   (без ключа только показывает, что и куда ляжет)
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = process.env.REELS_ROOT || path.join(os.homedir(), 'Desktop', 'АВАТАРЫ ');
const APPLY = process.argv.includes('--apply');

// персона в БД → папка на диске
const FOLDER = {
  'Дарья': 'Даша',
  'Анечка': 'аня',
};

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await p.query(
    `SELECT p.id, p.media_url, p.status, a.persona, a.is_spare,
            to_char(coalesce(p.published_at, p.created_at),'YYYY-MM-DD') d
       FROM posts p JOIN accounts a ON a.id=p.account_id
      WHERE p.kind='promo' AND p.media_url IS NOT NULL AND a.persona IS NOT NULL
      ORDER BY a.persona, coalesce(p.published_at, p.created_at)`);

  const unknown = new Set();
  const byPersona = new Map();
  for (const r of rows) {
    if (!FOLDER[r.persona]) unknown.add(r.persona);
    if (!byPersona.has(r.persona)) byPersona.set(r.persona, []);
    byPersona.get(r.persona).push(r);
  }
  if (unknown.size) {
    console.log(`⚠ нет соответствия папки для: ${[...unknown].join(', ')} → положу в папку с именем персоны.`);
    console.log('  Если у них уже есть папка под другим именем, скажи какая, и я поправлю таблицу в savereels.cjs.\n');
  }

  let saved = 0, skipped = 0;
  for (const [persona, list] of byPersona) {
    const dir = path.join(ROOT, FOLDER[persona] || persona);
    console.log(`${persona} → ${dir} (роликов: ${list.length})`);
    if (APPLY) fs.mkdirSync(dir, { recursive: true });
    for (const [i, r] of list.entries()) {
      const num = String(i + 1).padStart(2, '0');
      const name = `${num}_${r.d}_${String(r.id).slice(0, 8)}${r.is_spare ? '_запас' : ''}.mp4`;
      const dest = path.join(dir, name);
      if (fs.existsSync(dest)) { console.log(`   = ${name} (уже есть)`); skipped++; continue; }
      if (!APPLY) { console.log(`   → ${name}`); continue; }
      try {
        const resp = await fetch(r.media_url, { signal: AbortSignal.timeout(180000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 10000) throw new Error(`подозрительно мало байт: ${buf.length}`);
        fs.writeFileSync(dest, buf);
        console.log(`   ✓ ${name} (${(buf.length / 1048576).toFixed(1)} МБ)`);
        saved++;
      } catch (e) {
        // Не глотаем: «файл не скачался» обязано быть видно, иначе папка тихо останется неполной.
        console.log(`   ⛔ ${name}: ${e.message}`);
      }
    }
  }
  console.log(APPLY ? `\nсохранено ${saved}, уже было ${skipped}` : '\n(показ; для скачивания добавь --apply)');
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
