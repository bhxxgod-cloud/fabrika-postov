// ХУКИ ЗАГОЛОВКОВ ПО ШАБЛОНУ РОЛИКА (25.08.2026, пул утверждён владельцем построчно).
//
// ЗАЧЕМ. До этого название Shorts писала модель по одному общему промпту канала, вслепую к теме
// ролика. Получалось «Слушай, ты просто носишь не своё» на ролик про подбор парня: заголовок
// обещает разбор макияжа, внутри гадание, зритель уходит за секунду.
//
// ДВА РЕГИСТРА РЕЧИ. Владелец правил хуки построчно, и в правках проступили два разных языка:
//   «крик» — обвинение с конкретным ПРЕДМЕТОМ плюс обещание показать: «Выкинь это из косметички!
//            Показываю почему!». Годится там, где есть ОШИБКА и её можно исправить (макияж,
//            стрижка, брови, образ).
//   «пов»  — дневник от первого лица с эмоцией в скобках: «пов лучше бы ты не делала этот тренд...»,
//            «я плакала((». Годится там, где ошибки нет, а есть эмоция от результата (возраст,
//            типаж парня, будущий ребёнок, люкс-сумка).
// Спутать регистры нельзя: обвинять женщину за форму носа или за то, что ей выпал возраст, значит
// бить в комплекс. Поэтому в носу и трендах-гаданиях крик мягкий или отсутствует.
//
// ПОЧЕМУ ОБРАЗЦЫ, А НЕ ГОТОВЫЕ СТРОКИ. Готовые строки повторялись бы из ролика в ролик и ютуб
// счёл бы это спамом. Модель получает 6 образцов регистра и пишет новое ПО ИХ ОБРАЗУ.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM: __dirname тут нет, собираем сами (как в src/api.ts).
const here = path.dirname(fileURLToPath(import.meta.url));

// Хуки хранятся объектами {id, т}: id постоянный и служит ссылкой из реестра hook_usage и из
// имён файлов, поэтому строки нельзя перенумеровывать при добавлении новых.
type Hook = { id: string; т: string };
type Pool = Record<string, { крик?: Hook[]; пов?: Hook[]; _?: string; _риск?: string }>;
let cache: { at: number; pool: Pool } | null = null;

function loadPool(): Pool {
  if (cache && Date.now() - cache.at < 300_000) return cache.pool;
  for (const p of [path.resolve(process.cwd(), 'хуки-пул.json'), path.resolve(here, '../хуки-пул.json')]) {
    try {
      const pool = JSON.parse(fs.readFileSync(p, 'utf8')) as Pool;
      cache = { at: Date.now(), pool };
      return pool;
    } catch { /* следующий путь */ }
  }
  return {};
}

// Ключи пула — это же имена шаблонов генерки. Длинные проверяем первыми, иначе «boyfriend-match»
// и «boyfriend-report» схлопнулись бы в один.
export function templateOf(file: string | null | undefined, srcText?: string | null): string | null {
  const hay = (path.basename(String(file || '')) + ' ' + String(srcText || '')).toLowerCase();
  const keys = Object.keys(loadPool()).filter((k) => !k.startsWith('_')).sort((a, b) => b.length - a.length);
  for (const k of keys) if (hay.includes(k)) return k;
  return null;
}

function pick<T>(arr: T[], n: number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

// Блок, который дописывается к промпту канала. Без шаблона отдаём пусто: пусть работает старый
// промпт канала, это честнее, чем подсунуть образцы не по теме.
export function hookBlock(tpl: string | null): string {
  if (!tpl) return '';
  const pool = loadPool();
  const item = pool[tpl];
  if (!item) return '';
  const krik = (item.крик || []).map((h) => h.т);
  const pov = (item.пов || []).map((h) => h.т);
  const all = [...pick(krik, 4), ...pick(pov, 3)].filter(Boolean);
  if (!all.length) return '';
  return [
    '',
    `ТЕМА РОЛИКА: шаблон «${tpl}».`,
    'ОБРАЗЦЫ ЖИВЫХ НАЗВАНИЙ ДЛЯ ЭТОЙ ТЕМЫ (утверждены владельцем построчно):',
    ...all.map((s) => '  ' + s),
    'Напиши НОВОЕ название в этом же духе и в этом же регистре речи. Не копируй образцы дословно,',
    'но держи их интонацию, длину и знаки. Название обязано подходить именно этой теме.',
  ].join('\n');
}

// Хуки, уже занятые по этому посту на ДРУГИХ площадках. Один пост уходит в тикток, инстаграм,
// ютуб и ВК, и хуки к нему берут разные ветки чата. Без этой сверки на ютуб-заголовок попадала бы
// строка, которая уже стоит подписью в тиктоке: зритель читает одно и то же дважды.
export function postKey(file: string | null | undefined): string {
  return path.basename(String(file || '')).replace(/\.[a-z0-9]+$/i, '');
}
export function takenBlock(taken: string[]): string {
  if (!taken.length) return '';
  return ['', 'ЭТИ ХУКИ ПО ЭТОМУ ЖЕ ПОСТУ УЖЕ ЗАНЯТЫ НА ДРУГИХ ПЛОЩАДКАХ, ПОВТОРЯТЬ НЕЛЬЗЯ:',
    ...taken.map((t) => '  ' + t)].join('\n');
}
export function hookTextById(id: string): string | null {
  const pool = loadPool();
  for (const k of Object.keys(pool)) {
    if (k.startsWith('_')) continue;
    for (const рег of ['крик', 'пов'] as const) {
      const found = (pool[k][рег] || []).find((h) => h.id === id);
      if (found) return found.т;
    }
  }
  return null;
}

export const _forTests = { loadPool };
