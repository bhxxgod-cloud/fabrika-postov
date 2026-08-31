// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
//
// ENGINES — супервизор движков комментинга для Railway (сервис ig-worker). Раньше duty/backlog/validate жили
// только на ноуте владельца: закрыл крышку — всё встало. Здесь они крутятся 24/7 в облаке.
//
// Браузеры НЕ поднимаются в контейнере: работаем через ОБЛАЧНЫЙ GoLogin по API (wss), поэтому образу нужен
// только node + playwright-core как клиент. Локальный режим (GL_LOCAL=1) на Railway недоступен и не нужен.
//
// Каждый движок перезапускается при падении с нарастающей паузой (10с → 5мин), чтобы бесконечный краш-луп
// не жёг облачные сессии и не спамил в TG.
const path = require('path');
const { spawn } = require('child_process');

// vcomment/vshadow читают именно DB_PUBLIC_URL. На Railway база лежит в DATABASE_URL — сшиваем один раз здесь,
// иначе каждый дочерний процесс упадёт на connectionString=undefined.
if (!process.env.DB_PUBLIC_URL && process.env.DATABASE_URL) process.env.DB_PUBLIC_URL = process.env.DATABASE_URL;

const DIR = __dirname;
const SHOT = process.env.SHOT_DIR || '/tmp';
// Список движков. OFF-флаги — чтобы гасить любой по одной переменной, без передеплоя кода.
const ENGINES = [
  { name: 'duty', file: 'duty_safe.cjs', off: 'DUTY_OFF' },
  { name: 'backlog', file: 'backlog_safe.cjs', off: 'BACKLOG_OFF' },
  { name: 'validate', file: 'validate_safe.cjs', off: 'VALIDATE_OFF' },
  // Главный комментинг-конвейер по очереди «В РАБОТЕ» (queue_supervisor → smartrun → vcomment) — раньше жил только
  // на ноуте. ВАЖНО: чтобы не дублировать с web-воркером (maybeWorkQueue), на web-сервисе ставь WORK_QUEUE_OFF=1.
  { name: 'commenter', file: 'queue_supervisor.cjs', off: 'COMMENTER_OFF' },
  // СТОРОЖИ — авто-слежка за креаторами (пул-чтение + baseline + спайк-детект + бренд на новый пост + мобилизация
  // работяг на спайк). Заменяет старый newpost_watch. Гейт storozhi_enabled в radar_config (тумблер в панели) —
  // движок крутится, но тик выходит рано, пока не включат. off-флаг STOROZHI_OFF гасит процесс целиком.
  { name: 'storozhi', file: 'storozhi.cjs', off: 'STOROZHI_OFF' },
  // AUTOSCAN — сайт сам анализирует найденные посты (режим 2): по 1 свежему ненасканенному посту за цикл гонит
  // vcomment SCAN → карточка приходит уже с тиром и спросом, владельцу остаётся ЗАПУСК. Гейт autoscan_enabled +
  // AUTOSCAN_OFF. Пауза AUTOSCAN_GAP_MIN бережёт облачные часы.
  { name: 'autoscan', file: 'autoscan.cjs', off: 'AUTOSCAN_OFF' },
];

function start(e, attempt = 0) {
  if (process.env[e.off] === '1') { console.log(`[engines] ${e.name} выключен через ${e.off}=1`); return; }
  console.log(`[engines] старт ${e.name} (${e.file})${attempt ? ` — перезапуск #${attempt}` : ''}`);
  const p = spawn('node', [path.join(DIR, e.file)], {
    cwd: DIR,
    env: { ...process.env, SHOT_DIR: SHOT },
    stdio: ['ignore', 'inherit', 'inherit'], // логи движков идут прямо в логи Railway
  });
  p.on('exit', (code, sig) => {
    // Бэкофф: 10с, 20с, 40с… но не дольше 5 минут — иначе краш-луп сожжёт облачные сессии GoLogin.
    const wait = Math.min(10000 * Math.pow(2, attempt), 300000);
    console.log(`[engines] ${e.name} завершился (код ${code}${sig ? `, сигнал ${sig}` : ''}) — перезапуск через ${Math.round(wait / 1000)}с`);
    setTimeout(() => start(e, attempt + 1), wait);
  });
  p.on('error', (err) => console.log(`[engines] ${e.name} ошибка запуска: ${String(err.message).slice(0, 120)}`));
}

function startEngines() {
  const db = process.env.DB_PUBLIC_URL ? 'есть' : 'НЕТ (движки упадут)';
  console.log(`[engines] запуск супервизора | база: ${db} | OPENROUTER: ${process.env.OPENROUTER_API_KEY ? 'есть' : 'нет'}`);
  // Разносим старты, чтобы три движка не полезли в GoLogin одновременно (cloud-штормы ловили на этом).
  ENGINES.forEach((e, i) => setTimeout(() => start(e), i * 20000));
}

module.exports = { startEngines };
// Позволяем и прямой запуск: node engines.cjs
if (require.main === module) startEngines();
