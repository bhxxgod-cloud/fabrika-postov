// Оповещения владельцу. Если заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID —
// шлём в Телеграм; иначе просто пишем в лог. Всё best-effort: доставка алерта
// никогда не должна ронять воркер.
import { logError } from './db/index.js';

// Антиспам: один и тот же текст алерта не чаще раза в час (мёртвая сессия иначе
// шлётся на каждый тик публикации).
const lastSent = new Map<string, number>();
const THROTTLE_MS = 60 * 60 * 1000;

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// КУРИРОВАННЫЕ УВЕДЫ (решение владельца 24.07): в ТГ шлём ТОЛЬКО 4 типа, остальное = шум → лишь в лог/БД.
//  1) новый пост у креатора  2) акк забанило/заблокировало  3) замена акка (авто-замена / подхват дежурного)
//  4) результат по посту (сколько комментов, какими акками). Всё прочее (искатель, «дежурный ответил N»,
//  паузы, прокси-чат) — молча в app_errors. Обход для отладки: NOTIFY_ALL=1. Проверка связи всегда проходит.
const ALERT_ALLOW: RegExp[] = [
  /🆕\s*Новый пост/i,                       // 1) креатор
  /♻️\s*Авто-замена|заблокир|забанил|🚫/i,   // 2) бан/блок + 3) авто-замена (снос блокнутых → завод замены)
  /🛡.*(просел|подхват|замен|на смену выйдет следующий)/i, // 3) подхват/замена в дежурных
  /Пост\s*#/i,                              // 4) результат по посту (📩 готово / ⚠️ не прошёл)
  /Проверка связи/i,                        // кнопка «тест» в панели — всегда доставляем
];
function alertAllowed(msg: string): boolean {
  if (/^(1|true|yes)$/i.test(String(process.env.NOTIFY_ALL || ''))) return true;
  return ALERT_ALLOW.some((re) => re.test(msg));
}

export async function notifyOwner(msg: string, opts: { force?: boolean } = {}): Promise<void> {
  console.warn(`[ALERT] ${msg}`);
  // ПЕРСИСТ: раньше алерт жил только в Телеграме и в коротких логах Railway — через час его было уже
  // не найти и не запросить («ты же затрекал?» — нет, не трекал). Теперь каждый алерт ложится в
  // app_errors и доступен SQL-запросом. Пишем ДО троттлинга: повторы тоже часть истории.
  void logError('alert', msg).catch(() => {});
  if (!alertAllowed(msg)) return; // не из 4 курируемых типов — только в лог/БД, в ТГ не шлём
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;

  if (!opts.force) {
    const now = Date.now();
    const prev = lastSent.get(msg) || 0;
    if (now - prev < THROTTLE_MS) return; // тот же алерт недавно уже уходил
    lastSent.set(msg, now);
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: `🤖 neironka-poster\n${msg}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[notify] телеграм ответил HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[notify] телеграм не доставлен: ${e instanceof Error ? e.message : e}`);
  }
}

// Сообщение с INLINE-КНОПКАМИ (callback). Кнопки: [{text, data}] — data ≤64 байта (кладём короткий код).
// Нажатие ловит startTelegramPoll (long-polling) и вызывает переданный обработчик.
export async function notifyWithButtons(msg: string, buttons: { text: string; data: string }[]): Promise<void> {
  console.warn(`[ALERT+btn] ${msg}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: `🤖 neironka-poster\n${msg}`,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[notify] кнопки: телеграм HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[notify] кнопки не доставлены: ${e instanceof Error ? e.message : e}`);
  }
}

// Ответить на нажатие (снять «часики» + опц. правка текста сообщения, чтобы было видно результат).
async function answerCallback(cbId: string, text: string, editMsg?: { chatId: number | string; messageId: number; newText: string }): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cbId, text }), signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
  if (editMsg) {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: editMsg.chatId, message_id: editMsg.messageId, text: editMsg.newText, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => {});
  }
}

// LONG-POLLING нажатий кнопок. Один воркер, поэтому offset держим в памяти. handler(data) возвращает
// короткий текст-подтверждение (тост в ТГ) — им отвечаем на нажатие. Только от нашего TELEGRAM_CHAT_ID.
export function startTelegramPoll(handler: (data: string) => Promise<string>): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = String(process.env.TELEGRAM_CHAT_ID || '');
  if (!token || !chat) { console.log('[notify] TG-поллинг выключен (нет токена/чата)'); return; }
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["callback_query"]`, { signal: AbortSignal.timeout(40_000) });
        const j = await res.json() as any;
        for (const u of (j.result || [])) {
          offset = u.update_id + 1;
          const cb = u.callback_query;
          if (!cb || String(cb.message?.chat?.id) !== chat) continue; // чужой чат — игнор
          let toast = 'ок';
          try { toast = await handler(String(cb.data || '')); } catch { toast = 'ошибка'; }
          await answerCallback(cb.id, toast, cb.message ? { chatId: cb.message.chat.id, messageId: cb.message.message_id, newText: (cb.message.text || '') + `\n\n➡️ ${toast}` } : undefined);
        }
      } catch { await new Promise((r) => setTimeout(r, 5_000)); } // сеть/таймаут — пауза и повтор
    }
  };
  void loop();
  console.log('[notify] TG-поллинг нажатий запущен');
}

// Отправить скрин (JPEG-буфер) с подписью — для присылки ошибок постинга.
export async function notifyPhoto(caption: string, photo: Buffer): Promise<void> {
  console.warn(`[ALERT photo] ${caption}`);
  // Сама картинка в БД не лезет (тяжело), но ПОДПИСЬ — самая ценная диагностика («что за экран») —
  // сохраняется, чтобы потом можно было собрать статистику типовых поломок запросом.
  void logError('alert-photo', caption).catch(() => {});
  if (!alertAllowed(caption)) return; // не из 4 курируемых типов — фото в ТГ не шлём (подпись уже в логе)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('caption', `🤖 neironka-poster\n${caption}`.slice(0, 1000));
    form.append('photo', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'error.jpg');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn(`[notify] sendPhoto HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[notify] фото не доставлено: ${e instanceof Error ? e.message : e}`);
  }
}
