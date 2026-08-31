// === ЮТУБ-КАНАЛЫ (17-18.08) ======================================================================
// Постинг готовых Shorts на НАШИ каналы через YouTube Data API v3 (не браузер, не GoLogin).
// Много каналов: yt_channels, у каждого свой OAuth-клиент (свой проект Google Cloud = своя квота:
// 10 000 ед/сутки, загрузка 1600 → 6 роликов/сутки), свои настройки текста и темпа.
// id=1 бренд, дальше мультиакки-обучалки по промптам (ролики любых моделей, мягкий CTA, utm_medium=ник).
// Загрузка файлов с мака делает ytrunner.cjs (та же БД, те же правила); ролики по URL грузит сервер (tick).
// Env: PUBLIC_URL (redirect для OAuth = PUBLIC_URL/api/youtube/oauth/cb, один на все каналы).
import type { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { query } from './db/index.js';
import { generateYtTitle } from './ai.js';
import { templateOf, hookBlock, postKey, takenBlock, hookTextById } from './hooks.js';
import { notifyOwner } from './notify.js';

// force-ssl: право удалять/править видео (чистка приватных черновиков) и брендинг канала, не только загрузка.
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl';
const PUBLIC_URL = () => (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');
const redirectUri = () => PUBLIC_URL() + '/api/youtube/oauth/cb';

export type YtChannel = {
  subs?: number | null; avatar_url?: string | null; channel_views?: number | null; channel_stats_upd?: string | null;
  id: number; slug: string; name: string; channel_id: string | null; title: string | null;
  refresh_token: string | null; client_id: string | null; client_secret: string | null; connected_at: string | null;
  enabled: boolean; cta: string; landing: string; utm_source: string; utm_medium: string; utm_campaign: string;
  body: string; hashtags: string; titles: string; title_prompt: string; privacy: string; per_day: number; gap_min: number;
  post_hours: string; model_filter: string | null; platform: string | null; auth: any;
};
export const CH_FIELDS = ['name', 'cta', 'landing', 'utm_source', 'utm_medium', 'utm_campaign', 'body', 'hashtags', 'titles', 'title_prompt', 'privacy', 'post_hours', 'model_filter'] as const;

export async function ytChannels(): Promise<YtChannel[]> {
  return (await query<YtChannel>(`SELECT * FROM yt_channels ORDER BY id`)).rows;
}
export async function ytChannel(id: number): Promise<YtChannel> {
  const c = (await query<YtChannel>(`SELECT * FROM yt_channels WHERE id=$1`, [id])).rows[0];
  if (!c) throw new Error('нет канала #' + id);
  return c;
}
const pubChannel = (c: YtChannel) => { const { refresh_token, client_secret, ...rest } = c; return { ...rest, connected: !!refresh_token, has_client: !!(c.client_id && client_secret) }; };

// --- сборка текста: название + описание (CTA, ссылка с UTM, тело, хэштеги) ---------------------
export function buildYtMeta(s: YtChannel, item: { id?: number | string; src_title?: string | null; src_text?: string | null; file_hash?: string | null; utm_content?: string | null; ai_title?: string | null }) {
  const utmContent = item.utm_content || ('yt' + String(item.id ?? '') + '_' + (item.file_hash || createHash('sha1').update(String(item.src_title || Math.random())).digest('hex')).slice(0, 8));
  const isShort = /\/go\//.test(s.landing); // трекинг-ссылка админки сама проставит utm
  const link = isShort ? s.landing : s.landing + (s.landing.includes('?') ? '&' : '?') + new URLSearchParams({
    utm_source: s.utm_source, utm_medium: s.utm_medium, utm_campaign: s.utm_campaign, utm_content: utmContent,
  }).toString();
  let title = '', hookLine = '';
  if (item.src_text) {
    const lines = item.src_text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    hookLine = lines[0] || '';
    title = hookLine.split(/[.!?]/)[0].trim();
  }
  if (item.ai_title) title = item.ai_title.trim();
  if (!title && item.src_title) title = item.src_title;
  if (!title) {
    const pool = s.titles.split('\n').map((t) => t.trim()).filter(Boolean);
    const idx = parseInt((item.file_hash || '0').slice(0, 6), 16) % Math.max(1, pool.length);
    title = pool[idx] || 'Нейросеть по одному селфи';
  }
  title = title.replace(/[<>]/g, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  if (title.length > 90) title = title.slice(0, 87).trim() + '…';
  const isYT = !(s as any).platform || (s as any).platform === 'youtube';
  if (isYT && !/#shorts/i.test(title)) title += ' #Shorts';
  const BAD_TAGS = /ринопласт|пластическ|хирург|операц|филлер|ботокс|мужск|парн[яю]м/i;
  const tags = new Set(s.hashtags.split(/\s+/).filter((t) => t.startsWith('#')));
  if (item.src_text) for (const t of item.src_text.match(/#[\p{L}\p{N}_]+/gu) || []) if (!BAD_TAGS.test(t)) tags.add(t);
  if (isYT && ![...tags].some((t) => t.toLowerCase() === '#shorts')) tags.add('#shorts');
  if (!isYT) for (const t of [...tags]) if (t.toLowerCase() === '#shorts') tags.delete(t);
  const parts = [`${s.cta}${link}`];
  if (hookLine && hookLine !== title) parts.push(hookLine.replace(/нейронка про шаблоны/gi, 'нейронка про промпты'));
  if (s.body) parts.push(s.body);
  parts.push([...tags].slice(0, 15).join(' '));
  const description = parts.join('\n\n').replace(/[<>]/g, '').slice(0, 4900);
  return { title, description, utm_content: utmContent, link };
}

// Проверка текста перед загрузкой: ссылка с UTM, хэштеги, вменяемое название. Иначе ролик не уходит.
export function ytMetaProblems(m: { title: string; description: string }): string | null {
  const bad: string[] = [];
  const t = m.title.replace(/#shorts/i, '').trim();
  if (t.length < 8) bad.push('название короче 8 знаков');
  if (t.length > 95) bad.push('название длиннее 95');
  if (/[<>]|—/.test(m.title + m.description)) bad.push('запрещённые символы (< > —)');
  if (!/neironka\.pro/.test(m.description)) bad.push('нет ссылки на сайт');
  if ((m.description.match(/#[\p{L}\p{N}_]+/gu) || []).length < 3) bad.push('меньше 3 хэштегов');
  if (/#Shorts/i.test(m.title) && !/#shorts/i.test(m.description)) bad.push('нет #shorts');
  return bad.length ? bad.join('; ') : null;
}

// Байтовые названия: генерим заранее для всех queued без ai_title (раннер на маке LLM не зовёт).
export async function ytGenTitles(limit = 5): Promise<number> {
  const { rows } = await query<any>(`SELECT q.id, q.channel_id, q.src_title, q.src_text, q.file_path, q.media_url, q.template, c.title_prompt
    FROM yt_queue q JOIN yt_channels c ON c.id=q.channel_id WHERE q.status='queued' AND q.ai_title IS NULL ORDER BY q.id LIMIT $1`, [limit]);
  let n = 0;
  // Дедуп: в ленте канала уже встречались одинаковые названия («Цветотип поменял весь гардероб»
  // дважды). Модель повторяется, потому что образцы у неё одни и те же. Отдаём ей последние
  // названия канала как список запрещённых, это дешевле любой проверки после генерации.
  const recent = new Map<number, string[]>();
  for (const r of rows) {
    if (!recent.has(r.channel_id)) {
      const { rows: last } = await query<any>(
        `SELECT coalesce(title, ai_title) t FROM yt_queue WHERE channel_id=$1 AND coalesce(title, ai_title) IS NOT NULL
         ORDER BY coalesce(posted_at, created_at) DESC LIMIT 25`, [r.channel_id]);
      recent.set(r.channel_id, last.map((x: any) => String(x.t).replace(/\s*#\S+/g, '').trim()).filter(Boolean));
    }
    // Тема ролика решает регистр речи: у разбора («ошибка, исправляем») и у тренда-гадания
    // («пов, я плакала») разные языки, и перепутать их значит соврать зрителю заголовком.
    const tpl = r.template || templateOf(r.file_path || r.media_url, r.src_text);
    if (tpl && tpl !== r.template) await query(`UPDATE yt_queue SET template=$2 WHERE id=$1`, [r.id, tpl]).catch(() => {});
    const ctx = [r.src_text ? 'Подпись ролика: ' + r.src_text : '', 'Файл: ' + (r.file_path || r.media_url || '').split('/').pop()].filter(Boolean).join('\n');
    // Что уже взято по этому посту на других площадках (общий реестр hook_usage).
    const key = postKey(r.file_path || r.media_url);
    const { rows: занято } = await query<any>(
      `SELECT hook_id FROM hook_usage WHERE post_key=$1 AND platform<>'youtube'`, [key]).catch(() => ({ rows: [] as any[] }));
    const занятыеТексты = занято.map((x: any) => hookTextById(x.hook_id)).filter(Boolean) as string[];
    const used = recent.get(r.channel_id) || [];
    const noRepeat = used.length ? '\n\nЭТИ НАЗВАНИЯ НА КАНАЛЕ УЖЕ БЫЛИ, ПОВТОРЯТЬ И ПЕРЕСКАЗЫВАТЬ ИХ НЕЛЬЗЯ:\n' + used.map((x) => '  ' + x).join('\n') : '';
    const t = await generateYtTitle(r.title_prompt + hookBlock(tpl) + takenBlock(занятыеТексты) + noRepeat, ctx).catch(() => '');
    if (t) { await query(`UPDATE yt_queue SET ai_title=$2 WHERE id=$1`, [r.id, t]); used.unshift(t); n++; }
  }
  return n;
}

// --- OAuth (redirect общий, канал едет в state) ------------------------------------------------
export function ytAuthUrl(c: YtChannel): string {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.client_id || '', redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: String(c.id),
  }).toString();
}
async function tokenPost(c: YtChannel, params: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id || '', client_secret: c.client_secret || '', ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  return r.json() as Promise<Record<string, any>>;
}
const _access = new Map<number, { token: string; exp: number }>();
export async function ytAccessToken(c: YtChannel): Promise<string> {
  const a = _access.get(c.id);
  if (a && a.exp > Date.now() + 60_000) return a.token;
  if (!c.refresh_token) throw new Error(`канал ${c.slug} не подключён`);
  const j = await tokenPost(c, { refresh_token: c.refresh_token, grant_type: 'refresh_token' });
  if (!j.access_token) throw new Error('refresh failed: ' + (j.error_description || j.error || JSON.stringify(j)));
  const tok = { token: j.access_token as string, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  _access.set(c.id, tok);
  return tok.token;
}
async function ytApi(c: YtChannel, pathQ: string, init?: RequestInit) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + pathQ, {
    ...init, headers: { authorization: 'Bearer ' + await ytAccessToken(c), 'content-type': 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) throw new Error(`YouTube API ${r.status}: ${j.error?.message || ''}`);
  return j;
}

// --- загрузка ролика по публичному URL (сервер сам) --------------------------------------------
async function uploadFromUrl(c: YtChannel, item: any) {
  const meta = buildYtMeta(c, item);
  const bad = ytMetaProblems(meta); if (bad) throw new Error('текст не прошёл проверку: ' + bad);
  const src = await fetch(item.media_url, { signal: AbortSignal.timeout(120_000) });
  if (!src.ok) throw new Error('media_url ' + src.status);
  const buf = Buffer.from(await src.arrayBuffer());
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + await ytAccessToken(c), 'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(buf.length) },
    body: JSON.stringify({
      snippet: { title: meta.title, description: meta.description, categoryId: '22', defaultLanguage: 'ru', defaultAudioLanguage: 'ru' },
      status: { privacyStatus: c.privacy, selfDeclaredMadeForKids: false, embeddable: true },
    }),
  });
  if (!init.ok) { const j = await init.json().catch(() => ({})) as any; throw new Error(`init ${init.status}: ${j.error?.message || ''}`); }
  const loc = init.headers.get('location')!;
  const put = await fetch(loc, { method: 'PUT', headers: { 'content-length': String(buf.length), 'content-type': 'video/mp4' }, body: buf });
  if (!put.ok) throw new Error('upload ' + put.status + ': ' + (await put.text()).slice(0, 200));
  const j = await put.json() as any;
  return { id: j.id as string, meta };
}

// Гейт темпа (его же зеркалит ytrunner): слоты post_hours по МСК, один ролик на слот, потолок per_day, пауза gap_min.
export function ytSlotOpen(postHours: string, lastPostedAt: Date | null, now = new Date()): string | null {
  const hours = String(postHours || '').split(/[,\s]+/).filter(Boolean).map(Number).filter((h) => Number.isFinite(h) && h >= 0 && h < 24);
  if (!hours.length) return null;
  const msk = new Date(now.getTime() + 3 * 3600_000);
  const h = msk.getUTCHours();
  const slot = hours.find((sh) => h >= sh && h < sh + 1);
  if (slot === undefined) return `ждём слот (${hours.map((x) => x + ':00').join(', ')} МСК)`;
  if (lastPostedAt) {
    const lm = new Date(lastPostedAt.getTime() + 3 * 3600_000);
    if (lm.getUTCFullYear() === msk.getUTCFullYear() && lm.getUTCMonth() === msk.getUTCMonth() && lm.getUTCDate() === msk.getUTCDate() && lm.getUTCHours() >= slot) return `слот ${slot}:00 уже отработан`;
  }
  return null;
}
export async function ytGate(c: YtChannel): Promise<string | null> {
  const { rows } = await query<{ today: string; last: string | null }>(
    `SELECT count(*) FILTER (WHERE (posted_at AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date) today, max(posted_at) last FROM yt_queue WHERE channel_id=$1 AND status='posted'`, [c.id]);
  const today = Number(rows[0]?.today || 0);
  const lastD = rows[0]?.last ? new Date(rows[0].last) : null;
  if (!c.enabled) return 'автопостинг выключен';
  if (!c.refresh_token) return 'канал не подключён';
  if (today >= c.per_day) return `лимит ${c.per_day}/сутки выбран`;
  // жёсткий минимум между заливками: после простоя раннера просроченные слоты не должны уходить залпом
  const gapMin = Math.max(Number(c.gap_min) || 0, 30);
  if (lastD && Date.now() - lastD.getTime() < gapMin * 60_000) return `пауза до ${new Date(lastD.getTime() + gapMin * 60_000 + 3 * 3600_000).toISOString().slice(11, 16)} МСК`;
  return ytSlotOpen(c.post_hours, lastD);
}

// Тик раз в минуту: названия для очереди, потом по каждому каналу один ролик С media_url (файлы грузит ytrunner).
let ticking = false;
export async function ytTick(): Promise<void> {
  if (ticking) return; ticking = true;
  try {
    await ytGenTitles(5).catch(() => 0);
    for (const c of await ytChannels()) {
      if (await ytGate(c)) continue;
      const { rows } = await query<any>(
        `UPDATE yt_queue SET status='uploading', locked_at=now()
          WHERE id = (SELECT id FROM yt_queue WHERE channel_id=$1 AND status='queued' AND media_url IS NOT NULL
                        AND (scheduled_at IS NULL OR scheduled_at <= now()) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`, [c.id]);
      const item = rows[0];
      if (!item) continue;
      try {
        const r = await uploadFromUrl(c, item);
        await query(`UPDATE yt_queue SET status='posted', video_id=$2, url=$3, title=$4, description=$5, utm_content=$6, posted_at=now(), error=NULL WHERE id=$1`,
          [item.id, r.id, 'https://youtube.com/shorts/' + r.id, r.meta.title, r.meta.description, r.meta.utm_content]);
        await notifyOwner(`ютуб [${c.name}] ${c.privacy === 'private' ? 'черновик' : 'выложен'}: ${r.meta.title}\nhttps://studio.youtube.com/video/${r.id}/edit`).catch(() => {});
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const back = /quota|uploadLimit/i.test(m);
        await query(`UPDATE yt_queue SET status=$2, error=$3, locked_at=NULL WHERE id=$1`, [item.id, back ? 'queued' : 'error', m.slice(0, 500)]);
      }
    }
  } catch { /* тихо, следующий тик */ } finally { ticking = false; }
}

// Сторож раз в час, по каждому каналу. Не чаще раза в 6 ч на причину.
const _alerted: Record<string, number> = {};
let ytRefreshAllStatsImpl: (() => Promise<void>) | null = null;
// Фоновое обновление просмотров: зовётся по таймеру из src/index.ts, работает только после mountYoutube.
export async function ytRefreshAllStats(): Promise<void> { if (ytRefreshAllStatsImpl) await ytRefreshAllStatsImpl(); }
export async function ytWatchdog(): Promise<void> {
  try {
    const hb = (await query<any>(`SELECT max(tick_at) t FROM runner_heartbeat WHERE runner LIKE 'ytrunner%'`)).rows[0]?.t;
    for (const c of await ytChannels()) {
      if (!c.enabled || !c.refresh_token) continue;
      const st = (await query<any>(`SELECT
          count(*) FILTER (WHERE status='queued') queued,
          count(*) FILTER (WHERE status='queued' AND file_path IS NOT NULL) queued_files,
          count(*) FILTER (WHERE status='error' AND created_at > now() - interval '2 days') errors,
          max(posted_at) FILTER (WHERE status='posted') last_posted FROM yt_queue WHERE channel_id=$1`, [c.id])).rows[0];
      const alerts: [string, string][] = [];
      const lastMs = st.last_posted ? new Date(st.last_posted).getTime() : 0;
      const tag = `ютуб [${c.name}]`;
      if (Number(st.queued) > 0 && lastMs && Date.now() - lastMs > 26 * 3600e3) alerts.push(['stale', `${tag}: очередь ${st.queued}, а последний ролик был ${Math.round((Date.now() - lastMs) / 3600e3)} ч назад`]);
      if (Number(st.queued_files) > 0 && (!hb || Date.now() - new Date(hb).getTime() > 40 * 60e3)) alerts.push(['runner', `${tag}: ytrunner на маке молчит, в очереди файлов ${st.queued_files}`]);
      if (Number(st.errors) >= 3) alerts.push(['errors', `${tag}: ${st.errors} ошибок загрузки за 2 дня, смотри панель → YouTube`]);
      if (Number(st.queued) === 0) alerts.push(['empty', `${tag}: очередь пуста, докинь роликов`]);
      for (const [k, msg] of alerts) { const key = c.id + ':' + k; if (Date.now() - (_alerted[key] || 0) > 6 * 3600e3) { _alerted[key] = Date.now(); await notifyOwner(msg).catch(() => {}); } }
    }
  } catch { /* тихо */ }
}

// --- маршруты панели ---------------------------------------------------------------------------
export function mountYoutube(api: Router) {
  const err = (res: Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  const chId = (req: Request) => Number(req.query.ch || req.body?.ch || 1) || 1;

  api.get('/youtube/channels', async (_req, res) => {
    try {
      const chans = await ytChannels();
      const q = (await query<any>(`SELECT channel_id, status, count(*) n FROM yt_queue GROUP BY 1,2`)).rows;
      const hb = (await query<any>(`SELECT max(tick_at) t FROM runner_heartbeat WHERE runner LIKE 'ytrunner%'`).catch(() => ({ rows: [{ t: null }] }))).rows[0]?.t;
      const out = [];
      for (const c of chans) {
        const qq: Record<string, number> = {}; for (const r of q) if (Number(r.channel_id) === c.id) qq[r.status] = Number(r.n);
        const today = Number((await query<any>(`SELECT count(*) n FROM yt_queue WHERE channel_id=$1 AND status='posted' AND (posted_at AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date`, [c.id])).rows[0].n);
        out.push({ ...pubChannel(c), queue: qq, today, gate: await ytGate(c) });
      }
      res.json({ channels: out, redirect_uri: redirectUri(), runner_seen: hb });
    } catch (e) { err(res, e); }
  });

  // Новый канал: { slug, name, client_id, client_secret }
  api.post('/youtube/channels', async (req, res) => {
    try {
      const b = req.body || {};
      const slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!slug || !b.name) return res.status(400).json({ error: 'нужны slug и name' });
      const r = await query<any>(`INSERT INTO yt_channels (slug, name, client_id, client_secret, utm_medium, cta, title_prompt)
        VALUES ($1,$2,$3,$4,$1,$5,$6) RETURNING id`,
        [slug, b.name, b.client_id || null, b.client_secret || null,
         'сделала тут 👉', 'Ты пишешь названия для YouTube Shorts канала девушки 18-25 лет, которая показывает промпты и шаблоны нейросети по одному селфи (внешность, стрижка, макияж, образ, тренды из тиктока). Название 4-8 слов от первого лица, хук в первых 3 словах, темы: внешность, самооценка, парни, бывший, тренд из тиктока, сравнение со звездой. Одно слово можно КАПСОМ, эмодзи максимум одно в конце, без кавычек, хэштегов, цифр, слов «гайд», «туториал», «как сделать», без длинного тире. Не копируй примеры дословно, до 50 знаков. Верни ТОЛЬКО название.']);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { err(res, e); }
  });

  api.post('/youtube/channels/:id/settings', async (req, res) => {
    try {
      const id = Number(req.params.id); const b = req.body || {};
      for (const f of CH_FIELDS) if (typeof b[f] === 'string') await query(`UPDATE yt_channels SET ${f}=$1, updated_at=now() WHERE id=$2`, [f === 'model_filter' && !b[f].trim() ? null : b[f], id]);
      for (const f of ['client_id', 'client_secret'] as const) if (typeof b[f] === 'string' && b[f].trim()) await query(`UPDATE yt_channels SET ${f}=$1 WHERE id=$2`, [b[f].trim(), id]);
      if (b.per_day != null) await query(`UPDATE yt_channels SET per_day=$1 WHERE id=$2`, [Math.max(0, Number(b.per_day) || 0), id]);
      if (b.gap_min != null) await query(`UPDATE yt_channels SET gap_min=$1 WHERE id=$2`, [Math.max(0, Number(b.gap_min) || 0), id]);
      if (b.enabled != null) await query(`UPDATE yt_channels SET enabled=$1 WHERE id=$2`, [!!b.enabled, id]);
      res.json({ ok: true, channel: pubChannel(await ytChannel(id)) });
    } catch (e) { err(res, e); }
  });
  api.delete('/youtube/channels/:id', async (req, res) => {
    try {
      const id = Number(req.params.id); if (id === 1) return res.status(400).json({ error: 'бренд не удаляем' });
      const n = Number((await query<any>(`SELECT count(*) n FROM yt_queue WHERE channel_id=$1 AND status='posted'`, [id])).rows[0].n);
      if (n) return res.status(400).json({ error: `на канале ${n} выложенных, только отключить` });
      await query(`DELETE FROM yt_queue WHERE channel_id=$1`, [id]); await query(`DELETE FROM yt_channels WHERE id=$1`, [id]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  api.get('/youtube/oauth/url', async (req, res) => {
    try {
      const c = await ytChannel(chId(req));
      if (!c.client_id || !c.client_secret) return res.status(400).json({ error: 'у канала нет client_id/secret (Google Cloud → OAuth client)' });
      if (!PUBLIC_URL()) return res.status(400).json({ error: 'нет PUBLIC_URL' });
      res.json({ url: ytAuthUrl(c) });
    } catch (e) { err(res, e); }
  });
  const oauthCb = async (req: Request, res: Response) => {
    try {
      const code = String(req.query.code || ''); const id = Number(req.query.state || 1) || 1;
      if (!code) return res.status(400).send('нет code: ' + JSON.stringify(req.query));
      const c = await ytChannel(id);
      const j = await tokenPost(c, { code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
      if (!j.refresh_token) return res.status(400).send('нет refresh_token: ' + JSON.stringify(j));
      await query(`UPDATE yt_channels SET refresh_token=$1, connected_at=now(), updated_at=now() WHERE id=$2`, [j.refresh_token, id]);
      _access.delete(id);
      const c2 = await ytChannel(id);
      const me = await ytApi(c2, 'channels?part=snippet&mine=true');
      const ch = me.items?.[0];
      if (ch) await query(`UPDATE yt_channels SET channel_id=$1, title=$2 WHERE id=$3`, [ch.id, ch.snippet?.title || null, id]);
      res.redirect('/?tab=youtube&yt=connected&ch=' + id);
    } catch (e) { res.status(500).send(e instanceof Error ? e.message : String(e)); }
  };
  api.get('/youtube/oauth/cb', oauthCb);
  (api as any).ytOauthCb = oauthCb; // объявляем и на app-уровне в api.ts (без куки панели)
  api.post('/youtube/disconnect', async (req, res) => {
    const id = chId(req); await query(`UPDATE yt_channels SET refresh_token=NULL WHERE id=$1`, [id]); _access.delete(id); res.json({ ok: true });
  });

  api.post('/youtube/preview', async (req, res) => {
    try {
      const c = { ...(await ytChannel(chId(req))), ...(req.body?.settings || {}) };
      const item = req.body?.id ? (await query<any>(`SELECT * FROM yt_queue WHERE id=$1`, [req.body.id])).rows[0] : { id: 0, src_title: req.body?.src_title, src_text: req.body?.src_text, file_hash: 'abcdef12' };
      res.json(buildYtMeta(c, item || {}));
    } catch (e) { err(res, e); }
  });

  api.get('/youtube/queue', async (req, res) => {
    try {
      const id = chId(req); const st = String(req.query.status || '');
      const { rows } = await query<any>(
        `SELECT id, channel_id, file_path, media_url, src_title, ai_title, src_text, title, status, video_id, url, error, utm_content,
                to_char(created_at,'DD.MM HH24:MI') created, to_char(posted_at,'DD.MM HH24:MI') posted
           FROM yt_queue WHERE channel_id=$1 ${st ? 'AND status=$2' : ''} ORDER BY (status='posted'), id DESC LIMIT 300`, st ? [id, st] : [id]);
      res.json(rows);
    } catch (e) { err(res, e); }
  });
  api.post('/youtube/queue', async (req, res) => {
    try {
      const id = chId(req); const items = Array.isArray(req.body?.items) ? req.body.items : [];
      let added = 0, dup = 0;
      for (const it of items) {
        if (!it.file_path && !it.media_url) continue;
        const hash = it.file_hash || createHash('sha1').update(String(it.file_path || it.media_url)).digest('hex').slice(0, 16);
        const r = await query(`INSERT INTO yt_queue (channel_id, file_path, media_url, file_hash, src_title, src_text, scheduled_at)
                               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (file_hash) WHERE file_hash IS NOT NULL DO NOTHING`,
          [id, it.file_path || null, it.media_url || null, hash, it.src_title || null, it.src_text || null, it.scheduled_at || null]);
        (r.rowCount || 0) > 0 ? added++ : dup++;
      }
      res.json({ ok: true, added, dup });
    } catch (e) { err(res, e); }
  });
  // ЗАГРУЗКА РОЛИКА ПРЯМО ИЗ ПАНЕЛИ: файл кладём в media_uploads (байты в БД), в очередь пишем
  // media_url='upload:<uuid>'. Раннер на маке материализует его во временный файл и грузит на ютуб.
  // Так публиковать можно с любого устройства, включая телефон, файл на маке не нужен.
  const ytUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
  const ytUpOne = (req: Request, res: Response, next: NextFunction) => {
    ytUp.single('video')(req, res, (e: unknown) => {
      if (e) { res.status(413).json({ error: (e as { code?: string })?.code === 'LIMIT_FILE_SIZE' ? 'ролик больше 300 МБ' : 'ошибка загрузки файла' }); return; }
      next();
    });
  };
  api.post('/youtube/upload', ytUpOne, async (req, res) => {
    try {
      const f = req.file;
      if (!f?.buffer?.length) { res.status(400).json({ error: 'нет файла видео' }); return; }
      const chid = Number(req.body?.ch);
      if (!chid) { res.status(400).json({ error: 'не выбран канал' }); return; }
      const title = String(req.body?.title || '').trim().slice(0, 100);
      const text = String(req.body?.text || '').trim().slice(0, 4000);
      const now = String(req.body?.when || 'now') === 'now';
      const { rows: up } = await query<{ id: string }>(
        `INSERT INTO media_uploads (filename, mime, bytes, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id`,
        [f.originalname || 'clip.mp4', f.mimetype || 'video/mp4', f.buffer, f.size]);
      const uid = up[0].id;
      const hash = createHash('sha1').update(uid).digest('hex').slice(0, 16);
      const { rows } = await query<{ id: number }>(
        `INSERT INTO yt_queue (channel_id, media_url, file_hash, src_title, src_text, ai_title, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [chid, 'upload:' + uid, hash, title || null, text || null, title || null,
         now ? new Date(Date.now() - 3600e3) : null]);
      res.json({ ok: true, id: rows[0].id, mb: +(f.size / 1e6).toFixed(1), now });
    } catch (e) { err(res, e); }
  });
  // Заголовок по правилам канала для ролика, которого ещё нет в очереди (кнопка в секции публикации).
  api.post('/youtube/title', async (req, res) => {
    try {
      const c = await ytChannel(chId(req));
      const hint = String(req.body?.hint || '').trim().slice(0, 600);
      const t = await generateYtTitle((c as { title_prompt?: string }).title_prompt || '', hint || 'вертикальный ролик про разбор внешности по фото');
      res.json({ ok: !!t, title: t || '' });
    } catch (e) { err(res, e); }
  });
  // Опубликовать существующую задачу немедленно: двигаем слот в прошлое, раннер возьмёт в ближайший опрос.
  api.post('/youtube/queue/:id/now', async (req, res) => {
    try {
      const r = await query(`UPDATE yt_queue SET status='queued', error=NULL, locked_at=NULL,
                             scheduled_at=now() - interval '1 hour' WHERE id=$1 AND status<>'posted'`, [Number(req.params.id)]);
      res.json({ ok: (r.rowCount || 0) > 0 });
    } catch (e) { err(res, e); }
  });
  api.post('/youtube/queue/clear', async (req, res) => {
    try {
      const st = String(req.body?.status || 'queued');
      const r = await query(`DELETE FROM yt_queue WHERE channel_id=$1 AND status=$2`, [chId(req), st]);
      res.json({ ok: true, deleted: r.rowCount });
    } catch (e) { err(res, e); }
  });
  api.post('/youtube/gen-titles', async (_req, res) => { try { res.json({ ok: true, generated: await ytGenTitles(30) }); } catch (e) { err(res, e); } });
  api.post('/youtube/queue/:id/:action', async (req, res) => {
    try {
      const id = Number(req.params.id); const a = req.params.action;
      if (a === 'retry') await query(`UPDATE yt_queue SET status='queued', error=NULL, locked_at=NULL WHERE id=$1 AND status IN ('error','skipped')`, [id]);
      else if (a === 'skip') await query(`UPDATE yt_queue SET status='skipped' WHERE id=$1 AND status IN ('queued','error')`, [id]);
      else if (a === 'delete') await query(`DELETE FROM yt_queue WHERE id=$1 AND status<>'posted'`, [id]);
      else if (a === 'top') await query(`UPDATE yt_queue SET scheduled_at=now() - interval '1 year' WHERE id=$1`, [id]);
      else if (a === 'move') await query(`UPDATE yt_queue SET channel_id=$2 WHERE id=$1 AND status<>'posted'`, [id, Number(req.body?.ch) || 1]);
      else if (a === 'gentitle') {
        const r = (await query<any>(`SELECT q.*, c.title_prompt FROM yt_queue q JOIN yt_channels c ON c.id=q.channel_id WHERE q.id=$1`, [id])).rows[0];
        const t = r ? await generateYtTitle(r.title_prompt, (r.src_text ? 'Подпись ролика: ' + r.src_text + '\n' : '') + 'Файл: ' + (r.file_path || r.media_url || '').split('/').pop()) : '';
        if (t) await query(`UPDATE yt_queue SET ai_title=$2 WHERE id=$1`, [id, t]); return res.json({ ok: !!t, title: t });
      }
      else if (a === 'settitle') await query(`UPDATE yt_queue SET ai_title=$2 WHERE id=$1`, [id, String(req.body?.title || '').trim() || null]);
      else if (a === 'text') await query(`UPDATE yt_queue SET src_title=coalesce($2,src_title), src_text=coalesce($3,src_text) WHERE id=$1`, [id, req.body?.src_title ?? null, req.body?.src_text ?? null]);
      else return res.status(400).json({ error: 'unknown action' });
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // Статистика: просмотры выложенных (1 ед. квоты на 50 id, квота канала).
  const refreshStats = async (c: YtChannel) => {
    const { rows } = await query<any>(`SELECT id, video_id FROM yt_queue WHERE channel_id=$1 AND status='posted' AND video_id IS NOT NULL ORDER BY posted_at DESC LIMIT 200`, [c.id]);
    const out: Record<string, any> = {};
    for (let i = 0; i < rows.length; i += 50) {
      const j = await ytApi(c, 'videos?part=statistics&id=' + rows.slice(i, i + 50).map((r: any) => r.video_id).join(','));
      for (const v of j.items || []) out[v.id] = v.statistics;
    }
    for (const [vid, st] of Object.entries(out)) await query(
      `INSERT INTO yt_stats (video_id, channel_id, views, likes, comments, updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (video_id) DO UPDATE SET views=$3, likes=$4, comments=$5, updated_at=now()`,
      [vid, c.id, Number(st.viewCount || 0), Number(st.likeCount || 0), Number(st.commentCount || 0)]);
    // Заодно снимаем канал целиком: подписчики, ава, просмотры (1 ед. квоты).
    try {
      const cj = await ytApi(c, 'channels?part=snippet,statistics&mine=true');
      const ch = cj.items?.[0];
      if (ch) await query(
        `UPDATE yt_channels SET subs=$2, avatar_url=$3, channel_views=$4, channel_stats_upd=now(), title=coalesce($5,title) WHERE id=$1`,
        [c.id, Number(ch.statistics?.subscriberCount || 0), ch.snippet?.thumbnails?.default?.url || null,
         Number(ch.statistics?.viewCount || 0), ch.snippet?.title || null]);
    } catch { /* не роняем рефреш из-за авы */ }
    return Object.keys(out).length;
  };
  api.post('/youtube/stats/refresh', async (req, res) => {
    try { res.json({ ok: true, updated: await refreshStats(await ytChannel(chId(req))) }); } catch (e) { err(res, e); }
  });
  // Тот же проход, что и по кнопке, но доступный планировщику (см. src/index.ts).
  ytRefreshAllStatsImpl = async () => {
    for (const c of await ytChannels()) {
      if (c.platform !== 'youtube' || !c.refresh_token) continue;
      try { await refreshStats(c); } catch { /* один канал не валит остальные */ }
    }
  };
  // Обновить ВСЕ ютуб-каналы разом (кнопка сводки). Ошибка одного канала не валит остальные.
  api.post('/youtube/stats/refresh-all', async (_req, res) => {
    try {
      const out: Record<string, number | string> = {};
      for (const c of await ytChannels()) {
        if (c.platform !== 'youtube' || !c.refresh_token) continue;
        try { out[c.slug] = await refreshStats(c); } catch (e) { out[c.slug] = 'ошибка: ' + (e instanceof Error ? e.message : String(e)); }
      }
      res.json({ ok: true, channels: out });
    } catch (e) { err(res, e); }
  });
  // Сводка для лайв-статы: посты/просмотры за сегодня и всего, время последнего замера.
  api.get('/youtube/stats/summary', async (_req, res) => {
    try {
      const { rows } = await query<any>(`
        SELECT ch.id, ch.slug, ch.name, ch.enabled, ch.title, ch.subs, ch.avatar_url, ch.channel_views,
               to_char(ch.channel_stats_upd AT TIME ZONE 'Europe/Moscow', 'DD.MM HH24:MI') AS ch_upd,
               to_char(max(q.posted_at) FILTER (WHERE q.status='posted') AT TIME ZONE 'Europe/Moscow', 'DD.MM HH24:MI') AS last_post,
               count(*) FILTER (WHERE q.status='posted') AS posted_total,
               count(*) FILTER (WHERE q.status='posted' AND (q.posted_at AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date) AS posted_today,
               count(*) FILTER (WHERE q.status='queued') AS queued,
               coalesce(sum(s.views) FILTER (WHERE q.status='posted'), 0) AS views_total,
               coalesce(sum(s.views) FILTER (WHERE q.status='posted' AND q.posted_at::date=current_date), 0) AS views_today,
               to_char(max(s.updated_at) AT TIME ZONE 'Europe/Moscow', 'DD.MM HH24:MI') AS last_upd
          FROM yt_channels ch
          LEFT JOIN yt_queue q ON q.channel_id = ch.id
          LEFT JOIN yt_stats s ON s.video_id = q.video_id
         WHERE ch.platform = 'youtube'
         GROUP BY ch.id ORDER BY ch.id`);
      res.json({ rows });
    } catch (e) { err(res, e); }
  });
  api.get('/youtube/stats', async (req, res) => {
    try {
      const { rows } = await query<any>(
        `SELECT q.id, q.video_id, q.title, q.url, q.utm_content, to_char(q.posted_at,'DD.MM HH24:MI') posted, s.views, s.likes, s.comments, to_char(s.updated_at AT TIME ZONE 'Europe/Moscow','DD.MM HH24:MI') upd
           FROM yt_queue q LEFT JOIN yt_stats s ON s.video_id=q.video_id WHERE q.channel_id=$1 AND q.status='posted' ORDER BY q.posted_at DESC LIMIT 200`, [chId(req)]);
      const tot = rows.reduce((o: any, r: any) => (o.views += Number(r.views || 0), o.likes += Number(r.likes || 0), o), { views: 0, likes: 0 });
      const lastUpd = rows.map((r: any) => r.upd).filter(Boolean).sort().pop() || null;
      res.json({ rows, total: tot, last_upd: lastUpd });
    } catch (e) { err(res, e); }
  });
}
