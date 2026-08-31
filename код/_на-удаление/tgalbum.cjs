// tgalbum.cjs — ОТПРАВКА ЛОКАЛЬНЫХ КАРТИНОК АЛЬБОМОМ В ЧАТ (10.08).
//
// ЗАЧЕМ. tgchat.cjs send умеет только текст, а tgreview.cjs собирает пост из базы по его id.
// Регулярно нужно третье: показать начальнику ПАПКУ готовых файлов, которых в базе ещё нет
// (тикточные карусели, контактные листы, до и после правки). Это оно.
//
// Файлы шлём ФАЙЛАМИ, а не ссылками: телеграм на ссылки к нашему хранилищу отвечал
// WEBPAGE_CURL_FAILED, это уже проверено 09.08.
//
// Запуск: node tgalbum.cjs "подпись к альбому" файл1.jpg файл2.jpg ...
//         node tgalbum.cjs --chat <id> "подпись" файлы...
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = (process.env.TG_BRIDGE_TOKEN || safeRead('/tmp/.tgtok2') || safeRead('/tmp/.tgtok')).trim();
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

let a = process.argv.slice(2);
let chat = (process.env.REVIEW_CHAT || '-5502363795').trim();
if (a[0] === '--chat') { chat = a[1]; a = a.slice(2); }
const caption = a[0] || '';
const files = a.slice(1).filter((f) => fs.existsSync(f));

(async () => {
  if (!TOKEN) { console.error('нет токена бота'); process.exit(1); }
  if (!files.length) { console.error('нет ни одного существующего файла'); process.exit(1); }

  // ТИП МЕДИА ОПРЕДЕЛЯЕМ ПО РАСШИРЕНИЮ. Телеграм не даёт смешивать музыку с картинками в одном
  // альбоме, поэтому если пришло и то и то — честно падаем, а не отправляем половину молча.
  const isAudio = (f) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f);
  const isVideo = (f) => /\.(mp4|mov|webm)$/i.test(f);
  const kinds = new Set(files.map((f) => (isAudio(f) ? 'audio' : isVideo(f) ? 'video' : 'photo')));
  if (kinds.has('audio') && kinds.size > 1) {
    console.error('в одном альбоме нельзя смешивать музыку с картинками, разделите вызовы');
    process.exit(1);
  }
  const kind = kinds.has('audio') ? 'audio' : 'photo';
  const mime = kind === 'audio' ? 'audio/mpeg' : 'image/jpeg';

  // Телеграм принимает в один альбом не больше 10 медиа, поэтому режем пачками.
  for (let i = 0; i < files.length; i += 10) {
    const chunk = files.slice(i, i + 10);
    const fd = new FormData();
    fd.append('chat_id', chat);
    const media = chunk.map((f, j) => ({
      type: isVideo(f) ? 'video' : kind,
      media: `attach://f${j}`,
      // Подпись у альбома живёт на ПЕРВОМ элементе, у остальных её быть не должно.
      ...(j === 0 && i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
    }));
    fd.append('media', JSON.stringify(media));
    chunk.forEach((f, j) => {
      fd.append(`f${j}`, new Blob([fs.readFileSync(f)], { type: mime }), path.basename(f));
    });
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { console.error(`пачка ${i / 10 + 1} не ушла: ${j.description || r.status}`); process.exit(1); }
    console.log(`ушло медиа: ${chunk.length}`);
  }
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', String(e.message).slice(0, 140)); process.exit(1); });
