'use strict';
// СВЕРКА: ЧТО МЫ СЧИТАЕМ ОПУБЛИКОВАННЫМ ПРОТИВ ТОГО, ЧТО ЖИВО НА ЮТУБЕ (26.08.2026).
//
// ЗАЧЕМ. Ветка фермы телефонов поймала у себя случаи, когда журнал пишет успех, а поста в ленте
// нет, и наоборот. У нас в базе стоит status='posted', и до сегодня никто не проверял, жив ли
// ролик на самом деле. При приостановке канала или тихом сносе ролика база продолжает
// рапортовать успех, и увидеть это негде.
//
// ПОЧЕМУ ПОИМЁННО, А НЕ ПО СЧЁТЧИКУ. Счётчик videoCount врёт в обе стороны: на старых каналах
// лежат ролики, залитые до нашей системы (у Нейронки Про 101 против наших 44), и разница там не
// пропажа. Поэтому спрашиваем ютуб про КОНКРЕТНЫЕ наши video_id: что не вернулось в ответе, то
// удалено или скрыто. Это ловит именно нашу потерю, а не чужие остатки.
//
// ЦЕНА: videos.list берёт до 50 id за один запрос ценой 1 единица квоты. На 300 роликов это
// 6 единиц, то есть даром.
//
// НЕ ЧИНИТ САМА, намеренно: расхождение это повод посмотреть глазами. Автоматически переоткрыть
// задачу, ролик которой на самом деле жив, значит получить дубль на живом канале.
//
// Запуск: node сверка.cjs            все каналы
//         node сверка.cjs pokazhu    один канал
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const API = 'https://www.googleapis.com/youtube/v3';

async function токен(ch) {
  const p = new URLSearchParams({ client_id: ch.client_id, client_secret: ch.client_secret, refresh_token: ch.refresh_token, grant_type: 'refresh_token' });
  const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: p }).then((x) => x.json());
  if (!t.access_token) throw new Error('токен не вышел');
  return t.access_token;
}
(async () => {
  const только = process.argv[2];
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows: каналы } = await c.query(`SELECT id, slug, title, client_id, client_secret, refresh_token, enabled
    FROM yt_channels WHERE platform='youtube' AND title IS NOT NULL ${только ? 'AND slug=$1' : ''} ORDER BY id`, только ? [только] : []);
  const итог = [];
  for (const ch of каналы) {
    const { rows: наши } = await c.query(
      // Ролики, снятые самим владельцем, из сверки исключаем: они пропали не по вине площадки,
      // и без этой отсечки сверка вечно рапортовала бы ложную пропажу.
      `SELECT video_id FROM yt_queue WHERE channel_id=$1 AND status='posted' AND video_id IS NOT NULL AND video_id <> 'dry'
         AND coalesce(error,'') NOT LIKE '%сверке игнорировать%'`, [ch.id]);
    const ids = наши.map((x) => x.video_id);
    if (!ids.length) { итог.push({ канал: ch.title, наших: 0, живых: 0, пропало: 0, примечание: 'нечего сверять' }); continue; }
    let живые = new Set(), примечание = '';
    try {
      const a = await токен(ch);
      for (let i = 0; i < ids.length; i += 50) {
        const кусок = ids.slice(i, i + 50);
        const r = await fetch(`${API}/videos?part=id&id=${кусок.join(',')}`, { headers: { Authorization: 'Bearer ' + a } });
        const j = await r.json();
        if (j.error) { примечание = (j.error.message || '').slice(0, 60); break; }
        for (const it of j.items || []) живые.add(it.id);
      }
    } catch (e) { примечание = e.message.slice(0, 60); }
    const пропало = примечание ? null : ids.filter((x) => !живые.has(x));
    итог.push({ канал: ch.title, вкл: ch.enabled, наших: ids.length, живых: примечание ? null : живые.size,
      пропало: пропало ? пропало.length : null, примечание, список: пропало && пропало.length ? пропало.slice(0, 5) : null });
  }
  await c.end();

  console.log('СВЕРКА ' + new Date().toLocaleString('ru-RU') + '\n');
  for (const x of итог) {
    const метка = x.примечание ? 'НЕ СВЕРИТЬ' : (x.пропало ? 'ПРОПАЖА   ' : 'сходится  ');
    console.log(metka(метка) + x.канал.slice(0, 30).padEnd(32) + 'у нас ' + String(x.наших).padEnd(4) +
      (x.примечание ? '| ' + x.примечание : '| живо ' + x.живых + (x.пропало ? ' | ПРОПАЛО ' + x.пропало + ': ' + (x.список || []).join(', ') : '')));
  }
  function metka(s) { return s + ' '; }
  const беда = итог.filter((x) => x.пропало || x.примечание);
  console.log('\n' + (беда.length ? 'требует глаз: ' + беда.length + ' канал(ов)' : 'все каналы сошлись, потерь нет'));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
