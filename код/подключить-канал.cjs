'use strict';
// ПОДКЛЮЧЕНИЕ КАНАЛА БЕЗ ОБЩЕГО ДОМЕНА (27.08.2026).
//
// ЗАЧЕМ. Раньше все каналы авторизовались через ОДИН Google-проект и возвращались на ОДИН адрес
// (наш Railway). Для Google это прямая связь между «независимыми» каналами: одно приложение, одна
// квота, один обратный адрес. Пять каналов уже снесли 26.08 за скоординированность, и повторять
// эту схему на новых каналах нельзя.
//
// РЕШЕНИЕ. OAuth-клиент типа «Десктопное приложение»: обратный адрес там http://127.0.0.1 на этой
// машине, общего домена нет вообще. Скрипт поднимает локальный приёмник, ловит код, меняет его на
// refresh_token и кладёт в базу. Наружу не выходит ничего, кроме самого обмена с Google.
//
// Запуск: node подключить-канал.cjs <slug> <client_id> <client_secret>
const http = require('node:http');
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl';

const [slug, clientId, clientSecret] = process.argv.slice(2);
if (!slug || !clientId || !clientSecret) {
  console.log('нужно: node подключить-канал.cjs <slug> <client_id> <client_secret>');
  process.exit(1);
}
const ПОРТ = Number(process.env.OAUTH_PORT || 8731);
const redirect = 'http://127.0.0.1:' + ПОРТ;

const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES,
  access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
});

console.log('\n1) Открой эту ссылку В ПРОФИЛЕ GOLOGIN под аккаунтом нового канала:\n');
console.log(url + '\n');
console.log('2) Пройди экран согласия (на «Google hasn\'t verified this app» жми Advanced и ссылку внизу).');
console.log('3) Браузер вернётся на ' + redirect + ' — это нормально, страницу закроешь сам.\n');
console.log('жду код...');

const сервер = http.createServer(async (req, res) => {
  const у = new URL(req.url, redirect);
  const code = у.searchParams.get('code');
  const err = у.searchParams.get('error');
  if (!code && !err) { res.writeHead(204).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<h2 style="font-family:system-ui">' + (code ? 'Готово, можно закрыть вкладку.' : 'Отказано: ' + err) + '</h2>');
  if (err) { console.log('отказ:', err); процесс(1); return; }
  try {
    const t = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
    }).then((x) => x.json());
    if (!t.refresh_token) throw new Error('Google не дал refresh_token: ' + JSON.stringify(t).slice(0, 200));
    // кто это вообще: подтверждаем, что подключили именно тот канал
    const me = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: 'Bearer ' + t.access_token },
    }).then((x) => x.json());
    const имя = me.items?.[0]?.snippet?.title || '(имя не отдалось)';
    const chId = me.items?.[0]?.id || null;

    const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(
      `UPDATE yt_channels SET client_id=$2, client_secret=$3, refresh_token=$4, channel_id=coalesce($5, channel_id),
         name=coalesce(nullif(name,''), $6), title=coalesce(nullif(title,''), $6), connected_at=now(), updated_at=now()
       WHERE slug=$1 RETURNING id, slug, name, channel_id, enabled, per_day, post_hours, post_minute`,
      [slug, clientId, clientSecret, t.refresh_token, chId, имя]);
    await c.end();
    if (!r.rowCount) throw new Error('в базе нет канала со слагом ' + slug);
    console.log('\n✓ подключён канал: ' + имя + ' (' + (chId || 'id не отдался') + ')');
    console.table(r.rows);
    console.log('включить постинг: node -e "..." или через панель. Пока канал выключен, это намеренно.');
    процесс(0);
  } catch (e) { console.error('ERR', e.message); процесс(1); }
});
function процесс(код) { setTimeout(() => { сервер.close(); process.exit(код); }, 300); }
сервер.listen(ПОРТ, '127.0.0.1');
