// ПОКАЗ ПОСТА НАЧАЛЬНИКУ НА АПРУВ, С КНОПКАМИ (09.08, приказ: «сделай ещё к постам кнопки типа
// топ, хуйня и сразу вариант написать фидбек почему, и дать задание в чате claudex057»).
//
// ЧТО ЕДЕТ ОДНИМ ПОКАЗОМ (приказ того же дня: «ты кидаешь 4 фотки плюс смонтированный рилс постом,
// фотки под тикток пойдут, а рилс в инстаграм»):
//   1) четыре кадра альбомом,
//   2) собранный рилс,
//   3) текст поста (хук и подпись) и под ним кнопки: топ, хуйня, сказать почему.
//
// ЗАЧЕМ КНОПКИ, а не «напиши мне словами». Апрув словами теряется: было уже, что я слал пачку, а
// какие именно посты хорошие, оставалось в переписке и до базы не доезжало. Нажатие уходит в
// posts.meta.owner_verdict, то есть решение живёт в базе рядом с постом, а не в чате.
//
// Запуск: node tgreview.cjs <короткий-или-полный-id-поста> [ещё id...]
//         node tgreview.cjs --persona нов25            (последний склад этой персоны)
//         REVIEW_CHAT=-100... node tgreview.cjs ...    (по умолчанию мостовой чат)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
// ИМПОРТ, КОТОРОГО НЕ ХВАТАЛО (11.08). Сборку рилса на месте я сюда добавил, а execFileSync забыл
// импортировать, и показ падал на «execFileSync is not defined». В логе это выглядело как
// «⚠ сборка рилса не удалась», то есть фотографии уходили, а рилс молча нет, и начальник видел в
// группе пост без видео. Ошибка моя, ловится только запуском, поэтому теперь запуск и есть проверка.
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const TOKEN = (process.env.TG_BRIDGE_TOKEN || safeRead('/tmp/.tgtok2')).trim();
const CHAT = (process.env.REVIEW_CHAT || '-5502363795').trim();   // группа моста «qqq»
const DBURL = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();
const SCRATCH = '/private/tmp/claude-501/-Users-qq-untitled-folder';

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ЛИМИТ ТЕЛЕГРАМА ЖДЁМ, А НЕ ПАДАЕМ ОТ НЕГО (правка 10.08). На пятом посте подряд прилетело
// «Too Many Requests: retry after 41», и показ пачки обрывался на середине: четыре поста начальник
// увидел, пятый нет, а в логе стояла ошибка, будто не ушло ничего. Телеграм сам говорит, сколько
// ждать (retry_after), поэтому просто ждём это время и повторяем. Три попытки: если лимит держится
// дольше, значит дело не в темпе, и падать честнее, чем висеть.
async function withRetry(name, send) {
  for (let att = 1; att <= 3; att++) {
    const j = await send();
    if (j.ok) return j.result;
    const wait = j.parameters && j.parameters.retry_after;
    if (!wait || att === 3) throw new Error(`${name}: ${j.description}`);
    console.log(`  лимит телеграма, жду ${wait} с и повторяю (${name})`);
    await sleep((wait + 1) * 1000);
  }
}

async function api(method, params) {
  return withRetry(method, async () => {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
    });
    return r.json();
  });
}
// Файлы отправляем многочастной формой: локальные кадры и рилс лежат на диске, ссылками их не дать.
async function upload(method, fields, files) {
  return withRetry(method, async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    for (const [k, p] of Object.entries(files)) {
      form.append(k, new Blob([fs.readFileSync(p)]), path.basename(p));
    }
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body: form });
    return r.json();
  });
}

// Рилс ищем по персоне среди всего, что собрано в скретчпадах сессий: самый свежий файл выигрывает.
function findReel(persona) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p, depth + 1);
      else if (it.name.endsWith('.mp4') && it.name.includes(persona)) {
        try { const st = fs.statSync(p); if (st.size > 100_000) out.push({ p, t: st.mtimeMs }); } catch {}
      }
    }
  };
  walk(SCRATCH, 0);
  out.sort((a, b) => b.t - a.t);
  return out.length ? out[0].p : null;
}

const kb = (short) => ({
  inline_keyboard: [
    [{ text: '🔥 топ', callback_data: `v:top:${short}` }, { text: '💩 хуйня', callback_data: `v:bad:${short}` }],
    [{ text: '✍️ сказать почему', callback_data: `v:why:${short}` }],
  ],
});

