'use strict';
// ОБМЕН КОДА НА ТОКЕН ВРУЧНУЮ (27.08.2026).
//
// ЗАЧЕМ. Браузер Orbita в GoLogin блокирует локальные адреса (ERR_BLOCKED_BY_CLIENT), поэтому
// возврат на 127.0.0.1 до нашего приёмника не доходит. Но Google к этому моменту УЖЕ выдал код,
// и он виден в адресной строке. Берём его оттуда и меняем на refresh_token сами.
//
// Запуск: node обменять-код.cjs <slug> <client_id> <client_secret> "<code или весь URL>"
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const [slug, clientId, clientSecret, сырое] = process.argv.slice(2);
if (!slug || !clientId || !clientSecret || !сырое) {
  console.log('нужно: node обменять-код.cjs <slug> <client_id> <client_secret> "<code или URL>"');
  process.exit(1);
}
// принимаем и голый код, и целый адрес из строки браузера
const code = (() => {
  const s = String(сырое);
  const m = s.match(/[?&]code=([^&\s]+)/);
  return decodeURIComponent(m ? m[1] : s.trim());
})();
// порт берём из самого адреса: у каждого канала он свой, чтобы проекты не сходились в одну точку
const порт = (() => {
  const m = String(сырое).match(/^(https?:\/\/127\.0\.0\.1:\d+)/);
  return m ? m[1] : 'http://127.0.0.1:8731';
})();
(async () => {
  const t = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: порт, grant_type: 'authorization_code' }),
  }).then((x) => x.json());
  if (!t.refresh_token) throw new Error('Google не дал refresh_token: ' + JSON.stringify(t).slice(0, 240));
  const me = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: 'Bearer ' + t.access_token },
  }).then((x) => x.json());
  const имя = me.items?.[0]?.snippet?.title || '(имя не отдалось)';
  const chId = me.items?.[0]?.id || null;
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(
    `UPDATE yt_channels SET client_id=$2, client_secret=$3, refresh_token=$4, channel_id=coalesce($5, channel_id),
       name=$6, title=$6, connected_at=now(), updated_at=now()
     WHERE slug=$1 RETURNING id, slug, name, channel_id, enabled, per_day, post_hours, post_minute`,
    [slug, clientId, clientSecret, t.refresh_token, chId, имя]);
  await c.end();
  if (!r.rowCount) throw new Error('в базе нет канала со слагом ' + slug);
  console.log('✓ подключён: ' + имя + ' (' + (chId || 'id не отдался') + ')');
  console.table(r.rows);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
