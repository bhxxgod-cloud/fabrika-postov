// СТОРОЖ СКАНЕРА ПРОСМОТРОВ (11.08, приказ начальника: «ставь ему отстуки, нельзя чтобы он висел»).
//
// ЗАЧЕМ. Сканер пишет отстук в /tmp/viewsmon.beat на каждом аккаунте. Если отстук перестал
// обновляться, значит процесс висит на сети или на прокси, и мы молча остаёмся без цифр: ровно это
// и случилось ночью, я увидел это только потому, что полез смотреть руками.
//
// ЧЕСТНАЯ ОГОВОРКА ПРО МОЮ ЖЕ ОШИБКУ. В ту ночь я решил, что сканер завис, а он был жив: я
// сравнил его отстук со своим неверным представлением о текущем времени и убил здоровый процесс,
// потеряв прогресс. Поэтому здесь порог считается ТОЛЬКО машинным временем и логируется явно:
// сколько минут тишине, какой порог, что делаю. Никаких «на глаз».
//
// Запуск: node viewsguard.cjs   (сам крутится, проверка раз в минуту)
'use strict';
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const BEAT = '/tmp/viewsmon.beat';
const ЛОГ = '/tmp/viewsguard.log';
// Порог с запасом: обход одного аккаунта идёт с паузой 17-31 с, плюс ретраи по прокси. Десять
// минут тишины это уже не медленный аккаунт, это стоп.
const ПОРОГ_МИН = Number(process.env.VIEWSGUARD_MINUTES || 10);

const пиши = (s) => {
  const строка = `[${new Date().toISOString()}] ${s}`;
  console.log(строка);
  try { fs.appendFileSync(ЛОГ, строка + '\n'); } catch {}
};

function живой() {
  try { execSync('pgrep -f "viewsmon.cjs daemon" > /dev/null'); return true; } catch { return false; }
}

function тишина() {
  try {
    const b = JSON.parse(fs.readFileSync(BEAT, 'utf8'));
    return (Date.now() - new Date(b.tick_at).getTime()) / 60000;
  } catch { return Infinity; }
}

function поднять(почему) {
  пиши(`ПОДНИМАЮ сканер: ${почему}`);
  try { execSync('pkill -f "viewsmon.cjs daemon"'); } catch {}
  const лог = fs.openSync('/tmp/viewsmon.log', 'a');
  spawn(process.execPath, ['viewsmon.cjs', 'daemon'],
    { cwd: __dirname, detached: true, stdio: ['ignore', лог, лог] }).unref();
}

пиши(`сторож встал, порог тишины ${ПОРОГ_МИН} мин`);
setInterval(() => {
  const мин = тишина();
  if (!живой()) return поднять('процесса нет');
  if (мин > ПОРОГ_МИН) return поднять(`тишина ${мин.toFixed(1)} мин при пороге ${ПОРОГ_МИН}`);
  if (Math.random() < 0.05) пиши(`всё ровно, тишина ${мин.toFixed(1)} мин`);
}, 60000);
