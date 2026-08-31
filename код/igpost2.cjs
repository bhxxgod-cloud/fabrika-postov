// ПУБЛИКАТОР v2 (промо-фабрика → IG Reels), построен на iglib по контракту PLAN-igposter2.md.
// Отличия от старого igpost.cjs (закрытые ошибки разбора 31.07):
//   • состояние — только положительными признаками (classifyScreen), unknown = стоп;
//   • сверка ЧЕЙ логин: ds_user_id куки == ds_user_id из сохранённых кук акка (не постить на чужой);
//   • ввод только в видимые поля + обратное чтение (typeVerified);
//   • успех = НОВЫЙ shortcode: первоисточник это ответ IG на /media/configure_to_clips (ловит
//     сетевой свидетель), лента профиля (до/после) вторична; не «пропал спиннер» и не тост;
//   • после Share со страницы НЕ уходим до 6 минут: заливка и сборка поста идут ИМЕННО в это
//     время, навигация обрывает доводку configure (корень провалов 06.08);
//   • до post_submitted провалы возвращают пост в очередь (approved) — ретрай безопасен;
//     после клика Share ретраев НЕТ НИКОГДА: не подтвердился = ambiguous, смотрим глазами;
//   • постер НЕ пишет статусы аккаунтов; куки пересохраняет в БД (замкнутый круг).
// Запуск: DB_PUBLIC_URL=… node igpost2.cjs "<slug>" "<post_id>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const L = require('./iglib.cjs');
const PV = require('./postverify.cjs');   // сверка исхода снаружи, без браузера
const SLUG = process.argv[2];
const POST_ID = process.argv[3];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';
// РЕШЕНИЕ НАЧАЛЬНИКА 07.08: ограничение IG у наших акков касается ССЫЛОК, сами акки живые,
// поэтому посты без ссылок публикуем. Раньше мы по одной фразе «added a restriction» снимали
// акк с работы целиком и так вывели три рабочих аккаунта при полном складе.
// ВНИМАНИЕ (08.08): этот флаг — решение ВСЛЕПУЮ, и работает он только там, где подробности
// ограничения прочитать не удалось. Если restrictdetail прочитал экран и Instagram пишет
// «You can't post» — публикацию отменяем независимо от флага (см. гейт здоровья ниже).
// Выключить поведение: RESTRICT_POST_OK=0.
const RESTRICT_POST_OK = !/^(0|false|no)$/i.test(String(process.env.RESTRICT_POST_OK || '1'));
const TAG = `post2_${String(SLUG || '').replace(/\W/g, '_')}`;
// Скрины провалов пишутся с этим тегом: без него fail_3_диалог_создания.jpg от пяти акков подряд
// затирали друг друга и разбор шёл по чужому экрану (07.08).
L.setShotTag(TAG);
const sleep = L.sleep;

global.__GL = null;
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try {
    await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]);
    if (typeof gl.killBrowser === 'function') gl.killBrowser();
    console.log(`  ⏹ окно закрыто (${why})`);
  } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });

async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

async function fetchVideo(url) {
  const out = `${SHOT}/promo_${Date.now()}.mp4`;
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('видео не скачалось: HTTP ' + r.status);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  const size = fs.statSync(out).size;
  if (!size) throw new Error('видео скачалось пустым (0 байт)');
  console.log(`  📥 ролик скачан: ${(size / 1048576).toFixed(1)} МБ`);
  return out;
}

