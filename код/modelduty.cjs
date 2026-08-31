// СТОРОЖ МОДЕЛЬНЫХ АККОВ — сейвим акки, чтобы не отпадали. Философия: акки умирают от НАШИХ ЖЕ
// действий, в первую очередь от входов по паролю (03.08: dasha.smirnova83 и karina.mood82 сгорели
// на заходе, три акка поймали софт-блок на попытке логина). Значит сторож обязан быть трёхступенчатым,
// от бесплатного к дорогому, и на каждой ступени останавливаться, как только ответ получен:
//
//   1. АНОНИМНО (curl embed/профиль через прокси, БЕЗ акка) — жив ли акк публично.
//      Забанен → session_status менять бессмысленно, помечаем и не трогаем больше НИКОГДА.
//      Отдельный исход — СПРЯТАН (10.08): ник занят, профиль анониму не отдаётся. Это не «жив»
//      и не «нет профиля»: пишем health_state='hidden', паузу и снос НЕ трогаем, а сам акк идёт
//      на ступень 2 — она и есть безопасный чек входом (куки, без пароля).
//   2. КУКИ-РЕАНИМАЦИЯ (открыть Orbita с сохранёнными куками, БЕЗ ввода пароля) — если IG
//      признал сессию, пометить live и ЗАКРЫТЬ. Ноль вводов пароля = ноль поводов для бана.
//   3. ЛОГИН — сюда сторож НЕ ХОДИТ. Если куки мертвы, он лишь пишет need_login, а решение
//      о входе принимает владелец (или relogin --slug вручную, по одному, после кулдауна).
//
// Плотность: ОДИН акк за прогон ступени 2 (браузерной), пауза между прогонами. Ступень 1 дешёвая,
// гоняем всех. Запуск разово: node modelduty.cjs. Циклом: MODELDUTY_LOOP=1 (пауза 40-70 мин).
'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');
const igp = require('./igprofile.cjs');            // общий разбор ответа IG + подтверждение вердикта

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LOOP = process.env.MODELDUTY_LOOP === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Подтверждение вердикта «спрятан»: попыток и сколько РАЗНЫХ каналов должны сойтись. Два — минимум,
// иначе лимит нашего айпи превращается в метку на живом акке.
const HID_TRIES = Math.max(2, Number(process.env.MODELDUTY_HIDDEN_TRIES) || 4);
const HID_CONFIRM = Math.max(2, Number(process.env.MODELDUTY_HIDDEN_CONFIRM) || 2);
// Запасные каналы для переспроса (те же, что у остальных анонимных чеков). MODELDUTY_DIRECT=1 —
// прежнее поведение: только прокси акка и наш собственный айпи.
const PXPOOL = String(process.env.MODELDUTY_DIRECT || '') === '1' ? [] : igp.proxies();

function curl(url, proxy, ua) {
  return new Promise((res) => {
    const args = ['-s', '-m', '30', '-o', '/dev/null', '-w', '%{http_code}', '-A', ua || 'Mozilla/5.0 Chrome/124'];
    if (proxy) args.push('-x', proxy.includes('://') ? proxy : 'http://' + proxy);
    args.push(url);
    execFile('curl', args, { timeout: 35000 }, (err, stdout) => res(err ? '0' : String(stdout || '0').trim()));
  });
}
// Чтение профиля с телом ответа переехало в igprofile.ask (10.08): там же и app-id, и разбор.

