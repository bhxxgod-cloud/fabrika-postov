// hiddenscan.cjs — СКОЛЬКО НАШЕЙ ФЕРМЫ ВИДНО СНАРУЖИ (10.08).
//
// ЗАЧЕМ. Нашлось состояние, которого раньше не различали: ник существует, но профиль СПРЯТАН от
// анонима (ответ ровно {"status":"ok"} без ключа data). Такой аккаунт числился здоровым и уходил
// в работу, хотя его посты снаружи никто не видит. Восемь таких нашли на выборке, девятый вылез
// сразу же. Значит надо посчитать долю по ВСЕЙ ферме, а не гадать.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ПРЕДЫДУЩЕГО ПРОГОНА. Тот упёрся в лимиты: инстаграм душит датацентровые айпи
// после десятка запросов подряд. Здесь темп медленный: пауза между запросами и прокси по кругу.
//
// РЕШАЮЩЕЕ ПРАВИЛО: вердикт «спрятан» принимаем ТОЛЬКО при доказанно живом канале, иначе
// «спрятан» и «нас придушили» выглядят одинаково.
//
// ДОКАЗАТЕЛЬСТВО ЖИВОГО КАНАЛА БЕРЁМ ИЗ САМОГО ПРОГОНА, А НЕ ИЗ ЗАРАНЕЕ ВЫБРАННЫХ КОНТРОЛЬНЫХ
// (переделано 10.08 после первого же запуска). Что было: контрольными брались акки с
// опубликованными постами. Первый же контрольный, nails.by.sofia99, сам оказался СПРЯТАН — то есть
// контроль показывал «канал мёртв» там, где канал был жив, и все настоящие находки понижались до
// «непонятно». Именно так потерялся amara84898, про которого уже известно, что он спрятан.
// Урок: контроль нельзя выбирать по признаку «должен быть живым», его надо ДОКАЗЫВАТЬ в моменте.
// Теперь живым каналом считается тот, где хотя бы один из последних 10 ников ОТДАЛСЯ. Такие ники
// в прогоне идут постоянно, и они и есть честный контроль: они доказывают, что прокси пускают,
// ручка отвечает и данные приходят.
//
// Ничего не публикует, в аккаунты не логинится, в базу пишет только пометку о состоянии.
// Запуск: node hiddenscan.cjs [сколько ников] [пауза мс]
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();
const LIMIT = Number(process.argv[2] || 200);
const PAUSE = Number(process.argv[3] || 4000);
const UA = 'Instagram 269.0.0.18.75 Android';

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Прокси берём из файлов, что уже лежат на диске. Пароли никуда не печатаем.
function proxies() {
  const out = [];
  for (const f of ['/tmp/px/kz_magos_100.txt', '/tmp/px/kz_sous_100.txt']) {
    for (const l of safeRead(f).split('\n')) {
      const p = l.trim().split(':');
      if (p.length === 4) out.push(`http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`);
    }
  }
  return out;
}

