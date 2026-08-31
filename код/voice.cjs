// Озвучка для постов и рилсов.
//
// ДВА ПОСТАВЩИКА ЗА ОДНИМ ИНТЕРФЕЙСОМ, и это не архитектурное украшательство.
// Сегодня работает neironka.pro: там ElevenLabs, русский проверен на проде и
// баланс свой. Но авторизация у него СЕССИОННОЙ КУКОЙ, а кука протухает молча,
// и в этот момент конвейер встанет с 401 без внятной причины. Поэтому:
//   • голос зовётся через одну функцию, поставщик выбирается переменной;
//   • живость проверяется НА СТАРТЕ, а не в середине пачки;
//   • когда появится свой ключ fal.ai (там тот же ElevenLabs, но по токену,
//     и вдобавок генерация звуковых эффектов), меняется одна переменная.
//
// ГОЛОС ПРИВЯЗАН К КАНАЛУ, А НЕ К ПОСТУ. Один и тот же голос на разных
// аккаунтах это отпечаток, связывающий их между собой: у нас ферма, и аккаунты
// не должны выглядеть роднёй. Отсюда карта ГОЛОСА ниже: своя группа аккаунтов,
// свой voice_id.
//
// ЦЕНА. Считается округлением ВВЕРХ до 1000 знаков, минимум одна единица. Фраза
// озвучки это 50-80 знаков, то есть каждая стоит как целая тысяча. Значит
// озвучки надо ЗАКАЗЫВАТЬ ПАЧКОЙ И ПЕРЕИСПОЛЬЗОВАТЬ, а не генерировать под
// каждый пост: текст у нас типовой («гружу свою фотку», «вот что получилось»),
// лицо к нему не привязано.
const fs = require('fs');
const path = require('path');
const os = require('os');

const БАЗА = 'https://neironka.pro';
const ПАПКА_КУК = path.join(os.homedir(), '.neironka', 'secrets', 'admin_cookie.txt');

/** Модели и цена за 1000 знаков, в рублях с баланса сайта. */
const МОДЕЛИ = {
  'eleven-turbo-2-5': 10,       // дешевле всех, годится для типовых фраз
  'fish-audio': 12,
  'qwen-tts': 16,
  'eleven-multilingual-2': 18,
  'my-voice': 19,               // клон своего голоса
  'eleven-v3': 20,              // максимум эмоций, для хуков
};

/**
 * Голоса по группам аккаунтов. НЕ смешивать между группами: общий голос выдаёт
 * родство аккаунтов. Id настоящие, из каталога ElevenLabs на сайте.
 */
/**
 * Каталог НЕскрытых женских голосов: id → подпись. Лежит в файле рядом, чтобы
 * пополнять его без правки кода.
 *
 * ГРАБЛИ, НА КОТОРЫЕ УЖЕ НАСТУПИЛИ. В каталоге сайта скрытые голоса
 * (hidden:true) лежат вперемешку с рабочими, и вдобавок голос ПРИВЯЗАН К
 * МОДЕЛИ. Взяли id с пометкой «женский» из общего списка, скормили модели
 * turbo, и на выходе получили МУЖСКОЙ голос. Поэтому здесь только незакрытые,
 * а перед вводом голоса в оборот его надо послушать.
 */
const КАТАЛОГ = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'голоса-женские.json'), 'utf8'));
  } catch { return {}; }
})();

/**
 * Голоса, закреплённые за группами аккаунтов. Заполняется ПОСЛЕ прослушивания.
 *
 * Один голос на разных аккаунтах это отпечаток, связывающий их между собой: у
 * нас ферма, и аккаунты не должны выглядеть роднёй. Поэтому у каждой группы
 * свой, и менять их местами нельзя.
 */
const ГОЛОСА = {};

/** Найти id по имени из каталога: голосПоИмени('Настя'). */
function голосПоИмени(имя) {
  const н = String(имя).toLowerCase();
  for (const [id, подпись] of Object.entries(КАТАЛОГ)) {
    if (String(подпись).toLowerCase().startsWith(н)) return id;
  }
  return null;
}

// ── fal.ai ──────────────────────────────────────────────────────────────────
// Второй поставщик. Тот же ElevenLabs, но по ТОКЕНУ, а не по сессионной куке:
// ничего не протухает молча посреди пачки. Плюс там же живёт генерация звуковых
// эффектов, которая нужна для фонового звука клавиатуры и кафе.
//
// ВАЖНО ПРО ДЕНЬГИ: ключ принадлежит аккаунту desarro77llo@gmail.com, то есть
// расход идёт НЕ с баланса владельца. Это осознанное решение владельца.
//
// Отличия от neironka.pro, которые видно в коде:
//   • голос задаётся ИМЕНЕМ (Rachel, Alina), а не двадцатизначным id;
//   • параметра скорости нет вовсе, ускорение делаем ffmpeg-ом после;
//   • ответ синхронный, опрашивать очередь не нужно.
const ФАЙЛ_КЛЮЧА_FAL = path.join(os.homedir(), '.neironka', 'secrets', 'falkey.txt');
const FAL_МОДЕЛИ = {
  'eleven-v3': 'fal-ai/elevenlabs/tts/eleven-v3',
  'eleven-multilingual-2': 'fal-ai/elevenlabs/tts/multilingual-v2',
  'eleven-turbo-2-5': 'fal-ai/elevenlabs/tts/turbo-v2.5',
};

