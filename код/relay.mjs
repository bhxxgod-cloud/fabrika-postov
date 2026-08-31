// Переходник: слушаем в локальной сети БЕЗ пароля и уводим всё в ClickIP С паролем.
//
// Зачем: системная настройка http_proxy на Android умеет только host:port —
// поля для логина и пароля там нет вовсе. Поэтому пароль добавляем на нашей
// стороне, а телефону отдаём чистый адрес без авторизации.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { резать } from '/Users/qq/Desktop/НЕЙРОНКА/tapfarm/src/net/трафик-фильтр.mjs'

const [,, upstream, listenPort, kbitArg] = process.argv

// Ограничение полосы (кбит/с). TikTok сам подстраивает качество видео под
// доступную скорость, поэтому душить канал дешевле и надёжнее, чем лазить в
// настройки приложения: работает на любой плате и не требует ни одного тапа.
// ОГРАНИЧЕНИЕ ПОЛОСЫ ОТМЕНЕНО НАВСЕГДА — решение владельца 21.08.2026: «убери лимит
// вообще навсегда».
//
// История вопроса. Полосу душили ради экономии оплаченного резидентского трафика: тикток
// подстраивает качество под канал, и это казалось дешёвым способом. На деле это и было
// причиной «видео не грузятся», которую искали целый день.
//
// Замер, закрывший спор. Порт ClickIP напрямую отдаёт 3200 КБ/с. Через мост с потолком
// 6000 кбит — ровно 650, то есть упор в собственный потолок (6000 кбит = 750 КБ/с).
// После снятия: с ТЕЛЕФОНОВ 3.6 и 4.4 МБ/с. Владелец описал симптом точно: полоска
// загрузки под роликом не добегала.
//
// Экономить надо на мусоре (обновления OPPO, качалки Google — это делает трафик-фильтр),
// а не на самой ленте: лента и есть то, ради чего ферма живёт.
const KBIT = 0
if (!upstream) { console.error('нужен upstream: user:pass@host:port'); process.exit(1) }
const [creds, hostport] = upstream.split('@')
const [uHost, uPort] = hostport.split(':')
const auth = 'Basic ' + Buffer.from(creds).toString('base64')
const PORT = Number(listenPort || 8899)

// ── Учёт трафика по хостам ────────────────────────────────────────────────
// Считаем ровно то, за что платим: байты, прошедшие через нас в ClickIP.
// Каждый переходник ведёт свой файл, поэтому три процесса не дерутся за один
// и тот же файл и запись всегда целая.
const ПАПКА = path.dirname(fileURLToPath(import.meta.url))
const ФАЙЛ = path.join(ПАПКА, `трафик-${PORT}.tsv`)
const счёт = new Map() // хост -> { соединений, принято, отдано }

function узел(хост) {
  const ключ = String(хост).replace(/:\d+$/, '')
  let з = счёт.get(ключ)
  if (!з) { з = { соединений: 0, принято: 0, отдано: 0 }; счёт.set(ключ, з) }
  return з
}

// Подхватываем прошлый итог, чтобы перезапуск не обнулял статистику.
function загрузить() {
  try {
    for (const строка of fs.readFileSync(ФАЙЛ, 'utf8').split('\n')) {
      if (!строка || строка.startsWith('#') || строка.startsWith('хост\t')) continue
      const [хост, с, пр, от] = строка.split('\t')
      if (!хост) continue
      const з = узел(хост)
      з.соединений += Number(с) || 0; з.принято += Number(пр) || 0; з.отдано += Number(от) || 0
    }
  } catch { /* файла ещё нет — начинаем с нуля */ }
}

function сохранить() {
  const строки = [...счёт.entries()].sort((a, b) =>
    (b[1].принято + b[1].отдано) - (a[1].принято + a[1].отдано))
  let всегоП = 0, всегоО = 0, всегоС = 0
  for (const [, з] of строки) { всегоП += з.принято; всегоО += з.отдано; всегоС += з.соединений }
  const мб = (б) => (б / 1048576).toFixed(2)
  const текст = `# обновлено ${new Date().toLocaleString('ru-RU')} | порт ${PORT} → ${uHost}:${uPort}`
    + ` | всего ${мб(всегоП + всегоО)} МБ (принято ${мб(всегоП)}, отдано ${мб(всегоО)}, соединений ${всегоС})\n`
    + 'хост\tсоединений\tпринято_байт\tотдано_байт\tвсего_МБ\n'
    + строки.map(([х, з]) =>
        `${х}\t${з.соединений}\t${з.принято}\t${з.отдано}\t${мб(з.принято + з.отдано)}`).join('\n') + '\n'
  // Пишем через временный файл: если нас прибьют посреди записи, старый итог уцелеет.
  const врем = ФАЙЛ + '.tmp'
  fs.writeFileSync(врем, текст)
  fs.renameSync(врем, ФАЙЛ)
}

загрузить()
const таймер = setInterval(сохранить, 60_000)
таймер.unref?.()
for (const сигнал of ['SIGINT', 'SIGTERM']) {
  process.on(сигнал, () => { try { сохранить() } catch {} process.exit(0) })
}
process.on('exit', () => { try { сохранить() } catch {} })

function toUpstream(cb) {
  const s = net.connect(Number(uPort), uHost, () => cb(null, s))
  s.on('error', (e) => cb(e))
  return s
}

