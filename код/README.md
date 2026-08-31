# Нейронка · Постер

Мультиплатформенный автопостер под органику (TikTok / Threads / YouTube / Instagram)
через облачный браузер **GoLogin** + Playwright. Standalone-сервис: воркер публикует
по антибан-расписанию, прогревает аккаунты, ведёт воронку атрибуции и A/B-когорты.

Архитектура — по гайду Никиты (`threads-autoposter-guide.md`): человек один раз руками
логинится в аккаунт в десктопном GoLogin, пароли нигде не хранятся, бэкенд цепляется к
облачному браузеру по CDP и водит веб-морду как человек.

## Структура

```
src/
  gologin.ts          общий слой: облачное подключение (wss) + двухуровневая проверка сессии
  drivers/
    types.ts          контракт площадки (PlatformDriver) + SessionError/CaptchaError
    tiktok.ts         драйвер TikTok (аплоадер TikTok Studio + профиль прогрева)
    threads.ts        разъём под постер Никиты
    youtube.ts        YouTube Shorts (заготовка)
    instagram.ts      Instagram Reels (заготовка)
    index.ts          реестр драйверов (выбор по platform)
  warmup.ts           движок прогрева (главный сигнал площадки + флаг warmup_comments)
  scheduler.ts        антибан-расписание (прайм-слоты, джиттер, ночь, min-gap, лимит прогрева)
  worker.ts           три тика: публикация / проверка сессий / прогрев
  ai.ts               генерация текста (Anthropic) и картинок/видео (API neironka.pro)
  api.ts              REST + приём событий воронки + отдача панели
  auth.ts             вход оператора (пароль + подписанная кука)
  db/
    schema.sql        Postgres-схема (accounts с cohort/warmup_comments, posts, funnel_events, warmup_log)
    index.ts, migrate.ts
public/               панель (index.html + login.html)
docs/
  tiktok-poster.reference.ts   ЭТАЛОННЫЙ хардненный TikTok-постер (гео-префлайт, контракт ретраев)
  TIKTOK_GOLOGIN.md            гайд-адаптация под TikTok (RU)
```

> `docs/tiktok-poster.reference.ts` — усиленная версия TikTok-флоу (после состязательного
> ревью): гео-префлайт (с RU-IP заливка невозможна), поллинг-детект успеха, пер-аккаунтная
> гуманизация. Из него берётся боевой флоу; `src/drivers/tiktok.ts` — его адаптация под интерфейс.

## Как срастить с сайтом Никиты

- **Свободно (быстро):** сервис поднимает REST (`POST /api/posts`, `GET /api/accounts`,
  `POST /api/funnel`), сайт зовёт эти ручки. Общая база Postgres — схема совпадает.
- **Тесно:** драйвер площадки (`drivers/*.ts`) с единым интерфейсом переносится в воркер
  Никиты как ещё один кубик — драйвер-интерфейс уже общий.

## Локальный запуск

```bash
npm install
cp .env.example .env   # заполнить GOLOGIN_API_TOKEN, DATABASE_URL, DASHBOARD_PASSWORD, ANTHROPIC_API_KEY
npm run migrate
npm start              # панель на http://localhost:3000
```

## Деплой на Railway

```bash
railway init
railway add            # добавить плагин Postgres (даст DATABASE_URL)
railway up
railway variables --set "GOLOGIN_API_TOKEN=..." --set "DASHBOARD_PASSWORD=..." \
  --set "SESSION_SECRET=..." --set "ANTHROPIC_API_KEY=..."
railway domain
```

Миграция гоняется автоматически перед стартом (`railway.json`: `npm run migrate && npm start`).
Healthcheck — `/health`.

## Чек-лист запуска аккаунта

1. Купить sticky мобильный прокси (страна с рабочей загрузкой; для TikTok — Казахстан, НЕ РФ).
2. Создать профиль GoLogin, навесить прокси, войти в аккаунт руками → **Stop** профиля.
3. Завести аккаунт в панели: `platform`, `slug`, `gologin_profile_id`, `tracking_code`,
   `cohort` (A/B), `warmup_comments`.
4. Статус `warming` → прогрев пойдёт сам ~14 дней, посты с 8-го дня 1/сутки.
5. Через 14 дней перевести в `active`.
