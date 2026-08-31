// gencontent.ts — ВКЛАДКА «ГЕНЕРАЦИЯ» ПАНЕЛИ (25.08, приказ владельца: «нужно на сайт постера
// раздел добавить генерация, где мы будем всё кнопкой генерить, а не с тобой в чате»).
//
// ЗАЧЕМ. Весь конвейер маркетолога до сегодняшнего дня запускался из чата руками: выбрать девочку,
// прогнать обложки, собрать посты. Панель это уже умеет делать для постинга, а генерация жила
// отдельно. Этот модуль отдаёт панели три вещи: списки (модели, шаблоны, сборки), запуск и лог.
//
// ГДЕ ВЫПОЛНЯЕТСЯ. Скрипты конвейера лежат в neironka-poster/генерка и работают с локальными
// папками (~/Desktop/НЕЙРОНКА/...). Значит генерация идёт ТАМ, ГДЕ ЗАПУЩЕН СЕРВЕР ПАНЕЛИ. На
// Railway этих папок нет, поэтому вкладка работает с локально поднятой панелью; в облаке она
// честно скажет «нет папок конвейера», а не притворится работающей.
//
// ЧЕГО ЗДЕСЬ НЕТ. Никакой публикации: только производство файлов. Постингом занимаются
// существующие вкладки и ферма.
import type { Express, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ДОМ = os.homedir();
const КОРЕНЬ = path.join(ДОМ, 'Desktop', 'neironka-poster');
const СКРИПТЫ = path.join(КОРЕНЬ, 'генерка');
const БАЗЫ = path.join(ДОМ, 'Desktop', 'НЕЙРОНКА', 'ДОГЕН-РАБОТА');
const ИСХОДНИКИ = path.join(ДОМ, 'Desktop', 'НЕЙРОНКА', 'МОДЕЛИ-ИСХОДНИКИ');
const ВЫХОД = path.join(ДОМ, 'Desktop', 'НЕЙРОНКА', 'ГЕНЕРАЦИЯ-2.0');
const ЛОГИ = path.join(ДОМ, '.neironka', 'генерация-логи');

// СБОРКИ. Нумерацию закрепил владелец: сб1 — классика (4 кадра, озвучка в конце). Остальные
// заведены заранее, чтобы номер в имени файла не поехал, когда их доделает ветка фермы.
export const СБОРКИ = [
  { id: 'сб1', имя: 'сб1 · классика 4 кадра', описание: 'обложка с хуком, карточка, два образа, озвучка в конце' },
  { id: 'сб2', имя: 'сб2 · со строкой Яндекса', описание: 'то же плюс печатающийся поиск на финале' },
  { id: 'сб3', имя: 'сб3 · без карточки', описание: 'три кадра, только фото' },
  { id: 'сб4', имя: 'сб4 · длинный', описание: 'шесть кадров, расширенный разбор' },
];

type Задача = {
  id: string; модель: string; шаблон: string; сборка: string; сколько: number;
  статус: 'идёт' | 'готово' | 'сбой'; начата: number; кончена?: number;
  лог: string; собрано: number; pid?: number;
};
const задачи = new Map<string, Задача>();

const естьКонвейер = () => fs.existsSync(СКРИПТЫ) && fs.existsSync(БАЗЫ);

/** Модели: базы девочек из ДОГЕН-РАБОТА плюс папка исходников владельца. Снятые (_СНЯТЫЕ) не показываем. */
function модели(): Array<{ id: string; имя: string; обложек: number }> {
  const из = new Map<string, { id: string; имя: string; обложек: number }>();
  const ОБЛ = path.join(ДОМ, 'Desktop', 'НЕЙРОНКА', 'ОБЛОЖКИ-ДОГЕН');
  for (const каталог of [БАЗЫ, ИСХОДНИКИ]) {
    if (!fs.existsSync(каталог)) continue;
    for (const f of fs.readdirSync(каталог)) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      const id = f.replace(/\.[^.]+$/, '');
      if (id.startsWith('_')) continue;
      let обложек = 0;
      const п = path.join(ОБЛ, id);
      if (fs.existsSync(п)) обложек = fs.readdirSync(п).filter((x) => /\.(png|jpe?g)$/i.test(x) && !/^_/.test(x)).length;
      из.set(id, { id, имя: id, обложек });
    }
  }
  return [...из.values()].sort((a, b) => b.обложек - a.обложек || a.id.localeCompare(b.id, 'ru'));
}

/** Шаблоны: живые из templates.cjs (без disabled), названия — из tplprompts.json. */
function шаблоны(): Array<{ id: string; имя: string }> {
  const список: Array<{ id: string; имя: string }> = [];
  try {
    const т = JSON.parse(fs.readFileSync(path.join(КОРЕНЬ, 'tplprompts.json'), 'utf8')) as Record<string, string>;
    const выключенные = new Set<string>();
    try {
      const src = fs.readFileSync(path.join(КОРЕНЬ, 'templates.cjs'), 'utf8');
      for (const m of src.matchAll(/'([a-z0-9-]+)':\s*\{[^}]*disabled:\s*true/gi)) выключенные.add(m[1]);
    } catch { /* нет файла — показываем всё */ }
    for (const id of Object.keys(т)) {
      if (выключенные.has(id)) continue;
      список.push({ id, имя: id.replace(/^img-/, '') });
    }
  } catch { /* нет промптов */ }
  return список.sort((a, b) => a.имя.localeCompare(b.имя, 'ru'));
}