// Ступень 1: жив ли акк публично.
// РАНЬШЕ смотрели код ответа на /<ник>/ и считали 404 баном. Это ОСЛЕПЛО: Instagram теперь отдаёт
// анонимам одинаковую логин-стену с кодом 200 и на живого, и на удалённого, и на несуществующего
// (проверено калибровкой 03.08). Такой чек раздавал ложные вердикты.
// Работает web_profile_info: на живого приходит JSON с данными, на удалённого «Page Not Found».
// Он душит датацентровые IP после пары запросов, поэтому дёргаем редко и с паузами.
// ДВА ОГРАЖДЕНИЯ ПРОТИВ ЛОЖНОГО «АКК СНЕСЁН» (07.08, разбор инцидента с ложными вердиктами).
// 1) ГЛИТЧ-ОХРАНА. Тот же эндпоинт читают accaudit.cjs, accheck.cjs и accjanitor.cjs, и у всех
//    трёх стоит проверка «в теле есть asset / has been deleted / wait a few / rate / try again =
//    это сбой Instagram, а не приговор акку». Здесь её не было — единственный читатель без охраны.
//    Именно так бизнес-профиль с ответом «Asset has been deleted» был прочитан как «акка нет».
// 2) ПОДТВЕРЖДЕНИЕ ВТОРЫМ КАНАЛОМ. Вывод «профиля нет» теперь требует, чтобы ОБА захода (через
//    прокси и напрямую) реально ответили и оба сказали «нет». Придушенный лимитом эндпоинт умеет
//    отвечать пустым user, а цена ошибки здесь максимальная: ниже пишется suspended + paused, а с
//    паузы акк забирает автозамена вместе с профилем GoLogin. Так 06.08 потеряли neuro.vibe.club54.
// РАЗБОР ОТВЕТА — ОБЩИЙ (igprofile.cjs). Своей копии здесь больше нет: она была четвёртой в
// проекте, и копии уже разъезжались (дыру «ответ без user = акка нет» в accheck закрыли, а тут
// нет). Там же живут все уроки: почему приговор только по явному data.user===null, почему признаки
// сбоя ищутся ПОСЛЕ данных и почему ответ ровно {"status":"ok"} без data — это «спрятан».
async function publicAlive(h, proxy) {
  const absent = [];   // каналы, которые ОТВЕТИЛИ и сказали «профиля нет»
  let glitch = '';     // сбой сервиса: вердикта не даём вообще
  for (const p of [proxy, null]) {
    const via = p ? 'proxy' : 'direct';
    const r = igp.ask(h, p);
    if (r.kind === 'виден') return { alive: true, via };            // живой ответ важнее всего
    if (r.kind === 'нет-профиля' || r.kind === 'нет-ника') { absent.push(via); continue; }
    // СПРЯТАННЫЙ АКК (10.08). Ник существует, но профиль скрыт от анонима. Раньше это молча падало
    // в 'unknown', то есть дежурный видел «непонятно» там, где есть факт про акк.
    // ОДНОГО КАНАЛА МАЛО: с придушенного айпи «спрятан» неотличим от лимита, поэтому спрашиваем
    // ещё нескольких РАЗНЫХ прокси, и только их согласие делает это вердиктом. Приговор всё равно
    // НЕ выносим (чекпоинт от бана анонимно не отличить) — это повод для чека входом, не для паузы.
    if (r.kind === 'спрятан') {
      const v = await igp.probe(h, { tries: HID_TRIES, minConfirm: HID_CONFIRM });
      if (v.kind === 'виден') return { alive: true, via: 'подтверждающий канал' };
      if (v.kind === 'спрятан') return { alive: null, hidden: true, why: v.why, via: `профиль спрятан от анонима (${v.why})` };
      if (v.kind === 'нет-профиля' || v.kind === 'нет-ника') { absent.push(via, 'подтверждающий канал'); continue; }
      return { alive: null, via: `похоже на «спрятан», но подтверждения нет: ${v.why}` };
    }
    if (r.why) glitch = `${via}: ${r.why}`;                          // сбой IG, акк не трогаем
  }
  // ПЕРЕСПРОС ЧЕРЕЗ ПУЛ ПРОКСИ, ЕСЛИ СВОИ ДВА КАНАЛА НИЧЕГО НЕ ДАЛИ (10.08). Наш айпи Instagram
  // душит («Please wait a few minutes», HTTP 401), и тогда оба канала молчат, а сторож пишет
  // «вердикта нет» по всей ферме — ровно так спрятанные акки и оставались невидимыми.
  // Из переспроса принимаем только «виден» и «спрятан». «Профиля нет» отсюда НЕ выносим: этот
  // вывод ведёт к suspended+paused и дальше под автозамену, и слабых доказательств он не терпит.
  if (absent.length < 2 && PXPOOL.length) {
    const v = await igp.probe(h, { proxies: PXPOOL, tries: HID_TRIES, minConfirm: HID_CONFIRM, allowDirect: false });
    if (v.kind === 'виден') return { alive: true, via: 'пул прокси' };
    if (v.kind === 'спрятан') return { alive: null, hidden: true, why: v.why, via: `профиль спрятан от анонима (${v.why})` };
    glitch = glitch || `пул прокси: ${v.why}`;
  }
  // «Нет профиля» — только когда так сказали ДВА независимых канала. Один канал = слишком слабо
  // для приговора, который ведёт к сносу аккаунта.
  if (absent.length >= 2) return { alive: false, via: absent.join('+') };
  if (absent.length === 1) return { alive: null, via: `${absent[0]}: «нет профиля», второй канал не подтвердил` };
  if (glitch) return { alive: null, via: `сбой IG (${glitch})` };
  return { alive: null, via: 'unknown' };
}