const server = createServer((req, res) => {
  console.log('HTTP ' + req.method + ' ' + req.url)
  // Обычный HTTP: пересобираем запрос в абсолютной форме, как требует прокси.
  let хост = req.headers.host || req.url
  try { хост = new URL(req.url).host } catch { /* относительный путь — берём заголовок */ }
  if (резать(хост)) {
    console.log('ОТКАЗ ' + хост + ' — качалка обновлений, платный прокси не для неё')
    res.writeHead(403); return res.end('заблокировано фермой')
  }
  const з = узел(хост); з.соединений++
  toUpstream((err, up) => {
    if (err) { res.writeHead(502); return res.end('upstream: ' + err.message) }
    const headers = { ...req.headers, 'proxy-authorization': auth, connection: 'close' }
    delete headers['proxy-connection']
    const head = `${req.method} ${req.url} HTTP/1.1\r\n`
      + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'
    up.write(head)
    з.отдано += Buffer.byteLength(head)
    req.on('data', (ч) => { з.отдано += ч.length })
    req.pipe(up)
    up.pipe(res.socket)
    up.on('data', (ч) => { з.принято += ч.length })
    up.on('error', () => res.socket?.destroy())
  })
})

// HTTPS идёт методом CONNECT — это и есть основной путь для приложений.
server.on('connect', (req, clientSocket, head) => {
  console.log('CONNECT ' + req.url)
  // ОБРЫВ КЛИЕНТА НЕ ДОЛЖЕН УБИВАТЬ МОСТ.
  //
  // Обработчик ошибки вешался НИЖЕ — после того, как ответит апстрим. А телефон может
  // оборвать соединение РАНЬШЕ, пока мы ещё коннектимся: тогда у сокета нет слушателя
  // 'error', node считает это фатальным и роняет ВЕСЬ процесс моста.
  //
  // Цена была такая: 21.08 мосты Астаны и Алматы падали от обычного ECONNRESET, launchd
  // поднимал связку 11 раз, а между падениями у обеих OPPO не было интернета вовсе —
  // трафик 1.1 и 1.4 КБ/с вместо десятков. Со стороны это выглядело как «прокси медленные»,
  // и мы полдня искали причину в сети.
  clientSocket.on('error', () => { try { clientSocket.destroy() } catch { /* уже мёртв */ } })
  if (резать(req.url)) {
    console.log('ОТКАЗ ' + req.url + ' — качалка обновлений, платный прокси не для неё')
    try { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n') } catch { /* уже мёртв */ }
    return
  }
  const з = узел(req.url); з.соединений++
  toUpstream((err, up) => {
    if (err) { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${auth}\r\n\r\n`)
    let буфер = ''
    const ответ = (chunk) => {
      буфер += chunk.toString('latin1')
      const конец = буфер.indexOf('\r\n\r\n')
      if (конец === -1) return
      up.removeListener('data', ответ)
      const ok = /^HTTP\/1\.[01] 200/.test(буфер)
      if (!ok) { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); up.destroy(); return }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const хвост = Buffer.from(буфер.slice(конец + 4), 'latin1')
      if (хвост.length) { clientSocket.write(хвост); з.принято += хвост.length }
      if (head?.length) { up.write(head); з.отдано += head.length }
      clientSocket.on('data', (ч) => { з.отдано += ч.length })
      if (KBIT) {
        // Пропускаем данные порциями: после каждой порции ждём столько,
        // сколько она «стоит» при заданной полосе. Задержка выходит ровной,
        // без рывков, и приложение видит стабильно узкий канал.
        const байтВСек = (KBIT * 1000) / 8
        up.on('data', (ч) => {
          з.принято += ч.length
          up.pause()
          if (!clientSocket.write(ч)) { /* буфер клиента полон — ждём слива */ }
          setTimeout(() => up.resume(), Math.max(1, Math.round((ч.length / байтВСек) * 1000)))
        })
        up.on('end', () => clientSocket.end())
        clientSocket.pipe(up)
      } else {
        up.pipe(clientSocket); clientSocket.pipe(up)
        up.on('data', (ч) => { з.принято += ч.length })
      }
    }
    up.on('data', ответ)
    up.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => up.destroy())
  })
})

server.listen(PORT, '0.0.0.0', () => console.log(
  `переходник слушает 0.0.0.0:${PORT} → ${uHost}:${uPort}` + (KBIT ? ` | полоса ${KBIT} кбит/с` : ' | без ограничения')
  + ` | учёт трафика: ${ФАЙЛ}`))

// ПОСЛЕДНИЙ РУБЕЖ.
//
// Мост держит интернет ВСЕЙ фермы: упал он — телефоны слепнут молча, и ни один сторож
// этого не видит, потому что процесс launchd поднимет, а между падениями проходят минуты.
// Поэтому одиночная ошибка сокета не имеет права снимать процесс. Пишем и работаем дальше.
process.on('uncaughtException', (e) => {
  console.log('ПОЙМАЛ И НЕ УПАЛ: ' + String(e && e.message).slice(0, 120))
})
process.on('unhandledRejection', (e) => {
  console.log('ПОЙМАЛ ОБЕЩАНИЕ: ' + String(e && e.message).slice(0, 120))
})
