// Замок браузера, разбитый ПО GoLogin-аккаунту (тарифу) — семафор с лимитом на ключ.
// Разные аккаунты (акк1 — искатель/радар, акк2 — комменты) = РАЗНЫЕ ключи, идут параллельно.
// Внутри одного аккаунта одновременно можно держать GOLOGIN_CONCURRENCY профилей (по умолчанию 1 —
// как на базовом тарифе). Апнул тариф до N параллельных профилей -> поставь GOLOGIN_CONCURRENCY=N.
// Процесс один (воркер + API), поэтому module-level семафора достаточно.

// === РЕЗЕРВ ДЕЖУРНЫХ СЛОТОВ ===
// Реальный лимит облачных сессий GoLogin-аккаунта = ~10. Раньше GOLOGIN_CONCURRENCY=15 позволял регулярным
// задачам (радар/прогрев/комментинг) занять ВСЕ слоты, и подъём упавших акков голодал. Теперь из общих
// CLOUD_TOTAL слотов дежурству (релогин/подъём/сторож/revive) ЗАРЕЗЕРВИРОВАНО dutyReserve штук: регулярные
// задачи берут не больше (CLOUD_TOTAL − dutyReserve), а дежурные — до CLOUD_TOTAL. В тревогу резерв 3→5.
const CLOUD_TOTAL = Math.max(2, Number(process.env.CLOUD_SESSIONS) || 10);
let dutyReserve = Math.min(CLOUD_TOTAL - 1, Math.max(1, Number(process.env.DUTY_RESERVE) || 3));
let alarmUntil = 0;
export function regularLimit(): number { return Math.max(1, CLOUD_TOTAL - dutyReserve); }
export function dutyLimit(): number { return dutyReserve; }
export function setDutyReserve(n: number): void { dutyReserve = Math.min(CLOUD_TOTAL - 1, Math.max(1, n)); }
// Тревога: поднять резерв дежурства до 5 на срок (мс). По истечении — вернуть к 3. Проверяется лениво.
export function enterAlarm(ms = 30 * 60 * 1000): void { setDutyReserve(5); alarmUntil = Date.now() + ms; }
function checkAlarm(): void { if (alarmUntil && Date.now() > alarmUntil) { alarmUntil = 0; setDutyReserve(Math.max(1, Number(process.env.DUTY_RESERVE) || 3)); } }
export function dutyStatus(): { reserve: number; regular: number; total: number; alarm: boolean } {
  checkAlarm();
  return { reserve: dutyReserve, regular: regularLimit(), total: CLOUD_TOTAL, alarm: alarmUntil > 0 };
}

const active = new Map<string, number>();          // сколько профилей ключа сейчас открыто
const waiters = new Map<string, Array<() => void>>(); // очередь ожидающих на ключ
let pending = 0;                                    // всего ждут в очередях

export function browserBusy(): boolean {
  for (const n of active.values()) if (n > 0) return true;
  return false;
}
export function browserQueue(): number {
  return pending;
}

// Эксклюзивность ПРОФИЛЯ: один GoLogin-профиль нельзя открыть дважды одновременно (иначе вторая сессия
// закрывает браузер первой -> «Target page/browser has been closed» / «net::ERR_ABORTED»). Токен-семафор
// (withBrowserLock) ограничивает ОБЩЕЕ число сессий на аккаунт, но НЕ мешает двум взять один профиль —
// это и ловит резерв ниже. Неблокирующий: занят -> false, вызывающий берёт следующий акк (failover).
const inUseProfiles = new Set<string>();
export function tryReserveProfile(id?: string | null): boolean {
  if (!id) return true;              // нет id — не мешаем
  if (inUseProfiles.has(id)) return false;
  inUseProfiles.add(id);
  return true;
}
export function releaseProfile(id?: string | null): void {
  if (id) inUseProfiles.delete(id);
}

function acquire(key: string): Promise<void> {
  checkAlarm();
  const running = active.get(key) || 0;
  if (running < regularLimit()) { active.set(key, running + 1); return Promise.resolve(); }
  pending++;
  return new Promise<void>((resolve) => {
    const q = waiters.get(key) || [];
    q.push(resolve);
    waiters.set(key, q);
  });
}
function release(key: string): void {
  const q = waiters.get(key);
  if (q && q.length) { pending--; const next = q.shift()!; next(); } // слот передаём ждущему (active не трогаем)
  else active.set(key, Math.max(0, (active.get(key) || 1) - 1));
}

// key — идентификатор GoLogin-аккаунта. ВАЖНО: ключ обязан соответствовать токену, с которым
// реально коннектимся (иначе профили не того аккаунта посчитаются вместе).
export function withBrowserLock<T>(fn: () => Promise<T>, key = 'default'): Promise<T> {
  return acquire(key).then(async () => {
    try {
      return await fn();
    } finally {
      release(key);
    }
  });
}

// СЕМАФОР ВХОДА (внутрипроцессный): логин держит максимум LOGIN_LIMIT сессий разом. Это ЛОКАЛЬНЫЙ кап
// внутри web; ИСТИННЫЙ кросс-процессный потолок (бюджет GoLogin 15: commenting 7 / patrol 3 / logger 3, до 5)
// держит глобальный семафор в БД (gologin.ts claimSlot/gologin_slots) — web и ig-worker считают сумму там.
// Лимит логина = зарезервированная дежурная полоса (dutyLimit(), динамич. 3/5).
let loginActive = 0;
const loginWaiters: Array<() => void> = [];
export function loginSlotsBusy(): number { return loginActive; }
export function withLoginSlot<T>(fn: () => Promise<T>): Promise<T> {
  checkAlarm();
  const acq = loginActive < dutyLimit()
    ? (loginActive++, Promise.resolve())
    : new Promise<void>((resolve) => loginWaiters.push(resolve));
  return acq.then(async () => {
    try {
      return await fn();
    } finally {
      const next = loginWaiters.shift();
      if (next) next(); else loginActive--;
    }
  });
}

// === ЛИМИТ ТАРИФА GoLogin — ЧТОБ ЗНАЛИ ВСЕ СЕССИИ/ЧАТЫ ===
// Тариф держит МАКСИМУМ GOLOGIN_PLAN_SLOTS (15) одновременных облачных сессий на GoLogin-аккаунт.
// GOLOGIN_CONCURRENCY (LIMIT выше) — сколько воркер+панель (один процесс) держат разом; ставь ≤15.
// ВАЖНО: ручные заходы в GoLogin-приложении и внешние скрипты (delacct/suspendcheck/vegress…) идут
// МИМО этого семафора и ТОЖЕ жрут слоты тарифа. Превысил 15 суммарно → лишние сессии падают с
// «Target/browser has been closed». Оставляй ~2-3 слота в запас, если гоняешь скрипты/заходишь руками.
export const GOLOGIN_PLAN_SLOTS = Math.max(1, Number(process.env.GOLOGIN_PLAN_SLOTS) || 15);
// Текущая занятость облачных слотов воркером+панелью (для индикатора в панели). Внешние скрипты тут НЕ видны.
export function slotUsage(): { active: number; limit: number; plan: number; login: number } {
  let a = 0; for (const n of active.values()) a += n;
  // limit берём из env напрямую (не из внутренних констант — их имена в этом файле правит другая сессия).
  return { active: a, limit: Math.max(1, Number(process.env.GOLOGIN_CONCURRENCY) || 1), plan: GOLOGIN_PLAN_SLOTS, login: loginActive };
}
