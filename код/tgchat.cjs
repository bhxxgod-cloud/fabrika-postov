// ДВУСТОРОННИЙ ЧАТ С НАЧАЛЬНИКОМ ЧЕРЕЗ ТЕЛЕГРАМ (09.08, приказ: «сделай считывание чата, чтобы я
// там мог ещё отвечать, очень важно, мне нужно общаться с тобой через тг, где бот, а ты читал и
// отвечал тут»).
//
// ЗАЧЕМ ИМЕННО ТАК. tgsend.cjs умеет только слать. Обратного канала не было: начальник писал боту,
// а я этого не видел. Здесь три режима, и все три без вебхука, чтобы не отбирать бота у других
// скриптов и не поднимать сервер:
//   pull   — забрать всё новое и уйти (быстрый разовый съём);
//   watch  — долгий опрос, ЖДЁТ первое сообщение и выходит с ним (на это вешается фоновый сторож,
//            и когда сообщение приходит, я просыпаюсь и отвечаю);
//   send   — ответить в тот же чат, откуда пришло последнее сообщение, или в указанный.
//
// СМЕЩЕНИЕ (offset) храним на диске: телеграм отдаёт обновление повторно, пока его не подтвердили,
// поэтому без файла состояния одно и то же сообщение читалось бы вечно. Подтверждаем ТОЛЬКО после
// того, как записали сообщение в журнал, иначе при падении письмо начальника потерялось бы молча.
//
// Запуск:
//   node tgchat.cjs pull
//   node tgchat.cjs watch 300
//   node tgchat.cjs send "текст"            (в чат последнего сообщения)
//   node tgchat.cjs send --chat <id> "текст"
'use strict';
const fs = require('node:fs');

// ОТДЕЛЬНЫЙ БОТ ДЛЯ МОСТА (09.08). Первый бот (xmoneyforporsche_bot) занят: его обновления уже
// забирает серверный сервис, а телеграм запрещает двум опросчикам сидеть на одном боте и отвечает
// «Conflict: terminated by other getUpdates request». Если бы я всё равно подтверждал обновления,
// серверный бот молча терял бы нажатия своих кнопок. Поэтому начальник завёл второго бота
// (claudex057_bot), его токен лежит в /tmp/.tgtok2 и берётся ПЕРВЫМ.
const TOKEN = (process.env.TG_BRIDGE_TOKEN || safeRead('/tmp/.tgtok2') || safeRead('/tmp/.tgtok')).trim();
const STATE = '/tmp/tg_chat_state.json';
const INBOX = '/tmp/tg_inbox.md';
const QUEUE = '/tmp/tg_queue.md';   // сюда демон кладёт то, что адресовано мне, это мой будильник
// МОСТОВЫХ ЧАТОВ МОЖЕТ БЫТЬ НЕСКОЛЬКО (13.08, приказ «подключи другой чат в тг мой»).
// Было ровно одно значение, и вторая группа начальника молча становилась «разговором рядом»:
// сообщения оттуда падали в журнал, но в мою очередь не попадали, и я их не видел — ровно та же
// потеря, из-за которой 09.08 переписали правило «всё, что пришло в мостовой чат, адресовано мне».
// Список через запятую: REVIEW_CHAT=-5504101321,-5502363795.
const BRIDGE = String(process.env.REVIEW_CHAT || '-5502363795').split(',').map((s) => s.trim()).filter(Boolean);
const FILES = `${process.env.HOME}/Desktop/ТГ-файлы`;               // сюда качаю присланные файлы