// Ступень 2: куки-реанимация. Открываем локальную Orbita, кладём куки, смотрим classifyScreen.
// НИКАКИХ вводов: если не logged_in — закрываем и пишем need_login.
async function cookieRevive(row) {
  const { default: GoLogin } = await import('gologin');
  const gl = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(6000); await L.clearOverlays(page);
    const cls = await L.classifyScreen(ctx, page);
    return cls;
  } finally {
    // Закрыть ПРАВИЛЬНО (никогда pkill): stopLocal синхронизирует профиль, иначе акк вылогинится.
    try { await gl.stopLocal({ posting: false }); } catch {}
  }
}

// АДРЕСНЫЙ ПРОГОН (07.08). Сторож умел только «все модельные акки разом», и это делало его
// неприменимым, когда по одному конкретному акку есть запрет начальника «не трогать вообще»:
// ступень 1 всё равно дёргала его профиль и при ложном 404 могла поставить suspended+paused, а
// это (пока замки §3 не в проде) прямая дорога под автоснос — так 06.08 потеряли neuro.vibe.club54.
// Теперь слаги можно перечислить аргументами (как в statecheck.cjs), а MODELDUTY_SKIP — список
// через запятую, который не трогается НИКОГДА. Без аргументов поведение прежнее.
const ONLY = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const SKIP = String(process.env.MODELDUTY_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean);

