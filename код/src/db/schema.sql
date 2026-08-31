-- Схема мультиплатформенного постера.
-- Одна таблица аккаунтов на все площадки (различаются полем platform),
-- одна очередь постов, воронка событий для атрибуции, лог прогрева для A/B.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- === Аккаунты-персоны ===
CREATE TABLE IF NOT EXISTS accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform           text NOT NULL,                 -- tiktok | threads | youtube | instagram
  slug               text NOT NULL,                 -- ключ персоны, уникален в рамках площадки
  display_name       text,
  handle             text,                          -- @-хендл

  -- Голос персоны (для генерации текста)
  persona            text,
  system_prompt      text,                          -- промпт «голоса»
  gender             text,                          -- влияет на род в русском: делала/делал
  tone               text,

  -- Привязка к антидетект-браузеру
  gologin_profile_id text,
  proxy              jsonb,                          -- { type, country, host, ... } — sticky на профиль

  -- Жизненный цикл
  status             text NOT NULL DEFAULT 'warming',-- warming | active | paused
  posts_per_day      int  NOT NULL DEFAULT 1,

  -- Сессия (двухуровневая проверка: быстрая по кукам + глубокая через браузер)
  session_status     text NOT NULL DEFAULT 'unknown',-- unknown | live | dead
  session_checked_at timestamptz,

  -- Прогрев
  warmup_started_at  timestamptz,                   -- от неё считаем «день N из 14»
  warmup_at          timestamptz,                   -- когда последний раз грелся (троттлинг в БД, не в памяти)

  -- A/B-когорты прогрева: единственная разница между группами — warmup_comments
  cohort             text,                          -- 'A' | 'B' | NULL (не в эксперименте)
  warmup_comments    boolean NOT NULL DEFAULT false,-- писать ли комменты в прогреве

  -- Атрибуция: ссылка https://neironka.pro/go/<tracking_code>
  tracking_code      text,

  last_posted_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (platform, slug)
);