// Один анонимный запрос. Возвращает РАЗЛИЧИМЫЕ исходы, а не «получилось/не получилось».
function ask(nick, proxy) {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '25',
    '-H', `User-Agent: ${UA}`, '-H', 'X-IG-App-ID: 936619743392459',
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(nick)}`];
  if (proxy) args.push('--proxy', proxy);
  const out = String(spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 22 }).stdout || '');
  const nl = out.lastIndexOf('\n');
  const code = Number(out.slice(nl + 1).trim());
  let j = null;
  try { j = JSON.parse(out.slice(0, nl)); } catch {}
  if (code === 404) return 'нет-ника';
  if (/wait a few minutes|rate limit|try again/i.test(out)) return 'лимит';
  if (j && j.data && j.data.user) return 'виден';
  if (j && j.data && Object.prototype.hasOwnProperty.call(j.data, 'user') && j.data.user === null) return 'нет-профиля';
  if (j && j.status === 'ok' && !Object.prototype.hasOwnProperty.call(j, 'data')) return 'спрятан';
  return 'непонятно';
}

(async () => {
  const px = proxies();
  if (!px.length) { console.log('прокси не нашёл, без них инстаграм душит сразу'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  // Берём тех, кем мы работаем: пролитые и рабочие, у кого есть ник.
  const rows = (await c.query(`
    SELECT ig_login h, coalesce(persona,'') persona, coalesce(health_state,'') hs
      FROM accounts
     WHERE deleted_at IS NULL AND coalesce(ig_login,'') <> ''
       AND coalesce(status,'') NOT IN ('deleted','archived')
     ORDER BY (persona <> '') DESC, ig_login LIMIT $1`, [LIMIT])).rows;
  console.log(`ников к проверке ${rows.length}, прокси ${px.length}, пауза ${PAUSE} мс`);
  console.log('живой канал доказывают сами отдавшиеся ники: «спрятан» принимается только там,');
  console.log('где хотя бы один из последних 10 ников отдался нормально\n');

  const res = { виден: [], спрятан: [], 'нет-профиля': [], 'нет-ника': [], непонятно: [], лимит: [] };
  let pi = 0;
  const last10 = [];                                     // окно последних исходов
  const каналЖив = () => last10.includes('виден');
  const отложенные = [];                                 // «спрятан» при недоказанном канале
  for (const [i, a] of rows.entries()) {
    let v = ask(a.h, px[pi++ % px.length]);
    if (v === 'лимит' || v === 'непонятно') {           // одна вторая попытка с другого прокси
      await sleep(PAUSE);
      v = ask(a.h, px[pi++ % px.length]);
    }
    // Вердикт «спрятан» принимаем только при доказанно живом канале. Если канал не доказан,
    // ник НЕ теряем, а откладываем на второй проход, когда канал оживёт.
    if (v === 'спрятан' && !каналЖив() && i >= 10) { отложенные.push(a); v = 'непонятно'; }
    last10.push(v);
    if (last10.length > 10) last10.shift();
    res[v] = res[v] || [];
    res[v].push(a.h);
    const mark = v === 'виден' ? '🟢' : v === 'спрятан' ? '🙈' : v === 'нет-ника' ? '❌' : '·';
    console.log(`${String(i + 1).padStart(3)} ${mark} ${a.h.padEnd(24)} ${v}${a.persona ? ' · ' + a.persona : ''}`);
    await sleep(PAUSE);
  }

  // Второй проход по отложенным: те, кого некому было подтвердить с первого раза.
  if (отложенные.length) {
    console.log(`\nвторой проход по отложенным (${отложенные.length}): канал к этому моменту доказан`);
    for (const a of отложенные) {
      const v = ask(a.h, px[pi++ % px.length]);
      const idx = res['непонятно'].indexOf(a.h);
      if (v === 'спрятан' && каналЖив()) {
        if (idx >= 0) res['непонятно'].splice(idx, 1);
        res['спрятан'].push(a.h);
        console.log(`  🙈 ${a.h}: спрятан (подтверждено на втором проходе)`);
      } else {
        console.log(`  · ${a.h}: ${v}`);
        if (v === 'виден') { if (idx >= 0) res['непонятно'].splice(idx, 1); res['виден'].push(a.h); last10.push('виден'); }
      }
      await sleep(PAUSE);
    }
  }

  console.log('\n═══ ИТОГ ═══');
  const total = rows.length;
  for (const k of ['виден', 'спрятан', 'нет-профиля', 'нет-ника', 'непонятно', 'лимит']) {
    const n = (res[k] || []).length;
    if (n) console.log(`  ${k.padEnd(12)} ${String(n).padStart(3)}  (${Math.round((n / total) * 100)}%)`);
  }
  if ((res['спрятан'] || []).length) {
    console.log(`\nСПРЯТАННЫЕ (${res['спрятан'].length}): ${res['спрятан'].join(' ')}`);
    fs.writeFileSync('/tmp/hidden_nicks.txt', res['спрятан'].join('\n') + '\n');
    console.log('список лёг в /tmp/hidden_nicks.txt — по нему идёт чек входом');
  }
  await c.end().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', String(e.message).slice(0, 140)); process.exit(1); });
