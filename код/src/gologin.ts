import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { PlatformDriver } from './drivers/types.js';
import { withBrowserLock } from './lock.js';
import { notifyOwner } from './notify.js';
import { query } from './db/index.js';

// Общий слой облачного браузера GoLogin. Один на все площадки.
// Профиль (фингерпринт+куки+прокси) поднимается в облаке GoLogin, мы цепляемся
// по CDP из любой точки — машина нигде не крутится (в отличие от локального AdsPower).

const API = 'https://api.gologin.com';

// Токен GoLogin. Можно передать override (у группы свой аккаунт GoLogin) — иначе глобальный из env.
function token(override?: string | null): string {
  const t = (override && override.trim()) || process.env.GOLOGIN_API_TOKEN;
  if (!t) throw new Error('GOLOGIN_API_TOKEN не задан');
  return t;
}

// grabli #9: токен уходит в URL подключения -> вырезаем его из любого текста ошибок.
export function stripToken(text: string): string {
  return text.replace(/token=[^&\s"']+/gi, 'token=***');
}

// Ключ замка браузера = GoLogin-аккаунт (тариф). Строим из токена, с которым коннектимся:
// акк1 (env-токен, искатель) и акк2 (токен группы, комменты) -> разные ключи -> параллельно.
// Один и тот же токен -> один ключ -> очередь. Берём хвост токена (в лог не пишем).
export function lockKey(override?: string | null): string {
  const t = (override && override.trim()) || process.env.GOLOGIN_API_TOKEN || 'env';
  return 'gl:' + t.slice(-10);
}

// grabli #1: схема ОБЯЗАТЕЛЬНО wss:// (с https Playwright лезет за /json/version -> 404).
function cloudConnectUrl(profileId: string, tok?: string | null): string {
  const u = new URL('wss://cloudbrowser.gologin.com/connect');
  u.searchParams.set('token', token(tok));
  u.searchParams.set('profile', profileId);
  return u.toString();
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profileId: string;
  token?: string | null; // токен GoLogin-аккаунта этого профиля (для stop)
  slotId?: string | null; // занятый слот глобального семафора (release при disconnect)
}

// === ГЛОБАЛЬНЫЙ СЕМАФОР СЛОТОВ GoLogin (кросс-процесс, через БД — см. schema.sql) ===
// Бюджет 15: commenting=7 / patrol=3 / logger=3 (logger до 5 в экстренке). connect(opts.pool) занимает
// слот ДО открытия профиля, disconnect освобождает. Нет свободного → connect бросает — вызывающий скипает
// (бэкпрешер, не крэш). Потребители из ЛЮБОГО процесса (web/ig-worker) идут через эти же функции.
export type SlotPool = 'commenting' | 'patrol' | 'logger' | 'publish';
export const SLOT_CAPS: Record<string, number> = { commenting: 7, patrol: 3, logger: 3, publish: 2 };
export async function claimSlot(pool: SlotPool, holder: string, poolCap?: number, totalCap = 15): Promise<string | null> {
  const cap = poolCap ?? SLOT_CAPS[pool] ?? 3;
  const r = await query<{ id: string | null }>(`SELECT claim_gologin_slot($1,$2,$3,$4) AS id`, [pool, String(holder).slice(0, 60), cap, totalCap]).catch(() => null);
  return r?.rows[0]?.id ?? null;
}
export async function releaseSlot(id?: string | null): Promise<void> {
  if (!id) return;
  await query(`SELECT release_gologin_slot($1)`, [id]).catch(() => { /* протухнет по TTL */ });
}
export async function slotUsage(): Promise<{ pool: string; n: number }[]> {
  const r = await query<{ pool: string; n: string }>(`SELECT pool, count(*) n FROM gologin_slots GROUP BY pool`).catch(() => null);
  return (r?.rows || []).map((x) => ({ pool: x.pool, n: Number(x.n) }));
}

// Признак «слот занят/облако штормит» — стоит подождать и повторить (предыдущий профиль ещё гасится).
const isBusyErr = (m: string) => /limit|already|running|busy|slot|429|502|503|too many|reset|closed before/i.test(m);
// ИНФРАСТРУКТУРНАЯ ошибка (GoLogin/прокси лёг), а НЕ проблема аккаунта: 503/прокси/net/таймаут коннекта.
// Такое НЕ значит «акк мёртв» — не трогаем session_status, просто отступаем и ждём восстановления.
export const isInfraErr = (m: string) => /50[23]|429|too many|websocket error|proxy|tunnel|ERR_TIMED_OUT|ERR_CONNECTION|ERR_PROXY|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|net::ERR|closed before|timeout.*connect|connect.*timeout/i.test(m);

// ПРЕДОХРАНИТЕЛЬ GoLogin: если облако/прокси штормит (серия 503) — не долбим коннектами (это усугубляет
// 503), а делаем паузу. Коннекты в паузе fast-fail с понятной ошибкой. Восстанавливается сам.
let gologinDownUntil = 0;
let infraFailStreak = 0;
export function gologinHealth(): { down: boolean; downUntil: number; reason: string } {
  return { down: Date.now() < gologinDownUntil, downUntil: gologinDownUntil, reason: infraFailStreak >= 3 ? 'GoLogin/прокси штормит (503) — пауза' : '' };
}
let stormAlertedAt = 0; // троттлинг ТГ-алерта про шторм (раз в 15 мин, не спамим)
let stormActive = false; // сейчас в состоянии шторма (для алерта о восстановлении)
function noteInfraFail() {
  infraFailStreak++;
  if (infraFailStreak >= 3) {
    const cool = Math.min(10, 2 * (infraFailStreak - 2)) * 60 * 1000; // 2,4,6…10 мин, растёт со стриком
    gologinDownUntil = Date.now() + cool;
    console.warn(`[gologin] ПРЕДОХРАНИТЕЛЬ: ${infraFailStreak} инфра-сбоя подряд (503/прокси) → пауза ${cool / 60000} мин`);
    stormActive = true;
    // Алерт владельцу — чтобы не гадать, почему бот притих.
    // 03.08: троттл был 15 мин, и за ночь в ТГ ушло больше десятка одинаковых «GoLogin штормит».
    // Смысла в повторах нет: сообщение не несёт новой информации, предохранитель и так держит паузу
    // сам, а постинг моделей давно идёт ЛОКАЛЬНО (startLocal на маке) и от облачных 503 не страдает.
    // Поэтому: одно сообщение на шторм, повтор не чаще раза в 6 часов, о восстановлении сообщим отдельно.
    if (Date.now() - stormAlertedAt > 6 * 60 * 60 * 1000) {
      stormAlertedAt = Date.now();
      void notifyOwner(`⚠️ GoLogin штормит: ${infraFailStreak} сбоя коннекта подряд (503/прокси) — бот на паузе ${cool / 60000} мин, заходы приостановлены. Это инфраструктура GoLogin (не акки). Восстановится сам.`, { force: true }).catch(() => {});
    }
  }
}
function noteOk() {
  if (stormActive) { // вышли из шторма — сообщаем, что ожило
    stormActive = false;
    void notifyOwner('✅ GoLogin ожил — коннекты пошли, бот продолжает работу.', { force: true }).catch(() => {});
  }
  infraFailStreak = 0; gologinDownUntil = 0;
}

export async function connect(profileId: string, tok?: string | null, opts?: { pool?: SlotPool; poolCap?: number; holder?: string }): Promise<Session> {
  if (Date.now() < gologinDownUntil) {
    // GoLogin в паузе после серии 503 — не пытаемся (это инфраструктура, не акк).
    throw new Error(`GoLogin недоступен (прокси/503), пауза ещё ${Math.ceil((gologinDownUntil - Date.now()) / 1000)}с`);
  }
  // ГЛОБАЛЬНЫЙ СЕМАФОР: занимаем слот пула ДО открытия профиля. Нет свободного → бросаем (вызывающий скипает,
  // не крэшит) — это бэкпрешер против overcommit (co-причина no_connect). Освобождаем при любом провале ниже.
  let slotId: string | null = null;
  if (opts?.pool) {
    slotId = await claimSlot(opts.pool, opts.holder || profileId, opts.poolCap);
    if (!slotId) throw new Error(`нет свободного слота GoLogin (пул ${opts.pool} занят)`);
  }
  try {
  let lastMsg = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`[gologin] подключаюсь к профилю ${profileId}…${attempt > 1 ? ` (попытка ${attempt})` : ''}`);
    try {
      const browser = await chromium.connectOverCDP(cloudConnectUrl(profileId, tok), { timeout: 45_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      // === ПИННИНГ ЯЗЫКА IG ===
      // GoLogin раздаёт профилям СЛУЧАЙНУЮ локаль, из-за чего IG рисует интерфейс на любом языке, а весь
      // наш детект (2FA-экран, куки-баннер, «Не сейчас», bad_creds, суспенд) построен на текстовых регекспах
      // и молча промахивается на PL/AR/ID/HI/JA/KO/ZH/VI/TH → вход уходит в 'need_login', всплывашка висит,
      // комментинг рапортует «не нашёл поле». Прибиваем ОДИН язык (en) — учимся и работаем на нём одном.
      await context.addCookies([
        { name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' },
      ]).catch(() => {});
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
      // === ЭКОНОМИЯ РЕЗИД-ТРАФИКА === режем тяжёлые ресурсы, что идут через платный прокси. ВСЕГДА рубим
      // video/audio (рилсы — основная масса байт), шрифты И КАРТИНКИ режем ПО УМОЛЧАНИЮ — это главный
      // рычаг экономии резид-трафика (картинки IG = десятки МБ на заход). Комментингу/прогреву/радару/
      // дежурству/релогину контент не нужен — они кликают по DOM (лента определяется по <article>,
      // навигации и sessionid-куке, а не по загруженным пикселям). KEEP_IMAGES=1 — вернуть картинки
      // (если где-то сломается детект по аватарке); NO_TRAFFIC_SAVE=1 — выключить резку целиком.
      if (!/^(1|true|yes)$/i.test(String(process.env.NO_TRAFFIC_SAVE || ''))) {
        const heavy = new Set<string>(['media', 'font', 'image']);
        if (/^(1|true|yes)$/i.test(String(process.env.KEEP_IMAGES || ''))) heavy.delete('image');
        await page.route('**/*', (route) => {
          const req = route.request();
          const url = req.url();
          // НИКОГДА не режем данные: graphql/api/комменты/query — иначе сломаем логику (детект/комментинг).
          if (/graphql|\/api\/|\/comments\/|query/i.test(url)) return route.continue().catch(() => {});
          // Видео рилсов идёт СЕГМЕНТАМИ (MSE), resourceType бывает 'xhr'/'fetch', а не 'media' → режем по URL.
          // Та же дыра, что закрыта в vcomment: .m4s / mp4-сегменты cdn / bytestart= через платный прокси.
          const videoSeg = /\.m4s(\?|$)/i.test(url)
            || /(scontent|cdninstagram|fbcdn)[^ ]*\/(v|o1)\/[^ ]*\.(mp4|m4s|m4v|webm)/i.test(url)
            || (/bytestart=/i.test(url) && /(cdninstagram|fbcdn)/i.test(url));
          if (videoSeg || heavy.has(req.resourceType())) return route.abort().catch(() => {});
          return route.continue().catch(() => {});
        }).catch(() => {});
      }
      console.log(`[gologin] профиль ${profileId} подключён`);
      noteOk(); // облако живо — сбрасываем стрик/паузу
      return { browser, context, page, profileId, token: tok, slotId };
    } catch (err) {
      lastMsg = stripToken(err instanceof Error ? err.message : String(err));
      console.warn(`[gologin] не подключился к ${profileId}: ${lastMsg}`);
      if (attempt < 4 && isBusyErr(lastMsg)) {
        // Лимит/занятый слот или шторм облака — ждём 6-15с и пробуем снова.
        await new Promise((r) => setTimeout(r, 6000 + attempt * 3000));
        continue;
      }
      if (isInfraErr(lastMsg)) noteInfraFail(); // 503/прокси — считаем инфра-сбой, взводим предохранитель
      throw new Error(lastMsg);
    }
  }
  if (isInfraErr(lastMsg)) noteInfraFail();
  throw new Error(lastMsg);
  } catch (e) {
    await releaseSlot(slotId); // неудачный connect — слот не держим
    throw e;
  }
}

// Явно остановить облачный профиль в GoLogin (освобождает единственный слот на тарифе).
// browser.close() лишь отключает CDP-клиент — профиль остаётся "running" до простоя.
export async function stopCloudProfile(profileId: string, tok?: string | null): Promise<void> {
  try {
    const res = await fetch(`${API}/browser/${encodeURIComponent(profileId)}/web`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token(tok)}` },
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`[gologin] стоп профиля ${profileId}: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[gologin] не смог остановить профиль ${profileId}: ${e instanceof Error ? e.message : e}`);
  }
}

// === МАССОВЫЙ ЗАВОД ПРОФИЛЕЙ (панель: файл → профили с прокси/куками → ID акков) ===
export interface ProxySpec { mode: string; host: string; port: number; username?: string; password?: string; }

// Создать облачный профиль. Сервер сам генерит валидный фингерпринт (ответ /browser/fingerprint
// напрямую в /browser НЕ шлётся — формат fonts/webGLMetadata другой). os: 'win'|'mac'|'lin'.
export async function createCloudProfile(name: string, os = 'win', tok?: string | null): Promise<string> {
  const res = await fetch(`${API}/browser/quick`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(tok)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ os, name }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && /max profiles/i.test(body)) throw new Error('нет слотов в GoLogin (лимит профилей тарифа)');
    throw new Error(`create ${res.status}: ${stripToken(body).slice(0, 140)}`);
  }
  const j = (await res.json()) as Record<string, any>;
  const id = j.id || j._id;
  if (!id) throw new Error('GoLogin не вернул id профиля');
  return String(id);
}

// Прикрепить прокси к профилю (PATCH — валидируется, но НЕ пингуется на этом шаге).
export async function setProfileProxy(profileId: string, proxy: ProxySpec, tok?: string | null): Promise<void> {
  const res = await fetch(`${API}/browser/${encodeURIComponent(profileId)}/proxy`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token(tok)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(proxy),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
}

// Залить куки в профиль — акк поднимется уже залогиненным. Формат: массив [{name,value,domain,…}].
export async function importCookies(profileId: string, cookies: any[], tok?: string | null): Promise<void> {
  const res = await fetch(`${API}/browser/${encodeURIComponent(profileId)}/cookies`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(tok)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cookies),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`cookies HTTP ${res.status}`);
}

// Удалить профиль (чистка мёртвых). 403 = профиль расшарен/защищён (руками в GoLogin).
export async function deleteCloudProfile(profileId: string, tok?: string | null): Promise<number> {
  try {
    await stopCloudProfile(profileId, tok); // сперва гасим сессию, иначе running -> 403
  } catch { /* не критично */ }
  const res = await fetch(`${API}/browser/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token(tok)}` },
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

// Разбор строки прокси в любом ходовом виде: host:port:user:pass | user:pass@host:port | host:port,
// с необязательной схемой http:// | socks5:// (по умолчанию http, как у текущих IG-профилей).
// Пароль может содержать ':' — в colon-форме берём весь хвост. Ветку user:pass@host:port выбираем
// только если справа от последнего '@' реально host:port (иначе '@' встретился в логине/пароле).
export function parseProxy(raw: string | null | undefined): ProxySpec | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let mode = 'http';
  const scheme = s.match(/^(https?|socks[45]?):\/\//i);
  if (scheme) { mode = /socks/i.test(scheme[1]) ? 'socks5' : 'http'; s = s.slice(scheme[0].length); }
  const isHostPort = (str: string) => { const p = str.split(':'); return p.length === 2 && !!p[0].trim() && Number(p[1]) > 0; };
  let host = '', port = 0, username = '', password = '';
  const at = s.lastIndexOf('@');
  if (at >= 0 && isHostPort(s.slice(at + 1))) {
    const cred = s.slice(0, at); const hp = s.slice(at + 1);
    const ci = cred.indexOf(':');
    username = (ci >= 0 ? cred.slice(0, ci) : cred).trim();
    password = (ci >= 0 ? cred.slice(ci + 1) : '').trim();
    const p = hp.split(':'); host = p[0].trim(); port = Number(p[1]) || 0;
  } else {
    const parts = s.split(':');
    host = (parts[0] || '').trim(); port = Number(parts[1]) || 0;
    username = (parts[2] || '').trim(); password = parts.slice(3).join(':').trim(); // хвост с ':' не теряем
  }
  if (!host || !port) return null;
  return { mode, host, port, username, password };
}

// Отключиться И остановить облачный профиль — чтобы слот освободился сразу, не по простою.
export async function disconnect(session: Session): Promise<void> {
  await session.browser.close().catch(() => {});
  await stopCloudProfile(session.profileId, session.token); // close-after-use: гасим профиль сразу, не держим
  await releaseSlot(session.slotId);                        // освобождаем слот глобального семафора
  // Даём GoLogin реально освободить слот, иначе следующий профиль упрётся в лимит.
  await new Promise((r) => setTimeout(r, 3000));
}

// Быстрая проверка (дёшево, REST): есть ли у профиля непросроченная кука сессии.
// grabli #3: этот чек ВРЁТ — кука остаётся «живой» даже после отзыва сессии площадкой.
// Годится только для зелёной лампочки, НЕ для перевода dead -> live.
// null = «НЕ ЗНАЮ» (инфра-сбой), НЕ «мёртв». Раньше любой не-200 (503/429/401 от протухшего токена группы)
// возвращал false → maybeSessions метил акк 'dead'. При 401 на токене группы ВСЯ ГРУППА разом уезжала в dead,
// а храповик dead→live не пускал её обратно по быстрому чеку. Теперь такие ответы = null, статус не трогаем.
export async function checkSessionFast(profileId: string, cookieName = 'sessionid', tok?: string | null): Promise<boolean | null> {
  // Таймаут ОБЯЗАТЕЛЕН: без него зависший фетч (GoLogin 503-ит) вешает весь тик воркера.
  const res = await fetch(`${API}/browser/${profileId}/cookies`, {
    headers: { Authorization: `Bearer ${token(tok)}` },
    signal: AbortSignal.timeout(12_000),
  });
  // ЛЮБОЙ не-200 это «НЕ ЗНАЮ», а не «мёртв» (07.08). Раньше перечисление кодов (5xx/429/401/403)
  // было белым списком инфры, а всё остальное падало в `return false`, то есть в приговор акку.
  // Мимо списка проходили как раз самые обидные случаи: 402 «тариф GoLogin не оплачен», 404
  // «профиля нет» (это про профиль, а не про сессию), 400/408/409. В тот же день на этом сгорела
  // проверка картинок: платный сервис ответил 402, и девять годных постов уехали в брак.
  // Правило одно: ответ, которого мы не поняли, не даёт права выносить вердикт.
  if (!res.ok) return null;
  const cookies = (await res.json()) as Array<{ name: string; expirationDate?: number }>;
  const c = cookies.find((x) => x.name === cookieName);
  if (!c) return false;
  return !c.expirationDate || c.expirationDate * 1000 > Date.now();
}

// Прокси профиля из настроек GoLogin: адрес/порт/логин/пароль живут ТАМ,
// в панели их руками не вводим (у аккаунта остаётся только ожидаемое гео для сверки).
export async function getProfileProxy(profileId: string, tok?: string | null): Promise<{
  mode: string; host: string; port: number; username: string; password: string;
} | null> {
  try {
    const res = await fetch(`${API}/browser/${encodeURIComponent(profileId)}`, {
      headers: { Authorization: `Bearer ${token(tok)}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, any>;
    const p = j?.proxy;
    if (!p?.host) return null;
    return {
      mode: String(p.mode || 'http'),
      host: String(p.host),
      port: Number(p.port) || 0,
      username: String(p.username || ''),
      password: String(p.password || ''),
    };
  } catch {
    return null;
  }
}

// Все ID профилей одного GoLogin-аккаунта (пагинация v2). Для сверки БД↔GoLogin (reconcile): акк, чей
// gologin_profile_id пропал из этого множества = «профиль потерян». ⚠️ ok:false, если фетч рухнул на 1-й
// странице — иначе примем «пусто» за «все профили исчезли» и пометим всю группу profile_lost по ошибке.
export async function listAllProfiles(tok?: string | null): Promise<{ ok: boolean; ids: Set<string> }> {
  const ids = new Set<string>();
  for (let page = 1; page < 40; page++) {
    const r = await fetch(`${API}/browser/v2?page=${page}&limit=30`, {
      headers: { Authorization: `Bearer ${token(tok)}` }, signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!r || !r.ok) return { ok: page > 1, ids }; // рухнул на 1-й стр → ok=false (не доверяем неполному списку)
    const j = await r.json().catch(() => ({})) as any;
    const arr = Array.isArray(j) ? j : (j.profiles || []);
    for (const p of arr) { const id = String(p.id || p._id || ''); if (id) ids.add(id); }
    const total = Number(j.allProfilesCount || 0);
    if (arr.length < 30 || (total && ids.size >= total)) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  return { ok: true, ids };
}

// Замер точки выхода (egress): через какой IP и страну реально выходит профиль.
// Вызываем на уже открытой странице (внутри сессии прогрева) — слот не тратим лишний раз.
// Критично для антибана: TikTok должен видеть один и тот же мобильный IP нужной гео.
// ДВА НЕЗАВИСИМЫХ СЕРВИСА, ПО ДВЕ ПОПЫТКИ (07.08). Раньше замер был один запрос к ipinfo.io, и
// его провал (429 от ipinfo, HTML вместо JSON, таймаут 15с) писался в базу как proxy_status='dead',
// то есть чужой сервис выносил вердикт нашему каналу: акк выпадал из работы, а авто-починка тянула
// из пула новый порт под уже живой прокси. Это тот же класс ошибки, что 402 у проверки картинок.
// Теперь «мёртв» это только когда НИ ОДИН из двух разных сервисов не ответил с двух попыток:
// такое уже говорит о канале, а не о доступности одного сайта.
// country пустой = гео замерить не вышло (ipify его не отдаёт). Вызывающие обязаны в этом случае
// НЕ ставить 'mismatch': отсутствие данных не есть несовпадение.
const EGRESS_PROBES = [
  { url: 'https://ipinfo.io/json', geo: true },
  { url: 'https://api.ipify.org?format=json', geo: false },
];
export async function probeEgress(page: Page): Promise<{ ip: string; country: string } | null> {
  const fails: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const p of EGRESS_PROBES) {
      try {
        await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        const txt = await page.evaluate(() => document.body.innerText || '');
        const j = JSON.parse(txt);
        const ip = String(j.ip || '').trim();
        if (!ip) { fails.push(`${p.url}: без ip`); continue; }
        return { ip, country: p.geo ? String(j.country || '').trim().toUpperCase() : '' };
      } catch (e) {
        fails.push(`${p.url}: ${String((e as Error).message).slice(0, 50)}`);
      }
    }
  }
  console.warn(`[gologin] egress не замерен ни одним сервисом: ${fails.slice(0, 4).join(' · ')}`);
  return null;
}

// Глубокая проверка (правда): реально открыть браузер и посмотреть DOM.
// Только через неё разрешено переводить dead -> live.
// null = «НЕ ЗНАЮ» (07.08). Раньше стоял `catch { return false }`, и один и тот же false означал
// две противоположные вещи: «открыли ленту, там гость» и «профиль вообще не открылся». Во второй
// случай попадали шторм облака GoLogin, «нет свободного слота», fast-fail предохранителя, упавший
// прокси и таймаут goto — то есть НАША инфраструктура выносила приговор аккаунту. Кнопка
// «Проверить сессии» ходит по всей площадке, поэтому один шторм метил dead всех разом.
export async function checkSessionDeep(profileId: string, driver: PlatformDriver, tok?: string | null): Promise<boolean | null> {
  // Через замок этого GoLogin-аккаунта — 1 профиль за раз на тариф.
  return withBrowserLock(async () => {
    let session: Session | null = null;
    try {
      session = await connect(profileId, tok);
      await session.page.goto(driver.warmup.feedUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await session.page.waitForTimeout(2500);
      // Досюда дошли = профиль открылся и лента прочитана: вот этому ответу верить можно.
      return !(await driver.isLoggedOut(session.page));
    } catch (e) {
      // Не смогли посмотреть — значит не знаем. Вызывающий обязан оставить статус как был.
      console.warn(`[gologin] checkSessionDeep ${profileId}: проверить не удалось (${String((e as Error).message).slice(0, 90)}) — вердикт НЕ выносим`);
      return null;
    } finally {
      if (session) await disconnect(session);
    }
  }, lockKey(tok));
}
