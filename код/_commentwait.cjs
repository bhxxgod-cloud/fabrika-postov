'use strict';
// ЗАКРЕПЛЁННЫЙ КОММЕНТАРИЙ: ЧАСТЬ ПЕРВАЯ, НАПИСАТЬ. Ждёт возврата квоты и постит комментарий от
// имени канала на каждый ролик ручного залива 25.08.
//
// ПОЧЕМУ ТОЛЬКО НАПИСАТЬ. YouTube Data API v3 НЕ УМЕЕТ ЗАКРЕПЛЯТЬ комментарии: в дискавери-схеме
// есть commentThreads.insert/list, comments.insert/update/delete/setModerationStatus и ни одного
// метода pin. Закрепление живёт только в веб-интерфейсе, поэтому вторым шагом идёт браузер.
const fs = require('fs'), os = require('os');
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const КОММ = JSON.parse(fs.readFileSync(os.homedir() + '/Desktop/ЮТУБ/ручной-залив-25-08/комментарии.json', 'utf8'));
const пауза = (мс) => new Promise((r) => setTimeout(r, мс));
const лог = (s) => console.log('[' + new Date().toLocaleTimeString('ru-RU') + '] ' + s);

async function токен(ch) {
  const p = new URLSearchParams({ client_id: ch.client_id, client_secret: ch.client_secret, refresh_token: ch.refresh_token, grant_type: 'refresh_token' });
  const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: p }).then((x) => x.json());
  if (!t.access_token) throw new Error('токен: ' + JSON.stringify(t).slice(0, 120));
  return t.access_token;
}
async function написать(ch, videoId, текст) {
  const a = await токен(ch);
  const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST', headers: { Authorization: 'Bearer ' + a, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: текст } } } }),
  });
  if (r.ok) { const j = await r.json(); return { ok: true, id: j.id }; }
  const t = await r.text();
  return { ok: false, статус: r.status, квота: /exceeded your/i.test(t), текст: t.slice(0, 160) };
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query("SELECT slug, client_id, client_secret, refresh_token FROM yt_channels WHERE platform='youtube' AND enabled");
  await c.end();
  const по = Object.fromEntries(rows.map((r) => [r.slug, r]));
  const очередь = КОММ.filter((x) => по[x.slug]);
  лог('комментариев к постингу: ' + очередь.length);

  const сделано = [];
  for (let круг = 0; круг < 200 && очередь.length; круг++) {
    const x = очередь[0];
    const r = await написать(по[x.slug], x.video_id, x.комментарий).catch((e) => ({ ok: false, текст: e.message, квота: false }));
    if (!r.ok && r.квота) { лог('квота ещё не вернулась, жду 15 минут (осталось ' + очередь.length + ')'); await пауза(900000); continue; }
    if (r.ok) { лог('✓ ' + x.slug + ' ' + x.video_id + ' → ' + r.id); сделано.push({ ...x, comment_id: r.id }); }
    else лог('✗ ' + x.slug + ': ' + r.статус + ' ' + r.текст);
    очередь.shift();
    await пауза(2000);
  }
  fs.writeFileSync(os.homedir() + '/Desktop/ЮТУБ/ручной-залив-25-08/комментарии-поставлены.json', JSON.stringify(сделано, null, 1));
  лог('написано: ' + сделано.length + '. ЗАКРЕПИТЬ надо через браузер, API этого не умеет.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
