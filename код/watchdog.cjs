// СТОРОЖ ЖИЗНИ СКРИПТА (07.08, приказ начальника: «разберись так чтобы в след раз такого не было»).
//
// ИНЦИДЕНТ, ИЗ КОТОРОГО РОДИЛСЯ ЭТОТ ФАЙЛ. fix4.cjs отработал свою работу, напечатал
// «ИТОГ: пересобрано 1» и ВИСЕЛ 45 минут. Причина: после работы через adminbrowser.cjs
// (подключение к статичному хрому по CDP) в процессе остаются живые сокеты playwright, и нода
// сама не выходит. Снаружи это выглядело как «пересборка идёт», а она стояла: главный чат
// докладывал прогресс, которого не было.
//
// ЧТО ЗАКРЫВАЕТ СТОРОЖ (три разные болезни, у них разные лекарства):
//   1. РАБОТА СДЕЛАНА, ПРОЦЕСС НЕ ВЫШЕЛ  → wd.done(0) делает ЯВНЫЙ process.exit;
//   2. РАБОТА ВСТАЛА В СЕРЕДИНЕ           → бомба по общему лимиту и по «шаг не менялся»
//                                           (печатает причину и выходит НЕНУЛЕВЫМ кодом);
//   3. ЗАВИСАНИЕ НЕ ВИДНО СНАРУЖИ         → сердцебиение: каждые N секунд строка «что делаю
//                                           прямо сейчас» и сколько прошло.
//
// ПОЧЕМУ ТАЙМЕРЫ unref. Ref-таймер сам держит event loop открытым, то есть сторож стал бы новой
// миной: скрипт, который раньше выходил сам, ждал бы бомбу. unref-таймер лишним не держит ничего,
// но во время ЗАВИСАНИЯ (а там event loop жив, его держат чужие сокеты) исправно срабатывает.
//
// Использование:
//   const { armWatchdog, fetchBuf } = require('./watchdog.cjs');
//   const wd = armWatchdog({ minutes: 25, stallMinutes: 8, label: 'сборка поста Дарья' });
//   wd.stage(`жду рендер заказа ${i + 1} из ${n}`);
//   wd.done(0);                      // успех: печатает итог и ВЫХОДИТ
//   wd.fail(e);                      // провал: печатает причину и выходит кодом 1
//
// Проверка сторожа на маленьком лимите (без правки кода):  WD_MINUTES=0.2 node makepost.cjs …
// Полностью выключить (только для отладки):                WD_OFF=1 node …
'use strict';
const fs = require('node:fs');

// Пишем СИНХРОННО в fd 1: обычный console.log в пайп асинхронный, и последняя строка перед
// process.exit могла не успеть вылететь. Именно её и ждёт человек снаружи.
function say(s) { try { fs.writeSync(1, s + '\n'); } catch { console.log(s); } }

// ВЫХОД С ДОСЫЛКОЙ ВЫВОДА. process.exit обрывает ещё не улетевшие асинхронные записи в stdout,
// когда вывод идёт в пайп или в файл лога, а именно последние строки («ИТОГ», причина падения)
// человек и читает. 60 мс на прокрутку очереди стоят дешевле потерянного итога. Таймер ref-ный
// намеренно: он ОБЯЗАН сработать.
function bye(code) { setTimeout(() => process.exit(code), 60); }

