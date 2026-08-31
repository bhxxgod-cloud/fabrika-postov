// СВЕРКА ИСХОДА ПУБЛИКАЦИИ СНАРУЖИ, БЕЗ БРАУЗЕРА (06.08).
//
// ЗАЧЕМ. В ленте @darya.smirnova13 повисли ДВА одинаковых поста: заливка 05.08 22:46 (DbrPpFowqZk)
// прошла, но её исход не доехал до posts.external_url, и следующая попытка залила тот же материал
// второй раз (Dbrbnu5BbLN). Дубль для Instagram хуже пропуска: одинаковый контент выпадает из
// рекомендаций, а в ленте модели два одинаковых кадра видно глазами.
//
// ПОЧЕМУ ЭТО СЛУЧИЛОСЬ. «Второе мнение снаружи» в igpost2 было написано, но НЕ РАБОТАЛО НИ РАЗУ:
// список роликов «до» — это Set (iglib.getShortcodes), а проверка звала before.includes(...).
// У Set нет includes → TypeError → пустой catch → outsideSc всегда null → любой пост, чей профиль
// не успел отрисоваться в сессии за 3 минуты, получал ambiguous без ссылки. Отсюда 9 зависших
// постов на 06.08 и дубль в ленте. Урок: молчаливый catch превращает опечатку в тихую потерю
// результата, поэтому здесь исход ВСЕГДА возвращается объектом с причиной, а не null.
//
// ПРИНЦИП. Правда о публикации — снаружи, у зрителя, а не в нашей сессии. Читаем ленту тремя
// путями и НИКОГДА не путаем «поста нет» с «не смогли прочитать»:
//   {ok:true, items:[…]} — ленту прочитали, список медиа достоверный;
//   {ok:false, why}      — не прочитали (IG отдал заглушку, кука не принята, прокси упал);
//   {ok:false, gone:true}— профиля не существует.
// Второй и третий исходы НЕ дают права закрывать пост: «не видно» ≠ «не опубликован».
//
// БЕЗОПАСНОСТЬ. Куку аккаунта отправляем ТОЛЬКО через его собственный прокси: запрос с чужого
// IP по живой сессии — это ровно тот сигнал, за который Instagram выписывает чекпоинт. Без
// прокси ходим лишь анонимно, без единой куки. Браузер не открывается, вход не выполняется.
//
// Использование:
//   const PV = require('./postverify.cjs');
//   const feed = await PV.readFeed(acc);                  // acc: {h, ig_cookies, ig_proxy}
//   const hit  = PV.findByCaption(feed.items, caption);   // [] | [media, …]
'use strict';
const { execFileSync } = require('node:child_process');

const APP_ID = '936619743392459';                 // публичный web app-id, без него отдают логин-стену
const UA_DESK = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(url, { cookies = null, proxy = null, ua = UA_DESK, referer = null, timeout = 30 } = {}) {
  const args = ['-s', '--max-time', String(timeout), '-H', `x-ig-app-id: ${APP_ID}`, '-A', ua];
  if (cookies) args.push('-H', `Cookie: ${cookies}`);
  if (referer) args.push('-H', `Referer: ${referer}`);
  if (proxy) args.push('-x', String(proxy).includes('://') ? String(proxy) : `http://${proxy}`);
  args.push(url);
  try { return { out: execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }) }; }
  catch (e) { return { err: String(e.message).slice(0, 120) }; }
}

function cookiesOf(acc) {
  let cks = [];
  try { cks = typeof acc.ig_cookies === 'string' ? JSON.parse(acc.ig_cookies) : acc.ig_cookies; } catch {}
  return Array.isArray(cks) ? cks.filter((k) => k && k.name && k.value) : [];
}
function uidOf(acc) {
  const c = cookiesOf(acc).find((k) => k.name === 'ds_user_id');
  return c ? String(c.value) : null;
}

