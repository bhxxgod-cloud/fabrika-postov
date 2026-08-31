// scanpub.cjs — ПРИЦЕЛЬНАЯ ПРОВЕРКА АККОВ, НА КОТОРЫХ ЛЕЖАТ НАШИ ПУБЛИКАЦИИ (10.08).
//
// ЗАЧЕМ. Из 234 наших акков посты опубликованы всего у ДЕВЯТИ, и на них лежат все 57 публикаций.
// Если такой акк спрятан от анонима, значит оплаченный контент лежит невидимым, и это дороже
// любого другого состояния фермы. Широкий скан (hiddenscan.cjs) на этот вопрос не отвечает: он
// проверяет всех подряд, по одной попытке, и на девятке даёт слишком слабое основание.
//
// ЧЕМ ОТЛИЧАЕТСЯ. По ПЯТЬ попыток на ник с разных прокси, вердикт по большинству ОТВЕТИВШИХ
// попыток («сбой» в счёт не идёт: он про наш доступ, а не про акк).
//
// ГЛАВНОЕ ПРАВИЛО, БЕЗ КОТОРОГО ВЫВОД ПУСТОЙ. В прогоне обязан быть КОНТРОЛЬ, доказанный в
// моменте: хотя бы один ник, который ОТДАЛСЯ. Иначе «спрятан» и «нас душат лимитом» неотличимы.
// Проверено на своей же шкуре 10.08: сразу после широкого скана все пять попыток по каждому нику
// вернули сбой, потому что прокси были выжжены. Такой прогон не даёт вердикта вообще, и честно
// сказать «вердикта нет» правильнее, чем выдать спрятанность за факт.
//
// ПОЭТОМУ: если ни один ник в прогоне не отдался, скрипт НЕ печатает вердикты, а говорит, что
// канал мёртв и надо подождать. Дальше он сам ждёт и пробует ещё раз, до трёх кругов.
//
// Ничего не публикует, в акки не логинится, в базу не пишет.
// Запуск: node scanpub.cjs [попыток на ник] [пауза мс]
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { classify } = require('./igprofile.cjs');

const DBURL = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();
const TRIES = Number(process.argv[2] || 5);
const PAUSE = Number(process.argv[3] || 3500);
const КРУГОВ = 3;
const ОТДЫХ = 15 * 60 * 1000;   // сколько ждать, если канал выжжен

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function proxies() {
  const out = [];
  for (const f of ['/tmp/px/kz_magos_100.txt', '/tmp/px/kz_sous_100.txt']) {
    for (const l of safeRead(f).split('\n')) {
      const p = l.trim().split(':');
      if (p.length === 4) out.push(p);
    }
  }
  return out;
}

function ask(nick, p) {
  const a = ['-s', '-w', '\n%{http_code}', '--max-time', '25',
    '-H', 'User-Agent: Instagram 269.0.0.18.75 Android', '-H', 'X-IG-App-ID: 936619743392459',
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(nick)}`,
    '--proxy', `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`];
  const o = String(spawnSync('curl', a, { encoding: 'utf8', maxBuffer: 1 << 22 }).stdout || '');
  const nl = o.lastIndexOf('\n');
  return classify(o.slice(0, nl), Number(o.slice(nl + 1).trim())).kind;
}

(async () => {
  const px = proxies();
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  const rows = (await c.query(`
    SELECT a.ig_login h, coalesce(a.persona,'') persona, count(*) pub
      FROM accounts a JOIN posts p ON p.account_id = a.id AND p.published_at IS NOT NULL
     WHERE a.deleted_at IS NULL GROUP BY 1,2 ORDER BY pub DESC`)).rows;
  await c.end().catch(() => {});
  console.log(`акков с публикациями: ${rows.length}, всего публикаций ${rows.reduce((s, x) => s + Number(x.pub), 0)}`);
  console.log(`попыток на ник ${TRIES}, прокси ${px.length}\n`);

  for (let круг = 1; круг <= КРУГОВ; круг++) {
    let k = круг * 17;
    const итог = [];
    for (const a of rows) {
      const out = [];
      for (let i = 0; i < TRIES; i++) { out.push(ask(a.h, px[(k++ * 7 + i * 13) % px.length])); await sleep(PAUSE); }
      const ответили = out.filter((v) => v !== 'сбой');
      const счёт = {};
      ответили.forEach((v) => { счёт[v] = (счёт[v] || 0) + 1; });
      const верх = Object.entries(счёт).sort((x, y) => y[1] - x[1])[0];
      итог.push({ h: a.h, pub: a.pub, persona: a.persona, kind: верх ? верх[0] : null, из: ответили.length, out });
      console.log(`${a.h.padEnd(20)} публикаций ${String(a.pub).padStart(2)} · `
        + `${верх ? `${верх[0]} (${верх[1]} из ${ответили.length})` : 'вердикта нет: все попытки сбой'}`
        + `  [${out.join(', ')}]`);
    }
    const каналЖив = итог.some((x) => x.kind === 'виден');
    if (!каналЖив) {
      console.log(`\n⚠ КРУГ ${круг} НЕГОДЕН: ни один акк не отдался, значит прокси выжжены лимитом.`);
      console.log('  Вердикты не печатаю: «спрятан» и «нас душат» в таком прогоне неотличимы.');
      if (круг < КРУГОВ) { console.log(`  Жду ${ОТДЫХ / 60000} минут и пробую снова.\n`); await sleep(ОТДЫХ); continue; }
      console.log('  Круги кончились. Нужен другой пул прокси или пауза подольше.');
      process.exit(2);
    }
    const виден = итог.filter((x) => x.kind === 'виден');
    const спрятан = итог.filter((x) => x.kind === 'спрятан');
    const нет = итог.filter((x) => !x.kind || (x.kind !== 'виден' && x.kind !== 'спрятан'));
    console.log(`\n═══ ИТОГ (круг ${круг}, канал доказан: ${виден.length} акков отдались) ═══`);
    console.log(`  видны        ${виден.length} акков, публикаций ${виден.reduce((s, x) => s + Number(x.pub), 0)}`);
    console.log(`  СПРЯТАНЫ     ${спрятан.length} акков, публикаций ${спрятан.reduce((s, x) => s + Number(x.pub), 0)}`
      + (спрятан.length ? ` → ${спрятан.map((x) => x.h).join(' ')}` : ''));
    if (нет.length) console.log(`  без вердикта ${нет.length}: ${нет.map((x) => x.h).join(' ')}`);
    if (спрятан.length) {
      fs.writeFileSync('/tmp/hidden_pub_nicks.txt', спрятан.map((x) => x.h).join('\n') + '\n');
      console.log('\nсписок спрятанных с публикациями лёг в /tmp/hidden_pub_nicks.txt');
      console.log('это оплаченный контент, которого снаружи не видно: чек входом в первую очередь по ним');
    }
    process.exit(0);
  }
})().catch((e) => { console.error('ОШИБКА:', String(e.message).slice(0, 140)); process.exit(1); });