async function pass() {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const accs = (await c.query(
    `SELECT a.id, a.slug, coalesce(a.ig_login,a.slug) h, a.persona, a.session_status ss, a.ig_proxy,
            a.ig_cookies, a.gologin_profile_id pid, coalesce(a.ig_status,'-') ig, g.gologin_token tok
       FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL
        AND a.slug NOT LIKE 'FOL%'
        AND coalesce(a.ig_status,'') NOT IN ('suspended','banned','captcha')
        AND ($1::text[] IS NULL OR a.slug = ANY($1))
        AND NOT (a.slug = ANY($2))
      ORDER BY (a.session_status='live') ASC, a.persona`,
    [ONLY.length ? ONLY : null, SKIP])).rows;
  console.log(`\n[modelduty] акков под сторожем: ${accs.length}`
    + (ONLY.length ? ` (адресно: ${ONLY.join(', ')})` : '')
    + (SKIP.length ? ` | НЕ ТРОГАЮ: ${SKIP.join(', ')}` : ''));

  // ── Ступень 1: публичный чек всех (дёшево, без акков) ──
  const suspects = [];
  const hidden = [];
  for (const a of accs) {
    const r = await publicAlive(a.h, a.ig_proxy);
    if (r.hidden) {
      // СПРЯТАН — ОТДЕЛЬНЫЙ ИСХОД, НЕ «ЖИВ» И НЕ «НЕТ ПРОФИЛЯ» (10.08). Пишем факт и НИЧЕГО
      // больше: ни paused, ни dead, ни suspended. Анонимно чекпоинт от насмерть отключённого акка
      // не отличить, а пауза на терминальном акке — это прямая дорога под автозамену со сносом
      // профиля GoLogin (§3, так уже теряли акки). Здесь только метка и наряд «проверить входом».
      // Состояния из PROTECTED (в т.ч. замок автосноса 'keep') не перетираем.
      await c.query(
        `UPDATE accounts SET health_state = CASE WHEN coalesce(health_state,'') = ANY($3) THEN health_state ELSE 'hidden' END,
           health_note=$2, health_checked_at=now() WHERE id=$1`,
        [a.id, `modelduty: профиль спрятан от анонима (${r.why || 'подтверждено разными каналами'}) — нужен чек входом, автоснос по этому НЕ запускать`, igp.PROTECTED],
      ).catch(() => {});
      hidden.push(a.h);
      console.log(`  🙈 @${a.h} (${a.persona}): СПРЯТАН снаружи [${r.via}] — не бан и не сбой, помечен health_state='hidden'`
        + (a.ss !== 'live' ? ' — беру на куки-реанимацию (вход без пароля)' : ' — сессия live, проверять входом руками'));
      // Куки-реанимация здесь и есть тот самый «чек входом»: она открывает профиль с готовыми
      // куками и БЕЗ ввода пароля, а classifyScreen показывает, чекпоинт это или бан.
      if (a.ss !== 'live' && a.pid && a.ig_cookies) suspects.push(a);
      await sleep(2500);
      continue;
    }
    if (r.alive === false) {
      await c.query(`UPDATE accounts SET ig_status='suspended', status='paused', session_status='dead',
                       health_note='modelduty: профиль 404 публично' WHERE id=$1`, [a.id]);
      await c.query(`UPDATE posts SET status='cancelled', error='акк 404 (modelduty)' WHERE account_id=$1
                       AND status IN ('approved','publishing') AND post_submitted=false`, [a.id]);
      console.log(`  ⛔ @${a.h} (${a.persona}): 404 публично — помечен suspended, посты сняты`);
    } else if (r.alive) {
      console.log(`  🟢 @${a.h} (${a.persona}): публично жив${a.ss === 'live' ? '' : ' (сессия ' + a.ss + ' — кандидат на куки-реанимацию)'}`);
      if (a.ss !== 'live') suspects.push(a);
    } else {
      // Чек не ответил (IG душит датацентровые IP лимитом). Это НЕ повод считать акк мёртвым:
      // куки-реанимация всё равно безопасна, пароль там не вводится. 03.08 из-за пропуска таких
      // четыре акка с живыми куками так и висели мёртвыми. Исключение — те, у кого уже есть
      // РЕАЛЬНЫЙ негативный сигнал из браузера (suspended), их дёргать бессмысленно.
      const banned = /suspended|куки мертвы/i.test(String(a.health_note || ''));
      console.log(`  ？ @${a.h} (${a.persona}): публичный чек не дал вердикта [${r.via}]` +
        (banned ? ' — ранее видели suspended, пропускаю' : (a.ss !== 'live' ? ' — беру на куки-реанимацию' : '')));
      if (!banned && a.ss !== 'live') suspects.push(a);
    }
    await sleep(2500);
  }

  // ── Ступень 2: куки-реанимация ──
  // РАНЬШЕ брали ОДНОГО кандидата за прогон (`suspects.find`) — и всегда одного и того же, первого
  // по сортировке. Сторож циклился на нём, а остальные акки не проверялись НИ РАЗУ (03.08: четыре
  // акка с живыми куками месяцами числились мёртвыми). Теперь обходим всех, но по одному и с
  // паузой: плотность действий — то, что жжёт акки, поэтому спешить тут нельзя.
  const cands = suspects.filter((a) => a.pid && a.ig_cookies).slice(0, Number(process.env.REVIVE_MAX || 6));
  if (!cands.length) console.log('\n  (кандидатов на куки-реанимацию нет)');
  for (const [i, cand] of cands.entries()) {
    console.log(`\n  🔧 куки-реанимация @${cand.h} (${i + 1}/${cands.length}, без ввода пароля)…`);
    try {
      const cls = await cookieRevive(cand);
      if (cls.state === 'logged_in') {
        await c.query(`UPDATE accounts SET session_status='live', ig_status='login_ok',
                         health_note='modelduty: куки живы, вход не понадобился' WHERE id=$1`, [cand.id]);
        console.log(`  ✅ @${cand.h}: куки живы → live (пароль не вводился)`);
        // Поднятый акк — ещё НЕ рабочий: на нём чужая ава, чужой ник и чужие посты от прошлого
        // владельца. Раньше сторож просто ставил live и на этом всё, акк так и висел неоформленным
        // (03.08, @bryan436344). Ставим задачу на подготовку сразу, чтобы он начинал греться.
        const undressed = await c.query(`SELECT 1 FROM accounts WHERE id=$1 AND dressed_at IS NULL`, [cand.id]);
        if (undressed.rowCount) {
          await c.query(`INSERT INTO local_jobs (slug, mode, n, status)
             SELECT $1,'prepacc',1,'queued'
              WHERE NOT EXISTS (SELECT 1 FROM local_jobs WHERE slug=$1 AND mode='prepacc' AND status IN ('queued','running'))`,
            [cand.slug]);
          console.log(`  📋 @${cand.h} не оформлен — поставил в очередь на подготовку`);
        }
      } else if (/^(suspended|banned|disabled|captcha|challenge)/i.test(String(cls.state))) {
        // ТЕРМИНАЛЬНО ТОЛЬКО ПО СОСТОЯНИЮ, НЕ ПО evidence (07.08). Раньше регекс шёл по склейке
        // state + evidence, а evidence содержит АДРЕС страницы (см. iglib.classifyScreen): любой
        // редирект или заглушка, где в URL попалось suspend/challenge, метили живой акк как
        // заблокированный, а это snowballs в автоснос профиля GoLogin. Судим только сам вердикт
        // классификатора, который выносится по положительным признакам на экране.
        // ТЕРМИНАЛЬНО. Раньше тут ставилась только заметка, и сторож лез в тот же забаненный акк
        // каждый прогон (03.08: @oliver638149 открывали несколько дней подряд). Бан не лечится
        // ни куками, ни входом — помечаем и больше НИКОГДА не трогаем, посты снимаем.
        await c.query(`UPDATE accounts SET ig_status='suspended', status='paused', session_status='dead',
                         health_state='restricted', health_note=$2 WHERE id=$1`,
          [cand.id, `modelduty: ${cls.state} — акк заблокирован, из работы выведен`]);
        await c.query(`UPDATE posts SET status='cancelled', error='акк заблокирован (modelduty)'
                        WHERE account_id=$1 AND status IN ('approved','publishing') AND post_submitted=false`, [cand.id]);
        console.log(`  ⛔ @${cand.h}: ЗАБЛОКИРОВАН (${cls.state}) — выведен из работы, больше не открываем`);
      } else if (String(cls.state) === 'unknown' || String(cls.state) === 'rate_limited' || !String(cls.state)) {
        // ЭКРАН НЕ ОПОЗНАН — ВЕРДИКТА НЕТ (07.08). classifyScreen отдаёт 'unknown' в том числе когда
        // страница просто не догрузилась (прокси, таймаут, оборванный CDP), а раньше эта ветка писала
        // «куки мертвы». Заметка не безобидна: строка выше (`/suspended|куки мертвы/`) читает её и
        // ИСКЛЮЧАЕТ акк из куки-реанимации навсегда, то есть один недогруз страницы хоронил акк с
        // живыми куками. Ничего не пишем, следующий прогон посмотрит заново.
        console.log(`  ？ @${cand.h}: экран не опознан (${cls.state}) — заметку НЕ пишу, вердикта нет`);
      } else {
        await c.query(`UPDATE accounts SET health_note=$2 WHERE id=$1`,
          [cand.id, `modelduty: куки мертвы (${cls.state}) — нужен ручной вход, сторож не логинится`]);
        console.log(`  🔒 @${cand.h}: куки мертвы (${cls.state}) — пометил need_login, вход только вручную`);
      }
    } catch (e) { console.log(`  ⚠ @${cand.h}: реанимация не прошла (${String(e.message).slice(0, 90)}) — акк не тронут`); }
    if (i < cands.length - 1) await sleep(Number(process.env.REVIVE_GAP_SEC || 90) * 1000);
  }

  const alive = (await c.query(`SELECT count(*) n FROM accounts WHERE persona<>'' AND deleted_at IS NULL AND session_status='live'`)).rows[0].n;
  console.log(`[modelduty] итог прогона: live модельных акков ${alive}`);
  if (hidden.length) {
    console.log(`[modelduty] СПРЯТАНЫ СНАРУЖИ (${hidden.length}): ${hidden.join(', ')}`);
    console.log('[modelduty] это не приговор: снаружи видно только «профиль не отдаётся». Проверять входом,');
    console.log('[modelduty] автоснос и автозамену по метке hidden не запускать. Пока спрятан — посты снаружи не видны.');
  }
  await c.end();
}

(async () => {
  do {
    await pass().catch((e) => console.error('[modelduty] прогон упал:', e.message));
    if (LOOP) { const min = 40 + Math.floor(Math.random() * 30); console.log(`[modelduty] следующий прогон через ${min} мин`); await sleep(min * 60000); }
  } while (LOOP);
  process.exit(0);
})();
