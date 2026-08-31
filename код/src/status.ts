// Живой статус браузерных операций для панели: что сейчас идёт (прогрев/публикация
// какого аккаунта, сколько секунд) и последние результаты (успех/ошибка + причина).
// Один процесс — module-level состояния достаточно.

interface Current {
  type: string;
  slug: string;
  startedAt: number;
  step?: string; // что именно идёт сейчас (для живой строки статуса)
}
interface Result {
  slug: string;
  type: string;
  ok: boolean;
  error: string | null;
  summary: unknown;
  at: number;
}

let current: Current | null = null;
const recent: Result[] = [];

export function startActivity(type: string, slug: string): void {
  current = { type, slug, startedAt: Date.now() };
}

// Обновить «что сейчас делаем» (запускаю gologin / вошёл / пишу коммент …) — для живой строки.
export function updateActivity(step: string): void {
  if (current) current.step = step;
}

export function finishActivity(ok: boolean, error: string | null = null, summary: unknown = null): void {
  if (!current) return;
  recent.unshift({ slug: current.slug, type: current.type, ok, error, summary, at: Date.now() });
  if (recent.length > 20) recent.length = 20;
  current = null;
}

export function getStatus() {
  const now = Date.now();
  return {
    current: current
      ? { type: current.type, slug: current.slug, step: current.step ?? null, elapsedSec: Math.floor((now - current.startedAt) / 1000) }
      : null,
    recent: recent.slice(0, 8).map((r) => ({ ...r, agoSec: Math.floor((now - r.at) / 1000) })),
  };
}
