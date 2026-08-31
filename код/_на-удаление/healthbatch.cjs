// Прогон проверки здоровья по списку акков: N окон одновременно, каждый заход в отдельном процессе
// (ighealth.cjs сам закрывает своё окно Orbita; окна владельца и чужие процессы не трогаем).
// Запуск: node healthbatch.cjs /tmp/freepool.txt [окон=3]
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const LIST = process.argv[2] || '/tmp/freepool.txt';
const LANES = Number(process.argv[3]) || 3;
const slugs = fs.readFileSync(LIST, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

function one(slug) {
  return new Promise((resolve) => {
    const p = spawn('node', ['ighealth.cjs', slug], { cwd: __dirname, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const to = setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, 240000);
    p.on('close', () => {
      clearTimeout(to);
      const itog = (out.split('\n').find((l) => l.startsWith('ИТОГ:')) || 'ИТОГ: ⚠ без ответа').replace('ИТОГ: ', '');
      fs.appendFileSync('/tmp/healthbatch.txt', `${slug}\t${itog}\n`);
      console.log(`${slug}: ${itog}`);
      resolve({ slug, itog });
    });
  });
}

(async () => {
  fs.writeFileSync('/tmp/healthbatch.txt', '');
  console.log(`ПРОВЕРКА ${slugs.length} акков, окон одновременно: ${LANES}`);
  const queue = slugs.slice();
  const results = [];
  await Promise.all(Array.from({ length: LANES }, async () => {
    while (queue.length) {
      const s = queue.shift();
      results.push(await one(s));
    }
  }));
  console.log('\n=== ИТОГИ ===');
  const bad = results.filter((r) => /ОГРАНИЧЕН/.test(r.itog));
  const ok = results.filter((r) => /здоров/.test(r.itog));
  const other = results.filter((r) => !/ОГРАНИЧЕН|здоров/.test(r.itog));
  console.log(`чистых: ${ok.length} | с ограничением: ${bad.length} | не удалось проверить: ${other.length}`);
  if (bad.length) console.log('ОГРАНИЧЕНЫ: ' + bad.map((r) => r.slug).join(', '));
  if (other.length) console.log('НЕ ПРОВЕРЕНЫ (это про инструмент/прокси, НЕ вердикт по акку):');
  other.forEach((r) => console.log(`  ${r.slug}: ${r.itog}`));
  // ПУТЬ К СВОДКЕ ПЕЧАТАЕМ (07.08). Файл /tmp/healthbatch.txt писался и не читался ни одним
  // скриптом и ни одним человеком: лог, о котором никто не знает, это не журнал, а мусор.
  console.log(`построчная сводка: /tmp/healthbatch.txt (${slugs.length} строк, слаг + вердикт)`);
  process.exit(0);
})();