-- === Очередь постов ===
CREATE TABLE IF NOT EXISTS posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform       text NOT NULL,                     -- денормализовано для выборок воркера

  kind           text,                              -- формат: находка | вопрос | туториал | до-после ...
  status         text NOT NULL DEFAULT 'draft',     -- draft|approved|publishing|published|failed|skipped

  caption        text,
  media_url      text,
  media_type     text,                              -- VIDEO | IMAGE | TEXT
  reply_text     text,                              -- ссылка/пруф в первом комменте (не в теле поста)

  scheduled_at   timestamptz,
  published_at   timestamptz,
  external_url   text,                              -- ссылка на опубликованный пост

  -- Инвариант «после клика Опубликовать ретраи запрещены» (grabli #7)
  post_submitted boolean NOT NULL DEFAULT false,

  attempts       int NOT NULL DEFAULT 0,
  locked_at      timestamptz,                       -- аренда поста воркером (протухает за 10 мин)
  error          text,
  meta           jsonb,                             -- скриншоты сбоев [{label,url}], доп. данные

  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posts_due
  ON posts (status, scheduled_at)
  WHERE status = 'approved';

-- === Воронка атрибуции ===
-- Сайт neironka.pro шлёт сюда события по tracking_code персоны:
-- клик по ссылке -> регистрация -> оплата. Так пост привязывается к выручке.
CREATE TABLE IF NOT EXISTS funnel_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_code text NOT NULL,
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
  event_type    text NOT NULL,                      -- click | registration | payment
  revenue_cents int  NOT NULL DEFAULT 0,            -- для payment; в копейках, чтобы без float
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funnel_code ON funnel_events (tracking_code);
CREATE INDEX IF NOT EXISTS idx_funnel_account ON funnel_events (account_id);

-- === Лог прогрева ===
-- Нужен, чтобы честно сравнить A/B: сколько реальной активности было в каждой когорте.
CREATE TABLE IF NOT EXISTS warmup_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action     text NOT NULL,                         -- watch | like | follow | comment | captcha | error
  meta       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warmup_account ON warmup_log (account_id, created_at);

-- === Миграции колонок (идемпотентно) ===
-- Тип аккаунта: 'new' (новорег) | 'bought' (купленный). Влияет на длину прогрева
-- и день первого поста: новорег ~12-14 дней, купленный ~5-6.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'new';

-- Здоровье прокси: через какой IP/страну реально выходит профиль (замер в прогреве).
-- proxy_status: 'unknown' | 'ok' (гео совпало) | 'mismatch' (гео не то) | 'dead' (не замерили).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS egress_ip text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS egress_country text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS egress_checked_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_status text NOT NULL DEFAULT 'unknown';

-- === Загруженные видео (оригинал хранится один раз) ===
-- Каждый пост ссылается на оригинал + свой сид уникализации, поэтому одно
-- исходное видео на N аккаунтов = N разных файлов (генерятся при публикации).
CREATE TABLE IF NOT EXISTS media_uploads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename   text,
  mime       text,
  bytes      bytea NOT NULL,
  size_bytes int,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_upload_id uuid REFERENCES media_uploads(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS uniquify_level text NOT NULL DEFAULT 'none'; -- none | medium | max
ALTER TABLE posts ADD COLUMN IF NOT EXISTS uniquify_seed bigint;

-- === Группы аккаунтов (рабочий стол = пачки по 5-10-15 акков) ===
CREATE TABLE IF NOT EXISTS account_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  geo                text,                              -- страна пачки (KZ и т.п.)
  note               text,                              -- особенности: «покупные», «новорег» ...
  created_at         timestamptz NOT NULL DEFAULT now(),
  launched_at        timestamptz,                       -- когда запущена в работу
  warmup_started_at  timestamptz                        -- когда начат прогрев пачки
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES account_groups(id) ON DELETE SET NULL;
-- Комменты в прогреве задаём на уровне ГРУППЫ (тестим когортами): акки группы наследуют.
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS warmup_comments boolean NOT NULL DEFAULT false;
-- Свой GoLogin API-токен на группу: если её акки живут в ОТДЕЛЬНОМ GoLogin-аккаунте.
-- Воркер берёт токен группы, иначе глобальный из env. NULL = глобальный.
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS gologin_token text;

-- Площадка группы: группа принадлежит одной вкладке (tiktok/comments/…), чтобы TikTok-группа
-- не показывалась на вкладке «Комменты» и наоборот. Бэкфилл существующих: доминирующая
-- площадка её акков, пустым — 'tiktok' (все старые группы созданы под TikTok). Гард
-- `WHERE platform IS NULL` → идемпотентно, не трогает уже проставленные группы.
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS platform text;
-- Роль группы в конвейере комментинга (начальник 23.07): worker=работяги (ворк-лист),
-- watcher=сторожи (шнырь+дежурный на своих креаторах), cleaner=уборщики (дочистка/перепост провалов),
-- brand=брендбук-лица (премиум, только бренд топ-левел), claque=подсипаки (лайкают наши + «спасибо»).
-- Аноним-наблюдатель (читатель+шедоу-чекер) НЕ группа (без логина, анлим-прокси). Воркер берёт акк под роль.
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'worker';
UPDATE account_groups g SET platform = COALESCE(
  (SELECT a.platform FROM accounts a WHERE a.group_id=g.id GROUP BY a.platform ORDER BY count(*) DESC LIMIT 1),
  'tiktok'
) WHERE platform IS NULL;
-- После скоупинга: акк, чья площадка ≠ площадке его группы, «пропал бы» с рабочего стола
-- (его карточка рисуется только внутри карточки группы, а группа теперь на другой вкладке).
-- Отвязываем такие акки в «Без группы» — там они видимы и переназначаемы. Идемпотентно.
UPDATE accounts a SET group_id = NULL
  FROM account_groups g
  WHERE a.group_id = g.id AND a.platform <> g.platform;

-- === Ферма комментов (промо-сидинг под чужими постами) ===
-- Настройки на уровне ГРУППЫ: включён ли сидинг, по каким хэштегам, лимит/день.
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS seed_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS seed_hashtags text;      -- через запятую: нейросети,ai art
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS seed_per_day int NOT NULL DEFAULT 3;
-- Аккаунт-сторож: группа сидит в лайве, ловит новые комменты под нашим постом и сразу отвечает (реагируем первыми).
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS watchdog boolean NOT NULL DEFAULT false;
-- Когда акк последний раз ПЫТАЛСЯ комментить (обновляем при ЛЮБОМ исходе) — чтобы
-- провальный акк не монополизировал слот (иначе last_seed по успехам = вечный NULL).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS seed_at timestamptz;

-- === Ферма комментов через приватный API (Python-воркер instagrapi) ===
-- Куки + прокси + UA на аккаунт. Воркер заходит по этим кукам, без браузера.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_cookies jsonb;       -- экспорт куки (массив как из браузера)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_proxy text;          -- прокси акка: host:port:user:pass
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_user_agent text;     -- UA/девайс для консистентности
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_status text;         -- login_ok | challenge | 2fa | bad_login | bad_cookies | banned | null
-- Роль: 'reader' = аккаунт-искатель для радара (только читает хэштеги), НЕ комментит и
-- НЕ мешается с комментаторами. Вход по логин+паролю (для личного акка без кук) или по кукам.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_role text;           -- 'reader' | null (комментатор)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_login text;          -- юзернейм для входа по паролю
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_password text;       -- пароль (плейнтекст: воркеру нужно перелогиниваться)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_session jsonb;       -- кэш сессии instagrapi (чтобы не логиниться каждый раз)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_secret text;       -- 2FA-сид (base32, без пробелов) — код считаем сами (TOTP), показываем в панели
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_email text;          -- почта акка (восстановление)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_email_password text; -- пароль почты (плейнтекст)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS acc_no int;             -- № акка (слот) в группе для удобства; освободившийся переиспользуется (бэкфилл — отдельным скриптом)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS login_fails int DEFAULT 0; -- неудачных авто-входов подряд; >=3 → пауза (чтобы не жечь акк спам-логинами)

-- Пульс Python-воркера — чтобы в панели видеть, что он живой и что делает.
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  worker    text PRIMARY KEY,        -- 'ig_comment'
  last_seen timestamptz,
  status    text,                    -- что делает сейчас
  note      text
);

-- Лог промо-комментов: что, где, виден ли (проверка shadowban).
CREATE TABLE IF NOT EXISTS seed_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  target_url  text,                          -- под каким постом
  text        text,                          -- сам коммент
  visible     boolean,                       -- прошёл ли (проверка видимости): null=не проверяли
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seed_account ON seed_comments (account_id, created_at);

-- Профиль из TikTok (подтягиваем после постинга): ник, аватар, описание.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tt_nick text;      -- @-хендл (латиница)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tt_name text;      -- отображаемое имя (по-русски)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tt_avatar_url text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tt_bio text;

-- === РАДАР: поиск релевантных постов (НЕ автокоммент) ===
-- Воркер читает хэштеги (recent), смотрит картинку через vision-модель + комменты на
-- спрос «как/где/чем сделал», ранжирует и КЛАДЁТ В ПАНЕЛЬ. Комментит человек сам, открыто.
CREATE TABLE IF NOT EXISTS radar_config (
  id        int PRIMARY KEY DEFAULT 1,
  tags      text,                              -- хэштеги через запятую (напр. промпт, нейросети)
  enabled   boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO radar_config (id, tags) VALUES (1, 'промпт, нейросети, нейровидео')
  ON CONFLICT (id) DO NOTHING;
-- Твоя строка про нейронку для драфтера ответов (постишь сам, открыто).
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS reply_text text;
UPDATE radar_config SET reply_text = 'делал в нейронке про 🙌 (neironka.pro — там всё в куче, без впн)' WHERE id=1 AND reply_text IS NULL;
-- АВТО-РАЗДАЧА: бот сам отдаёт найденный пост со спросом отдохнувшему акку под лимитом и комментит.
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS auto_reply boolean NOT NULL DEFAULT false;
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS daily_limit int NOT NULL DEFAULT 14;      -- комментов/сутки на акк
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS min_gap_min int NOT NULL DEFAULT 25;      -- минут между комментами акка
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS auto_askers int NOT NULL DEFAULT 3;       -- скольким людям отвечать в авто
-- Счётчик комментов на акк за сутки (для лимита/ротации) + когда последний раз комментил (отдых).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS comments_today int NOT NULL DEFAULT 0;
-- ОФОРМЛЕНИЕ АККА (dressup.cjs): авка + отображаемое имя + био. Ставится ПОСЛЕ первого входа, ДО прогрева и
-- комментинга (акк-«яйцо» ловит action_block на первом же комменте). Имя в новом IG правится через Meta
-- Accounts Center (/profiles/{id}/name/), на /accounts/edit/ поля имени больше нет. Ник (@username) НЕ меняем:
-- он же логин-креденшл (ig_login) + лимит IG 2 смены/14 дней.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dressed_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_set boolean;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bio_set boolean;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nick_changed_at timestamptz;
-- ПРИОРИТЕТ ОФОРМЛЕНИЯ (решение владельца 28.07): человек, открывая профиль, видит АВУ и НИК — их меняем первыми,
-- био/имя вторично. Ник подбирается ПОД КАТЕГОРИЮ АВЫ (аниме-ава → аниме-ник), иначе диссонанс.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_login_old text;      -- прежний @ник (откат, если смена сломала вход)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_cat text;        -- категория авы: anime|girly|car|nature|city|animals|mood|popculture
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_file text;       -- имя файла (одна картинка = один акк, дедуп)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_thumb text;      -- base64-миниатюра для карточки в панели

-- НАБЛЮДАЕМОСТЬ ОФОРМЛЕНИЯ ИЗ ПАНЕЛИ (владелец 28.07: «это всё проверять с окна сайта»).
-- dressup пишет сюда исход последней попытки: статус, человеческую причину и СКРИНШОТ последнего экрана,
-- чтобы не лазить в логи на маке и видеть глазами, на чём споткнулись (логин/2FA/попап/чек-поинт).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dress_status text;   -- ok | bad_creds | checkpoint | 2fa_fail | no_edit | error
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dress_error text;    -- короткая причина по-русски
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dress_step text;     -- на каком шаге встали
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dress_shot text;     -- base64-скрин последнего экрана (мелкий)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dress_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_avatar_file ON accounts (avatar_file) WHERE avatar_file IS NOT NULL;

-- === ЗДОРОВЬЕ АККА (гейт постинга, 01.08) =====================================================
-- Урок: постили на акк, у которого IG уже удалил контент за спам и добавил restriction. Теперь
-- ighealth.cjs читает /accounts/account_status/ и кладёт вердикт сюда; постер igpost2 при
-- health_state='restricted' не постит, а возвращает ролик в очередь.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_state text;        -- ok | defect | restricted | banned | no_session | unknown | error
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_note text;         -- человеческая причина (цитата IG)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;
-- === ЕДИНЫЙ ЧЕК СНАРУЖИ (accheck.cjs, 06.08) ==================================================
-- Повод: у damari1735 на аватарке была ЧУЖАЯ девушка, а в постах модель Анечка; имя профиля
-- техническое «Damari», био пустое. Ни один чек этого не поймал, потому что никто не сравнивал
-- ЛИЦО. accheck.cjs читает профиль анонимно и сверяет лицо авы с refs/<персона>.jpg и с лицами
-- в ленте. Итог: health_state='defect' + человеческий health_note.
-- ВАЖНО: 'defect' — информационный статус, он НЕ гейт (постинг режут только 'restricted' и
-- терминальные ig_status), иначе одна косметическая придирка заморозила бы всю ферму.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS face_state text;          -- ok | mismatch | no_face | no_ref | unknown
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS followers_count int;      -- подписчиков на момент последнего чека
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS followers_prev int;       -- сколько было чеком раньше (динамика)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS posts_count int;          -- постов в ленте снаружи (не по нашей таблице posts)
-- С какого адреса акк реально выходил в последний раз. Встроенный прокси GoLogin — ОБЩИЙ пул,
-- «регион uk» ничего не говорит о репутации конкретного IP, а разбор банов должен опираться на факт.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_egress_ip text;
-- У модели ОДИН основной акк + запасные (страховка от шэдоубана, решение владельца 01.08).
-- Запасной получает ту же персону, но is_spare=true: постер по умолчанию берёт основной.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_spare boolean NOT NULL DEFAULT false;
-- 1 модель = 1 ОСНОВНОЙ аккаунт (запасные под индекс не попадают).
DROP INDEX IF EXISTS uq_accounts_persona;
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_persona_main
  ON accounts (persona) WHERE persona IS NOT NULL AND persona <> '' AND deleted_at IS NULL AND is_spare = false;
-- МОСТ ПАНЕЛЬ→МАК: панель (облако) кладёт задачу, localrunner.cjs на маке выполняет ЛОКАЛЬНО (0 облачных часов
-- GoLogin) и пишет результат. mode: 'dress' (оформление) | 'brand' (бренд-комменты) | 'comments'.
CREATE TABLE IF NOT EXISTS local_jobs (
  id         bigserial PRIMARY KEY,
  slug       text,
  mode       text,
  n          int,
  urls       text,
  proxy      text,
  status     text DEFAULT 'queued',   -- queued | running | done | failed
  result     text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_local_jobs_status ON local_jobs (status, id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS comments_day date;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_commented_at timestamptz;
-- Брендовый коммент для сценария ответа (к нему бот отвечает веткой с промптом).
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS brand_comment text;
UPDATE radar_config SET brand_comment = 'все работает топ 🔥 делал в нейронка про, найдёте в яндексе' WHERE id=1 AND brand_comment IS NULL;
-- НАШ промпт: постится веткой ВСЕГДА (если в комментах готового не нашли — берём этот). Редактируемый.
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS default_prompt text;
UPDATE radar_config SET default_prompt = 'ультрареалистичный кинематографичный портрет, естественная текстура кожи, мягкий дневной свет из окна, снято на телефон 35мм, лёгкое плёночное зерно, винтажная атмосфера, чёткие выразительные глаза' WHERE id=1 AND default_prompt IS NULL;
-- Без длинного тире (по нему палят бота) — чиним ранее сохранённый дефолт.
UPDATE radar_config SET brand_comment = 'все работает топ 🔥 делал в нейронка про, найдёте в яндексе' WHERE id=1 AND brand_comment LIKE '%—%';
-- AUTOSCAN (режим 2): сайт сам сканит найденные посты в фоне (autoscan.cjs) → карточка приходит с тиром/спросом.
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS autoscan_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS radar_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text UNIQUE,                   -- шорткод поста (дедуп)
  tag           text,                          -- по какому хэштегу нашли
  url           text,
  image_url     text,
  caption       text,
  like_count    int,
  comment_count int,
  taken_at      timestamptz,                   -- когда опубликован пост
  demand_hits   int NOT NULL DEFAULT 0,        -- сколько «как/где/чем сделал» в комментах
  vision_summary text,                         -- что на картинке (vision-модель)
  last_comment_at timestamptz,                 -- дата последнего коммента (живость поста)
  relevance     int NOT NULL DEFAULT 0,        -- 0-100 насколько релевантен нейронке
  score         int NOT NULL DEFAULT 0,        -- итоговый ранг (свежесть+спрос+релевантность)
  status        text NOT NULL DEFAULT 'new',   -- new | reviewed | dismissed
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_score ON radar_posts (status, score DESC);
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS last_comment_at timestamptz;
-- Заранее сгенерённые варианты ответа (чтобы в композере не ждать «генерирую…»).
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS variants jsonb;
-- Сгенерённый под пост промпт (если в комментах готового не нашли — постим этот).
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS gen_prompt text;
-- Простой сквозной номер поста (#1, #2 …) для истории/сопоставления + пометка ручного добавления.
CREATE SEQUENCE IF NOT EXISTS radar_post_seq;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS seq bigint;
-- ПУЛ ОТРАБОТКИ: пост, взятый в работу (кнопка 🚀 в панели или подтверждение вирал-уведа). queued_at
-- NOT NULL = «в работе». hot_alerted — вирал-увед (10+ комментов/2ч) уже слался, не спамим повторно.
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS queued_at timestamptz;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS hot_alerted boolean NOT NULL DEFAULT false;
-- ДОКОММЕНТ: сколько комментов было на посту, когда мы его ОТРАБОТАЛИ (снапшот при успешном ответе).
-- Прирост (текущее - worked_count) = новые комменты после нас → повод докомментить. recomment_at —
-- когда последний раз слали увед «докомментить» (троттлинг, не чаще ~6ч на пост).
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS worked_count int;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS recomment_at timestamptz;
-- ОБУЧЕНИЕ/УПРАВЛЕНИЕ (юзер объясняет решения — бот учится):
--  dismiss_reason  — почему «не то» (учимся не брать похожее);
--  rating_note     — почему поставил такую оценку 1-10 (сигнал качества);
--  work_instructions — «в работу с условием»: что сделать с постом и почему (директива движку).
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS dismiss_reason text;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS rating_note text;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_instructions text;
-- work_* — параметры запуска поста из модалки радара (владелец задаёт на «▶ Запуск»):
--  work_accounts — сколько акков; work_perpost — ответов на акк; work_brand — ставить ли бренд-топ (bool);
--  work_cta — слово-триггер автора (LLM расширяет на похожие) → комментаторы с ним = лиды;
--  work_target — ПЛАН по комментам: всего ответов людям на пост (движок стопает по достижении; 0/NULL = без лимита).
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_accounts int;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_perpost int;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_brand boolean;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_cta text;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_target int;
-- manual_tier — тир, выставленный владельцем РУКОЙ на карточке (tier1-4); перебивает авто-scan_tier. По нему движок
-- и модалка выбирают способ комментинга (сколько акков/ответов/весь ли спрос). NULL = авто (по scan_tier).
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS manual_tier text;
-- work_dest — КУДА ведём комменты на этом посту: 'site' (нейронка про, дефолт) или 'bot' (тг-бот @gener7_bot).
-- vcomment по нему выбирает пул фраз (env POOL_DEST). Те же акки могут комментить и бота, и сайт.
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS work_dest text;
-- АУДИО-ТРЕНД: тренды снимают под ОДНУ песню. Копим audio_id + название саунда с трендовых рилсов —
-- потом сканим аудио-страницу (instagram.com/reels/audio/{id}) = поток СВЕЖИХ рилсов того же тренда
-- (keyword-поиск отдаёт старьё, аудио — свежак). radar_audios — отслеживаемые трендовые саунды.
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS audio_id text;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS audio_title text;
CREATE TABLE IF NOT EXISTS radar_audios (
  audio_id   text PRIMARY KEY,
  title      text,
  seen_count int NOT NULL DEFAULT 1,       -- на скольки трендовых постах встретился (популярность саунда)
  enabled    boolean NOT NULL DEFAULT true, -- сканить его аудио-страницу
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
UPDATE radar_posts SET seq = nextval('radar_post_seq') WHERE seq IS NULL;
ALTER TABLE radar_posts ALTER COLUMN seq SET DEFAULT nextval('radar_post_seq');
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS source text;  -- 'manual' — добавлен руками
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS recent_comments int NOT NULL DEFAULT 0;  -- комментов за 2 дня (живость)
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS rechecked_at timestamptz;  -- когда пост перечитывали (для чистки утонувших)
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS rating int;  -- оценка поста 1-10 от юзера (обучение: качество фраз -> вес в скоринге)
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS dm_bait boolean DEFAULT false; -- креатор ловит лиды в ЛС (гайд/промпт в директ) -> топим в выдаче
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS author_replies int DEFAULT 0;  -- сколько раз автор отвечает в комментах (много -> спрос отвечен, нам места нет)

-- Очередь ответов из радара: с ЛИЧНОГО акка нейронки пишем коммент под найденным постом.
-- Юзер выбирает акк + текст в панели -> воркер постит по одному (через замок акк2).
CREATE TABLE IF NOT EXISTS radar_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_code   text NOT NULL,                       -- radar_posts.code
  post_url    text NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',      -- pending | posted | failed
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  posted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_radar_replies_pending ON radar_replies (status, created_at) WHERE status='pending';

-- Отслеживаемые креаторы: ловим их НОВЫЕ посты, чтобы прокомментировать первым.
CREATE TABLE IF NOT EXISTS radar_creators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text UNIQUE NOT NULL,           -- @-хендл без собаки
  url         text,
  last_codes  jsonb,                          -- недавние шорткоды постов (для детекта нового)
  note        text,
  enabled     boolean NOT NULL DEFAULT true,
  checked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- === СТОРОЖИ: baseline комментов креатора + здоровье чтения (для детекта спайка) ===
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS post_history   jsonb   NOT NULL DEFAULT '[]'; -- [{code,cc,ts}] последних постов
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS baseline_cc    numeric;                        -- медиана комментов = норма креатора
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS avg_interval_h numeric;                        -- средний интервал между постами (ч)
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS read_fails     int     NOT NULL DEFAULT 0;      -- подряд фейлов чтения грида
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS cr_status      text    NOT NULL DEFAULT 'ok';   -- ok | unreadable | banned
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS last_post_at   timestamptz;                     -- когда замечен последний пост
ALTER TABLE radar_creators ADD COLUMN IF NOT EXISTS hot_until      timestamptz;                     -- до когда чекать чаще (недавний спайк)
-- Тумблеры/крутилки СТОРОЖЕЙ (панель пишет → воркер читает каждый тик, без редеплоя)
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS storozhi_enabled boolean NOT NULL DEFAULT false; -- слежка за креаторами вкл
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS brand_new_post   boolean NOT NULL DEFAULT true;  -- бренд-коммент на каждый новый пост
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS mobilize_spike   boolean NOT NULL DEFAULT true;  -- мобилизация работяг на спайк
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS shadow_check     boolean NOT NULL DEFAULT false; -- шэдоу-чек после комментов
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS creator_poll_min int NOT NULL DEFAULT 60;        -- каденс проверки креаторов (мин)
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS spike_mult       numeric NOT NULL DEFAULT 2.5;   -- порог спайка (× к baseline)
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS spike_workers    int NOT NULL DEFAULT 6;         -- работяг на спайк-пост
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS tier1_burn_fresh boolean NOT NULL DEFAULT true;  -- тир-1: жечь свежие акки (расходник)
-- Ручной комментинг из панели (владелец сам ставит пост в работу 🚀 и рулит рубильником, без редеплоя):
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS commenter_enabled boolean NOT NULL DEFAULT false; -- рубильник комментинга; движок идлит пока false
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS comments_per_post int NOT NULL DEFAULT 2;          -- сколько ответов на пост
-- Сколько ответить спрашивавшим (задаёт юзер под конкретный пост) + итог для истории.
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS asker_count int NOT NULL DEFAULT 3;
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS result text;
-- Запасной акк (failover): если основной не зашёл — бот пробует этим. Один постит, не оба.
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS fallback_account_id uuid;
-- Выбранные юзером варианты ответа людям (крутятся по кругу — разным разный текст).
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS texts jsonb;
-- Второй акк для роли «свой коммент + промпт» (если задан — роли делят два акка). +свой failover.
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS brand_account_id uuid;
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS brand_fallback_id uuid;
-- Когда ответ реально ушёл в работу (взят пулом) — для честного сброса зависших (НЕ по created_at).
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS posting_at timestamptz;
-- Юзер выбрал НЕ постить промпт под этим постом (только брендовый коммент) — режим plain принудительно.
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS no_prompt boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tt_profile_checked_at timestamptz;

-- Живой статус комментинга для дашборда: что акк комментит СЕЙЧАС (пишет vcomment на старте прогона).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS commenting_post text;      -- шорткод поста, который сейчас комментит
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS commenting_at timestamptz; -- когда взялся комментить (свежий = «онлайн, комментит»)

-- Мягкое удаление аккаунтов (корзина): deleted_at заполнен = в корзине, NULL = активен.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Код с почты/смс для входа искателя по паролю: воркер ждёт, юзер вводит код в панели.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_challenge_code text;

-- Страйки искателя радара: серия 429 за скан = +1 (искатель «в спаме» у IG). 3 подряд — ротация
-- (роль reader снимается, читателем сажаем следующий живой акк). Чистый скан сбрасывает в 0.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reader_strikes int NOT NULL DEFAULT 0;

-- Когда акк УПАЛ на блок (bad_login/challenge/captcha/suspended/restricted). Отдельно от session_checked_at,
-- который сбивается любым чеком/revive → по нему нельзя честно отмерить «2 часа после софт-блока» для
-- восстановления. blocked_at ставится ТОЛЬКО в момент постановки блок-статуса, не трогается чеками.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS blocked_at timestamptz;

-- Отметка ПОСЛЕДНЕЙ реальной попытки авто-входа (maybeRelogin). Отдельно от session_checked_at, который
-- бампают фоновые чеки (maybeSessions/maybeSilenceWatch каждые ~30 мин). Коллизия: гейт-кулдаун релогина
-- (2fa_cooldown 4ч / прочие 1ч) раньше читал session_checked_at → фоновый чек постоянно сбивал отсчёт,
-- и кулдаун НИКОГДА не дозревал (особенно 4ч для 2FA) → релогин не брал почти никого. relogin_try_at
-- бампается ТОЛЬКО когда мы реально пробуем войти; фоновые чеки его не трогают. NULL = ещё не пробовали (берём сразу).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS relogin_try_at timestamptz;

-- Пул ЗАПАСНЫХ прокси: восстановление берёт свободный sticky отсюда мгновенно (у ClickIP нет API,
-- создаём пачкой заранее через браузер). status: free | assigned | dead.
CREATE TABLE IF NOT EXISTS proxy_pool (
  id serial PRIMARY KEY,
  proxy text UNIQUE NOT NULL,
  country text DEFAULT 'GB',
  status text NOT NULL DEFAULT 'free',
  assigned_slug text,
  created_at timestamptz DEFAULT now(),
  assigned_at timestamptz
);

-- Автоматически проставляем blocked_at в момент постановки блок-статуса (любым кодом), и снимаем при login_ok.
-- Триггер — чтобы не расставлять blocked_at по всем ~8 местам UPDATE вручную и не забыть ни одно.
CREATE OR REPLACE FUNCTION set_blocked_at() RETURNS trigger AS $$
BEGIN
  IF NEW.ig_status IN ('bad_login','challenge','captcha','suspended','restricted')
     AND (OLD.ig_status IS DISTINCT FROM NEW.ig_status) THEN
    NEW.blocked_at := now();
  ELSIF NEW.ig_status = 'login_ok' AND OLD.ig_status IS DISTINCT FROM 'login_ok' THEN
    NEW.blocked_at := NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_blocked_at ON accounts;
CREATE TRIGGER trg_blocked_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_blocked_at();

-- Роль задания в radar_replies: 'both' (старое: 1 акк всё / 2 роли), 'askers' (ТОЛЬКО ответы людям,
-- строго указанным акком) или 'brand' (ТОЛЬКО бренд-коммент). Мульти-выбор акков в композере создаёт
-- несколько строк с 'askers'/'brand' — по одной на акк.
ALTER TABLE radar_replies ADD COLUMN IF NOT EXISTS roles text NOT NULL DEFAULT 'both';

-- БРОНЬ комментов: кому уже ответили (post_code+username). Параллельные акки атомарно бронируют
-- человека ПЕРЕД ответом → один человек никогда не получит два наших ответа, даже при разной
-- сортировке комментов у акков. Работает и между днями (повторное задание не отвечает тем же людям).
CREATE TABLE IF NOT EXISTS radar_reply_targets (
  post_code  text NOT NULL,
  username   text NOT NULL,
  assigned_account_id uuid,
  status     text NOT NULL DEFAULT 'done',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_code, username)
);

-- Дежурство на ГЛАВНОМ посту (напр. рил Алины): бот периодически проверяет пост и отвечает новым
-- спрашивающим с дежурного акка (ig_role='duty', первый живой по списку = на смене).
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS duty_url text;
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS duty_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS duty_per_visit int NOT NULL DEFAULT 2;
-- Число комментов поста при последнем чеке (анонимный HTTP-чек без логина): выросло → есть новые
-- комменты → дежурный выходит СРАЗУ, не дожидаясь расписания. Не отдался чек — фолбэк-расписание.
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS duty_last_count int NOT NULL DEFAULT 0;

-- Дежурство берёт бойцов из ГРУППЫ с флагом watchdog=true (галка «🛡 Аккаунт-сторож» в модалке группы —
-- она уже была, но раньше ни к чему не подключалась). Единый источник состава дежурных, без «двух окон».

-- Блокировки акка на конкретном посту: автор ограничил доступ (страница «недоступно» именно этому акку).
-- Чтобы не выбирать таких для ответа под этим постом. Пишется автоматически, когда vcomment/peek ловит блок.
CREATE TABLE IF NOT EXISTS post_account_blocks (
  code       text NOT NULL,                        -- шорткод поста (radar_posts.code)
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked    boolean NOT NULL DEFAULT true,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, account_id)
);

-- Лог ошибок для показа на сайте (что и где упало).
CREATE TABLE IF NOT EXISTS app_errors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source     text,                              -- api | worker | radar | commenting | …
  message    text,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_errors_at ON app_errors (created_at DESC);

-- === Лог жизни аккаунтов (переживает удаление акка: slug/платформа/снимок хранятся копией) ===
-- Единая история: постинг → ограничения/бан → пауза → удаление. По ней делаем выводы (что жжёт акки).
CREATE TABLE IF NOT EXISTS account_events (
  id         bigserial PRIMARY KEY,
  account_id uuid,                       -- обнулится/останется висеть после hard-delete — не FK
  slug       text,                       -- ДЕНОРМ: чтобы событие читалось и после удаления акка
  platform   text,
  kind       text NOT NULL,              -- comment|post|challenge|bad_login|restriction|captcha|paused|relogin_ok|login_ok|trashed|deleted
  detail     jsonb,                      -- снимок: {comments_today, comments_total, age_days, account_type, proxy_country, ig_status, reason, url}
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acc_events_slug ON account_events (slug);
CREATE INDEX IF NOT EXISTS idx_acc_events_kind_at ON account_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_events_acc ON account_events (account_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ТАБЛИЦЫ-ШИНА КОММЕНТИНГ-ДВИЖКОВ (раньше создавались ad-hoc из vcomment.cjs/smartrun.cjs → дрейф схемы).
-- Теперь ими владеет migrate. Все — CREATE ... IF NOT EXISTS, безопасно на существующей базе.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- Дедуп-леджер «этому юзеру под этим постом уже ответили» (пишет vcomment, читают /radar/live, smartrun, validate_safe).
CREATE TABLE IF NOT EXISTS post_answered (
  code     text,
  username text,
  ts       timestamptz DEFAULT now(),
  PRIMARY KEY (code, username)
);
CREATE INDEX IF NOT EXISTS idx_post_answered_code ON post_answered (code);
CREATE INDEX IF NOT EXISTS idx_post_answered_ts ON post_answered (ts);

-- Пер-прогонная статистика акка (комменты/бренд/причина стопа) — обучение и /radar/live (сумма brand за день).
CREATE TABLE IF NOT EXISTS account_run_stats (
  id            bigserial PRIMARY KEY,
  slug          text,
  comments      int,
  brand         int,
  posts_tried   int,
  retire_reason text,
  elapsed       int,
  ts            timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_stats_slug ON account_run_stats (slug);
CREATE INDEX IF NOT EXISTS idx_run_stats_ts ON account_run_stats (ts);

-- Акки, спалённые капчей (чек-поинт IG) → снос профиля + замена (captchaSweep / maybeReplaceBlocked).
CREATE TABLE IF NOT EXISTS captcha_dead (
  slug     text PRIMARY KEY,
  ig_login text,
  ts       timestamptz DEFAULT now()
);

-- Акки под IG-ограничением «нельзя делиться ссылками» (карантин от бренда, авто-снятие через ~30 дней).
CREATE TABLE IF NOT EXISTS share_restricted (
  slug     text PRIMARY KEY,
  ig_login text,
  ts       timestamptz DEFAULT now()
);

-- Посты, где автор ОГРАНИЧИЛ комменты (постить нельзя никому) → исключаются из очереди.
CREATE TABLE IF NOT EXISTS post_restricted (
  code text PRIMARY KEY,
  ts   timestamptz DEFAULT now()
);

-- Память «какой акк уже комментил какой пост» (no-repeat + 12ч-пауза бэклога).
CREATE TABLE IF NOT EXISTS account_post_done (
  slug text,
  code text,
  ts   timestamptz DEFAULT now(),
  PRIMARY KEY (slug, code)
);
CREATE INDEX IF NOT EXISTS idx_apd_code ON account_post_done (code);

-- Журнал бренд-комментов акка (кап 1/день + кулдаун 12ч).
CREATE TABLE IF NOT EXISTS brand_posted (
  slug text,
  ts   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brand_posted_slug_ts ON brand_posted (slug, ts);

-- ============================================================================
-- КАМПАНЕЙНОЕ ДЕЖУРСТВО (владелец сессии ДЕЖУРСТВО / duty_safe.cjs). Append-only блок.
-- Горячий пост «выжимаем» N дней силами N ботов: бюджет спрашивающих + суточный темп + фронтлоад свежего
-- поста + приоритет. Роутинг ботов на ОДИН топ-приоритетный пост вместо распыления по многим.
-- Дедуп людей — общий post_answered(code, username), список НЕ делим по позициям (vcomment таргетит по @username).
-- ============================================================================
CREATE TABLE IF NOT EXISTS duty_campaign (
  code        text PRIMARY KEY,                     -- шорткод поста (из url; radar_posts.code)
  url         text NOT NULL,                        -- полный url reel/p для vcomment
  opened_at   timestamptz NOT NULL DEFAULT now(),   -- взят в кампанию; окно жизни считаем отсюда
  window_days int NOT NULL DEFAULT 5,               -- сколько дней выжимаем пост
  budget      int NOT NULL DEFAULT 200,             -- макс. РАЗНЫХ спрашивающих ответить (потолок; истина в post_answered)
  per_day     int NOT NULL DEFAULT 40,              -- базовый суточный темп ответов (фронтлоад корректирует множителем)
  bots        int NOT NULL DEFAULT 3,               -- сколько дежурных держать на посту (после egress-гейта поднимать до 10)
  priority    int NOT NULL DEFAULT 100,             -- выше = берём раньше (концентрируем силу)
  status      text NOT NULL DEFAULT 'open',         -- open | done | paused
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_duty_campaign_pick ON duty_campaign (status, priority DESC, opened_at DESC);
-- Полоса кампании: 'duty' (горячий пост дежурства, читает duty_safe) | 'demand' (роутинг спроса, пишет ПОСТИНГ,
-- читает commenter). Одна таблица — две полосы, движки не толкаются. Идемпотентный ALTER: таблица уже в проде.
ALTER TABLE duty_campaign ADD COLUMN IF NOT EXISTS lane text DEFAULT 'duty';
CREATE INDEX IF NOT EXISTS idx_duty_campaign_lane ON duty_campaign (status, lane, priority DESC);

-- ============================================================================
-- ГЛОБАЛЬНЫЙ СЕМАФОР СЛОТОВ GoLogin (владелец сессии ЛОГГЕР). КРОСС-ПРОЦЕСС: web и ig-worker — РАЗНЫЕ
-- процессы, env-кап на процесс НЕ координирует сумму → overcommit → no_connect. Единый счётчик в БД.
-- Бюджет 15: пулы commenting=7 / patrol=3 / logger=3 (logger до 5 в экстренке: relogin-watchdog / большой
-- бэклог мёртвых). Потребители: web (logger/patrol/publish) + ig-worker (commenting/patrol) — ВСЕ через эти
-- функции, свои счётчики НЕ делают. claim атомарен через advisory-lock; протухшие слоты (процесс умер,
-- держа слот) авто-освобождаются TTL 15 мин (сессия дольше не живёт — watchdog'и рубят раньше).
-- ============================================================================
CREATE TABLE IF NOT EXISTS gologin_slots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool       text NOT NULL,                        -- commenting | patrol | logger
  holder     text,                                 -- slug/профиль для отладки
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gologin_slots_pool ON gologin_slots (pool);

-- Занять слот: NULL если пул или total уже на потолке. Advisory-lock сериализует claim между процессами.
CREATE OR REPLACE FUNCTION claim_gologin_slot(p_pool text, p_holder text, p_pool_cap int, p_total_cap int DEFAULT 15)
RETURNS uuid AS $$
DECLARE v_id uuid; v_total int; v_pool int;
BEGIN
  PERFORM pg_advisory_xact_lock(823641);                                    -- общий ключ на claim слота
  DELETE FROM gologin_slots WHERE claimed_at < now() - interval '15 minutes'; -- реклейм протухших (умерший процесс)
  SELECT count(*), count(*) FILTER (WHERE pool = p_pool) INTO v_total, v_pool FROM gologin_slots;
  IF v_total >= p_total_cap OR v_pool >= p_pool_cap THEN RETURN NULL; END IF;
  INSERT INTO gologin_slots (pool, holder) VALUES (p_pool, p_holder) RETURNING id INTO v_id;
  RETURN v_id;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_gologin_slot(p_id uuid) RETURNS void AS $$
BEGIN DELETE FROM gologin_slots WHERE id = p_id; END; $$ LANGUAGE plpgsql;

-- === CTA-посты (ПОСТИНГ) === автор обещал промпт ЗА КОММЕНТ («с меня промпт», «пиши +», «слово в комменты»).
-- На CTA-посту комментим ВСЕХ комментаторов (не только явный «промт»). Ставит vcomment.cjs при детекте описания;
-- supervisor роутит бюджет по флагу. Append-only, идемпотентно.
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS is_cta boolean NOT NULL DEFAULT false;
ALTER TABLE radar_posts ADD COLUMN IF NOT EXISTS cta_word text;   -- кодовое слово CTA (если автор просит писать «ХОЧУ»/«+»)

-- === НАБЛЮДАТЕЛЬ: один акк чекит просмотры постов и статус акков ===
-- Наблюдательный акк — один на систему, выбирается в панели.
ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS observer_account_id uuid;
-- Запуски наблюдателя: каждый заход акка-наблюдателя.
CREATE TABLE IF NOT EXISTS observer_runs (
  id          bigserial PRIMARY KEY,
  observer_account_id uuid NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  duration_s  int,
  posts_checked int DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_observer_runs_observer ON observer_runs (observer_account_id);
-- Результаты: просмотры каждого поста на момент проверки + ссылка на пост.
CREATE TABLE IF NOT EXISTS observer_results (
  id              bigserial PRIMARY KEY,
  observer_account_id uuid NOT NULL,
  post_id         uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  view_count      int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_observer_results_post ON observer_results (post_id, updated_at DESC);

-- === УНИКАЛИЗАТОР ДЛЯ ВЛАДЕЛЬЦА (01.08) =======================================================
-- Инструмент «залил ролик → получил N разных файлов → скачал себе» для СТОРОННИХ аккаунтов,
-- не связанных с постером. Считаем в облаке (ffmpeg есть в nixpacks), результат храним в БД:
-- у Railway нет тома, а файлы мелкие (~1.3 МБ на копию). Чистим TTL-ом, см. worker.
CREATE TABLE IF NOT EXISTS uniq_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename   text,
  level      text NOT NULL DEFAULT 'medium',   -- medium | max
  variants   int  NOT NULL DEFAULT 5,
  status     text NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  done_n     int  NOT NULL DEFAULT 0,
  src_bytes  bytea,                            -- оригинал (удаляем после успеха, чтобы не пухла база)
  src_size   int,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uniq_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES uniq_jobs(id) ON DELETE CASCADE,
  idx        int  NOT NULL,
  filename   text,
  bytes      bytea,
  size_bytes int,
  params     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uniq_files_job ON uniq_files (job_id, idx);
CREATE INDEX IF NOT EXISTS idx_uniq_jobs_status ON uniq_jobs (status, created_at DESC);

-- === МАСС-ПОСТИНГ: пачки роликов по моделям (01.08) ===========================================
-- Не «выложить всё сразу», а ПЛАНИРОВЩИК: владелец кидает пачку, система раскладывает по времени
-- с анти-бан ритмом, показывает план ДО записи, дальше сама подаёт задачи на мак.
-- Уроки: акки жгутся от объёма (21.07) и от одинакового контента на связанных акках (01.08).
CREATE TABLE IF NOT EXISTS post_batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text,
  status     text NOT NULL DEFAULT 'planned',   -- planned | running | paused | done | cancelled
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES post_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_posts_batch ON posts (batch_id, scheduled_at);
-- Один пост = максимум одна ЖИВАЯ задача на мак: физическая защита от дублей публикации.
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_jobs_igpost_live
  ON local_jobs (urls) WHERE mode='igpost' AND status IN ('queued','running');
-- ОДИН АККАУНТ = максимум одна ЖИВАЯ задача публикации (06.08). Индекс выше защищал от дубля
-- ПОСТА, но не от дубля по АККАУНТУ: два разных поста могли встать в очередь на один слаг, а это
-- две сессии в одном профиле — самый надёжный способ убить аккаунт. Проверка «занят» была в коде
-- у части источников задач и отсутствовала у остальных (ручные раздатчики, ретрай, SQL руками),
-- поэтому переносим её в базу: обойти нельзя ничем, включая INSERT руками. Код, ставящий задачу,
-- обязан ловить ошибку уникальности и трактовать её как «акк занят» (так уже делают postdaemon
-- и blast_one_each). Логика допуска целиком живёт в postguard.cjs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_jobs_igpost_slug_live
  ON local_jobs (slug) WHERE mode='igpost' AND status IN ('queued','running');

-- СТАТИСТИКА ПОСТОВ (03.08). Instagram убрал счётчики из публичной выдачи: страница рилса и embed
-- приходят без чисел, поэтому анонимно просмотры больше не снять. Зато лента СВОЕГО аккаунта их
-- отдаёт, если запрос идёт с его куками — этим и пользуемся (stats.cjs, браузер не открывается).
-- Храним снимок на момент сбора: панель показывает цифры и время последнего обновления.
CREATE TABLE IF NOT EXISTS post_stats (
  shortcode   text PRIMARY KEY,
  account_id  uuid,
  persona     text,
  views       int  DEFAULT 0,
  likes       int  DEFAULT 0,
  comments    int  DEFAULT 0,
  taken_at    timestamptz,
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_post_stats_persona ON post_stats(persona);

-- СЕРДЦЕБИЕНИЕ ЛОКАЛЬНОГО РАННЕРА (07.08). Повод: третий инцидент «очередь публикаций стоит
-- молча». Процесс был жив по ps, лог не двигался 40 минут, задачи висели queued. Снаружи не было
-- НИ ОДНОГО признака, по которому «жив и работает» отличается от «жив и завис», поэтому раннер
-- теперь сам отмечается здесь раз в 5 минут. Главное поле не beat_at, а tick_at: время последнего
-- УСПЕШНОГО опроса очереди. Завис на запросе к базе, значит beat_at свежий, а tick_at застыл, и
-- сторож (runnerguard.sh) видит это ФАКТОМ. Таблица служебная, локальная, одна строка на раннера.
CREATE TABLE IF NOT EXISTS runner_heartbeat (
  runner      text PRIMARY KEY,        -- localrunner, localrunner#2 …
  pid         int,
  host        text,
  phase       text,                    -- poll | idle | job | db_error | crash | stopped
  job_id      bigint,
  job_slug    text,
  note        text,                    -- человеческая строка «что делаю» (та же, что в логе)
  tick_at     timestamptz,             -- последний УСПЕШНЫЙ опрос очереди
  beat_at     timestamptz DEFAULT now(),
  started_at  timestamptz
);

-- ФАКТ ПРОФИЛЯ СНАРУЖИ (07.08). Приказ: единая таблица акков в панели показывает ава+ник+био,
-- «надо чтобы в таблицу всё тянулось». Текста био в базе не было НИГДЕ (только флаг bio_set),
-- имени и адреса авы — тоже. Заполняет accheck.cjs при анонимном чтении web_profile_info:
-- это снимок того, что РЕАЛЬНО видит зритель, а не то, что мы когда-то записывали.
-- ЧЕСТНОСТЬ ВЕРДИКТА (урок ложных банов): поля пишутся ТОЛЬКО когда профиль реально прочитан.
-- Сбой IG (лимит, заглушка, «Asset has been deleted» у бизнес-профилей) вердиктом не является:
-- тогда бампается только profile_try_at, а данные остаются прежними — панель показывает
-- «не проверено» по paре try_at/checked_at, а не врёт «нет авы/нет био».
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_bio text;               -- текст био, как видит зритель
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ig_full_name text;         -- имя профиля, как видит зритель
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_url text;           -- CDN-адрес авы (истекает → снимок кладём в avatar_thumb)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_checked_at timestamptz; -- последний УСПЕШНЫЙ анонимный чек профиля
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_try_at timestamptz;     -- последняя ПОПЫТКА чека (успех или сбой)

-- ЧЕКЕР ПРОСМОТРОВ (09.08, приказ: «чекер просмотров на акках, заведённых в магос, 24/7»).
-- ПОВОД: 50 акков пролиты магосом, у каждого один наш рилс, все живы и с авой, но ощущение что
-- просмотров нет. Один замер это не ответ: ноль в моменте и ноль третьи сутки это разные диагнозы.
-- Нужен РЯД по дням, поэтому таблицы только ДОПИСЫВАЮТСЯ: каждый обход это новые строки.
-- Чем отличается от post_stats: там одна строка на шорткод и она перезаписывается (последнее
-- значение, для панели). Здесь история, перезаписи нет никогда. post_stats не ломаем и не трогаем.
-- Источник: анонимная публичная ручка web_profile_info через прокси из пула. Ноль входов в акки.
CREATE TABLE IF NOT EXISTS post_views_log (
  id          bigserial PRIMARY KEY,
  run_id      text,                    -- метка обхода (ISO старта круга), чтобы группировать замеры
  username    text NOT NULL,           -- ник, как его видит зритель
  shortcode   text NOT NULL,           -- код поста
  media_type  text,                    -- рилс | видео | фото | карусель
  views       int,                     -- video_view_count; null значит счётчик не отдан (фото или скрыт)
  likes       int,
  comments    int,
  taken_at    timestamptz,             -- когда пост опубликован
  checked_at  timestamptz DEFAULT now()-- момент замера
);
CREATE INDEX IF NOT EXISTS idx_pvl_user_time ON post_views_log(username, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvl_code_time ON post_views_log(shortcode, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvl_run ON post_views_log(run_id);

-- Снимок АККАУНТА в тот же момент. Отдельно от постов, потому что диагноз «профиль не отдаётся»
-- существует и без постов, и путать его с «лимит IP» нельзя: первое про акк, второе про нас.
CREATE TABLE IF NOT EXISTS acct_views_log (
  id          bigserial PRIMARY KEY,
  run_id      text,
  username    text NOT NULL,
  verdict     text,                    -- ok | лимит | нет профиля | недоступен | не прочитан
  posts_count int,
  followers   int,
  is_private  boolean,
  has_avatar  boolean,
  http_code   int,
  tries       int,                     -- сколько прокси пришлось перебрать
  checked_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avl_user_time ON acct_views_log(username, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_avl_run ON acct_views_log(run_id);

-- ТРЕКИНГ ПРОКСИ В ЗАМЕРАХ (09.08, приказ: «прокси нужно начать тречить: где больше валида, какие
-- меньше падают по статистике и с каких больше просмотров, например какое гео»).
-- Пароли в базу НЕ пишем: только хост, порт и гео, этого хватает и для группировки, и для того,
-- чтобы найти конкретную sticky-сессию (у kz-магос порт = отдельный IP).
ALTER TABLE acct_views_log ADD COLUMN IF NOT EXISTS proxy_host text;
ALTER TABLE acct_views_log ADD COLUMN IF NOT EXISTS proxy_port text;
ALTER TABLE acct_views_log ADD COLUMN IF NOT EXISTS proxy_geo  text;
ALTER TABLE post_views_log ADD COLUMN IF NOT EXISTS proxy_host text;
ALTER TABLE post_views_log ADD COLUMN IF NOT EXISTS proxy_port text;
ALTER TABLE post_views_log ADD COLUMN IF NOT EXISTS proxy_geo  text;

-- КАЖДАЯ ПОПЫТКА ЗАПРОСА, а не только удачная. Без этого нельзя ответить «какие прокси меньше
-- падают»: в снимке видно лишь того, кто в итоге сработал, а вся статистика падений теряется.
-- Одна строка = один запрос к инстаграму через один прокси.
CREATE TABLE IF NOT EXISTS proxy_probe_log (
  id         bigserial PRIMARY KEY,
  run_id     text,
  proxy_host text,                 -- хост провайдера (74.81.81.81, proxy.click-ip.com …)
  proxy_port text,                 -- порт = sticky-сессия = отдельный IP
  proxy_geo  text,                 -- KZ | GB | RU | ? (из строки прокси, фолбэк proxy_pool.country)
  username   text,                 -- кого пытались прочитать
  outcome    text,                 -- ok | лимит | отказ
  http_code  int,
  ms         int,                  -- сколько длился запрос
  checked_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ppl_geo_time ON proxy_probe_log(proxy_geo, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppl_hostport ON proxy_probe_log(proxy_host, proxy_port);
CREATE INDEX IF NOT EXISTS idx_ppl_run ON proxy_probe_log(run_id);

-- СВЯЗКА «АККАУНТ → ПРОКСИ → ГЕО» (10.08). Полная версия с обоснованием: миграция
-- migrations/2026-08-10-account-proxy-geo.sql. Здесь дубль теми же идемпотентными ALTER, чтобы
-- деплойный migrate.ts довёл колонки сам.
-- ПОВОД: журнал proxy_probe_log выше отвечает только «какие прокси меньше падают У НАС ПРИ ЧТЕНИИ».
-- На «с каких больше просмотров» он не отвечает: гео влияет на охват через ПРОЛИВ акка, а связь
-- «акк → его рабочий прокси» в базе не хранилась (ig_proxy пуст у 150 магос-акков, egress_country
-- ставится только замером через GoLogin, которого у них нет). Эти поля и есть та связка.
-- Пароль в них НЕ кладём: хост, порт и гео, секрет остаётся в ig_proxy/proxy_pool.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_host text;      -- хост провайдера, без логина и пароля
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_port text;      -- порт = sticky-сессия = отдельный IP; NULL если известна только пачка
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_geo  text;      -- KZ | GE | RU | GB | '?' (не разобрали — так и пишем, не выдумываем)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_geo_src text;   -- ig_proxy | proxy_pool | health_note | файл | вручную
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS proxy_bound_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_accounts_proxy_geo ON accounts(proxy_geo);

-- === ЮТУБ-КАНАЛ (17.08): постинг готовых Shorts на СВОЙ канал через YouTube Data API ===
-- Один канал (владелец), OAuth refresh_token в БД. Очередь роликов: путь на маке (грузит ytrunner.cjs)
-- или публичный URL (грузит сервер). Описание, хэштеги, ссылка с UTM собираются автоматически из yt_settings.
CREATE TABLE IF NOT EXISTS yt_channel (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  channel_id    text,
  title         text,
  refresh_token text,
  client_id     text,                                -- копия env при подключении: ytrunner на маке читает только БД
  client_secret text,
  connected_at  timestamptz,
  updated_at    timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS yt_settings (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cta             text NOT NULL DEFAULT 'Сделать такое же 👉',
  landing         text NOT NULL DEFAULT 'https://neironka.pro/',
  utm_source      text NOT NULL DEFAULT 'youtube',
  utm_medium      text NOT NULL DEFAULT 'shorts',
  utm_campaign    text NOT NULL DEFAULT 'shorts',
  body            text NOT NULL DEFAULT 'Готовые шаблоны, нужно только твоё фото. Без VPN, оплата картой РФ, 50 ₽ на старте.',
  hashtags        text NOT NULL DEFAULT '#shorts #нейросети #нейросеть #нейронка #аифото',
  titles          text NOT NULL DEFAULT E'Одно селфи и нейросеть показала, что мне идёт\nЗагрузила селфи, результат за минуту\nНейросеть подобрала мне образ по одному фото\nЧто нейросеть сказала про моё лицо\nСделала себе гайд по внешности за минуту',
  privacy         text NOT NULL DEFAULT 'public',    -- public | unlisted | private
  per_day         int  NOT NULL DEFAULT 4,           -- сколько роликов в сутки (квота API: ~6 загрузок/день на проект)
  gap_min         int  NOT NULL DEFAULT 180,         -- пауза между роликами, минут
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz DEFAULT now()
);
INSERT INTO yt_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS yt_queue (
  id            bigserial PRIMARY KEY,
  file_path     text,                                -- локальный путь на маке (грузит ytrunner)
  media_url     text,                                -- или публичный URL (грузит сервер)
  file_hash     text,                                -- дедуп
  src_title     text,                                -- название из sidecar-текста / имени файла
  src_text      text,                                -- исходная подпись (ig/tt txt), если была
  title         text,                                -- финальное название
  description   text,                                -- финальное описание (cta+utm+body+hashtags)
  utm_content   text,                                -- уникальная метка ролика в ссылке
  status        text NOT NULL DEFAULT 'queued',      -- queued | uploading | posted | error | skipped
  video_id      text,
  url           text,
  error         text,
  scheduled_at  timestamptz,
  posted_at     timestamptz,
  locked_at     timestamptz,
  created_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_queue_hash ON yt_queue (file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_yt_queue_status ON yt_queue (status, id);
ALTER TABLE yt_channel ADD COLUMN IF NOT EXISTS client_id text;
ALTER TABLE yt_channel ADD COLUMN IF NOT EXISTS client_secret text;
-- Слоты постинга по МСК: «утро, день, вечер». Ролик уходит в первый час слота, один ролик на слот в сутки.
ALTER TABLE yt_settings ADD COLUMN IF NOT EXISTS post_hours text NOT NULL DEFAULT '10,14,19';
UPDATE yt_settings SET per_day=3 WHERE id=1 AND per_day=4;
-- Байтовые названия от LLM (сервер генерит заранее в ai_title, раннер на маке только читает) + черновики.
ALTER TABLE yt_queue ADD COLUMN IF NOT EXISTS ai_title text;
ALTER TABLE yt_settings ADD COLUMN IF NOT EXISTS title_prompt text NOT NULL DEFAULT 'Ты пишешь названия для YouTube Shorts бьюти-канала девушки 18-25 лет про нейросеть neironka.pro (по одному селфи делает гайд по внешности, стрижке, макияжу, образу). Стиль лучших роликов канала: короткий байтовый хук до 50 знаков, разговорный, от первого лица, интрига или спор, без кавычек, без хэштегов, можно 1 эмодзи в конце, без длинных тире. Примеры: «Как развести парня. Не повторять!», «Тест внешности пошел не по плану 😳», «Они говорили что я выскочка», «Перехитрила парня)». Верни ТОЛЬКО одно название.';
UPDATE yt_settings SET privacy='private' WHERE id=1;   -- 17.08: ролики уходят в черновик, владелец с телефона ставит обложку и публикует
ALTER TABLE yt_queue ADD COLUMN IF NOT EXISTS cover_path text;   -- обложка (кадр1.jpg), раннер вклеивает её первым кадром
UPDATE yt_settings SET per_day=6, gap_min=120, post_hours='9,11,13,15,18,21' WHERE id=1 AND per_day=3;

-- === ЮТУБ: МНОГО КАНАЛОВ (18.08) ===
-- Канал = строка yt_channels со своими OAuth-ключами (свой проект Google Cloud = своя квота 6 загрузок/сутки),
-- своими настройками текста и темпа. id=1 = брендовый канал (перенос из yt_channel + yt_settings).
-- Каналы 2+ = мультиакки-обучалки по промптам: ролики любых моделей, мягкий CTA, utm_medium = ник канала.
CREATE TABLE IF NOT EXISTS yt_channels (
  id            serial PRIMARY KEY,
  slug          text UNIQUE NOT NULL,                -- короткий ключ: brand, dasha, ...
  name          text NOT NULL,                       -- как показываем в панели
  channel_id    text,                                -- UC… после подключения
  title         text,                                -- название канала из YouTube
  refresh_token text,
  client_id     text,                                -- OAuth-клиент этого канала (свой проект = своя квота)
  client_secret text,
  connected_at  timestamptz,
  enabled       boolean NOT NULL DEFAULT true,
  cta           text NOT NULL DEFAULT 'Сделать такое же 👉',
  landing       text NOT NULL DEFAULT 'https://neironka.pro/',
  utm_source    text NOT NULL DEFAULT 'youtube',
  utm_medium    text NOT NULL DEFAULT 'shorts',
  utm_campaign  text NOT NULL DEFAULT 'shorts',
  body          text NOT NULL DEFAULT 'Готовые шаблоны, нужно только твоё фото. Без VPN, оплата картой РФ, 50 ₽ на старте.',
  hashtags      text NOT NULL DEFAULT '#shorts #нейросети #нейросеть #нейронка #аифото',
  titles        text NOT NULL DEFAULT E'Одно селфи и нейросеть показала, что мне идёт\nЗагрузила селфи, результат за минуту\nНейросеть подобрала мне образ по одному фото',
  title_prompt  text NOT NULL DEFAULT 'Верни ТОЛЬКО одно байтовое название для YouTube Shorts до 50 знаков от первого лица девушки, без кавычек и хэштегов.',
  privacy       text NOT NULL DEFAULT 'private',
  per_day       int  NOT NULL DEFAULT 6,
  gap_min       int  NOT NULL DEFAULT 120,
  post_hours    text NOT NULL DEFAULT '9,11,13,15,18,21',
  model_filter  text,                                -- NULL = мультиакк (любые модели); иначе подстрока пути ролика
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
-- Перенос брендового канала (id=1) из старых одиночных таблиц. Идемпотентно.
INSERT INTO yt_channels (id, slug, name, channel_id, title, refresh_token, client_id, client_secret, connected_at,
  enabled, cta, landing, utm_source, utm_medium, utm_campaign, body, hashtags, titles, title_prompt, privacy, per_day, gap_min, post_hours)
SELECT 1, 'brand', 'Нейронка (бренд)', c.channel_id, c.title, c.refresh_token, c.client_id, c.client_secret, c.connected_at,
  s.enabled, s.cta, s.landing, s.utm_source, s.utm_medium, s.utm_campaign, s.body, s.hashtags, s.titles, s.title_prompt, s.privacy, s.per_day, s.gap_min, s.post_hours
FROM yt_settings s LEFT JOIN yt_channel c ON c.id=1 WHERE s.id=1
ON CONFLICT (id) DO NOTHING;
SELECT setval('yt_channels_id_seq', GREATEST((SELECT max(id) FROM yt_channels), 1));
ALTER TABLE yt_queue ADD COLUMN IF NOT EXISTS channel_id int NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_yt_queue_ch_status ON yt_queue (channel_id, status, id);
ALTER TABLE yt_stats ADD COLUMN IF NOT EXISTS channel_id int;
-- === МУЛЬТИПЛАТФОРМА ПОСТЕРА КОРОТКИХ ВИДЕО (20.08): те же yt_channels/yt_queue, платформа = поле ===
-- vk: канал = сообщество, auth={access_token,group_id}; заливка video.save (user-токен со scope video,groups,wall,offline).
-- rutube: auth={token}; заливка через api.rutube.ru. У обеих платформ квот как у ютуба нет, темп держим сами.
ALTER TABLE yt_channels ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'youtube';
ALTER TABLE yt_channels ADD COLUMN IF NOT EXISTS auth jsonb;

-- === СВОДНАЯ СТАТИСТИКА ПО ВСЕМ ПЛОЩАДКАМ (25.08) ===
--
-- Приказ владельца: «нужно взять все акки и свести их в постере в стату по
-- просмотрам и тд». До сих пор цифры лежали в трёх несвязанных местах: ютуб в
-- yt_stats, инстаграм в post_stats, тикток вообще вне базы (в файле фермы на
-- маке). Ответить на вопрос «сколько мы всего набрали» было нечем.

-- ЛАТАЕМ СТАРУЮ ДЫРУ. yt_stats создавалась мимо этого файла: ниже по тексту
-- есть ALTER TABLE yt_stats, а CREATE TABLE нет нигде. На живой базе таблица
-- есть (265 строк), а на развёрнутой с нуля не появилась бы вовсе, и вся
-- статистика ютуба молча показала бы пустоту. Дописываем ровно ту форму,
-- которая уже работает в бою.
CREATE TABLE IF NOT EXISTS yt_stats (
  video_id   text PRIMARY KEY,
  views      bigint,
  likes      bigint,
  comments   bigint,
  updated_at timestamptz DEFAULT now()
);

-- НИКИ TIKTOK, ЗА КОТОРЫМИ СЛЕДИМ.
--
-- Почему список живёт здесь, а не берётся у фермы: ферма слушает localhost на
-- маке владельца, а панель отдаётся из облака и достучаться туда не может
-- никогда. Цифры мы берём из веба (см. src/ttweb.ts), а веб-обходу нужен лишь
-- список ников, и держать его в базе панели дешевле, чем городить мост.
CREATE TABLE IF NOT EXISTS tt_accounts (
  nick        text PRIMARY KEY,
  title       text,                                  -- как звать по-человечески
  active      boolean NOT NULL DEFAULT true,         -- следим или отложили
  exists_on_tiktok boolean,                          -- NULL = ещё не проверяли
  followers   bigint,
  likes_total bigint,
  video_count int,
  added_at    timestamptz NOT NULL DEFAULT now(),
  checked_at  timestamptz                            -- когда последний раз смотрели
);

-- ТЕКУЩИЙ СНИМОК ПО ПОСТУ TIKTOK. Перезапись, история отдельно (stats_log).
-- posted_at не запрашиваем у площадки: время создания зашито в id поста.
CREATE TABLE IF NOT EXISTS tt_post_stats (
  post_id    text PRIMARY KEY,
  nick       text NOT NULL,
  views      bigint,
  posted_at  timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tt_post_stats_nick ON tt_post_stats (nick, posted_at DESC);

-- ЖУРНАЛ ЗАМЕРОВ: ТОЛЬКО ДОПИСЫВАНИЕ, ПЕРЕЗАПИСИ НИКОГДА.
--
-- Это главное, чего не хватало. Все три существующих хранилища (yt_stats,
-- post_stats, снимок фермы) держат ОДНУ строку на объект и затирают прошлое
-- значение. Поэтому вопрос «на сколько выросли просмотры за неделю» сегодня
-- неотвечаем в принципе: вчерашних цифр физически не осталось.
--
-- Ряд начинается с первого замера, и до накопления истории вкладка обязана
-- писать «накапливаем с такого-то числа», а не рисовать ноль: ноль тут
-- означал бы «не выросли», что неправда.
CREATE TABLE IF NOT EXISTS stats_log (
  id          bigserial PRIMARY KEY,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  platform    text NOT NULL,        -- youtube | vk | instagram | tiktok
  account_key text NOT NULL,        -- slug канала, persona инстаграма, ник тиктока
  post_key    text,                 -- video_id | shortcode | id поста; NULL для строк уровня аккаунта
  level       text NOT NULL,        -- post | account
  views       bigint,
  likes       bigint,
  comments    bigint,
  followers   bigint,
  posts_count int,
  source      text                  -- yt_api | ig_cookies | tt_web | farm
);
CREATE INDEX IF NOT EXISTS idx_stats_log_lookup ON stats_log (platform, account_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_log_day ON stats_log (checked_at DESC);
