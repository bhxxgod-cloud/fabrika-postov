'use strict';
// ПРАВИЛА КОНТЕНТА КАНАЛОВ (25.08, владелец: «это мультики, такие посты сюда попадать не могут»).
// Наши ютуб-каналы про разбор ВНЕШНОСТИ РЕАЛЬНОГО человека. Рисованные превращения
// (мультяшный 3D, аниме, поп-арт, игровые стили) ломают обещание канала и путают зрителя.
const path = require('path');

// рисованные и игровые стили — на ютуб не пускаем
const DRAWN = [
  'pixar-3d', 'anime', 'winx-fairy', 'gta', 'popart', 'plush-toy',
  'fantasy-char', 'doodle-watercolor', 'barbie', 'toy',
];
// фотореалистичные образы — можно, человек остаётся собой
const PHOTO_OK = [
  'golden-portrait', 'double-exposure', 'bw-editorial', 'business-portrait',
  'retro-90s', 'tryon',
];
// профильные разборы — всегда можно
const CORE = [
  'makeup-colortype', 'brow-map', 'nose-verdict', 'haircut-match',
  'beauty-guide', 'boyfriend-match', 'lip-guide', 'face-report',
];

// Имя файла вида «мила-n02-pixar-3d-p1.mp4» или «кукла-1-report-anime-p2.mp4».
// Ищем ЛЮБОЕ вхождение запрещённого стиля, потому что генерка комбинирует названия.
function isDrawn(file) {
  const b = path.basename(String(file || '')).toLowerCase();
  return DRAWN.some((t) => b.includes(t));
}
function styleOf(file) {
  const b = path.basename(String(file || '')).toLowerCase();
  for (const t of [...DRAWN, ...PHOTO_OK, ...CORE]) if (b.includes(t)) return t;
  return 'неизвестно';
}

// ЛИЧНЫЕ ФАЙЛЫ ВЛАДЕЛЬЦА НЕ ПОСТИМ НИКОГДА (26.08.2026).
// В пул исходников (СОКРОВИЩНИЦА-РИЛСЫ/годные) попали три файла прямо с телефона владельца, и
// один из них, реклама чужого бренда, ушёл в ленту ВК. Имя файла с камеры это единственный
// надёжный признак: наши ролики всегда называются по схеме «модель-шаблон-номер», а камера даёт
// IMG_/VID_/RPReplay/ScreenRecording. Такие файлы в постинг не пускаем даже если они лежат в пуле.
const ЛИЧНЫЕ = /(^|\/)(IMG_|VID_|RPReplay|ScreenRecording|Photo on |Снимок экрана|Запись экрана)/i;
function личныйФайл(file) {
  const b = path.basename(String(file || ''));
  return ЛИЧНЫЕ.test(b) || /ЛИЧНОЕ-НЕ-ПОСТИТЬ/.test(String(file || ''));
}

// Канал может разрешить рисованное явно: model_filter='allow-drawn'
function allowedForChannel(file, channel) {
  if (личныйФайл(file)) return false;   // личное владельца не постим ни на каком канале
  if (!isDrawn(file)) return true;
  return String(channel && channel.model_filter || '').includes('allow-drawn');
}
module.exports = { isDrawn, styleOf, allowedForChannel, личныйФайл, DRAWN, PHOTO_OK, CORE };