// Приведение медиа из ЛЮБОГО формата IG к одному виду. Форматов три, и они меняются на ходу:
// items[] (лента по куке), profile_grid_items[] (новая раскладка той же ленты, встречена 06.08),
// edge_owner_to_timeline_media.edges[] (анонимный web_profile_info).
function normMedia(m) {
  if (!m) return null;
  const node = m.media || m.node || m;
  const code = node.code || node.shortcode;
  if (!code) return null;
  const capNode = node.caption || (((node.edge_media_to_caption || {}).edges || [])[0] || {}).node;
  const ts = node.taken_at || node.taken_at_timestamp || null;
  return {
    code,
    caption: String((capNode && capNode.text) || ''),
    taken_at: ts ? new Date(ts * 1000) : null,
    is_video: !!(node.is_video || node.video_versions || node.media_type === 2),
  };
}
function mediaList(j) {
  if (!j || typeof j !== 'object') return [];
  const raw = (j.items && j.items.length ? j.items : null)
    || (j.profile_grid_items && j.profile_grid_items.length ? j.profile_grid_items : null)
    || (((j.data || {}).user || {}).edge_owner_to_timeline_media || {}).edges
    || [];
  return raw.map(normMedia).filter(Boolean);
}

// ── ЧТЕНИЕ ЛЕНТЫ ────────────────────────────────────────────────────────────────────────────
// Порядок источников — от самого правдивого к самому доступному. Первый достоверный ответ и есть
// ответ; остальные не трогаем, чтобы не частить запросами по одному аккаунту.
async function readFeed(acc, { count = 24, tries = 2 } = {}) {
  const handle = acc.h || acc.ig_login || acc.slug;
  const uid = uidOf(acc);
  const jar = cookiesOf(acc).map((k) => `${k.name}=${k.value}`).join('; ');
  const notes = [];

  for (let t = 0; t < tries; t++) {
    // 1. Своя лента по своей куке через свой прокси. Отдаёт всё и всегда, пока сессия жива.
    if (uid && jar && acc.ig_proxy) {
      const { out, err } = curl(`https://www.instagram.com/api/v1/feed/user/${uid}/?count=${count}`,
        { cookies: jar, proxy: acc.ig_proxy, referer: `https://www.instagram.com/${handle}/` });
      if (err) notes.push(`кука+прокси: ${err}`);
      else {
        let j = null; try { j = JSON.parse(out); } catch {}
        const list = mediaList(j);
        if (list.length) return { ok: true, items: list, source: 'кука акка', handle, complete: list.length < count };
        if (j && j.require_login) notes.push('кука+прокси: сессия не принята (require_login)');
        else if (j && j.special_empty_state) notes.push('кука+прокси: IG отдал пустую заглушку (кука не принята)');
        else notes.push(`кука+прокси: пусто (${String(out).slice(0, 60)})`);
      }
    } else if (uid && jar && !acc.ig_proxy) {
      // Осознанный отказ: кука без своего прокси = запрос с чужого IP по живой сессии.
      notes.push('кука есть, но прокси у акка нет — по куке не ходим (чужой IP = чекпоинт)');
    }

    // 2. Аноним с нашего IP. Ноль риска для акка: ни одной куки, обычный публичный запрос.
    for (const [label, opts] of [
      ['аноним', { ua: UA_MOB }],
      ['аноним через прокси акка', acc.ig_proxy ? { ua: UA_MOB, proxy: acc.ig_proxy } : null],
    ]) {
      if (!opts) continue;
      const { out, err } = curl(
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, opts);
      if (err) { notes.push(`${label}: ${err}`); continue; }
      if (/Page Not Found/i.test(out) && !/"user"/.test(out)) return { ok: false, gone: true, handle, why: 'профиля не существует (переименован или снесён)' };
      let j = null; try { j = JSON.parse(out); } catch { notes.push(`${label}: не JSON`); continue; }
      const u = (j.data || {}).user;
      if (!u) { notes.push(`${label}: ${String(out).slice(0, 50)}`); continue; }
      const list = mediaList(j);
      const total = (u.edge_owner_to_timeline_media || {}).count;
      // Пустая лента у существующего профиля — достоверный факт, а не сбой: так закрываются посты,
      // которые «нажали Share», но не долетели, на аккаунте без единой публикации.
      if (list.length || total === 0) {
        return { ok: true, items: list, source: label, handle, private: !!u.is_private,
          total: typeof total === 'number' ? total : null, complete: typeof total === 'number' ? list.length >= total : false };
      }
      notes.push(`${label}: профиль читается, но лента пустая при count=${total}`);
    }
    if (t + 1 < tries) await sleep(6000);
  }
  return { ok: false, handle, why: notes.join(' | ') || 'ленту прочитать не удалось' };
}