/** Запуск сборки: тот же assemble_girl, что гоняется из чата, только вызванный кнопкой. */
function запустить(з: Задача) {
  fs.mkdirSync(ЛОГИ, { recursive: true });
  fs.mkdirSync(ВЫХОД, { recursive: true });
  const файлЛога = path.join(ЛОГИ, з.id + '.log');
  const поток = fs.createWriteStream(файлЛога, { flags: 'a' });
  // проход выбираем свободный: панель не должна затирать посты, собранные из чата
  const проход = String(20 + Math.floor(Math.random() * 60));
  const дочерний = spawn('node', [path.join(СКРИПТЫ, 'assemble_girl.cjs'), з.модель, проход], {
    cwd: КОРЕНЬ,
    env: {
      ...process.env,
      TPLS: з.шаблон,
      OUT_DIR: ВЫХОД,
      COVER_REUSE: '1',
      SBORKA: з.сборка,
      ПОСТОВ: String(з.сколько),
    },
  });
  з.pid = дочерний.pid;
  const писать = (b: Buffer) => {
    const s = b.toString();
    поток.write(s);
    з.лог = (з.лог + s).slice(-8000);
    з.собрано = (з.лог.match(/^OK /gm) || []).length;
  };
  дочерний.stdout.on('data', писать);
  дочерний.stderr.on('data', писать);
  дочерний.on('close', (код) => {
    з.статус = код === 0 ? 'готово' : 'сбой';
    з.кончена = Date.now();
    поток.end();
  });
}

// КИРИЛЛИЦА В ПУТИ РОУТА НЕ РАБОТАЕТ (поймано 25.08): браузер и curl шлют путь в процентном
// кодировании, а express сравнивает с литералом — запрос падал в catch-all и отдавал index.html
// с кодом 200, то есть «успех» без единого признака поломки. Пути только латиницей.
export function registerGenRoutes(app: Express, requireAuth: any) {
  // Списки для формы
  app.get('/api/gen/lists', requireAuth, (_req: Request, res: Response) => {
    if (!естьКонвейер()) {
      return res.json({ доступно: false, причина: 'на этой машине нет папок конвейера (генерка/ и ДОГЕН-РАБОТА) — вкладка работает на локальной панели' });
    }
    res.json({ доступно: true, модели: модели(), шаблоны: шаблоны(), сборки: СБОРКИ, выход: ВЫХОД });
  });

  // Запуск
  app.post('/api/gen/start', requireAuth, (req: Request, res: Response) => {
    if (!естьКонвейер()) return res.status(400).json({ error: 'нет папок конвейера на этой машине' });
    const модель = String(req.body?.модель || '').trim();
    const шаблон = String(req.body?.шаблон || '').trim();
    const сборка = String(req.body?.сборка || 'сб1').trim();
    const сколько = Math.max(1, Math.min(20, Number(req.body?.сколько) || 1));
    if (!модель || !шаблон) return res.status(400).json({ error: 'нужны модель и шаблон' });
    const идёт = [...задачи.values()].find((z) => z.статус === 'идёт');
    if (идёт) return res.status(409).json({ error: `уже идёт задача ${идёт.модель} · ${идёт.шаблон}` });
    const id = 'g' + Date.now().toString(36);
    const з: Задача = { id, модель, шаблон, сборка, сколько, статус: 'идёт', начата: Date.now(), лог: '', собрано: 0 };
    задачи.set(id, з);
    try { запустить(з); } catch (e: any) { з.статус = 'сбой'; з.лог = String(e?.message || e); }
    res.json({ ok: true, id });
  });

  // Живой статус и лог
  app.get('/api/gen/status', requireAuth, (req: Request, res: Response) => {
    const id = String(req.query.id || '');
    const з = задачи.get(id);
    if (!з) return res.status(404).json({ error: 'задача не найдена' });
    res.json({
      id: з.id, статус: з.статус, модель: з.модель, шаблон: з.шаблон, сборка: з.сборка,
      собрано: з.собрано, сколько: з.сколько, лог: з.лог,
      секунд: Math.round(((з.кончена || Date.now()) - з.начата) / 1000),
    });
  });

  // Последние задачи (для истории на вкладке)
  app.get('/api/gen/jobs', requireAuth, (_req: Request, res: Response) => {
    res.json([...задачи.values()].sort((a, b) => b.начата - a.начата).slice(0, 10)
      .map((з) => ({ id: з.id, модель: з.модель, шаблон: з.шаблон, сборка: з.сборка, статус: з.статус, собрано: з.собрано })));
  });

  // Остановить
  app.post('/api/gen/stop', requireAuth, (req: Request, res: Response) => {
    const з = задачи.get(String(req.body?.id || ''));
    if (!з || !з.pid) return res.status(404).json({ error: 'нечего останавливать' });
    try { process.kill(з.pid, 'SIGKILL'); з.статус = 'сбой'; з.кончена = Date.now(); } catch { /* уже умер */ }
    res.json({ ok: true });
  });
}
