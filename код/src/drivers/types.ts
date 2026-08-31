import type { Page } from 'playwright-core';

// Единый контракт площадки. Каждый драйвер (tiktok/threads/youtube/instagram)
// реализует его одинаково — поэтому воркер и прогрев работают с любой площадкой,
// а драйвер Никиты по Threads встаёт рядом как ещё один такой же кубик.

export interface PublishInput {
  caption: string;
  mediaUrl?: string;
  mediaType?: 'VIDEO' | 'IMAGE' | 'TEXT';
  replyText?: string; // ссылка/пруф в первом комменте, НЕ в теле поста
  // Готовые байты медиа (уже уникализированные воркером). Если заданы —
  // грузим их напрямую, mediaUrl не качаем.
  media?: { name: string; mimeType: string; buffer: Buffer };
}

export interface PublishResult {
  externalUrl?: string;
  // true, если клик «Опубликовать» уже прошёл, но подтверждение не дождались.
  // Воркер НЕ ретраит такой пост (grabli #7) — помечает «проверь руками».
  maybePublished?: boolean;
}

export type PrimarySignal = 'watch_time' | 'reply_velocity' | 'scroll';

// Профиль поведения прогрева — у каждой площадки свой главный сигнал.
// TikTok/YouTube = время просмотра, Threads = reply velocity, Instagram = скролл.
export interface WarmupProfile {
  feedUrl: string;
  primarySignal: PrimarySignal;
  screensPerSession: [number, number]; // [min, max]
  dwellMs: [number, number];           // сколько «смотреть» ролик/пост
  likeChance: number;                  // 0..1 на экран
  followChance: number;                // 0..1 на сессию
  commentChance: number;               // 0..1 — применяется ТОЛЬКО если warmup_comments=true
  // Ниша-прицел: тематические хэштеги/запросы, чтобы алгоритм отнёс аккаунт
  // к russophone+ИИ пулу (тогда первые посты сеются в правильную аудиторию).
  nicheQueries: string[];
  selectors: Record<string, string[]>;
}

export interface PlatformDriver {
  platform: string;
  // Мультиязычные маркеры разлогина (UI на языке страны прокси).
  isLoggedOut(page: Page): Promise<boolean>;
  // Прочитать ник/аватар/био профиля (best-effort). Подтягиваем после постинга.
  getProfileInfo?(page: Page): Promise<{ nick?: string; avatarUrl?: string; bio?: string } | null>;
  // Полный флоу публикации со всеми граблями площадки.
  publish(page: Page, input: PublishInput): Promise<PublishResult>;
  warmup: WarmupProfile;
}

// Сессия отозвана площадкой -> аккаунт в dead + алерт. Логиниться программно НЕЛЬЗЯ.
export class SessionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SessionError';
  }
}

// Капча = человек в цикле. Бот её НЕ решает (это и ToS, и сам по себе бан-вектор).
// Аккаунт ставится на паузу, владелец чистит капчу руками в десктоп-приложении GoLogin.
export class CaptchaError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CaptchaError';
  }
}