// ── СОПОСТАВЛЕНИЕ ПО ПОДПИСИ ────────────────────────────────────────────────────────────────
// Единственный признак «это наш пост», который переживает потерю shortcode. Эмодзи и переносы
// Instagram отдаёт по-разному в разных выдачах, поэтому сравниваем только буквы и цифры.
function normCaption(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function findByCaption(items, caption, { minLen = 25, head = 45 } = {}) {
  const mine = normCaption(caption);
  if (mine.length < minLen) return [];           // короткую подпись можно спутать с чужой — не рискуем
  const key = mine.slice(0, head);
  return (items || []).filter((m) => {
    const his = normCaption(m.caption);
    return his.startsWith(key) || his.includes(key);
  });
}

const postUrl = (code) => `https://www.instagram.com/reel/${code}/`;
const codeOf = (url) => (String(url || '').match(/\/(?:p|reel)\/([^/?]+)/) || [])[1] || null;

// Ждём появления нашего поста снаружи: сразу после Share лента отдаёт его не мгновенно.
// Возвращает {found, media, feed} — found=false с ok-лентой означает честное «в ленте его нет».
async function waitForPost(acc, { caption, before = [], timeoutMs = 120000, everyMs = 20000 } = {}) {
  const beforeSet = new Set([...(before instanceof Set ? before : before || [])]);
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const feed = await readFeed(acc, { tries: 1 });
    last = feed;
    if (feed.ok) {
      const hit = findByCaption(feed.items, caption).filter((m) => !beforeSet.has(m.code));
      if (hit.length) return { found: true, media: hit[0], all: hit, feed };
      // Подпись могла не совпасть (IG режет длинные), но новый ролик после Share всё равно наш:
      // на аккаунте модели постим только мы, посторонних публикаций там не появляется.
      const fresh = feed.items.filter((m) => !beforeSet.has(m.code));
      if (fresh.length === 1 && beforeSet.size) return { found: true, media: fresh[0], all: fresh, feed, byNew: true };
    }
    if (Date.now() - t0 >= timeoutMs) return { found: false, feed: last };
    await sleep(everyMs);
  }
}

// ── ТОЧЕЧНАЯ ПРОВЕРКА ОДНОЙ ПУБЛИКАЦИИ ──────────────────────────────────────────────────────
// Отвечает на вопрос «наш пост ещё жив и чей он», когда shortcode известен. Ходит от лица
// аккаунта-наблюдателя (любой живой акк фермы, через его прокси) — чтение чужого профиля
// обычным залогиненным зрителем, не действие на самом акке. Пример пользы 06.08: пост
// DbrPpFowqZk отвечал «Media not found» при живом контрольном посте с другого акка — так
// подтвердилось, что @darya.smirnova13 скрыт чекпоинтом, а не «сверка сломалась».
const SC_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function shortcodeToMediaId(sc) {
  let n = 0n;
  for (const ch of String(sc)) { const i = SC_ALPHABET.indexOf(ch); if (i < 0) return null; n = n * 64n + BigInt(i); }
  return n.toString();
}
function mediaInfo(shortcode, observer) {
  const id = shortcodeToMediaId(shortcode);
  if (!id) return { ok: false, why: 'некорректный shortcode' };
  const jar = cookiesOf(observer).map((k) => `${k.name}=${k.value}`).join('; ');
  if (!jar || !observer.ig_proxy) return { ok: false, why: 'наблюдателю нужны и куки, и свой прокси' };
  const { out, err } = curl(`https://www.instagram.com/api/v1/media/${id}/info/`, { cookies: jar, proxy: observer.ig_proxy });
  if (err) return { ok: false, why: err };
  let j = null; try { j = JSON.parse(out); } catch { return { ok: false, why: 'не JSON' }; }
  const it = (j.items || [])[0];
  if (!it) return { ok: false, why: String(j.message || 'медиа недоступно') };
  return { ok: true, media: normMedia(it), owner: (it.user || {}).username || null,
    views: Number(it.play_count ?? it.view_count ?? 0), likes: Number(it.like_count ?? 0) };
}

module.exports = { readFeed, findByCaption, normCaption, waitForPost, postUrl, codeOf, uidOf, cookiesOf, mediaList, normMedia, mediaInfo, shortcodeToMediaId };
