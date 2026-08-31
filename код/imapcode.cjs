// Сырой IMAP-over-TLS: читает инбокс почты акка и достаёт свежий код подтверждения Instagram.
// Только ЧТЕНИЕ (без удаления/пометок) — безопасно. Хост IMAP = mail.<домен> (Firstmail-домены отвечают и на imap.firstmail.ltd).
// usage: node imapcode.cjs <email> <password> [host] [sinceEpochMs]
//   → печатает JSON {ok, code, subject, when, whenMs} по самому свежему письму IG (новее sinceEpochMs, если задан).
const tls = require('tls');
const [EMAIL, PASS, HOST_ARG, SINCE_ARG] = process.argv.slice(2);
const HOST = HOST_ARG || ('mail.' + (EMAIL || '').split('@')[1]);
const SINCE = Number(SINCE_ARG || 0);
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function imapDateMs(s) { // "18-Jul-2026 17:54:54 +0300"
  const m = String(s).match(/(\d{1,2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/);
  if (!m) return 0;
  const tz = (m[7][0] === '-' ? -1 : 1) * (parseInt(m[7].slice(1, 3)) * 60 + parseInt(m[7].slice(3, 5)));
  return Date.UTC(+m[3], MON[m[2]] || 0, +m[1], +m[4], +m[5], +m[6]) - tz * 60000;
}
const q = s => '"' + String(s).replace(/([\\"])/g, '\\$1') + '"';

function imap(host) {
  const sock = tls.connect({ host, port: 993, servername: host, rejectUnauthorized: false });
  let buffer = ''; const waiters = [];
  sock.on('data', d => { buffer += d.toString('utf8'); pump(); });
  sock.on('error', e => { while (waiters.length) waiters.shift().reject(e); });
  function pump() {
    while (waiters.length) {
      const w = waiters[0];
      const re = new RegExp('^' + w.tag + ' (OK|NO|BAD)([^\r\n]*)\r\n', 'm');
      const m = buffer.match(re);
      if (!m) break;
      const end = buffer.indexOf(m[0]) + m[0].length;
      const text = buffer.slice(0, end); buffer = buffer.slice(end);
      waiters.shift(); w.resolve({ status: m[1], text });
    }
  }
  let n = 0;
  const cmd = (c) => new Promise((resolve, reject) => { n++; const tag = 'A' + n; waiters.push({ tag, resolve, reject }); sock.write(tag + ' ' + c + '\r\n'); });
  const ready = () => new Promise(r => { const chk = () => { if (/\* OK/i.test(buffer)) { buffer = ''; r(); } else setTimeout(chk, 80); }; chk(); });
  const close = () => { try { sock.end(); } catch {} };
  return { cmd, ready, close };
}

// Достаём 6-значный код из письма IG (учитываем формат «123 456» и рус/англ формулировки).
function extractCode(body) {
  const t = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); // quoted-printable
  // приоритет: код рядом со словами Instagram/code/код/confirm/подтвер
  const near = t.match(/(?:instagram|code|код|confirm|подтвер|verification|войти)[\s\S]{0,80}?\b(\d{3}\s?\d{3})\b/i)
    || t.match(/\b(\d{3}\s?\d{3})\b[\s\S]{0,40}?(?:instagram|code|код)/i)
    || t.match(/\b(\d{6})\b/);
  return near ? near[1].replace(/\s/g, '') : '';
}

(async () => {
  if (!EMAIL || !PASS) { console.log(JSON.stringify({ ok: false, err: 'usage: <email> <password> [host]' })); return; }
  const c = imap(HOST);
  try {
    await c.ready();
    const li = await c.cmd(`LOGIN ${q(EMAIL)} ${q(PASS)}`);
    if (li.status !== 'OK') { console.log(JSON.stringify({ ok: false, err: 'login: ' + li.text.trim().slice(0, 120), host: HOST })); c.close(); return; }
    const sel = await c.cmd('SELECT INBOX');
    const exists = Number((sel.text.match(/\* (\d+) EXISTS/) || [])[1] || 0);
    if (!exists) { console.log(JSON.stringify({ ok: false, err: 'пустой инбокс', host: HOST })); c.close(); return; }
    const from = Math.max(1, exists - 14);
    // Тянем последние ~15 писем (новейшие в конце), парсим с конца — берём свежайший IG-код.
    const fe = await c.cmd(`FETCH ${from}:${exists} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])`);
    const blocks = fe.text.split(/\* \d+ FETCH /).slice(1);
    let best = null;
    for (const b of blocks) {
      const subj = (b.match(/Subject:\s*([^\r\n]*)/i) || [])[1] || '';
      const fr = (b.match(/From:\s*([^\r\n]*)/i) || [])[1] || '';
      const when = (b.match(/INTERNALDATE "([^"]+)"/) || [])[1] || '';
      const whenMs = imapDateMs(when);
      if (!/instagram|instagr|ig\b/i.test(subj + ' ' + fr)) continue;
      if (SINCE && whenMs && whenMs < SINCE) continue; // старее нужного момента — пропускаем (протухший код)
      const code = extractCode(subj) || extractCode(b);
      if (code && (!best || whenMs >= best.whenMs)) best = { code, subject: subj.trim().slice(0, 80), from: fr.trim().slice(0, 60), when, whenMs };
    }
    console.log(JSON.stringify(best ? { ok: true, ...best, host: HOST } : { ok: false, err: 'IG-письмо с кодом не найдено', host: HOST, seen: blocks.length, since: SINCE }));
    c.close();
  } catch (e) { console.log(JSON.stringify({ ok: false, err: String(e.message || e).slice(0, 120), host: HOST })); c.close(); }
})();