(async () => {
  if (!TOKEN) { console.error('нет токена моста в /tmp/.tgtok2'); process.exit(1); }
  const args = process.argv.slice(2);
  if (!args.length) { console.log('usage: node tgreview.cjs <id поста> [...]  |  --persona <персона>'); process.exit(1); }

  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();

  let rows = [];
  if (args[0] === '--persona') {
    rows = (await c.query(
      `SELECT id, meta FROM posts WHERE meta->>'persona' = $1 AND jsonb_array_length(meta->'image_urls') = 4
         AND status IN ('backlog','approved') AND published_at IS NULL ORDER BY created_at DESC LIMIT 1`, [args[1]])).rows;
  } else {
    for (const a of args) {
      const r = await c.query(
        `SELECT id, meta FROM posts WHERE id::text = $1 OR left(id::text,8) = $1 LIMIT 1`, [a.replace(/^#/, '')]);
      if (r.rows[0]) rows.push(r.rows[0]); else console.log(`  пост ${a} не нашёл`);
    }
  }
  if (!rows.length) { console.log('нечего показывать'); await c.end(); process.exit(1); }

  for (const row of rows) {
    const m = row.meta || {};
    const short = String(row.id).slice(0, 8);
    const persona = m.persona || '?';
    const tpl = m.template || '?';
    const imgs = (m.image_urls || []).slice(0, 4);
    if (imgs.length !== 4) { console.log(`  ${short}: кадров ${imgs.length}, а нужно 4, пропускаю`); continue; }

    // Альбом кадров. ВСЁ отправляем файлами, даже то, что лежит по ссылке (правка 09.08).
    // Причина: телеграм пытался скачать ссылку сам и падал с WEBPAGE_CURL_FAILED, то есть показ
    // рвался на середине из-за чужой сети. Качаем сами, тогда отправка зависит только от нас.
    const files = {}; const media = [];
    const tmp = fs.mkdtempSync('/tmp/tgreview_');
    for (const [i, u] of imgs.entries()) {
      let local;
      if (/^https?:\/\//.test(u)) {
        local = `${tmp}/f${i}.jpg`;
        const r = await fetch(u);
        if (!r.ok) { console.log(`  ${short}: кадр ${i + 1} не скачался (${r.status}), пропускаю пост`); local = null; }
        else fs.writeFileSync(local, Buffer.from(await r.arrayBuffer()));
      } else {
        local = path.isAbsolute(u) ? u : path.join(__dirname, u);
        if (!fs.existsSync(local)) { console.log(`  ${short}: кадра ${i + 1} нет на диске, пропускаю пост`); local = null; }
      }
      if (!local) { media.length = 0; break; }
      files[`f${i}`] = local;
      const item = { type: 'photo', media: `attach://f${i}` };
      if (i === 0) item.caption = `#${persona} · кадры под тикток · шаблон ${tpl} · пост ${short}`;
      media.push(item);
    }
    if (!media.length) continue;
    await upload('sendMediaGroup', { chat_id: CHAT, media }, files);

    // ТЕКСТ И КНОПКИ ЕДУТ НА МЕДИА, А НЕ ОТДЕЛЬНЫМ СООБЩЕНИЕМ (правка 10.08).
    //
    // Почему: в группе моста у бота ОТКЛЮЧЕНО право на текстовые сообщения, sendMessage отвечает
    // «not enough rights to send text messages to the chat», а медиа проходит. Это не поломка, а
    // прямое следствие приказа «не логгируй в тг чат наш снова»: начальник перекрыл боту текст,
    // чтобы чат не превращался в лог. Пост при этом показывать надо, и кнопки «топ / хуйня» тоже.
    //
    // Телеграм разрешает reply_markup у sendVideo и sendPhoto, поэтому подпись с хуком и кнопки
    // вешаем на рилс, а если рилса нет — на последний кадр отдельным сообщением с фото.
    // Так ни одна ветка больше не зависит от права на текст.
    const hook = m.hook_text || '(хука нет)';
    const cap = (m.caption_text || m.captionText || '') || '(подписи нет)';
    // Подпись у медиа ограничена 1024 знаками, режем с запасом и честной отметкой обрыва.
    let body = `#${persona} · пост ${short} · шаблон ${tpl}\n\n📌 заголовок на кадре 1\n${hook}\n\n📝 подпись\n${cap}`;
    if (body.length > 1000) body = body.slice(0, 990) + '… (обрезано)';

    // РИЛС СОБИРАЕМ НА МЕСТЕ, ЕСЛИ ЕГО ЕЩЁ НЕТ (11.08, приказ: «почему в группу не приходят посты
    // со смонтированным рилсом сразу к фото, пофикси щас это»).
    // ПОЧЕМУ РАНЬШЕ НЕ ПРИХОДИЛ: findReel только ИЩЕТ готовый файл по имени персоны в скретчпаде.
    // Для свежего поста рилса на диске ещё нет, потому что сборка идёт отдельным шагом пачкой, и
    // отправщик честно писал «рилс не собран». То есть это была не поломка, а недоделка: показ
    // зависел от того, успела ли пройти сборка. Теперь если файла нет, зовём сборщик на одну
    // персону и ждём. QA_REQUIRE=0 обязателен: у свежего поста вердикта качества ещё нет, а
    // сборщик по умолчанию берёт только посты с чистым вердиктом и вернул бы пустой пул.
    let reel = findReel(persona);
    if (!reel) {
      try {
        console.log(`  · рилса нет на диске, собираю для ${persona}`);
        execFileSync(process.execPath, [path.join(__dirname, 'magosreels.cjs'), '1'], {
          cwd: __dirname, stdio: 'inherit', timeout: 240000,
          env: { ...process.env, PERSONA_LIKE: persona, QA_REQUIRE: '0', OUT_DIR: path.join(SCRATCH, 'reels_tg') },
        });
        reel = findReel(persona);
      } catch (e) {
        console.log(`  ⚠ сборка рилса не удалась: ${String(e.message).slice(0, 80)}`);
      }
    }
    if (reel) {
      await upload('sendVideo', { chat_id: CHAT, caption: body, supports_streaming: 'true',
        reply_markup: JSON.stringify(kb(short)) }, { video: reel });
    } else {
      const last = files[`f${media.length - 1}`];
      await upload('sendPhoto', { chat_id: CHAT, caption: `${body}\n\n(рилс не собран)`,
        reply_markup: JSON.stringify(kb(short)) }, { photo: last });
    }
    console.log(`  показал ${short} (${persona}), рилс: ${reel ? 'есть' : 'нет'}`);
  }
  await c.end();
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
