// prepoints.cjs — ГОТОВИМ ОТРЫВКИ НОВЫХ ТРЕКОВ НАЧАЛЬНИКУ НА ПРОСЛУШКУ (10.08).
//
// ЗАЧЕМ. Замер по складу: постов 116, а звучат они на СЕМИ треках, по 17-19 постов на трек.
// Инстаграм сопоставляет аудио отпечатком и собирает такие рилсы на одну страницу трека, то есть
// это готовая склейка нашей фермы по звуку — ровно та поломка, которую разбирали 09.08, только
// теперь не по одному треку, а по семи.
//
// ПОЧЕМУ ПУЛ ОСТАЛСЯ СЕМЬЮ, ХОТЯ ТРЕКОВ 47. Приказ начальника был «делай рилсы с верифнутыми
// отрывками»: рядом с треком лежит файл <трек>.points с секундами, которые он отобрал на слух.
// Сборщик считает трек годным ТОЛЬКО при наличии этого файла, а он есть у семи. Сорок
// восстановленных треков лежат мёртвым грузом.
//
// ЧТО ДЕЛАЕТ ЭТОТ МОДУЛЬ. Не отменяет приказ и не подделывает проверку: он режет по каждому
// непроверенному треку КАНДИДАТА в отрывок (самое громкое окно, тем же замером volumedetect, каким
// автовыбор жил до ручного отбора) и складывает файлы под номерами. Начальник слушает и говорит
// номера, которые годятся, после чего .points пишется его решением, а пул вырастает с 7 до 47.
//
// Ничего не публикуем, денег не тратим: только локальный ffmpeg.
// Запуск: node prepoints.cjs [длина отрывка в секундах, по умолчанию 14]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const FF = require('ffmpeg-static');

const DIR = path.join(__dirname, 'audio');
const OUT = process.env.PP_OUT || `${process.env.HOME}/Desktop/ТРЕКИ-на-прослушку`;
const NEED = Number(process.argv[2] || 14);

const probe = (args) => String(spawnSync(FF, args, { encoding: 'utf8' }).stderr || '');

function duration(f) {
  const m = probe(['-hide_banner', '-i', f]).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

// Самое громкое окно длиной NEED. Та же мерка, что в reelbuild.chorusPoints: средний уровень плюс
// добавка за пик, потому что при равном среднем выше пик у более живого куска.
function loudest(f, dur) {
  const step = Math.max(3, Math.round(NEED / 2));
  const wins = [];
  for (let t = 0; t + NEED <= dur - 1; t += step) {
    const out = probe(['-hide_banner', '-ss', String(t), '-t', String(NEED), '-i', f,
      '-af', 'volumedetect', '-f', 'null', '-']);
    const mean = out.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    const peak = out.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    if (mean) wins.push({ t: Math.round(t), db: parseFloat(mean[1]), peak: peak ? parseFloat(peak[1]) : -99 });
  }
  if (!wins.length) return null;
  wins.sort((a, b) => (b.db + b.peak / 8) - (a.db + a.peak / 8));
  return wins[0];
}

const all = fs.readdirSync(DIR).filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f)).sort();
const todo = all.filter((f) => !fs.existsSync(path.join(DIR, f + '.points')));
console.log(`треков всего ${all.length}, с отобранными отрывками ${all.length - todo.length}, готовлю кандидатов по ${todo.length}`);
fs.mkdirSync(OUT, { recursive: true });

const map = [];
for (const [i, name] of todo.entries()) {
  const src = path.join(DIR, name);
  const dur = duration(src);
  if (!dur || dur < NEED + 4) { console.log(`  ✗ ${name}: длина ${Math.round(dur)} с, короче отрывка`); continue; }
  const w = loudest(src, dur);
  if (!w) { console.log(`  ✗ ${name}: уровень не намерился`); continue; }
  const num = String(i + 1).padStart(2, '0');
  const out = path.join(OUT, `${num}_${name.replace(/^boss_/, '').replace(/\.(mp3|m4a|aac|wav)$/i, '')}.mp3`);
  spawnSync(FF, ['-y', '-ss', String(w.t), '-t', String(NEED), '-i', src,
    '-af', 'loudnorm=I=-14:TP=-1.5', '-b:a', '128k', out], { stdio: 'ignore' });
  map.push({ num, track: name, from: w.t, db: w.db, file: out });
  console.log(`  ✅ ${num} ${name}: секунда ${w.t}, уровень ${w.db} дБ`);
}

fs.writeFileSync(path.join(OUT, 'список.json'), JSON.stringify(map, null, 1));
fs.writeFileSync(path.join(OUT, 'список.txt'),
  map.map((m) => `${m.num}. ${m.track} — с секунды ${m.from}`).join('\n') + '\n');
console.log(`\nИТОГ: кандидатов ${map.length}, папка ${OUT.replace(process.env.HOME, '~')}`);
console.log('дальше: начальник называет годные номера, по ним пишется <трек>.points и пул растёт');
