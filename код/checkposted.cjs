// ПРОВЕРКА ПРОЛИТЫХ АККОВ СНАРУЖИ (09.08, приказ начальника: «как проверить запощенные акки, там
// почти все уебало, займись»).
//
// ПРИНЦИП: НЕ ЗАХОДИМ В АККИ. Смотрим профиль так, как его видит любой прохожий, анонимным
// запросом к публичной ручке профиля. Ноль риска: ни входа, ни сессии, ни действий. Заодно это и
// есть правда: если анонимный зритель поста не видит, значит поста для мира нет.
//
// ЧТО ОТВЕЧАЕТ:
//   • есть ли профиль вообще (404 значит акк снесён или переименован);
//   • сколько публикаций видно (ноль значит залив не дошёл, хотя магос считал успехом);
//   • приватный или открытый, сколько подписчиков, есть ли ава;
//   • СПРЯТАН ЛИ ПРОФИЛЬ (10.08): ник занят, но анониму профиль не отдаётся. Это ни «жив», ни
//     «нет профиля», ни наш сбой — отдельный исход, по нему идёт чек ВХОДОМ. Ставится только
//     после подтверждения с нескольких РАЗНЫХ прокси и пишется в accounts.health_state='hidden';
//   • 401 и 403 в вердикт про акк не идут вообще: это лимит нашего айпи или логин-стена.
//
// Прокси берём из нашего пула (проверенные живые), чтобы инстаграм не резал по одному IP.
// Запуск: node checkposted.cjs <файл-со-списком-ников>
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const igp = require('./igprofile.cjs');          // общий разбор ответа IG + подтверждение вердикта

const FILE = process.argv[2];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const UA = 'Instagram 219.0.0.12.117 Android';   // короткий мобильный UA: публичная ручка отдаёт json
// Подтверждение «спрятан»: попыток и сколько РАЗНЫХ каналов должны сойтись (минимум два).
const HID_TRIES = Math.max(2, Number(process.env.CHECKPOSTED_HIDDEN_TRIES) || 4);
const HID_CONFIRM = Math.max(2, Number(process.env.CHECKPOSTED_HIDDEN_CONFIRM) || 2);

// Разбор ответа и правило вердикта — в igprofile.cjs, одни на весь проект. СПРЯТАН (10.08):
// ответ ровно {"status":"ok"} БЕЗ ключа data. Ник существует, профиль скрыт от анонима. Раньше
// такой ответ уходил в «не прочитал (код 200)», то есть выглядел как наш сбой связи, хотя это
// факт про акк. Ставим его только после подтверждения с РАЗНЫХ прокси: с одного айпи «спрятан»
// и «нас придушили лимитом» неотличимы, а 401 «Please wait a few minutes» не в счёт вообще.
function profile(nick, proxy) {
  const r = igp.ask(nick, proxy, { ua: UA });
  const u = r.user;
  return {
    code: r.code,
    kind: r.kind,
    спрятан: r.kind === 'спрятан',
    есть: r.kind === 'виден',
    постов: u ? (u.edge_owner_to_timeline_media || {}).count : null,
    подписчиков: u ? (u.edge_followed_by || {}).count : null,
    приватный: u ? u.is_private : null,
    ава: u ? !!u.profile_pic_url : null,
    имя: u ? (u.full_name || '') : '',
  };
}

