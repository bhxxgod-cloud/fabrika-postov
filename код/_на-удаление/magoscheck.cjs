// magoscheck.cjs — АНОНИМНЫЙ ДОЧЁТ ГРУППЫ «МАГО (постинг)» (10.08).
//
// ЗАЧЕМ. У части акков ник существует, но профиль не отдаётся анониму: ответ ровно {"status":"ok"}
// без ключа data. Такой акк числится здоровым, а снаружи его никто не видит. Надо получить полный
// список таких по группе 786f34fe-c865-43d7-a3cb-99ea8cc5e55b.
//
// В акки НЕ логинимся, ничего не публикуем, в базу НЕ пишем. Только чтение публичной ручки.
//
// ТРИ РАЗЛИЧИМЫХ ИСХОДА (калибровка 10.08):
//   200 + data.user      → OPEN    профиль отдаётся
//   200 + {"status":"ok"} без data → HIDDEN  ник занят, профиль скрыт от анонима
//   404                  → MISSING ника не существует (проверено на выдуманных: 8 из 8 дали 404)
//   401 «Please wait…»   → НЕ вердикт, это лимит нашего IP. Повторяем с другого прокси.
//
// ПРАВИЛО ДОКАЗАТЕЛЬСТВА: один запрос ничего не значит. Нужно NEED согласных вердиктов с РАЗНЫХ
// прокси (каждый magos-порт = отдельный egress IP). Если вердикты разошлись — тянем ещё попытки
// и берём большинство, расхождение печатаем.
//
// Запуск ИЗ папки проекта: node magoscheck.cjs [need] [пауза мс]
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const NEED = Number(process.argv[2] || 3);
const PAUSE = Number(process.argv[3] || 4500);
const MAXTRY = 12;                       // предел попыток на ник, чтобы прогон не завис на лимитах
const UA = 'Instagram 269.0.0.18.75 Android';
const OUT = '/tmp/magoscheck.json';

const NICKS = ['deepikajoly','esther635979','florescitra','fumikocervantes','ghadamukherjee',
  'gizembong','harsha79110','hiljeeo','honeyletchae','iseulgemayel','jin170866','jonsdottirsuad',
  'katjaahn','keigowerner','kunigundetesta','lacroixseoyeon','lorenzoravensworth','maritathanasiou',
  'michelebahrami','michikoanand','milan88530','pangriko','prins.alejandro','reinamatsui',
  'riosmargaux','sergei.bong','shuangkapadia','sigridbyun','stanley80214','tabithaorlov',
  'tayloryuhan','vasilihidayat','weiweitaniguchi','yistavrou','yoonjinyadav'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// Прокси с диска. Пароли никуда не печатаем.
function proxies() {
  const out = [];
  for (const f of ['/tmp/px/kz_magos_100.txt', '/tmp/px/kz_sous_100.txt']) {
    for (const l of safeRead(f).split('\n')) {
      const p = l.trim().split(':');
      if (p.length === 4) out.push({ id: `${p[0]}:${p[1]}`, url: `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}` });
    }
  }
  return out;
}

// Один анонимный запрос. Возвращает различимый исход, а не «получилось/не получилось».
function ask(nick, proxy) {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '25',
    '-H', `User-Agent: ${UA}`, '-H', 'X-IG-App-ID: 936619743392459',
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(nick)}`];
  if (proxy) args.push('--proxy', proxy.url);
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 22 });
  const out = String(r.stdout || '');
  const nl = out.lastIndexOf('\n');
  const code = Number(out.slice(nl + 1).trim());
  const body = out.slice(0, nl);
  if (code === 404) return { v: 'MISSING', code };
  if (code === 200) {
    let j = null;
    try { j = JSON.parse(body); } catch { return { v: 'RETRY', code, why: 'битый json' }; }
    if (j && j.data && j.data.user) return { v: 'OPEN', code, followers: j.data.user.edge_followed_by?.count ?? null };
    if (j && j.status === 'ok' && !('data' in j)) return { v: 'HIDDEN', code };
    return { v: 'RETRY', code, why: 'неопознанное тело' };
  }
  if (code === 401 || code === 429) return { v: 'RETRY', code, why: 'лимит нашего ip' };
  if (!code) return { v: 'RETRY', code: 0, why: 'прокси не ответил' };
  return { v: 'RETRY', code, why: `http ${code}` };
}

(async () => {
  const px = proxies();
  if (!px.length) { console.error('нет прокси'); process.exit(1); }
  console.log(`ников ${NICKS.length}, прокси ${px.length}, нужно согласных ${NEED}, пауза ~${PAUSE}мс`);

  let cursor = Math.floor(Math.random() * px.length);   // общий курсор: не жжём одни и те же порты
  const results = {};

  for (let i = 0; i < NICKS.length; i++) {
    const nick = NICKS[i];
    const votes = [];       // только вердикты
    const usedProxy = [];
    let tries = 0, limited = 0;

    while (tries < MAXTRY) {
      // добираем, пока у лидирующего вердикта нет NEED голосов
      const tally = {};
      votes.forEach((v) => { tally[v] = (tally[v] || 0) + 1; });
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= NEED) break;

      const p = px[cursor % px.length]; cursor++;
      tries++;
      const r = ask(nick, p);
      if (r.v === 'RETRY') {
        limited++;
        // пул к концу прогона массово отвечает лимитом: тормозим сильнее
        await sleep(PAUSE + 2000 + Math.floor(Math.random() * 2000));
        continue;
      }
      votes.push(r.v);
      usedProxy.push(p.id);
      await sleep(PAUSE + Math.floor(Math.random() * 1500));
    }

    const tally = {};
    votes.forEach((v) => { tally[v] = (tally[v] || 0) + 1; });
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const verdict = ranked.length ? ranked[0][0] : 'UNKNOWN';
    const split = ranked.length > 1;
    results[nick] = { verdict, votes, tally, tries, limited, split, proxies: usedProxy };
    console.log(`[${i + 1}/${NICKS.length}] ${nick.padEnd(22)} ${verdict.padEnd(8)} голоса=${votes.join(',') || '-'} попыток=${tries} лимитов=${limited}${split ? '  ⚠ РАСХОЖДЕНИЕ' : ''}`);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  const by = (v) => Object.keys(results).filter((k) => results[k].verdict === v);
  console.log('\n===== ИТОГ ПО ЭТОЙ ПАРТИИ =====');
  console.log(`скрыто (HIDDEN): ${by('HIDDEN').length} — ${by('HIDDEN').join(', ') || '-'}`);
  console.log(`отдаётся (OPEN): ${by('OPEN').length} — ${by('OPEN').join(', ') || '-'}`);
  console.log(`нет ника (MISSING): ${by('MISSING').length} — ${by('MISSING').join(', ') || '-'}`);
  console.log(`не добили (UNKNOWN): ${by('UNKNOWN').length} — ${by('UNKNOWN').join(', ') || '-'}`);
  console.log(`подробности: ${OUT}`);
})();
