// Честность флага прокси: proxy_status='ok' у акков, чей канал НЕ отвечает, это ложь в данных,
// из-за которой система считает акк рабочим и раз за разом ведёт его в браузер на «Proxy Error».
// Проверка живости делает proxycheckpool.cjs (curl через прокси), сюда приходит её результат.
const { Pool } = require('pg');
const fs = require('node:fs');

(async () => {
  const FILE = '/tmp/proxy_dead.txt';
  // СВЕЖЕСТЬ СПИСКА (07.08). Скрипт молча читал файл любой давности и метил прокси мёртвыми. Файл
  // мог быть собран сутки назад или в момент, когда лежала сеть самого ноутбука, и тогда одна старая
  // выкладка выключала половину флота. Список старше 30 минут больше не считаем результатом проверки.
  const MAX_AGE_MIN = Number(process.env.PROXYFLAG_MAX_AGE_MIN || 30);
  let st;
  try { st = fs.statSync(FILE); } catch { console.log(`нет файла ${FILE} — нечего применять`); return; }
  const ageMin = (Date.now() - st.mtimeMs) / 60000;
  if (ageMin > MAX_AGE_MIN) {
    console.log(`ОТКАЗ: ${FILE} собран ${ageMin.toFixed(0)} мин назад (порог ${MAX_AGE_MIN}). `
      + 'Прогоните proxycheckpool.cjs заново: старый список это не проверка, а догадка.');
    process.exit(2);
  }
  const dead = fs.readFileSync(FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!dead.length) { console.log('мёртвых прокси нет'); return; }
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // МАССОВЫЙ ПРОВАЛ ЭТО НЕ ВЕРДИКТ. Если «мёртвыми» оказались больше половины живых акков, дело
  // почти всегда в нашей сети или в самом чекере, а не в прокси у каждого второго. Такое не
  // применяем без явного приказа: цена ошибки это выключенная ферма.
  const total = Number((await p.query(`SELECT count(*) n FROM accounts WHERE deleted_at IS NULL AND ig_proxy IS NOT NULL`)).rows[0].n) || 0;
  if (total && dead.length > total * 0.5 && !/^(1|true|yes)$/i.test(String(process.env.PROXYFLAG_FORCE || ''))) {
    console.log(`ОТКАЗ: в списке ${dead.length} из ${total} акков (>50%). Похоже, лежала наша сеть или чекер, `
      + 'а не прокси у каждого второго. Проверьте канал и прогоните заново, либо PROXYFLAG_FORCE=1.');
    await p.end(); process.exit(3);
  }
  const r = await p.query(
    `UPDATE accounts SET proxy_status='dead' WHERE slug = ANY($1) AND coalesce(proxy_status,'')<>'dead' RETURNING slug`, [dead]);
  console.log(`помечено proxy_status='dead': ${r.rowCount} (${r.rows.map((x) => x.slug).join(', ')})`);
  await p.end();
})().catch((e) => { console.log('ОШИБКА:', e.message); process.exit(1); });