(async () => {
  if (!FILE || !fs.existsSync(FILE)) { console.log('usage: node checkposted.cjs <файл-со-списком>'); process.exit(1); }
  const nicks = fs.readFileSync(FILE, 'utf8').split('\n').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  // Каналы: запас из proxy_pool ПЛЮС общий список (файлы /tmp/px, env IG_PROBE_PROXIES). Читать со
  // своего айпи бессмысленно: Instagram душит его после сотни анонимных запросов, и тогда весь
  // прогон превращается в «не прочитал», а спрятанные акки остаются невидимыми.
  const pool = (await c.query(`SELECT proxy FROM proxy_pool WHERE status IN ('spare','reserve_uk') LIMIT 40`)).rows.map((x) => x.proxy);
  const px = igp.proxies(pool);
  console.log(`проверяю ников: ${nicks.length}, каналов (прокси): ${px.length}\n`);

  const днём = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const rows = [];
  for (const [i, n] of nicks.entries()) {
    let r = profile(n, px.length ? px[i % px.length] : null);
    // Одна повторная попытка через другой прокси: резидентки иногда просто не отвечают.
    if (r.kind === 'сбой' && px.length > 1) r = profile(n, px[(i + 7) % px.length]);
    // Ни «виден», ни честная 404 — вердикта пока НЕТ. Переспрашиваем с разных каналов: и «спрятан»,
    // и лимит нашего айпи выглядят с одного адреса одинаково, а спутать их — значит либо повесить
    // метку на живой акк, либо (как раньше) не увидеть спрятанный вообще.
    let v = null;
    if (r.kind !== 'виден' && r.kind !== 'нет-ника' && px.length) {
      v = await igp.probe(n, { proxies: px, ua: UA, tries: HID_TRIES, minConfirm: HID_CONFIRM, allowDirect: false });
      if (v.kind === 'виден') r = profile(n, v.egress);
    }
    const вид = v && v.kind !== 'виден' ? v.kind : r.kind;   // итоговый исход после переспроса
    const спрятанПодтверждён = вид === 'спрятан';            // probe отдаёт «спрятан» только подтверждённым
    let вердикт;
    if (r.есть && r.постов > 0) вердикт = 'ЖИВ, посты видны';
    else if (r.есть && r.постов === 0) вердикт = 'жив, но постов НЕТ';
    else if (вид === 'нет-ника') вердикт = 'НЕТ ПРОФИЛЯ (снесён или переименован)';
    else if (вид === 'нет-профиля') вердикт = 'НЕТ ПРОФИЛЯ (снесён или забанен)';
    else if (спрятанПодтверждён) вердикт = `СПРЯТАН снаружи (ник есть, профиль скрыт, ${v.why}) — нужен чек входом`;
    else if (вид === 'без-вердикта' && v.leaning === 'спрятан') вердикт = `похоже, спрятан, но подтверждения нет (${v.why})`;
    else if (v) вердикт = `не прочитал: ${v.why}`;
    else вердикт = r.code === 401 || r.code === 403
      ? 'не прочитал: лимит нашего IP или логин-стена (это не про акк)'
      : `не прочитал (код ${r.code})`;
    rows.push({ ник: n, вердикт, постов: r.постов, подписчиков: r.подписчиков, приват: r.приватный, ава: r.ава });
    console.log(`  ${String(i + 1).padStart(2)} ${n.padEnd(22)} ${вердикт}${r.постов != null ? `, постов ${r.постов}` : ''}`);
    // Метим состояние в базе, чтобы это не пропало вместе с логом. Отдельным словом в health_state
    // помечаем ТОЛЬКО подтверждённого спрятанного: иначе наш же лимит станет меткой на живом акке.
    // PROTECTED-состояния (в т.ч. замок автосноса 'keep') не перетираем никогда.
    await c.query(
      `UPDATE accounts SET health_note = $2, health_checked_at = now(),
         health_state = CASE WHEN $3::boolean AND coalesce(health_state,'') <> ALL($4::text[]) THEN 'hidden' ELSE health_state END
        WHERE slug = $1 OR ig_login = $1`,
      [n, `внешняя проверка ${днём}: ${вердикт}`, спрятанПодтверждён, igp.PROTECTED]).catch(() => {});
  }
  await c.end().catch(() => {});
  console.log('\nСВОДКА:');
  const by = {};
  for (const r of rows) by[r.вердикт] = (by[r.вердикт] || 0) + 1;
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${v} × ${k}`);
  fs.writeFileSync('/tmp/checkposted.json', JSON.stringify(rows, null, 1));
  console.log('\nподробности: /tmp/checkposted.json');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
