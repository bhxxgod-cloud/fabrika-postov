'use strict';
// ОБЁРТКА МЕРЫ СХОЖЕСТИ ЛИЦА ДЛЯ СБОРЩИКОВ. Считает facesim.py и отдаёт число.
//
// ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Мера нужна в двух местах и по разным поводам: сборщику (onepost) — сразу
// после кадра 3, чтобы РЕШИТЬ про ретрай до того, как заплачено за кадр 4; гейту (framegate) —
// перед складом, чтобы пост с чужим лицом не уехал в готовые. Разводить две копии вызова питона
// нельзя: пороги разъедутся, и гейт начнёт спорить со сборщиком.
//
// ПОЧЕМУ ПИТОН, А НЕ NODE. Модель сравнения лиц это cv2.FaceRecognizerSF (sface.onnx), а opencv у
// нас есть только в питоне, там же живёт facevalidate.py с тем же детектором yunet. Тянуть в ноду
// вторую реализацию onnx ради одного косинуса это лишняя зависимость на пустом месте.
//
// ПОЧЕМУ МЕРА ВООБЩЕ ПОЯВИЛАСЬ: см. шапку facesim.py. Коротко — начальник поймал глазами пост
// нов28 (кадры 3 и 4 с другой девушкой), а числом это поймать было нечем: расстояние по цвету
// волос мерит фон, а «похожа по типажу» это не мера.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const PY = path.join(__dirname, 'facesim.py');
// Порог держим ОДНОЙ константой в питоне и читаем его оттуда же вместе с ответом: два порога в двух
// языках это готовый спор гейта со сборщиком через месяц.
const SAME_FACE = 0.363;
// Серая зона у порога: гейт про такие числа пишет предупреждение, но пост не рубит, приговор глазами.
const GREY_LOW = 0.33;

/**
 * Схожесть лиц на кадрах. Считается ОДНИМ вызовом питона на все кадры: запуск интерпретатора с
 * загрузкой двух onnx стоит около секунды, и по вызову на пару это заметно на объёме.
 * @param {string[]} files локальные файлы кадров, по порядку
 * @returns {{pairs:Object<string,number|null>, faces:number[], same:number, error?:string}}
 *   pairs это пары по номерам кадров начиная с 1: «1-3» это обложка против образа.
 *   null в паре значит «в одном из кадров лица не нашли», и это НЕ ноль: ноль читается как
 *   «другой человек», а «лица нет» решает вызывающий по-своему.
 */
function faceSim(files) {
  const bad = files.filter((f) => !fs.existsSync(f));
  if (bad.length) return { pairs: {}, faces: [], same: SAME_FACE, error: `нет файлов: ${bad.join(', ')}` };
  const r = spawnSync('python3', [PY, ...files], { encoding: 'utf8', maxBuffer: 1 << 22, timeout: 180000 });
  if (r.error || r.status !== 0) {
    // Мера НЕ обязана валить пост: если питона или модели нет, гейт скажет «не проверено» и
    // пропустит дальше по остальным правилам. Тихо возвращать ноль нельзя, ноль это приговор.
    return { pairs: {}, faces: [], same: SAME_FACE,
      error: `facesim.py не сработал: ${(r.error && r.error.message) || String(r.stderr || '').trim().split('\n').pop() || `код ${r.status}`}` };
  }
  let j = null;
  try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { /* скажем ниже */ }
  if (!j || !j.pairs) return { pairs: {}, faces: [], same: SAME_FACE, error: 'facesim.py вернул не JSON' };
  if (j.error) return { pairs: {}, faces: [], same: SAME_FACE, error: j.error };
  return { pairs: j.pairs, faces: j.faces || [], same: Number(j.same_face) || SAME_FACE };
}

/**
 * Удержал ли кадр лицо обложки. Отдельная функция, потому что сборщику нужен ответ по ОДНОЙ паре
 * и до заказа следующего кадра.
 * @param {string} cover файл обложки (кадр 1)
 * @param {string} frame файл проверяемого кадра
 * @returns {{ok:boolean|null, d:number|null, error?:string}} ok=null значит «проверить не удалось»
 */
function keepsFace(cover, frame) {
  const r = faceSim([cover, frame]);
  if (r.error) return { ok: null, d: null, error: r.error };
  const d = r.pairs['1-2'];
  if (d === null || d === undefined) return { ok: null, d: null, error: 'лица не нашлись в одном из кадров' };
  return { ok: d >= r.same, d };
}

module.exports = { faceSim, keepsFace, SAME_FACE, GREY_LOW };