function ключFal() {
  return fs.readFileSync(ФАЙЛ_КЛЮЧА_FAL, 'utf8').trim();
}

/** Живость ключа. Бесплатно: просим временный токен, генерацию не заказываем. */
async function проверитьFal() {
  const r = await fetch('https://rest.alpha.fal.ai/tokens/', {
    method: 'POST',
    headers: { Authorization: `Key ${ключFal()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_apps: ['fal-ai/elevenlabs/tts/eleven-v3'], token_expiration: 60 }),
  });
  if (!r.ok) throw new Error(`ключ fal.ai не принят: ${r.status}`);
  return { живой: true };
}

/** Озвучка через fal.ai в файл. */
async function озвучитьFal(текст, файл, { модель = 'eleven-v3', голос = 'Rachel', стабильность = 0.5 } = {}) {
  const путь = FAL_МОДЕЛИ[модель] || FAL_МОДЕЛИ['eleven-v3'];
  const r = await fetch(`https://fal.run/${путь}`, {
    method: 'POST',
    headers: { Authorization: `Key ${ключFal()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(текст), voice: голос, stability: стабильность }),
  });
  if (!r.ok) throw new Error(`fal.ai отклонил заказ: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const url = d?.audio?.url || d?.audio_url || d?.url;
  if (!url) throw new Error('fal.ai не вернул ссылку на звук');
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (buf.length < 1000) throw new Error(`файл озвучки подозрительно мал: ${buf.length} байт`);
  fs.mkdirSync(path.dirname(файл), { recursive: true });
  fs.writeFileSync(файл, buf);
  return { файл, байт: buf.length };
}

function кука() {
  const raw = fs.readFileSync(ПАПКА_КУК, 'utf8').trim();
  const m = raw.match(/nf_session=[^;\s]+/);
  return m ? m[0] : `nf_session=${raw}`;
}

/**
 * Живость доступа. Зовётся ПЕРЕД пачкой, а не после первого отказа: протухшая
 * кука даёт 401 на каждом заказе, и без этой проверки мы узнаем о ней, потеряв
 * половину прогона.
 */
async function проверитьДоступ() {
  const r = await fetch(`${БАЗА}/api/account/balance`, { headers: { Cookie: кука() } });
  if (r.status === 401) throw new Error('кука neironka.pro протухла: обновить ~/.neironka/secrets/admin_cookie.txt');
  if (!r.ok) throw new Error(`neironka.pro отдал ${r.status}`);
  const d = await r.json();
  return { рублей: Math.round((d.balanceKopecks || 0) / 100) };
}

/** Заказать озвучку. Возвращает id задачи, файл забирается опросом. */
async function заказать(текст, { модель = 'eleven-multilingual-2', голос } = {}) {
  if (!текст || !String(текст).trim()) throw new Error('пустой текст озвучки');
  const r = await fetch(`${БАЗА}/api/generate/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: кука() },
    body: JSON.stringify({ kind: 'audio', slug: модель, prompt: String(текст), voice: голос }),
  });
  if (r.status === 401) throw new Error('кука протухла посреди работы');
  if (!r.ok) throw new Error(`заказ озвучки отклонён: ${r.status} ${await r.text().catch(() => '')}`);
  const d = await r.json();
  if (!d.id) throw new Error('сервер не вернул id задачи');
  return d.id;
}

/** Дождаться готовности и вернуть прямую ссылку на mp3. */
async function дождаться(id, { таймаутМс = 180_000, шагМс = 3000 } = {}) {
  const до = Date.now() + таймаутМс;
  while (Date.now() < до) {
    const r = await fetch(`${БАЗА}/api/generations?kind=audio&limit=20`, { headers: { Cookie: кука() } });
    if (r.ok) {
      const d = await r.json();
      const мой = (d.items || []).find((x) => x.id === id);
      if (мой?.status === 'done' && мой.result?.url) {
        return { url: мой.result.url, копеек: мой.costKopecks || 0 };
      }
      if (мой?.status === 'failed') throw new Error('озвучка не удалась на стороне сервиса');
    }
    await new Promise((s) => setTimeout(s, шагМс));
  }
  throw new Error(`озвучка не поспела за ${Math.round(таймаутМс / 1000)} с`);
}

/** Заказать и сразу скачать в файл. */
async function озвучить(текст, файл, opts = {}) {
  const id = await заказать(текст, opts);
  const { url, копеек } = await дождаться(id, opts);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (buf.length < 1000) throw new Error(`файл озвучки подозрительно мал: ${buf.length} байт`);
  fs.mkdirSync(path.dirname(файл), { recursive: true });
  fs.writeFileSync(файл, buf);
  return { файл, байт: buf.length, рублей: копеек / 100 };
}

/** Во что обойдётся пачка фраз. Округление вверх до 1000 знаков за фразу. */
function цена(фразы, модель = 'eleven-turbo-2-5') {
  const за1000 = МОДЕЛИ[модель] || 0;
  return фразы.reduce((с, ф) => с + Math.max(1, Math.ceil(String(ф).length / 1000)) * за1000, 0);
}

module.exports = { проверитьДоступ, заказать, дождаться, озвучить, цена, ГОЛОСА, КАТАЛОГ, голосПоИмени, МОДЕЛИ, проверитьFal, озвучитьFal, FAL_МОДЕЛИ };
