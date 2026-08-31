import { query } from './db/index.js';

// Антибан-расписание. Прайм-слоты по таймзоне АУДИТОРИИ (CEST), джиттер, ночная
// тишина, min-gap между любыми постами всей сетки, лимит прогрева.

const PRIME_HOURS = [9, 13, 19, 21];
const NIGHT_START = 2; // 02:00–07:00 CEST не постим
const NIGHT_END = 7;
const NETWORK_MIN_GAP_MS = 25 * 60 * 1000; // 25 мин между ЛЮБЫМИ постами сетки
const JITTER_MS = 20 * 60 * 1000; // ±20 мин
const CEST_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2 (CEST, летнее европейское)

const localHour = (d: Date) => new Date(d.getTime() + CEST_OFFSET_MS).getUTCHours();
const jitter = () => (Math.random() * 2 - 1) * JITTER_MS;

// Ближайший разрешённый прайм-слот с джиттером, начиная с `from`.
export function nextSlot(from: Date): Date {
  const cand = new Date(from.getTime());
  for (let step = 0; step < 24 * 14; step++) {
    const h = localHour(cand);
    if (PRIME_HOURS.includes(h) && !(h >= NIGHT_START && h < NIGHT_END)) {
      const withJitter = new Date(cand.getTime() + jitter());
      if (withJitter > from) return withJitter;
    }
    cand.setTime(cand.getTime() + 60 * 60 * 1000); // +1 час
  }
  return new Date(from.getTime() + 60 * 60 * 1000);
}

// Прошло ли достаточно времени с последнего поста ВСЕЙ сетки (min-gap).
export async function networkGapClear(now: Date): Promise<boolean> {
  const { rows } = await query<{ last: Date | null }>(
    `SELECT max(published_at) AS last FROM posts WHERE published_at IS NOT NULL`,
  );
  const last = rows[0]?.last;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= NETWORK_MIN_GAP_MS;
}

// Не ночь ли сейчас по CEST.
export function isNightNow(now: Date): boolean {
  const h = localHour(now);
  return h >= NIGHT_START && h < NIGHT_END;
}

// Лимит прогрева: первые ~14 дней аккаунта — максимум 1 пост/сутки.
export function warmupDay(warmupStartedAt: Date | null, now: Date): number {
  if (!warmupStartedAt) return 999;
  return Math.floor((now.getTime() - new Date(warmupStartedAt).getTime()) / (24 * 3600 * 1000)) + 1;
}

// Дней прогрева до первого поста по типу аккаунта: новорег ~8, купленный ~6.
export function warmingDaysFor(type: string | null | undefined): number {
  return type === 'bought' ? 6 : 8;
}

// Порог дня, с которого в прогреве разрешены СВОИ комменты. 0 = сразу (акки КУПЛЕННЫЕ, с историей —
// им прогрев «сначала только смотрим» не нужен, как свежерегам). Радар-ответы этим порогом и так не гейтятся.
export const COMMENT_START_DAY = 0;
