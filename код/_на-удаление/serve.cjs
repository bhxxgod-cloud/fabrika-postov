// Локальная раздача роликов для постера. Нужна потому, что igpost2 берёт видео ПО ССЫЛКЕ
// (media_url), а ролики из фабрики лежат на диске у владельца. Постинг идёт с этого же мака,
// поэтому 127.0.0.1 постеру виден. Раздаём ровно одну папку и только .mp4, ничего больше.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.argv[2] || '/tmp/serve';
const PORT = Number(process.argv[3]) || 8917;

http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent((req.url || '').split('?')[0]));
  const file = path.join(DIR, name);
  if (!name.endsWith('.mp4') || !fs.existsSync(file)) { res.writeHead(404); res.end('нет файла'); return; }
  const size = fs.statSync(file).size;
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
  console.log(`отдан ${name} (${(size / 1048576).toFixed(1)} МБ)`);
}).listen(PORT, '127.0.0.1', () => console.log(`раздаю ${DIR} на http://127.0.0.1:${PORT}/`));
