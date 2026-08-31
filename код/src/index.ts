import 'dotenv/config';
import { createRequire } from 'node:module';
import { createApp } from './api.js';
import { startWorker } from './worker.js';
import { ytTick, ytWatchdog, ytRefreshAllStats } from './youtube.js';
import { обойтиТикток, снятьПоказания } from './stats.js';

// Движки комментинга — CommonJS (.cjs), их нельзя импортировать статически из ESM-модуля.
const requireCjs = createRequire(import.meta.url);

for (const key of ['GOLOGIN_API_TOKEN', 'DATABASE_URL', 'DASHBOARD_PASSWORD']) {
  if (!process.env[key]) console.warn(`[warn] ${key} не задан — заполни .env (см. .env.example).`);
}

// Защита от падения всего процесса (а с ним и воркера-автопостинга) из-за
// одиночной необработанной ошибки в каком-нибудь роуте/промисе. Логируем и живём.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err instanceof Error ? err.message : err);
});

const PORT = Number(process.env.PORT || 3000);
const app = createApp();
app.listen(PORT, () => {
  console.log(`панель: http://localhost:${PORT}`);
  // ROLE=engines (сервис ig-worker) — крутим движки комментинга вместо воркера-автопостинга.
  // Веб-сервер поднимаем в обоих режимах: на нём висит healthcheck Railway, без него деплой не пройдёт.
  // Автопостинг и комментинг РАЗВЕДЕНЫ по сервисам: два startWorker() на одну базу = гонки за профили.
  if (process.env.ROLE === 'engines') {
    console.log('[role] engines — движки комментинга (дежурство/бэклог/валидатор), автопостинг выключен');
    requireCjs('../engines.cjs').startEngines();
  } else {
    startWorker();
    // ЮТУБ-КАНАЛ: раз в минуту сервер грузит ролики по публичному URL (локальные файлы грузит ytrunner.cjs на маке).
    setInterval(() => { ytTick().catch(() => {}); }, 60_000);
    setInterval(() => { ytWatchdog().catch(() => {}); }, 3600_000);
    // Просмотры сами по себе не обновлялись, только кнопкой. Снимаем раз в 3 часа:
    // videos.list стоит 1 единицу квоты на 50 роликов, то есть пара единиц из 10 000 в сутки на канал.
    setInterval(() => { ytRefreshAllStats().catch(() => {}); }, 3 * 3600_000);

    // СТАТИСТИКА КОПИТСЯ САМА, А НЕ ПО НАЖАТИЮ.
    //
    // Кнопка обхода в панели есть, но ряд по дням кнопкой не набирается:
    // владелец не станет жать её каждые шесть часов, а без регулярности вопрос
    // «на сколько выросли просмотры за неделю» так и останется неотвечаемым.
    // Все три хранилища метрик держат ОДНУ строку на объект и затирают прошлое
    // значение, поэтому историю приходится копить отдельно.
    //
    // Тикток обходим вебом: это бесплатно и не будит телефоны. Шаг шесть часов,
    // потому что четыре точки в сутки уже дают внятную дневную дельту, а чаще
    // ходить к чужому сайту без нужды незачем.
    //
    // Снятие показаний ютуба и инстаграма НЕ ходит никуда наружу: оно копирует
    // в журнал то, что их собственные сборщики уже положили в базу. Отсюда и шаг
    // в час: это два запроса, и они ничего не стоят.
    //
    // Первый прогон откладываем на минуту после старта: при деплое и так шумно,
    // а лишняя одновременная работа на холодном старте только мешает.
    setTimeout(() => {
      обойтиТикток().then((r) => console.log(`[стата] тикток: обошёл ${r.обошли}, постов ${r.постов}`))
        .catch((e) => console.error('[стата] обход тиктока не удался:', e?.message || e));
      снятьПоказания().then((r) => console.log(`[стата] показания в журнал: ${r.строк} строк`))
        .catch((e) => console.error('[стата] показания не сняты:', e?.message || e));
    }, 60_000);
    setInterval(() => { обойтиТикток().catch((e) => console.error('[стата] тикток:', e?.message || e)); }, 6 * 3600_000);
    setInterval(() => { снятьПоказания().catch((e) => console.error('[стата] показания:', e?.message || e)); }, 3600_000);
    setTimeout(() => { ytRefreshAllStats().catch(() => {}); }, 120_000);
  }
});
