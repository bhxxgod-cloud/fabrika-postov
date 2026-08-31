// МОСТ К ЕДИНОМУ ПРЕДОХРАНИТЕЛЮ ПУБЛИКАЦИИ (`postguard.cjs` в корне репозитория).
//
// ЗАЧЕМ отдельный файл, а не своя проверка на TS: предохранитель написан на CommonJS, потому что
// его зовут локальные скрипты на маке (планировщик postdaemon, раздатчики, публикатор igpost2).
// Если облако будет судить аккаунты по своим правилам, а мак по своим, мы вернёмся ровно в тот
// день, когда cherry.mood59 получил 25 заходов в аккаунт с ограничением от Instagram: каждый
// источник задач пропускал его по собственному набору проверок. Поэтому облако зовёт ТОТ ЖЕ файл
// через createRequire (приём уже используется в src/index.ts и src/uniquify.ts).
import { createRequire } from 'node:module';
import { query } from './db/index.js';

const requireCjs = createRequire(import.meta.url);

export type PostVerdict = {
  ok: boolean;
  hard: boolean;   // true = безопасность аккаунта (обойти нельзя), false = темп (лимит/интервал)
  code: string;
  reason: string;
};

type GuardModule = {
  canPost: (slugOrId: string, opts: Record<string, unknown>) => Promise<PostVerdict>;
};

// Предохранителю отдаём наш пул через функцию q(sql, params) — своё соединение он не открывает.
export async function canPost(slug: string, stage: 'queue' | 'run' = 'queue'): Promise<PostVerdict> {
  try {
    const guard = requireCjs('../postguard.cjs') as GuardModule;
    return await guard.canPost(slug, {
      query: (sql: string, params?: unknown[]) => query(sql, params),
      stage,
    });
  } catch (e) {
    // Предохранитель не отработал (файл не уехал в образ, битый SQL) — это НЕ повод постить
    // вслепую. Молчаливое «раз проверка сломалась, значит можно» и есть способ навредить аккаунтам.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, hard: true, code: 'guard_error', reason: `предохранитель не отработал: ${msg.slice(0, 160)}` };
  }
}