// СЛЕШ-КОМАНДЫ (приказ: «сделай, чтобы я мог по какому-то слешу к тебе обратиться и ты знал, что
// это запрос в чате к тебе»). Нужны по двум причинам: в группе бот с включённым privacy видит
// только команды, и мне нужен явный признак «это обращение ко мне», а не разговор рядом.
const CMDS = [
  { command: 'q', description: 'вопрос или задача мне' },
  { command: 'task', description: 'поставить задачу в работу' },
  { command: 'status', description: 'что сейчас идёт и где стоит' },
  { command: 'stop', description: 'остановить то, что я делаю' },
];

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function state() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { offset: 0, lastChat: null }; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); }
async function api(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

// Из обновления вытаскиваем только то, что нужно человеку: кто, где, когда, что.
function pick(u) {
  const m = u.message || u.edited_message || u.channel_post;
  if (!m) return null;
  const who = m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') + (m.from.username ? ` (@${m.from.username})` : '') : 'канал';
  const kind = m.text ? 'текст' : m.photo ? 'фото' : m.video ? 'видео' : m.document ? 'файл' : m.voice ? 'голосовое' : 'другое';
  const raw = m.text || m.caption || '';
  // Разбираем слеш-команду. В группе имя бота приклеивается через собаку (/q@claudex057_bot),
  // поэтому отрезаем и его, иначе команда не распознается и сообщение уйдёт как обычный текст.
  const cm = raw.match(/^\/([A-Za-z_]+)(?:@\S+)?\s*([\s\S]*)$/);
  const cmd = cm ? cm[1].toLowerCase() : '';
  const body = cm ? cm[2].trim() : raw;
  // БЕЛЫЙ СПИСОК АВТОРОВ (правка 09.08, вопрос начальника про права в группе).
  // Опасность: бот получает сообщения из ЛЮБОГО чата, куда его добавили, и от ЛЮБОГО участника.
  // Значит любой, кого добавили в группу, или кто нашёл бота в личке, мог бы командовать мной от
  // чужого имени: попросить файлы, ключи, «скачай с компьютера». Поэтому распоряжения принимаю
  // ТОЛЬКО от начальника по его telegram id. Остальное пишется в журнал как чужая речь и в мою
  // очередь на исполнение НЕ попадает.
  const OWNER = String(process.env.TG_OWNER_ID || '1940570381');
  const свой = m.from && String(m.from.id) === OWNER;

  // ВСЁ, ЧТО ПРИШЛО В МОСТОВОЙ ЧАТ, АДРЕСОВАНО МНЕ (правка 09.08 по факту потери сообщений).
  // Было: обращением считались только слеш-команда, реплай и личка. После того как начальник снял
  // приватность у бота, обычные сообщения стали доходить, но в мою очередь не попадали, и я
  // молча пропустил два важных вопроса. Мостовой чат создан только для нас двоих, поэтому здесь
  // любое сообщение это обращение.
  const мне = свой && (BRIDGE.includes(String(m.chat.id)) || m.chat.type === 'private' || !!cmd || !!m.reply_to_message);
  return {
    id: u.update_id, chat: m.chat.id, тип_чата: m.chat.type, кто: who, вид: kind,
    время: new Date(m.date * 1000).toISOString().replace('T', ' ').slice(0, 19),
    команда: cmd, мне, свой, текст: body, сырое: raw,
  };
}

// Вердикт начальника пишем в meta поста. Причину дописываем отдельным полем, чтобы нажатие и
// объяснение не перетирали друг друга: сначала прилетает кнопка, потом текст.
async function saveVerdict(short, verdict, why) {
  const url = (process.env.DB_PUBLIC_URL || safeRead('/tmp/dburl.txt')).trim();
  if (!url) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  const patch = { at: new Date().toISOString() };
  if (verdict) patch.verdict = verdict;
  if (why) patch.why = why;
  await c.query(
    `UPDATE posts SET meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{owner_verdict}',
        coalesce(meta->'owner_verdict','{}'::jsonb) || $2::jsonb, true)
      WHERE left(id::text,8) = $1`, [short, JSON.stringify(patch)]);
  await c.end().catch(() => {});
}

function log(msgs) {
  if (!msgs.length) return;
  const lines = msgs.map((m) => `\n### ${m.время} · ${m.кто} · чат ${m.chat} (${m.тип_чата}) · ${m.вид}${m.команда ? ` · /${m.команда}` : ''}${m.мне ? ' · МНЕ' : ''}\n${m.текст || '(без текста)'}\n`);
  fs.appendFileSync(INBOX, lines.join(''));
}

(async () => {
  if (!TOKEN) { console.error('нет токена: положи его в /tmp/.tgtok или в TELEGRAM_BOT_TOKEN'); process.exit(1); }
  const mode = process.argv[2] || 'pull';
  const s = state();

  // Одноразовая настройка: показать боту список команд, чтобы в телеграме была подсказка по слешу.
  if (mode === 'setup') {
    await api('setMyCommands', { commands: CMDS });
    const me = await api('getMe', {});
    console.log(`бот @${me.username} готов, команды: ${CMDS.map((c) => '/' + c.command).join(' ')}`);
    return;
  }

  if (mode === 'send') {
    let rest = process.argv.slice(3);
    let chat = s.lastChat;
    if (rest[0] === '--chat') { chat = rest[1]; rest = rest.slice(2); }
    // Дублирование моих ответов в чат (приказ 09.08: «мне нужно, чтобы ты дублировал мысли в чат тг,
    // все твои сообщения идут сейчас в чат тг»). Через файл, потому что длинный текст с переносами
    // в аргументах командной строки ломается, а ответы у меня длинные.
    let text;
    if (rest[0] === '--file') {
      text = fs.readFileSync(rest[1], 'utf8');
      if (!chat) chat = BRIDGE[0];
    } else {
      text = rest.join(' ');
    }
    // Телеграм рубит сообщения длиннее 4096 символов, поэтому длинный ответ режу по абзацам.
    if (text && text.length > 3900) {
      const parts = []; let buf = '';
      for (const para of text.split('\n\n')) {
        if ((buf + '\n\n' + para).length > 3900) { parts.push(buf); buf = para; } else buf = buf ? buf + '\n\n' + para : para;
      }
      if (buf) parts.push(buf);
      for (const [i, p] of parts.entries()) {
        await api('sendMessage', { chat_id: chat, text: parts.length > 1 ? `(${i + 1}/${parts.length})\n${p}` : p, disable_web_page_preview: true });
      }
      console.log(`отправлено в чат ${chat}: ${parts.length} частей, ${text.length} символов`);
      return;
    }
    if (!chat) { console.error('не знаю, куда отвечать: сперва прочитай сообщение (pull или watch) либо укажи --chat <id>'); process.exit(1); }
    if (!text) { console.error('пустой текст'); process.exit(1); }
    await api('sendMessage', { chat_id: chat, text, disable_web_page_preview: true });
    console.log(`отправлено в чат ${chat}: ${text.slice(0, 80)}`);
    return;
  }

  // Долгий опрос: телеграм сам держит соединение до timeout секунд, лишнего трафика нет.
  const waitSec = Math.min(Number(process.argv[3] || (mode === 'watch' ? 300 : 0)) || 0, 3000);
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const timeout = mode === 'watch' ? Math.min(50, left || 1) : 0;
    // СЕТЬ РВЁТСЯ, И ЭТО НОРМА. Раньше сторож умирал на первом же «fetch failed» и сообщения
    // начальника ждали, пока я его подниму руками. Теперь сетевую ошибку просто пережидаем:
    // выходим ТОЛЬКО когда пришло сообщение или кончилось окно ожидания.
    let ups;
    try {
      ups = await api('getUpdates', { offset: s.offset || undefined, timeout, allowed_updates: ['message', 'edited_message', 'callback_query'] });
    } catch (e) {
      if (mode !== 'watch') throw e;
      console.error(`сеть подвела (${e.message}), жду 10 секунд и повторяю`);
      await new Promise((r) => setTimeout(r, 10_000));
      if (Date.now() >= deadline) { console.log('окно ожидания вышло'); return; }
      continue;
    }
    // НАЖАТИЯ КНОПОК АПРУВА. Обрабатываем ЗДЕСЬ же, а не отдельным демоном: опросчик у бота может
    // быть только один, второй получит Conflict. Вердикт кладём в posts.meta.owner_verdict, чтобы
    // решение начальника жило в базе рядом с постом, а не терялось в переписке.
    const cbs = ups.map((u) => u.callback_query).filter(Boolean);
    for (const cb of cbs) {
      // Нажатия принимаем тоже ТОЛЬКО от начальника: иначе любой участник группы мог бы ставить
      // вердикты по постам и путать нам отдел качества.
      if (String((cb.from || {}).id) !== String(process.env.TG_OWNER_ID || '1940570381')) {
        try { await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'кнопки только для владельца' }); } catch {}
        continue;
      }
      const [, verdict, short] = (cb.data || '').split(':');
      const label = verdict === 'top' ? 'топ' : verdict === 'bad' ? 'хуйня' : 'жду причину';
      try {
        if (verdict === 'why') {
          await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'напиши причину ответом на это сообщение' });
          await api('sendMessage', {
            chat_id: cb.message.chat.id, text: `почему по посту ${short}? ответь на это сообщение`,
            reply_markup: { force_reply: true, input_field_placeholder: `причина по ${short}` },
          });
        } else {
          await api('answerCallbackQuery', { callback_query_id: cb.id, text: `принял: ${label}` });
          await saveVerdict(short, verdict, '');
          await api('editMessageReplyMarkup', {
            chat_id: cb.message.chat.id, message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: verdict === 'top' ? '✅ отмечено: топ' : '✅ отмечено: хуйня', callback_data: 'noop' }]] },
          });
        }
        fs.appendFileSync(INBOX, `\n### ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · КНОПКА · пост ${short} · ${label}\n`);
        console.log(`кнопка: пост ${short} = ${label}`);
      } catch (e) { console.error('кнопка не обработалась:', e.message); }
    }
    const msgs = ups.map(pick).filter(Boolean);
    // Ответ на приглашение «напиши причину» это фидбек по конкретному посту: вытаскиваем id из
    // текста того сообщения, на которое отвечают, и дописываем причину к вердикту.
    for (const u of ups) {
      const mm = u.message;
      const parent = mm && mm.reply_to_message && (mm.reply_to_message.text || '');
      const hit = parent && parent.match(/почему по посту ([0-9a-f]{8})/);
      if (hit && mm.text) {
        await saveVerdict(hit[1], null, mm.text.trim());
        await api('sendMessage', { chat_id: mm.chat.id, text: `записал причину по ${hit[1]}, поставил в работу` });
        fs.appendFileSync('/tmp/tg_tasks.md', `\n- пост ${hit[1]}: ${mm.text.trim()}\n`);
      }
    }
    if (msgs.length) {
      log(msgs);
      s.offset = ups[ups.length - 1].update_id + 1;
      s.lastChat = msgs[msgs.length - 1].chat;
      saveState(s);
      for (const m of msgs) console.log(`[${m.время}] ${m.кто} · чат ${m.chat} · ${m.вид}: ${m.текст || '(без текста)'}`);
      console.log(`\nвсего новых: ${msgs.length}, журнал: ${INBOX}`);
      // ОЧЕРЕДЬ ДЛЯ МЕНЯ. Демон работает круглосуточно и сам никогда не выходит, поэтому разбудить
      // меня он может только через файл: складываю сюда всё, что адресовано мне, а отдельный
      // сторож файла (обычный bash, без телеграма, значит без конфликта опросчиков) видит рост
      // файла и завершается, и это будит меня.
      // ФАЙЛЫ КАЧАЕМ СРАЗУ. Начальник прислал файл со сотней аккаунтов, а я его потерял: демон
      // подтвердил обновление, file_id ушёл вместе с ним, и скачать стало нечем. Теперь документ
      // забираем в момент чтения и кладём путь в очередь.
      for (const u of ups) {
        const mm = u.message; const doc = mm && mm.document;
        if (!doc) continue;
        try {
          const f = await api('getFile', { file_id: doc.file_id });
          const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
          const buf = Buffer.from(await r.arrayBuffer());
          fs.mkdirSync(FILES, { recursive: true });
          const dest = `${FILES}/${doc.file_name || ('file_' + doc.file_unique_id)}`;
          fs.writeFileSync(dest, buf);
          fs.appendFileSync(QUEUE, `ФАЙЛ ПРИШЁЛ: ${dest} (${buf.length} байт)\n`);
          console.log(`скачал файл: ${dest} (${buf.length} байт)`);
        } catch (e) { console.error('файл не скачался:', e.message); }
      }
      const forMe = msgs.filter((m) => m.мне);
      if (forMe.length) {
        fs.appendFileSync(QUEUE, forMe.map((m) => `[${m.время}] ${m.кто}${m.команда ? ' /' + m.команда : ''}: ${m.текст || '(пусто)'}\n`).join(''));
      }
      if (mode !== 'daemon') return;
      continue;
    }
    if (mode === 'daemon') continue;
    if (mode !== 'watch' || Date.now() >= deadline) { console.log('новых сообщений нет'); return; }
  }
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
