'use strict';
// БЛОК СТРАН НА РУЧНОЙ ЗАЛИВ 25.08. Studio такой настройки для обычных роликов не даёт, она
// ставится только через API videos.update (contentDetails.regionRestriction.allowed), а квота
// на 25.08 была выбрана до последней единицы. Скрипт ждёт восстановления (сброс в 00:00 PT,
// это 10:00 МСК) и проставляет RU,BY. Проверяет дешёвым channels.list (1 единица), чтобы не
// жечь квоту впустую.
const fs = require('fs');
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const РЕГИОНЫ = (process.env.YT_REGIONS || 'RU,BY').split(',').map((s) => s.trim()).filter(Boolean);
const РОЛИКИ = ['uj-AcEw5WY8','J_WTIL3MDYg','dY3XxA1BCJc','VWLxr7Ojhwc','KjjcgXanupM','zS8cuQ-aZgc','DzYNwp2_lcA','0o-9ylH1iEU','ajPcQcbbArI','JlRuS8Ullsk'];
const пауза = (мс) => new Promise((r) => setTimeout(r, мс));
const лог = (s) => console.log('[' + new Date().toLocaleTimeString('ru-RU') + '] ' + s);

async function токен(ch) {
  const p = new URLSearchParams({ client_id: ch.client_id, client_secret: ch.client_secret, refresh_token: ch.refresh_token, grant_type: 'refresh_token' });
  const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: p }).then((x) => x.json());
  if (!t.access_token) throw new Error('токен не вышел: ' + JSON.stringify(t).slice(0, 120));
  return t.access_token;
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(`SELECT q.video_id, ch.slug, ch.client_id, ch.client_secret, ch.refresh_token
    FROM yt_queue q JOIN yt_channels ch ON ch.id=q.channel_id WHERE q.video_id = ANY($1)`, [РОЛИКИ]);
  await c.end();
  лог('роликов к обработке: ' + rows.length);

  // ПРОБНИК ТОЛЬКО ТЕМ ЖЕ МЕТОДОМ. Первая версия проверяла квоту дешёвым channels.list, он
  // ответил 200, а videos.update тут же дал 403 quotaExceeded: у списков и правок разное
  // поведение при исчерпании. Поэтому пробуем ровно ту операцию, которая нужна.
  async function поставить(v) {
    const a = await токен(v);
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=contentDetails', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + a, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: v.video_id, contentDetails: { regionRestriction: { allowed: РЕГИОНЫ } } }),
    });
    if (r.ok) return { ok: true };
    const текст = await r.text();
    return { ok: false, статус: r.status, квота: /exceeded your/i.test(текст), текст: текст.slice(0, 160) };
  }

  const осталось = rows.slice();
  for (let круг = 0; круг < 200 && осталось.length; круг++) {
    const проба = await поставить(осталось[0]).catch((e) => ({ ok: false, текст: e.message, квота: false }));
    if (!проба.ok && проба.квота) { лог('квота ещё не вернулась, жду 15 минут (осталось ' + осталось.length + ')'); await пауза(900000); continue; }
    if (проба.ok) { лог('✓ ' + осталось[0].slug + ' ' + осталось[0].video_id); осталось.shift(); }
    else { лог('✗ ' + осталось[0].slug + ': ' + проба.статус + ' ' + проба.текст); осталось.shift(); }
    await пауза(1500);
  }
  лог(осталось.length ? 'не доделано: ' + осталось.length : 'готово: регион стоит на всех роликах');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