(async () => {
  if (!SLUG || !POST_ID) { console.log('usage: node igpost2.cjs <slug> <post_id>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT p.id, p.caption, p.media_url, p.media_type, p.meta, p.reply_text, p.post_submitted, a.id aid, a.gologin_profile_id pid,
            a.ig_cookies, a.session_status, coalesce(a.ig_login,a.slug) h, a.persona, a.display_name, g.gologin_token tok
       FROM posts p JOIN accounts a ON a.id=p.account_id JOIN account_groups g ON g.id=a.group_id
      WHERE p.id=$1 AND a.slug=$2`, [POST_ID, SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ пост/акк не найден'); await c.end(); process.exit(1); }

  // Провал ДО клика Share: пост остаётся approved (очередь), причина в error — ретрай безопасен.
  // НО ретрай безопасен только у ВРЕМЕННЫХ причин. 02.08: запасной акк Ани забанили через час после
  // заведения, постер увидел /accounts/suspended/, вернул пост в очередь — и воркер подал его снова.
  // 102 захода в мёртвый акк подряд. Бан ретраем не лечится, поэтому терминальные экраны разбираем
  // отдельно: помечаем акк, снимаем пост, цикл обрывается на первом же разе.
  // ПРИГОВОР ТОЛЬКО ПО ОДНОЗНАЧНОЙ ФОРМУЛИРОВКЕ (07.08). Регекс применяется к ТЕКСТУ строки-причины,
  // а не к экрану, и раньше в нём стояла голая альтернатива «suspended»: любое сообщение об ошибке, куда
  // попало это слово (адрес в тексте, лог прокси, заглушка провайдера), метило акк suspended + paused,
  // а с паузы его забирает автозамена и сносит вместе с профилем GoLogin. Оставляем только формы,
  // которые не появляются случайно: путь /accounts/suspended и явные фразы IG.
  const TERMINAL_RX = /accounts\/suspended|подтвердите, что вы человек|confirm you'?re human|account has been disabled|мы (отключили|заблокировали) ваш аккаунт/i;
  const killAccount = async (state, reason) => {
    await c.query(`UPDATE accounts SET ig_status=$2, status='paused', session_status='dead',
                     health_state='restricted', health_note=$3 WHERE id=$1`,
      [row.aid, state, String(reason).slice(0, 300)]).catch(() => {});
    await c.query(`UPDATE posts SET status='cancelled', error=$2 WHERE id=$1`,
      [row.id, `акк ${state} — пост снят, ретраи бессмысленны`]).catch(() => {});
    console.log(`ИТОГ: ⛔ акк помечен ${state}, пост снят (ретраи прекращены): ${String(reason).slice(0, 120)}`);
  };
  const backToQueue = async (reason) => {
    if (TERMINAL_RX.test(String(reason))) { await killAccount('suspended', reason); return; }
    // Неоформленный акк ретраем не чинится: пока не поставят аву и не уберут чужие посты, каждая
    // следующая попытка упрётся в тот же гейт. Без отвода это станет долбёжкой, как 02.08 (102 захода).
    const dress = /НЕ ОФОРМЛЕН|ЧУЖИЕ ПОСТЫ/.test(String(reason));
    await c.query(
      `UPDATE posts SET status='approved', error=$2, attempts=attempts+1` +
      (dress ? `, scheduled_at = now() + interval '2 hours'` : '') + ` WHERE id=$1`,
      [row.id, reason.slice(0, 300)]);
    console.log(`ИТОГ: ✗ вернул в очередь${dress ? ' (следующая попытка через 2ч — нужна подготовка акка)' : ''}: ${reason}`);
  };

  // ИНВАРИАНТ: после клика «Поделиться» ретраи запрещены навсегда — дубли хуже пропуска.
  if (row.post_submitted) { console.log('ИТОГ: пост уже отправлялся — ретрай запрещён'); await c.end(); process.exit(0); }
  if (!row.media_url) { await c.query(`UPDATE posts SET status='failed', error='нет media_url' WHERE id=$1`, [row.id]); console.log('ИТОГ: ✗ нет media_url'); await c.end(); process.exit(1); }

  // ГЕЙТЫ ДО ОТКРЫТИЯ ОКНА (вход — дорогая операция; без готовой сессии окно не открываем).
  let cks = [];
  try { cks = L.normCookies(row.ig_cookies); } catch { cks = []; }
  const expectedId = L.pickCookie(cks, 'ds_user_id');
  const hasSess = (L.pickCookie(cks, 'sessionid') || '').length > 10;
  if (!hasSess || !expectedId) { await backToQueue('нет сохранённых кук сессии (sessionid/ds_user_id) — нужен вход и съём кук, постер окно не открывает'); await c.end(); process.exit(0); }
  if (row.session_status !== 'live') { await backToQueue(`session_status=${row.session_status} — жду, пока акк поднимут (постер акки не судит и не логинит)`); await c.end(); process.exit(0); }

  // ФИНАЛЬНЫЙ ПРЕДОХРАНИТЕЛЬ (06.08). Последний рубеж перед дорогой операцией: окно Orbita ещё
  // НЕ открыто, вход не потрачен. Зачем он тут, если гейты есть у источников задач: задачу можно
  // поставить руками через SQL, старым скриптом или ретраем — и тогда ни один гейт не сработает.
  // Ровно так cherry.mood59 получил 25 заходов в «аккаунт ограничен». Стадия 'run': свою живую
  // задачу занятостью не считаем, межпостовый интервал не перепроверяем (он решён при постановке).
  {
    const PG = require('./postguard.cjs');
    const v = await PG.canPost(SLUG, { client: c, stage: 'run', ignoreJobId: process.env.POSTGUARD_JOB_ID || null });
    if (!v.ok) {
      // Акк сам не вылечится (пауза, ограничение IG, снос) — снимаем пост С ЭТОГО акка обратно на
      // склад, иначе материал навсегда прилипнет к мёртвому аккаунту и будет ждать вечно.
      // Временные причины (провалы, лимит, занятость) — обычный возврат в очередь.
      if (['status_paused', 'health_block', 'deleted', 'no_account'].includes(v.code)) {
        await c.query(`UPDATE posts SET status='backlog', scheduled_at=NULL, error=$2 WHERE id=$1`,
          [row.id, `снят с @${row.h}: ${v.reason}`.slice(0, 300)]).catch(() => {});
        console.log(`ИТОГ: 🛡 предохранитель [${v.code}]: ${v.reason} — окно не открываю, пост вернул на склад`);
      } else {
        await backToQueue(`ПРЕДОХРАНИТЕЛЬ [${v.code}]: ${v.reason} — окно не открываю, вход не трачу`);
        console.log(`  🛡 предохранитель закрыл публикацию до входа в акк: ${v.code}`);
      }
      await c.end(); process.exit(0);
    }
  }
  console.log(`ПУБЛИКУЮ для «${row.persona}» на @${row.h} (ds_user_id=${expectedId}): ${String(row.caption || '').slice(0, 60)}`);

  // КАРУСЕЛЬ ФОТО (фотопосты фабрики): meta.image_urls = 2-3 картинки, качаем все и грузим одним
  // setInputFiles. Уникализация — uniqphoto (свой сид на КАЖДЫЙ кадр, привязан к акку).
  const isCarousel = row.media_type === 'CAROUSEL' && Array.isArray((row.meta || {}).image_urls) && row.meta.image_urls.length;
  let videoPath = null;      // для карусели тут МАССИВ путей — setInputFiles принимает и то и то
  try {
    if (isCarousel) {
      const files = [];
      for (const [i, u] of row.meta.image_urls.entries()) {
        const out = `${SHOT}/car_${Date.now()}_${i + 1}.jpg`;
        const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`фото ${i + 1} не скачалось: HTTP ${r.status}`);
        fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
        if (!fs.statSync(out).size) throw new Error(`фото ${i + 1} пустое`);
        files.push(out);
      }
      console.log(`  📥 карусель скачана: ${files.length} фото`);
      // НОВОЕ ПРАВИЛО (начальник 05.08): перед постингом нового рилса снимаем просмотры прошлых.
      // stats.cjs ходит curl'ом по куке акка (без браузера) и пишет снимок в post_stats.
      try {
        const { execFileSync } = require('node:child_process');
        const out = execFileSync('node', [require('node:path').join(__dirname, 'stats.cjs'), row.slug],
          { encoding: 'utf8', timeout: 90000, env: { ...process.env, DB_PUBLIC_URL: process.env.DB_PUBLIC_URL || require('node:fs').readFileSync('/tmp/dburl.txt', 'utf8').trim() } });
        console.log('  📊 срез просмотров перед постом: ' + String(out).trim().split('\n').pop());
      } catch (e) { console.log('  ⚠ срез просмотров не снялся: ' + String(e.message).slice(0, 80)); }

      // ГЕЙТ КАЧЕСТВА (03.08): фабрика иногда рисует на «после» ДРУГУЮ девушку и бьёт текст на
      // плашке («ОФАЛ», «we f cut»). Такое ушло в ленту, потому что никто не смотрел глазами.
      // Теперь смотрит vision-модель. Непроверенное (нет ключа/сети) тоже НЕ публикуем: пост
      // подождёт, это дешевле, чем чужое лицо в аккаунте модели.
      // meta.manual_ok=true — кадры проверены глазами человека (дождевые от аватар-чата и т.п.):
      // машинную проверку пропускаем, для одиночных фото ей и сравнивать нечего (05.08).
      if (process.env.VALIDATE_OFF !== '1' && !(row.meta || {}).manual_ok) {
        const V = require('./validatepost.cjs');
        // ПРИЗНАКИ СБОРКИ ИЗ meta ОБЯЗАНЫ ДОЕЗЖАТЬ ДО ПРОВЕРКИ (07.08).
        // Здесь передавался ОДИН template, а признаки того, КАК собран пост, терялись. Из-за этого
        // валидатор судил наши штатные приёмы как брак, и посты падали в rejected на ровном месте:
        //   • cover_from_owner — кадр 1 это живое фото владельца, а арты рисует движок, поэтому
        //     лицо на арте всегда чуть другое. Без coverRef это «ЛИЦО НЕ СОВПАДАЕТ» = брак
        //     (пойман на @mahjobi__mks: «на кадре 1 и кадрах 2-4 разные девушки»);
        //   • frame4_art — кадр 4 СОЗНАТЕЛЬНО сделан из кадра 2 в другом кадрировании, без
        //     frame4Art это «ДУБЛИ КАДРОВ» = брак.
        // Оба признака уже лежат в meta и уже учтены внутри валидатора — не доходил только вызов.
        // harvestlog.cjs передаёт их давно, публикатор — нет; отсюда расхождение вердиктов.
        const vmeta = row.meta || {};
        const vr = await V.validateCarousel(files, {
          template: vmeta.template,
          coverRef: vmeta.cover_from_owner === true,
          frame4Art: vmeta.frame4_art === true,
        });
        // СБОЙ ПРОВЕРКИ ЭТО НЕ БРАК КАРТИНОК (07.08). Проверка ходит в платный vision, и когда он
        // ответил «нужна оплата» (HTTP 402), вердикт приходил 'unknown', а код рубил пост как брак:
        // девять годных постов подряд ушли в rejected, публикация встала полностью. Инфраструктурный
        // сбой не имеет права судить контент: при несостоявшейся проверке публикуем и оставляем
        // пометку, брак это только явный 'reject' от самой модели.
        // Признак сбоя берём готовым полем (V.checkFailed), а НЕ регуляркой по тексту problems:
        // первая версия фикса разбирала текст и молча пропускала часть случаев, например
        // «нет OPENROUTER_API_KEY» — такие посты продолжали уходить в брак.
        const failed = V.checkFailed(vr);
        await c.query(`UPDATE posts SET meta = meta || jsonb_build_object('validation', $2::jsonb) WHERE id=$1`,
          [row.id, JSON.stringify({ verdict: vr.verdict, ok: vr.ok !== false, reason: vr.reason || null,
            kind: vr.kind || null, problems: vr.problems || [], checks: vr.checks || null,
            at: new Date().toISOString() })]).catch(() => {});
        if (failed) {
          console.log(`  ⚠ проверка картинок не состоялась (${vr.reason || 'unknown'}/${vr.kind || '?'}: ${(vr.problems || [])[0]}) — публикую без неё, пометка в базе`);
        }
        if (vr.verdict !== 'ok' && !failed) {
          const why = (vr.problems || []).slice(0, 3).join('; ') || 'без деталей';
          await c.query(`UPDATE posts SET status='rejected', error=$2 WHERE id=$1`,
            [row.id, `брак картинок (${vr.verdict}): ${why}`.slice(0, 300)]).catch(() => {});
          console.log(`ИТОГ: ⛔ НЕ публикую — брак картинок (${vr.verdict}): ${why}`);
          await c.end(); process.exit(0);
        }
        console.log(`  ✅ проверка картинок пройдена (уверенность ${vr.confidence ?? '?'})`);
      }
      if (process.env.UNIQ_OFF !== '1') {
        const UP = require('./uniqphoto.cjs');
        const done = await UP.uniquifyPhotos({ files, outDir: `${SHOT}/car_uniq_${Date.now()}`, seedKey: String(row.aid) });
        files.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
        videoPath = done.map((d) => d.path);
        console.log(`  🧬 фото уникализированы под акк ${String(row.aid).slice(0, 8)} (${done.length} шт., кроп/поворот/цвет/шум свои на кадр)`);
      } else videoPath = files;

      // КАРУСЕЛЬ → РИЛС (решение владельца 03.08). В ленте IG режет высокую плашку до 4:5, и низ
      // с выводами обрезается — читать нечего. Рилс идёт 9:16, картинка помещается целиком, плюс
      // у рилсов охват выше. Поэтому кадры склеиваем в вертикальное видео и грузим как ролик.
      // REEL_OFF=1 — вернуть публикацию каруселью.
      if (process.env.REEL_OFF !== '1') {
        const RB = require('./reelbuild.cjs');
        // Сид музыки — от ПОСТА, а не от аккаунта: иначе у одного акка во всех рилсах играет
        // одна и та же мелодия (03.08). Разные посты = разные треки.
        const reel = await RB.buildReel({ files: videoPath, out: `${SHOT}/reel_${Date.now()}.mp4`, seedKey: String(row.id) });
        videoPath.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
        videoPath = reel.path;
        console.log(`  🎬 собран рилс 1080×1920: ${reel.duration.toFixed(1)} сек, ${(reel.size / 1048576).toFixed(1)} МБ (картинка целиком, без обрезки)`);
      }
    } else videoPath = await fetchVideo(row.media_url);
  }
  catch (e) { await c.query(`UPDATE posts SET status='failed', error=$2 WHERE id=$1`, [row.id, String(e.message).slice(0, 200)]); console.log('ИТОГ: ✗', e.message); await c.end(); process.exit(1); }
  if (!isCarousel) {
    // УНИКАЛИЗАЦИЯ (решение владельца 01.08): один ролик на ДВА акка (личный модели + брендовый) IG
    // ловит по перцептивному хэшу и отпечатку звука → копию режет в охвате и склеивает акки.
    // Сид от аккаунта: у каждой модели свой стабильный вариант. UNIQ_OFF=1 — выключить.
    if (process.env.UNIQ_OFF !== '1') {
      try {
        const U = require('./uniq.cjs');
        const out = `${SHOT}/uniq_${Date.now()}.mp4`;
        const before = fs.statSync(videoPath).size;
        const r = await U.uniquifyFile({ inPath: videoPath, outPath: out, seedKey: String(row.aid), level: process.env.UNIQ_LEVEL || 'medium' });
        try { fs.unlinkSync(videoPath); } catch {}
        videoPath = r.path;
        console.log(`  🧬 уникализировано под акк ${String(row.aid).slice(0, 8)}: ${(before / 1048576).toFixed(1)}→${(r.size / 1048576).toFixed(1)} МБ ` +
          `(зум ${r.params.scale.toFixed(3)}, скорость ${r.params.speed.toFixed(3)}, оттенок ${r.params.hue.toFixed(1)}°)`);
      } catch (e) {
        // Публиковать ИСХОДНЫЙ файл нельзя: одинаковый ролик на двух акках IG склеивает по
        // перцептивному хэшу — это ровно та беда, ради которой уникализация и делалась. Раньше тут
        // стояло предупреждение в консоль и публикация продолжалась, то есть у защиты был тихий
        // обход. Теперь пост возвращается в очередь и ждёт, пока ffmpeg починится.
        await backToQueue(`уникализация не прошла (${String(e.message).slice(0, 120)}) — сырой файл не публикуем`);
        await closeLocal('uniq-fail'); await c.end(); process.exit(0);
      }
    } else console.log('  🧬 уникализация выключена (UNIQ_OFF=1)');
  }

  // ГЕЙТ КАЧЕСТВА ДЛЯ ВИДЕО. Карусели проверялись, а ролики уходили в ленту без присмотра —
  // и брак у них свой: чёрный первый кадр (в ленте пост выглядит сломанным), каша вместо
  // картинки. Смотрим три кадра: начало, середину и конец.
  if (!isCarousel && process.env.VALIDATE_OFF !== '1') {
    try {
      const V = require('./validatepost.cjs');
      const vr = await V.validateVideo(videoPath, { template: 'видеоролик' });
      await c.query(`UPDATE posts SET meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('validation', $2::jsonb) WHERE id=$1`,
        [row.id, JSON.stringify({ verdict: vr.verdict, ok: vr.ok !== false, reason: vr.reason || null,
          kind: vr.kind || null, problems: vr.problems || [], at: new Date().toISOString() })]).catch(() => {});
      // Брак ролика — только явный 'reject' от модели. Несостоявшуюся проверку (нет кадров, лёг
      // сервис) не считаем браком по тому же правилу 07.08, что и для каруселей.
      if (vr.verdict === 'reject' && !V.checkFailed(vr)) {
        const why = (vr.problems || []).slice(0, 3).join('; ') || 'без деталей';
        await c.query(`UPDATE posts SET status='rejected', error=$2 WHERE id=$1`, [row.id, `брак ролика: ${why}`.slice(0, 300)]).catch(() => {});
        console.log(`ИТОГ: ⛔ НЕ публикую — брак ролика: ${why}`);
        await c.end(); process.exit(0);
      }
      // 'unknown' у видео НЕ блокируем: кадр мог не извлечься по техническим причинам, а ролик
      // приходит от владельца и уже просмотрен им. Для каруселей правило строже — там источник фабрика.
      console.log(`  ✅ проверка ролика: ${vr.verdict}`);
    } catch (e) { console.log(`  ⚠ проверка ролика не отработала (${String(e.message).slice(0, 70)}) — публикую`); }
  }

  // GoLogin локально; 503/сеть — ретраи с паузой (до окна, безопасно).
  const { default: GoLogin } = await import('gologin');
  // Пустой архив профиля = браузер стартует БЕЗ кук (разбор 07.08: 4 боевых акка так и умирали).
  L.dropBrokenProfileZip(row.pid);
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  let st = null;
  for (let t = 1; t <= 3 && !st; t++) {
    try { st = await gl.startLocal(); if (!st || !st.wsUrl) { st = null; throw new Error('startLocal без wsUrl'); } }
    catch (e) { console.log(`  ⚠ GoLogin попытка ${t}/3: ${String(e.message).slice(0, 80)}`); if (t < 3) await sleep(90000); }
  }
  if (!st) { await backToQueue('GoLogin недоступен (3 попытки) — задача вернётся позже'); await closeLocal('no-gl'); await c.end(); process.exit(0); }

  let finalStatus = null, err = null, postUrl = null, submitted = false;
  try {
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);

    // СЕТЕВОЙ СВИДЕТЕЛЬ ЗАЛИВКИ (06.08, разбор «Share нажат, поста нет»). Окно «shared» врёт,
    // лента запаздывает, а сетевые запросы говорят правду из первых рук: rupload_* это доставка
    // байтов файла на сервер, /media/configure это команда «собери из них пост». Пишем каждый
    // такой запрос с исходом, чтобы разбор провала опирался на факт, ГДЕ оборвалось: файл не
    // уехал, configure не отправился, IG ответил ошибкой. Успешный configure отдаёт shortcode
    // нового поста, это самое прямое доказательство публикации из существующих.
    const NET = [];
    let cfgShortcode = null;
    const NET_RX = /rupload_ig(video|photo)|\/media\/configure|\/web\/create\//i;
    page.on('requestfailed', (r) => {
      if (!NET_RX.test(r.url())) return;
      const e = { t: new Date().toISOString().slice(11, 19), m: r.method(), u: r.url().slice(0, 130), fail: (r.failure() || {}).errorText || 'без причины' };
      NET.push(e);
      console.log(`  🕸 ОБРЫВ ${e.m} ${e.u} : ${e.fail}`);
    });
    page.on('response', (res) => {
      if (!NET_RX.test(res.url()) || res.request().method() === 'OPTIONS') return;
      const e = { t: new Date().toISOString().slice(11, 19), m: res.request().method(), u: res.url().slice(0, 130), st: res.status() };
      NET.push(e);
      // Тело читаем асинхронно и не роняем прогон, если IG его не отдал (редирект, обрыв).
      res.text().then((body) => {
        e.body = String(body).slice(0, 300);
        if (/configure/i.test(res.url()) && res.status() === 200) {
          const sc = (String(body).match(/"code"\s*:\s*"([A-Za-z0-9_-]{8,})"/) || [])[1];
          if (sc) { cfgShortcode = sc; e.shortcode = sc; console.log(`  🕸 configure подтвердил пост: shortcode ${sc}`); }
        }
        if (res.status() >= 400) console.log(`  🕸 ${e.st} ${e.m} ${e.u} тело: ${e.body.slice(0, 160)}`);
      }).catch(() => {});
      if (res.status() < 400) console.log(`  🕸 ${e.st} ${e.m} ${e.u}`);
    });
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies([{ name: 'ig_lang', value: 'en', domain: '.instagram.com', path: '/' }]).catch(() => {});
    await ctx.addCookies(cks);
    console.log(`  🍪 сессия подставлена (${cks.length} кук)`);

    // С КАКОГО IP МЫ ВЫХОДИМ. Встроенный прокси GoLogin — ОБЩИЙ пул: адрес выдаётся динамически и
    // делится с чужими пользователями, поэтому «регион uk» ничего не говорит о репутации адреса.
    // Один лёгкий запрос к нейтральному сервису до захода на IG, чтобы бан-разбор опирался на факт,
    // а не на догадку «наверное, прокси плохие». Не удалось узнать — просто пишем это, не гадаем.
    try {
      const ipPage = await ctx.newPage();
      await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const txt = await ipPage.evaluate(() => document.body.innerText).catch(() => '');
      const ip = (String(txt).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
      await ipPage.close().catch(() => {});
      console.log(`  🌐 выходим с адреса: ${ip || 'не определился'}`);
      if (ip) await c.query(`UPDATE accounts SET last_egress_ip=$2 WHERE id=$1`, [row.aid, ip]).catch(() => {});
    } catch (e) { console.log(`  🌐 адрес не определился: ${String(e.message).slice(0, 60)}`); }

    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(6000); await L.dismissDialogs(page);
    // ЭКРАН ВЫБОРА ПРОФИЛЯ (07.08, скриншот fail_post2_FOL_2593_1_сессия.jpg): Instagram показывает
    // аватарку со СТАРЫМ ником акка и три кнопки «Continue», «Use another profile», «Create new
    // account». Сессия при этом ЖИВАЯ, надо просто подтвердить вход. Наш код видел незнакомый экран
    // и объявлял «сессия не подтверждена», из-за чего свежеоформленные акки не могли постить.
    // Поэтому: ищем Continue не только как кнопку по строгому имени, но и по видимому тексту, и
    // считаем экран профиль-пикером, если рядом есть «Use another profile».
    for (let t = 0; t < 3; t++) {
      const picker = await page.locator('text=/Use another profile|Выбрать другой профиль/i').count().catch(() => 0);
      let cont = page.getByRole('button', { name: /^(Continue|Продолжить)$/i }).first();
      let vis = await cont.isVisible({ timeout: 2000 }).catch(() => false);
      if (!vis) {
        // У кнопки внутри бывает иконка с невидимой подписью, поэтому строгое имя не совпадает:
        // та же грабля, что была с пунктом меню «Post Post» (разбор 07.08).
        cont = page.locator('div[role="button"], button').filter({ hasText: /^(Continue|Продолжить)$/i }).first();
        vis = await cont.isVisible({ timeout: 2000 }).catch(() => false);
      }
      if (!vis) break;
      if (picker) console.log('  ⚠ экран выбора профиля: подтверждаю вход кнопкой Continue');
      await cont.click({ timeout: 5000 }).catch(() => {});
      await sleep(7000);
      await L.dismissDialogs(page);
    }
    await L.dismissDialogs(page);

    // КТО МЫ: положительная классификация + сверка личности (1 модель = 1 аккаунт).
    await L.step(page, SHOT, 'сессия', async () => {
      const cls = await L.classifyScreen(ctx, page);
      if (cls.state !== 'logged_in') throw new Error(`экран=${cls.state} (${cls.evidence}) — сессия не подтверждена`);
      if (String(cls.dsUserId) !== String(expectedId)) throw new Error(`в браузере ds_user_id=${cls.dsUserId}, у акка ${expectedId} — ЧУЖАЯ сессия, стоп`);
    });
    console.log('  ✓ в нужном аккаунте');

    // ГЕЙТ ЗДОРОВЬЯ (урок 01.08): постить на ограниченный акк = добивать его. Проверяем ДО работы.
    // restricted → пост назад в очередь + алерт; unknown → работаем, но громко логируем.
    const health = await L.checkAccountStatus(page);
    if (health.state === 'restricted') {
      await L.snap(page, SHOT, `${TAG}_restricted`);
      // ЧИТАЕМ ПОДРОБНОСТИ ТУТ ЖЕ (претензия начальника 07.08). Раньше мы ловили фразу «added a
      // restriction to your account», писали её в лог и уходили — ни что ограничено, ни за что, ни
      // до какого числа. А сессия в этот момент уже открыта и оплачена: пройти по «See why» стоит
      // один переход. Всё найденное падает в account_events(restriction_detail) + журнал блокеров,
      // чтобы решение «ждать или менять акк» принималось по тексту Instagram, а не наугад.
      // Обёрнуто в try: чтение подробностей НИКОГДА не должно ломать постинг.
      let extra = '';
      let chto = [];   // «что ограничено» СЛОВАМИ Instagram (summary.what) — на этом строится решение
      try {
        const RD = require('./restrictdetail.cjs');
        // readAndSaveOnce: если подробности уже читали за последние 12ч — берём их из базы, лишние
        // переходы на каждую публикацию не делаем (постинг на ограниченном акке теперь продолжается).
        const r = await RD.readAndSaveOnce({ client: c, page, accountId: row.aid, slug: SLUG, tagBase: `${TAG}_restrict` });
        chto = (r.summary.what || []).map(String);
        extra = ` | ПОДРОБНОСТИ: ${(r.summary.what || []).join('; ')}; причина: ${(r.summary.reasons || []).join('; ')}; срок: ${(r.summary.dates || []).slice(0, 3).join(' / ') || 'не указан'}`;
        console.log(r.skipped
          ? `  📄 подробности ограничения уже прочитаны ${r.at}, читаю из базы:${extra}`
          : `  📄 подробности ограничения прочитаны и записаны (блокер ${r.blocker}), скрины: ${(r.shots || []).join(' ')}`);
      } catch (e) { console.log(`  ⚠ подробности ограничения прочитать не удалось: ${String(e.message).slice(0, 120)}`); }
      // ОГРАНИЧЕНИЕ НА ССЫЛКИ НЕ ЗАПРЕЩАЕТ ПУБЛИКОВАТЬ (07.08: начальник открыл экран «See why» и
      // прочитал текст — ограничение касается ССЫЛОК, акки живые). Раньше мы по одной фразе снимали
      // акк целиком и так вывели из работы три рабочих аккаунта при полном складе. Наши подписи
      // ссылок не содержат: призыв текстовый («ищи нейронка про шаблоны в яндексе»), проверено по
      // всем 80 постам склада — URL ноль. Поэтому публикуем, но только убедившись в этом для
      // КОНКРЕТНОГО поста, а при ссылке в подписи по-прежнему отказываемся.
      const linkOnly = /link|ссыл/i.test(String(health.excerpt || '') + ' ' + String(extra || ''));
      const capHasLink = /https?:\/\/|www\.|\b[a-z0-9-]+\.(pro|com|ru|me|io|net)\b|t\.me/i.test(String(row.caption || ''));

      // РЕШАЕМ ПО ПРОЧИТАННОМУ, А НЕ ПО ФЛАГУ (08.08). До этой правки подробности читались, писались
      // в базу — и ни на что не влияли: RESTRICT_POST_OK=1 пропускал ЛЮБОЕ ограничение, включая то,
      // где Instagram прямым текстом пишет «You can't post». Это ровно то добивание акка, от которого
      // гейт и ставили (урок 01.08). Признак берём тот же, по которому restrictdetail ставит блокер
      // с blocks=['post','comment'] — строку «действия (…)» из summary.what.
      const banDeystvii = chto.some((x) => /^действия/i.test(x));            // публикация/лайки/комменты/подписки
      const podrobnostiEst = chto.some((x) => !/не удалось определить/i.test(x));

      // 1) ЗАПРЕТ ДЕЙСТВИЙ — жёсткий стоп, флаг не спасает. Ретрай тут бесполезен (запрет висит
      //    часами-днями), акк надо снимать с постинга: блокер restrictdetail уже поставил.
      if (banDeystvii) {
        throw new Error(`АККАУНТ ОГРАНИЧЕН В ДЕЙСТВИЯХ (Instagram: «${chto.join('; ')}») — публиковать нельзя, ретрай бесполезен, акк снимаем с постинга${extra}`);
      }
      // 2) Ссылка в подписи при живом ограничении — не рискуем (проверка была и раньше).
      if (capHasLink) {
        throw new Error(`АККАУНТ ОГРАНИЧЕН и в подписи есть ссылка — не публикую (${health.excerpt.slice(0, 90)})${extra}`);
      }
      // 3) Осталось охват / ссылки / реклама — публиковать это не запрещает, подпись чистая, идём дальше.
      //    Если подробности не прочитались — решаем как раньше, по RESTRICT_POST_OK: встать намертво
      //    из-за неудачного чтения экрана хуже, чем опубликовать. RESTRICT_POST_OK=0 остаётся ручным
      //    тормозом оператора «на ограниченный акк не постим вообще».
      if (RESTRICT_POST_OK || linkOnly) {
        console.log(podrobnostiEst
          ? `  ⚠ ограничение: ${chto.join('; ')} — публикацию оно не запрещает, ссылок в подписи нет — публикую дальше`
          : `  ⚠ ограничение есть, но ЧТО именно ограничено — по тексту не определилось${extra}; решаю по RESTRICT_POST_OK, ссылок в подписи нет — публикую дальше`);
      } else {
        throw new Error(`АККАУНТ ОГРАНИЧЕН: «${health.hit}» — постинг отменён, акк не добиваем (${health.excerpt.slice(0, 120)})${extra}`);
      }
    }
    console.log(`  🩺 статус акка: ${health.state}${health.state === 'unknown' ? ` (не распознал экран: ${health.excerpt.slice(0, 90)})` : ''}`);

    // ЛИЧНОСТЬ: персона ↔ ник ↔ имя профиля. Не блокируем публикацию, но говорим вслух:
    // «Дарья» на @varya.smirnova13 читается как фейк (замечание владельца 01.08).
    const ident = L.checkIdentity({ persona: row.persona, handle: row.h, displayName: row.display_name });
    if (!ident.ok) ident.issues.forEach((i) => console.log(`  ⚠ личность: ${i}`));

    // База для проверки успеха: ролики профиля ДО публикации.
    const before = await L.step(page, SHOT, 'скан профиля ДО', () => L.getShortcodes(page, row.h));
    console.log(`  📊 роликов на профиле до: ${before.size}`);

    // ГЕЙТ ОФОРМЛЕНИЯ (урок 03.08). На @amari277525 ушёл наш ролик, а на профиле стояла ЧУЖАЯ ава
    // (азиатская девушка) и висели два чужих поста прежнего владельца — профиль читается как угнанный.
    // Проверяем ФАКТОМ на уже открытой странице, а не полем в БД: dressed_at ставится безусловно в
    // конце dressup, avatar_set пишется без подтверждения, доверять им нельзя.
    // Наши публикации — всегда /reel/, чужое наследство — /p/, отсюда и признак.
    if (process.env.DRESS_GATE_OFF !== '1') {
      const ours = new Set((await c.query(
        `SELECT external_url FROM posts WHERE account_id=$1 AND external_url IS NOT NULL`, [row.aid]
      ).catch(() => ({ rows: [] }))).rows
        .map((x) => (String(x.external_url).match(/\/(?:p|reel)\/([^/]+)/) || [])[1]).filter(Boolean));

      const prof = await page.evaluate(() => {
        const img = [...document.querySelectorAll('header img, img')]
          .find((i) => /profile picture|фото профиля/i.test(i.getAttribute('alt') || ''));
        const photos = [...document.querySelectorAll('a[href*="/p/"]')]
          .map((x) => (x.getAttribute('href').match(/\/p\/([^/]+)/) || [])[1]).filter(Boolean);
        return { src: img ? img.src : null, photos: [...new Set(photos)] };
      }).catch(() => ({ src: null, photos: [] }));

      const noAvatar = !prof.src || /anonymousUser|profilePicDefault/i.test(prof.src);
      const foreign = prof.photos.filter((sc) => !ours.has(sc));
      if (noAvatar) throw new Error(`НЕ ОФОРМЛЕН: на профиле нет авы модели — сначала prepacc.cjs`);
      // meta.allow_dirty_grid=true — решение начальника 05.08 по damari: старые посты прежнего
      // контура ОСТАВЛЯЕМ и постим поверх (удаление/архив отклонены). Гейт не блокирует.
      // Флаг разрешения снимаем и с поста, и с АККА: решение «постим поверх старой сетки»
      // принимается по аккаунту, а не по каждому посту (05.08, damari намотал 7 провалов подряд).
      const allowDirty = (row.meta || {}).allow_dirty_grid || row.allow_dirty_grid;
      if (foreign.length && !allowDirty)
        throw new Error(`ЧУЖИЕ ПОСТЫ в сетке (${foreign.length}: ${foreign.slice(0, 3).join(',')}) — сначала чистка`);
      if (foreign.length) console.log(`  ⚠ в сетке ${foreign.length} старых постов — постим поверх (allow_dirty_grid)`);
      console.log(`  ✓ профиль оформлен: ава на месте, чужих постов нет`);
    }

    // СОЗДАНИЕ ПОСТА. Вся работа с интерфейсом — в iglib (единственный модуль UI по контракту).
    // ДВА ВАРИАНТА МЕНЮ (найдено 07.08 по дампам и скринам боевых провалов): на обычном профиле
    // иконка «New post» сразу открывает мастер, а на ПРОФЕССИОНАЛЬНОМ профиле «Create» раскрывает
    // список «Post / Live video / Ad / AI» и нужен второй клик по пункту «Post». Пункт не
    // находился строгим матчером по роли (в доступное имя влезает <title> из svg: «Post Post»),
    // отсюда «диалог с input[type=file] не появился» на promt.vibe.lab, ai.promt.mood, mahjobi__mks.
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4000); await L.dismissDialogs(page);
    // СЕТКА БЕЗОПАСНОСТИ на нативный выбор файла: если вариант интерфейса откроет системное окно
    // вместо скрытого инпута, файл отдаём в него же (иначе прогон повис бы на пустом окне).
    let nativePick = false;
    const onChooser = async (ch) => { nativePick = true; try { await ch.setFiles(videoPath); } catch {} };
    page.on('filechooser', onChooser);
    const wiz = await L.step(page, SHOT, 'диалог создания', async () => {
      const w = await L.openCreateWizard(page, { log: (m) => console.log(`\n    ${m}`) });
      if (!w) throw new Error('мастер создания не открылся: ни файлового поля в диалоге, ни признаков мастера на странице '
        + '(проверено 4 попытки: иконка «New post» + пункт меню «Post»)');
      return w;
    });
    console.log(`  ✓ мастер создания открыт (${wiz.where}${wiz.notes.length ? '; ' + wiz.notes.join(' → ') : ''})`);

    // Файл. input[type=file] в IG скрыт ВСЕГДА — правило видимости на него не распространяется,
    // setInputFiles работает со скрытым инпутом по конструкции Playwright.
    await L.step(page, SHOT, 'загрузка файла', async () => {
      await wiz.input.waitFor({ state: 'attached', timeout: 20000 });
      await wiz.input.setInputFiles(videoPath);
    });
    console.log(`  📤 файл отправлен${nativePick ? ' (через нативное окно выбора)' : ''}, жду обработку…`);

    // ИНВАРИАНТ мастера: рабочий диалог обязан быть жив. Пропал — стоп с причиной, а не слепые клики.
    // «Диалога нет» бывает ДВУХ РОДОВ, и раньше они путались (07.08): мастер действительно закрыт
    // ИЛИ страница не отвечает (Instagram жмёт видео в браузере — тогда все проверки молча отдают
    // «не нашёл»). Второе временное: даём странице отдышаться, а не объявляем мастер потерянным.
    const aliveOrDie = async (where) => {
      let last = '';
      for (let t = 0; t < 3; t++) {
        const live = await L.pageAlive(page);
        if (live.kind === 'closed') throw new Error(`ОКНО БРАУЗЕРА ЗАКРЫТО СНАРУЖИ (${live.why}) на шаге «${where}» — интерфейс тут ни при чём`);
        if (live.alive) {
          const d = await L.workDialog(page);
          if (d) return d;
          last = 'мастер не найден на живой странице';
        } else last = `страница не отвечает: ${live.why}`;
        if (t < 2) { console.log(`\n  ⏳ ${where}: ${last} — жду 8с и проверяю снова`); await sleep(8000); }
      }
      throw new Error(`рабочий диалог создания закрылся (${where}): ${last} — дальше кликать вслепую нельзя`);
    };
    // Ждём готовности мастера ПОЛОЖИТЕЛЬНО (до 2 минут), а не глухой паузой 14 секунд: на
    // бесплатном прокси обработка файла в неё не укладывалась, и мастер объявлялся потерянным.
    await L.step(page, SHOT, 'мастер после загрузки', async () => {
      const r = await L.waitEditorReady(page, { timeoutMs: 120000, log: (m) => console.log(`\n  🧹 ${m}`) });
      if (!r.ok) throw new Error(r.reason + ' — дальше кликать вслепую нельзя');
      console.log(`\n  ✓ мастер готов через ${r.secs}с (медиа в диалоге: ${r.media})`);
      await L.snap(page, SHOT, `${TAG}_uploaded`);
    });
    page.off('filechooser', onChooser);

    // Формат 9:16 (без него Reels режет в квадрат). Не критично для публикации — не роняем, но логируем честно.
    try {
      const dlg = await aliveOrDie('перед кадрированием');
      const cropBtn = dlg.locator('svg[aria-label*="Select crop" i], svg[aria-label*="Crop" i], svg[aria-label*="Кадр" i]').first();
      if (await cropBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await L.clickSafe(page, cropBtn, 'иконка кадрирования');
        await sleep(1800);
        const opts = await dlg.evaluate((d) => [...d.querySelectorAll('div[role="button"],button,span')]
          .filter((e) => e.offsetParent !== null).map((e) => (e.textContent || '').trim())
          .filter((t) => t && t.length < 20)).catch(() => []);
        console.log(`  🔲 пункты кадрирования: ${JSON.stringify([...new Set(opts)].slice(0, 12))}`);
        const ratio = dlg.getByText(/^\s*9\s*:\s*16\s*$/).first();
        if (await ratio.isVisible({ timeout: 3000 }).catch(() => false)) { await L.clickSafe(page, ratio, '9:16'); console.log('  🔲 формат 9:16 выбран'); await sleep(1500); }
        else console.log('  ⚠ пункта 9:16 нет в меню (см. список выше) — публикую как есть');
      } else console.log('  (иконка кадрирования не видна — вероятно IG сам определил вертикаль)');
    } catch (e) { console.log('  ⚠ кадрирование:', String(e.message).slice(0, 90)); }

    // Шаги Next до экрана подписи. Признак экрана подписи ПОЛОЖИТЕЛЬНЫЙ (видимое поле), не счётчик кликов.
    const capBox = await L.step(page, SHOT, 'экран подписи', async () => {
      for (let s = 0; s < 4; s++) {
        const dlg = await aliveOrDie(`шаг Next №${s + 1}`);
        const box = await L.visEdit(dlg, 'div[contenteditable="true"][role="textbox"], textarea[aria-label*="aption" i]', 2500);
        if (box) return box;
        await L.clearOverlays(page);
        const next = dlg.getByRole('button', { name: /^(Next|Далее)$/i }).first();
        if (await next.isVisible({ timeout: 6000 }).catch(() => false)) { await L.clickSafe(page, next, `Next №${s + 1}`); await sleep(4500); }
        else {
          // ВТОРОЙ ПРИЗНАК той же кнопки: видимый текст. Матчер по роли слепнет, когда Instagram
          // подкладывает в кнопку <svg><title>…</title></svg> — доступное имя перестаёт быть «Next»
          // (ровно так пропал пункт «Post» в меню создания 07.08). innerText этим не портится.
          const byText = await L.clickByText(page, /^(next|далее)$/i, { timeout: 4000 });
          if (byText.ok) { console.log(`  ↪ Next №${s + 1} найден по тексту (матчер по роли не увидел)`); await sleep(4500); }
          else await sleep(2500);
        }
      }
      throw new Error('видимое поле подписи не появилось после 4 шагов Next (диалог был жив)');
    });

    // ОБЛОЖКА: ролики одного шаблона начинаются одним кадром → в сетке два поста с ОДИНАКОВЫМ превью
    // (замечание владельца 01.08). Сдвигаем кадр обложки на позицию, детерминированно зависящую от id
    // поста: у каждого ролика превью своё. Не критично для публикации — не роняем, но логируем.
    try {
      const dlg = await aliveOrDie('перед обложкой');
      const cover = dlg.getByText(/^(Cover|Обложка|Select cover|Выбрать обложку)$/i).first();
      if (await cover.isVisible({ timeout: 3000 }).catch(() => false)) await L.clickSafe(page, cover, 'Cover');
      const slider = dlg.locator('input[type="range"]').first();
      if (await slider.isVisible({ timeout: 3000 }).catch(() => false)) {
        // позиция 20-80% по хешу id поста — стабильно, но у каждого ролика своя
        const h = String(row.id).split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 1000, 7);
        const pct = 20 + (h % 61);
        await slider.evaluate((el, p) => {
          const max = Number(el.max || 100), min = Number(el.min || 0);
          el.value = String(min + ((max - min) * p) / 100);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, pct);
        console.log(`  🖼 обложка сдвинута на ${pct}% длительности (у каждого ролика своя)`);
        await sleep(1500);
      } else console.log('  🖼 выбор обложки в мастере не найден — превью останется первым кадром');
    } catch (e) { console.log('  ⚠ обложка:', String(e.message).slice(0, 80)); }

    if (row.caption) {
      await L.step(page, SHOT, 'подпись', async () => {
        const r = await L.typeVerified(capBox, String(row.caption).slice(0, 2100));
        if (!r.ok) throw new Error(`обратное чтение не совпало: ввели ${String(row.caption).length}, в поле «${String(r.got).slice(0, 40)}…»`);
      });
      console.log('  ✍️ подпись введена и подтверждена обратным чтением');
    }
    await sleep(1500);

    // ПУБЛИКАЦИЯ. Сначала метка post_submitted (с этого момента ретраи запрещены), потом клик.
    const share = await L.step(page, SHOT, 'кнопка Share', async () => {
      const dlg = await aliveOrDie('перед публикацией');
      await L.clearOverlays(page);
      const b = dlg.getByRole('button', { name: /^(Share|Поделиться|Опубликовать)$/i }).first();
      if (await b.isVisible({ timeout: 8000 }).catch(() => false)) return b;
      // ВТОРОЙ ПРИЗНАК: видимый текст кнопки (матчер по роли слепнет от <title> внутри svg).
      const byText = await L.findByText(page, /^(share|поделиться|опубликовать)$/i, { timeout: 6000 });
      if (byText.ok) { console.log('  ↪ кнопка «Share» найдена по тексту (матчер по роли не увидел)'); return byText.el; }
      throw new Error('кнопка Share не видна на экране подписи (ни по роли, ни по тексту)');
    });
    // ДАМП КОМПОЗЕРА ПЕРЕД SHARE (06.08). Провалы выглядели как «всё шло гладко, поста нет»,
    // потому что никто не смотрел, ЧТО реально лежит в мастере перед кликом: видео или картинка,
    // сколько медиа, доехал ли файл до сервера. Фиксируем состояние и в лог, и скрином.
    try {
      const dlg = await L.workDialog(page);
      const st8 = dlg ? await dlg.evaluate((d) => {
        const vids = [...d.querySelectorAll('video')].map((v) => ({
          dur: Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : null,
          w: v.videoWidth, h: v.videoHeight, src: String(v.currentSrc || '').slice(0, 40),
        }));
        const blobs = [...d.querySelectorAll('img')].filter((i) => String(i.src || '').startsWith('blob:') && i.offsetParent !== null).length;
        return { vids, blobs };
      }).catch(() => null) : null;
      const up = NET.filter((e) => /rupload_ig/i.test(e.u));
      const upOk = up.filter((e) => e.st && e.st < 400).length;
      console.log(`  🔬 композер перед Share: видео ${JSON.stringify((st8 || {}).vids || [])}, blob-картинок ${(st8 || {}).blobs ?? '?'}; заливок в сеть ${up.length} (успешных ${upOk})`);
      if (!upOk) console.log('  🔬 ⚠ ни одной успешной rupload-заливки не видно: файл мог не доехать до сервера');
      await L.snap(page, SHOT, `${TAG}_preshare`);
    } catch (e) { console.log('  🔬 дамп композера не снялся:', String(e.message).slice(0, 80)); }
    // УЛИКА ДО КЛИКА (06.08). Между Share и записью исхода процесс может умереть: убили окно,
    // упала сеть, оборвалась база. Тогда факт «мы нажали Share вот в эту секунду, а до нас на
    // профиле было вот столько роликов» терялся навсегда, и разобраться постфактум было нечем.
    // Кладём его в базу ДО клика: postreconcile.cjs потом однозначно скажет, что залилось.
    await c.query(
      `UPDATE posts SET post_submitted=true, status='publishing',
         meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('share_click', $2::jsonb) WHERE id=$1`,
      [row.id, JSON.stringify({ at: new Date().toISOString(), handle: row.h, before: [...before] })],
    );
    submitted = true;
    await share.click({ timeout: 6000 });
    console.log('  🚀 Share нажат, жду подтверждения от Instagram…');

    // ПРЯМОЕ ПОДТВЕРЖДЕНИЕ ОТ INSTAGRAM (06.08, показал начальник скриншотом). После Share сам IG
    // рисует окно «Your post has been shared» с галочкой. Это положительное доказательство из
    // первых рук, и оно приходит СРАЗУ, тогда как лента профиля обновляется с задержкой и снаружи
    // отдаётся из кэша. Из-за этого реально опубликованные посты получали вердикт «заливка не
    // прошла», предохранитель считал их провалами и снимал ЗДОРОВЫЕ акки с постинга.
    // КОРЕНЬ «Share нажат, поста нет» (найден сетевым свидетелем 06.08 вечером, прогон на
    // @bryan436344). Факт: ВСЯ заливка начинается только ПОСЛЕ клика Share: rupload видео,
    // rupload обложки, затем configure_to_clips. На рилсах configure отвечает 202 («транскод не
    // готов»), и веб-клиент IG сам ДОЖИМАЕТ его повторными запросами до 200 со shortcode. Уход
    // со страницы (навигация на профиль за сверкой) обрывает эту доводку: байты залиты, а пост
    // так и не собран. На быстрой сети доводка укладывалась в старое окно 2 минуты, на медленном
    // бесплатном прокси нет, отсюда «то работает, то нет» и «руками с того же акка постится»
    // (человек со страницы не уходит). Поэтому: ждём до 6 минут, НЕ покидая композер, и выходим
    // раньше только по первоисточнику (configure 200 дал shortcode) или по экранному «shared».
    let sharedToast = false;
    let shareError = null;      // текст ошибки, которую IG показал после Share (если показал)
    let triedAgain = false;     // родной «Try again» жмём не больше одного раза
    for (let i = 0; i < 72 && !cfgShortcode; i++) {   // до 6 минут, шаг 5 сек
      const st9 = await page.evaluate(() => {
        const txt = document.body.innerText || '';
        const okRx = /your post has been shared|your reel has been shared|post shared|reel shared|ваша публикация опубликована|публикация размещена|ваш пост опубликован/i;
        // Отрицательный исход IG тоже рисует словами: раньше мы его не читали и ждали вслепую.
        const errRx = /couldn'?t (be )?(shared|post)|wasn'?t (shared|posted)|could not be shared|something went wrong|upload failed|не удалось (опубликовать|поделиться)|что-то пошло не так/i;
        if (okRx.test(txt)) return { ok: true };
        const hitErr = (txt.match(errRx) || [])[0];
        if (hitErr) return { err: hitErr };
        return {};
      }).catch(() => ({}));
      if (st9.ok) { sharedToast = true; break; }
      if (st9.err && !shareError) {
        shareError = st9.err;
        console.log(`  ⛔ Instagram показал ошибку после Share: «${shareError}»`);
        await L.snap(page, SHOT, `${TAG}_share_error`);
        // Родной ретрай самого IG: это ТА ЖЕ попытка публикации (configure перезапускается по
        // уже залитому файлу), инвариант «после Share прогон не повторяем» не нарушается.
        if (!triedAgain) {
          triedAgain = true;
          const again = page.getByRole('button', { name: /^(Try again|Повторить|Retry)$/i }).first();
          if (await again.isVisible({ timeout: 2500 }).catch(() => false)) {
            await again.click({ timeout: 4000 }).catch(() => {});
            console.log('  ↻ нажал родной «Try again» Instagram (один раз), жду исход дальше');
            shareError = null;   // исход снова неизвестен, читаем экран заново
          }
        }
      }
      await sleep(5000);
    }
    if (sharedToast) console.log('  ✓ Instagram подтвердил: «Your post has been shared»');
    else if (!cfgShortcode) console.log(`  ⏳ подтверждения на экране нет за 6 мин${shareError ? ` (последняя ошибка: «${shareError}»)` : ''}, проверяю ленту`);
    await L.snap(page, SHOT, `${TAG}_postshare`);
    // Пауза перед сверкой лентой нужна только когда исход неизвестен: при подтверждённом
    // configure (shortcode на руках) ждать нечего, навигация уже ничего не оборвёт.
    if (!cfgShortcode) await sleep(15000);

    // УСПЕХ = новый shortcode. Первоисточник это ответ сервера IG на /media/configure (его дал
    // сетевой свидетель), лента профиля лишь вторична: она запаздывает и отдаётся из кэша.
    if (cfgShortcode) console.log(`  ✅ беру shortcode из ответа configure (первоисточник): ${cfgShortcode}`);
    const sc = cfgShortcode || await L.waitNewShortcode(page, row.h, before, 180000);
    await L.snap(page, SHOT, `${TAG}_after`);
    if (sc) {
      postUrl = `https://www.instagram.com/reel/${sc}/`;
      finalStatus = 'published';
      console.log(`  ✅ опубликовано: ${postUrl}`);
      // ПРАВИЛО ВЛАДЕЛЬЦА 01.08: постер ТОЛЬКО публикует рилс с описанием. Никаких комментов
      // (reply_text игнорируем; добивка руками — igfirstcomment.cjs, запускается только по команде).
    } else {
      // ВТОРОЕ МНЕНИЕ СНАРУЖИ (05.08, починено 06.08). Внутри сессии лента может не успеть
      // отрисоваться, и пост повисал в ambiguous, хотя лежит в ленте. Спрашиваем IG как зритель.
      //
      // ЗДЕСЬ БЫЛ КОРЕНЬ ДУБЛЯ. Прошлая версия звала before.includes(...), а before — это Set
      // (iglib.getShortcodes). У Set нет includes → TypeError → молчаливый catch → «снаружи не
      // видно» ВСЕГДА, при любом исходе. Так реально опубликованный пост @darya.smirnova13
      // получил ambiguous без ссылки, был возвращён в работу и залился в ленту вторым разом.
      // Теперь сверка живёт в postverify.cjs, ходит несколькими путями и различает «поста нет»
      // и «прочитать не смогли»; ошибки видны в логе, а не проглатываются.
      const acc = (await c.query(
        `SELECT coalesce(ig_login,slug) h, ig_cookies, ig_proxy FROM accounts WHERE id=$1`, [row.aid]
      )).rows[0] || { h: row.h };
      const outside = await PV.waitForPost(acc, { caption: row.caption, before, timeoutMs: 120000 });
      if (outside.found) {
        postUrl = PV.postUrl(outside.media.code);
        finalStatus = 'published';
        console.log(`  ✅ опубликовано (подтверждено снаружи, ${outside.feed.source}${outside.byNew ? ', по новому ролику' : ', по подписи'}): ${postUrl}`);
      } else if (outside.feed && outside.feed.ok) {
        // Лента прочитана достоверно, нашего поста в ней нет: заливка не прошла. Ретраить всё
        // равно нельзя (инвариант после Share), но человек хотя бы видит однозначный вердикт.
        // ОТКАТ 06.08 (начальник проверил акк руками): поста в ленте НЕТ, значит окно «shared»
        // самому по себе верить нельзя — оно было от РУЧНОГО поста начальника, а не от нашего.
        // Внешний вердикт «в ленте нет» главный; toast пишем в текст только как улику для разбора.
        finalStatus = 'ambiguous';
        err = `Share нажат, ролика нет в ленте (проверено снаружи: ${outside.feed.source}, ${outside.feed.items.length} медиа)${sharedToast ? ', при этом в сессии было окно «shared»' : ''} — заливка не прошла`;
        console.log('  ⚠ ' + err);
      } else {
        finalStatus = 'ambiguous';
        err = `Share нажат, исход не определён: ленту снаружи прочитать не удалось (${(outside.feed || {}).why || 'нет ответа'}) — досверит postreconcile.cjs`;
        console.log('  ⚠ ' + err);
      }
      // РАЗБОР ПО СЕТИ. Пост не подтвердился, значит печатаем всю сетевую историю заливки:
      // по ней видно, доехал ли файл (rupload) и чем ответил IG на попытку собрать пост (configure).
      console.log(`  🕸 сетевая история заливки (${NET.length} записей):`);
      for (const e of NET) console.log(`    ${e.t} ${e.m} ${e.st || 'ОБРЫВ:' + (e.fail || '?')} ${e.u}${e.body && (!e.st || e.st >= 400) ? ' | ' + String(e.body).slice(0, 120) : ''}`);
      if (shareError) console.log(`  🕸 плюс экранная ошибка IG после Share: «${shareError}»`);
    }

    // ЗАМКНУТЬ КРУГ КУК: пересохраняем свежую сессию в БД (только подтверждённо залогиненную).
    try {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) {
        await c.query(`UPDATE accounts SET ig_cookies=$2 WHERE id=$1`, [row.aid, JSON.stringify(fresh)]);
        console.log(`  🔄 куки пересохранены в БД (${fresh.length})`);
      }
    } catch (e) { console.log('  ⚠ куки не пересохранились:', String(e.message).slice(0, 60)); }

    await b.close().catch(() => {});
  } catch (e) {
    err = String(e.message).slice(0, 250);
    // До post_submitted — в очередь (ретрай безопасен). После — ТОЛЬКО ambiguous: Share мог сработать.
    finalStatus = submitted ? 'ambiguous' : null;
    if (submitted) err = 'после клика Share: ' + err;
  }

  // ЗАПИСЬ ИСХОДА — САМОЕ ХРУПКОЕ МЕСТО ВСЕГО ПРОГОНА (06.08). Ролик уже в ленте, а знание об
  // этом живёт в одной переменной в памяти: не доехало до базы — и материал считается незалитым,
  // после чего его зальют повторно. Поэтому пишем с ретраями, а если база так и не приняла,
  // кладём улику на диск: postreconcile.cjs подберёт её и допишет ссылку.
  if (finalStatus) {
    let saved = false;
    for (let t = 1; t <= 4 && !saved; t++) {
      try {
        await c.query(`UPDATE posts SET status=$2, published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,
            external_url=coalesce($3,external_url), error=$4 WHERE id=$1`, [row.id, finalStatus, postUrl, err]);
        saved = true;
      } catch (e) {
        console.log(`  ⚠ исход не записался в базу (попытка ${t}/4): ${String(e.message).slice(0, 80)}`);
        await sleep(3000 * t);
      }
    }
    if (!saved) {
      try {
        const dir = '/tmp/igpost2_unsaved'; fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/${row.id}.json`, JSON.stringify(
          { post_id: row.id, slug: SLUG, handle: row.h, status: finalStatus, external_url: postUrl, error: err, at: new Date().toISOString() }, null, 1));
        console.log(`  💾 база недоступна — исход сохранён в ${dir}/${row.id}.json (подберёт postreconcile.cjs)`);
      } catch (e) { console.log('  ⛔ исход не сохранён НИГДЕ: ' + String(e.message).slice(0, 80)); }
    }
  } else if (err) {
    await backToQueue(err);
  }
  // СТРАХОВКА ОТ ДУБЛЯ В ЛЕНТЕ (06.08). Кейс darya.smirnova13: заливка прошла, но исход не
  // записался, ретрай залил тот же пост второй раз, и в ленте повисли два одинаковых кадра.
  // Для Instagram это дубликат: с 30.04.2026 такой контент выпадает из рекомендаций. Поэтому
  // если Share уже нажимали, а статус почему-то остался «в очереди», фиксируем ambiguous:
  // человек посмотрит, а робот повторно не польёт.
  try {
    const st = (await c.query(`SELECT status, post_submitted FROM posts WHERE id=$1`, [row.id])).rows[0];
    if (st && st.post_submitted && ['approved', 'publishing', 'backlog'].includes(st.status)) {
      await c.query(`UPDATE posts SET status='ambiguous',
        error=coalesce(error,'') || ' | Share нажат, исход не записался: ретрай запрещён' WHERE id=$1`, [row.id]);
      console.log('  🛡 исход не записался, но Share нажимали — пост помечен ambiguous, дубля не будет');
    }
  } catch {}
  try { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch {}
  const итог = finalStatus === 'published' ? `✅ опубликовано → ${postUrl}` : finalStatus === 'ambiguous' ? `⚠ ambiguous: ${err}` : `✗ не вышло: ${err}`;
  console.log(`ИТОГ: ${итог}`);
  await tg(`🎬 Постер v2 «${row.persona}» @${row.h}: ${итог}`);
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