function human(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

function armWatchdog(opts = {}) {
  const label = String(opts.label || 'скрипт');
  // WD_MINUTES перебивает лимит для проверки сторожа на искусственно маленьком значении.
  const minutes = Number(process.env.WD_MINUTES || opts.minutes || 20);
  // «Шаг не менялся столько минут» — главная защита пачек: общий лимит у пачки из 20 постов
  // честно большой, а вот стоять на одном шаге 8 минут она не имеет права.
  const stallMinutes = Number(process.env.WD_STALL_MINUTES || opts.stallMinutes || minutes);
  const beatSec = Number(process.env.WD_BEAT_SEC || opts.beatSec || 30);
  const off = /^(1|true|yes)$/i.test(String(process.env.WD_OFF || ''));

  const started = Date.now();
  let stage = 'старт';
  let stageAt = started;
  let lastBeat = started;
  let armed = true;

  const elapsed = () => human(Date.now() - started);

  function bang(why) {
    armed = false;
    clearInterval(tick);
    say('');
    say(`⛔ СТОРОЖ: «${label}» ${why}.`);
    say(`⛔ СТОРОЖ: стоял на шаге «${stage}» ${human(Date.now() - stageAt)}, всего прожил ${elapsed()}.`);
    say('⛔ СТОРОЖ: РАБОТА НЕ ДОВЕДЕНА, выхожу кодом 2. Считать её выполненной нельзя.');
    bye(2);
  }

  let lastTick = started;
  const tick = setInterval(() => {
    if (!armed) return;
    const now = Date.now();
    // ПОПРАВКА НА ЗАБЛОКИРОВАННЫЙ EVENT LOOP. execFileSync/spawnSync держат поток целиком, таймеры
    // в это время не тикают вообще. Без поправки сторож, проснувшись после честного синхронного
    // ребёнка (например accheck.cjs на 40 минут), увидел бы «шаг не менялся 40 минут» и казнил бы
    // работу, которая шла нормально. Общий лимит НЕ сдвигаем: он про реальное время жизни.
    const overdue = now - lastTick - 5000;
    lastTick = now;
    if (overdue > 10000) {
      stageAt += overdue;
      say(`  ⏱ (поток был занят синхронной работой ${human(overdue)}, отсчёт шага сдвинут)`);
    }
    if (now - started > minutes * 60000) return bang(`не уложился в лимит ${minutes} мин`);
    if (now - stageAt > stallMinutes * 60000) return bang(`завис: шаг не менялся ${stallMinutes} мин`);
    if (now - lastBeat >= beatSec * 1000) {
      lastBeat = now;
      say(`  ⏱ ${stage}; прошло ${elapsed()}`);
    }
  }, 5000);
  if (typeof tick.unref === 'function') tick.unref();

  if (off) { armed = false; clearInterval(tick); say(`(сторож выключен WD_OFF=1: ${label})`); }
  else say(`⏱ сторож взведён: «${label}», лимит ${minutes} мин, замер шага ${stallMinutes} мин`);

  return {
    // Смена шага. Печатаем сразу: по этой строке видно, докуда дошло, если потом всё встало.
    stage(text) {
      stage = String(text);
      stageAt = lastBeat = Date.now();
      say(`  · ${stage} (${elapsed()})`);
      return this;
    },
    // Молча обновить «шаг живой», не засоряя лог (для длинных однообразных циклов).
    poke(text) { if (text) stage = String(text); stageAt = Date.now(); return this; },
    left() { return Math.max(0, minutes * 60000 - (Date.now() - started)); },
    // УСПЕХ. Явный выход обязателен: после CDP в процессе живут сокеты playwright, и нода сама
    // не завершается (тот самый висяк fix4.cjs на 45 минут).
    done(code = 0, msg) {
      armed = false;
      clearInterval(tick);
      if (msg) say(msg);
      say(`✔ «${label}» закончил за ${elapsed()} (код выхода ${code})`);
      bye(code);
    },
    fail(e, code = 1) {
      armed = false;
      clearInterval(tick);
      say(`✗ «${label}» упал на шаге «${stage}» через ${elapsed()}: ${String((e && e.message) || e).slice(0, 200)}`);
      bye(code);
    },
  };
}

// СЕТЬ ВСЕГДА С ТАЙМАУТОМ (07.08). fetch без сигнала висит столько, сколько захочет другая
// сторона: скачивание кадра с r2.dev или запрос к API превращались в тот же тихий висяк, только
// внутри шага. Возвращает Buffer, ошибку пишет по-русски и с именем шага.
async function fetchBuf(url, opts = {}) {
  const ms = Number(opts.ms || 90000);
  const min = Number(opts.min || 0);
  const what = String(opts.what || 'файл');
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(ms), ...(opts.init || {}) }); }
  catch (e) {
    const to = String((e && e.name) || '') === 'TimeoutError' || /abort/i.test(String((e && e.message) || ''));
    throw new Error(to ? `${what} не скачался за ${Math.round(ms / 1000)} с (таймаут сети)`
                       : `${what} не скачался: ${String((e && e.message) || e).slice(0, 80)}`);
  }
  if (!r.ok) throw new Error(`${what} не скачался: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (min && buf.length < min) throw new Error(`${what} подозрительно мал: ${buf.length} байт`);
  return buf;
}

// Скачать в файл. Тонкая обёртка, чтобы grab() в скриптах не повторял таймаут-логику копипастой.
async function fetchToFile(url, out, opts = {}) {
  fs.writeFileSync(out, await fetchBuf(url, opts));
  return out;
}

module.exports = { armWatchdog, fetchBuf, fetchToFile, human };
