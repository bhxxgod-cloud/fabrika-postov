// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
//
// RELOGIN — массовое возвращение разлогиненных акков в строй. Это и есть наш реальный потолок: движки
// исправны, но половина фермы заходит ГОСТЯМИ (session_status врал, пока не появился аудит).
//
// ДВА ПРЕДОХРАНИТЕЛЯ, без них massive-релогин сжигает акки:
//  1) ПРОКСИ СНАЧАЛА. Купленный акк на ротирующем/мёртвом прокси ловит верификацию по номеру и умирает
//     насовсем. Меряем egress дважды: разные IP = ротация = НЕ ЛОГИНИМСЯ (нужен sticky).
//  2) ОДНА ПОПЫТКА НА АКК. chlogin вводит код один раз и останавливается при провале — перебор лочит акк.
//     Здесь тот же принцип: не удалось — записали причину, идём дальше, повтор только вручную.
//
// Запуск: DB_PUBLIC_URL=… node relogin.cjs [сколько] [--dry]
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const { Client } = require('pg');
const { spawn } = require('child_process');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const LIMIT = Number(process.argv[2] || 25);
const DRY = process.argv.includes('--dry');
const GAP = Number(process.env.GAP_SEC || 40) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

// Разбор строки прокси: host:port:user:pass либо http://user:pass@host:port.
function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(?:https?:\/\/)?(?:([^:@]+):([^@]*)@)?([^:/@]+):(\d+)$/);
  if (m) return { host: m[3], port: +m[4], username: m[1] || '', password: m[2] || '' };
  m = s.match(/^([^:]+):(\d+):([^:]*):(.*)$/);
  if (m) return { host: m[1], port: +m[2], username: m[3] || '', password: m[4] || '' };
  return null;
}

// Точка выхода через прокси (forward-режим, как в src/proxycheck.ts).
function egress(host, port, user, pass, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const headers = { Host: 'api.ipify.org', Connection: 'close' };
      if (user) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      const req = http.request({ host, port, method: 'GET', path: 'http://api.ipify.org/', headers, timeout: timeoutMs }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 100) req.destroy(); });
        res.on('end', () => { const s = d.trim(); fin(/^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : null); });
      });
      req.on('error', () => fin(null));
      req.on('timeout', () => { req.destroy(); fin(null); });
      req.end();
    } catch { fin(null); }
  });
}

// Вердикт по прокси ДО захода в IG: ok / dead / rotating / unparsed.
async function proxyVerdict(raw) {
  if (!raw) return { ok: false, why: 'прокси не задан' };
  const p = parseProxy(raw);
  if (!p) return { ok: false, why: 'прокси не распознан' };
  const a = await egress(p.host, p.port, p.username, p.password);
  const b = await egress(p.host, p.port, p.username, p.password);
  if (!a && !b) return { ok: false, why: `МЁРТВ :${p.port} (нет ответа ×2)` };
  if (a && b && a !== b) return { ok: false, why: `РОТИРУЕТ :${p.port} (${a} ≠ ${b}) — нужен sticky` };
  return { ok: true, why: `стабилен ${a || b}` };
}

function runLogin(slug) {
  return new Promise((res) => {
    let out = '';
    const p = spawn('node', [path.join(DIR, 'chlogin.cjs'), slug], {
      cwd: DIR,
      env: { ...process.env, DB_PUBLIC_URL: DBURL, SHOT_DIR: process.env.SHOT_DIR || '/tmp' },
    });
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    const killer = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* noop */ } }, 6 * 60000);
    p.on('exit', () => { clearTimeout(killer); res(out); });
    p.on('error', () => { clearTimeout(killer); res(out); });
  });
}

(async () => {
  const c = await db();
  // Явный список акков: `node relogin.cjs --slug landen6965,rylan61667`. Нужен для МОДЕЛЬНЫХ акков —
  // общая выборка ниже берёт только ферму комментинга (platform='comments'), а девочки живут отдельно.
  // Предохранители те же: прокси меряется, попытка одна.
  const slugArg = (process.argv.find((x) => x.startsWith('--slug=')) || '').slice(7)
    || (process.argv.includes('--slug') ? process.argv[process.argv.indexOf('--slug') + 1] : '');
  const wanted = String(slugArg || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = wanted.length ? (await c.query(
    `SELECT a.id, a.slug, a.ig_proxy, coalesce(a.ig_status,'-') ig, a.totp_secret IS NOT NULL AND a.totp_secret<>'' AS has_totp
     FROM accounts a
     WHERE a.deleted_at IS NULL AND (a.slug = ANY($1) OR a.ig_login = ANY($1))
       AND coalesce(a.ig_status,'') NOT IN ('captcha','banned')`, [wanted])).rows : (await c.query(
    `SELECT a.id, a.slug, a.ig_proxy, coalesce(a.ig_status,'-') ig, a.totp_secret IS NOT NULL AND a.totp_secret<>'' AS has_totp
     FROM accounts a
     WHERE a.platform='comments' AND a.deleted_at IS NULL AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.session_status,'')='dead'
       AND a.ig_password IS NOT NULL AND a.ig_password<>''
       AND a.status NOT IN ('paused','trash')
       AND coalesce(a.ig_status,'') NOT IN ('captcha','banned')
     ORDER BY a.last_commented_at DESC NULLS LAST LIMIT $1`, [LIMIT])).rows;
  await c.end();
  console.log(`[relogin] кандидатов: ${rows.length}${DRY ? ' (СУХОЙ ПРОГОН — только проверка прокси, без входа)' : ''}\n`);

  const tally = { ok: 0, proxy_bad: 0, fail: 0 };
  let i = 0;
  for (const a of rows) {
    i++;
    const v = await proxyVerdict(a.ig_proxy);
    if (!v.ok) {
      tally.proxy_bad++;
      console.log(`[${String(i).padStart(2)}/${rows.length}] ${a.slug.padEnd(20)} ⛔ прокси: ${v.why} — НЕ логинимся (иначе вериф по номеру)`);
      const c2 = await db();
      await c2.query(`UPDATE accounts SET proxy_status='bad' WHERE id=$1`, [a.id]).catch(() => {});
      await c2.end();
      continue;
    }
    if (DRY) { console.log(`[${String(i).padStart(2)}/${rows.length}] ${a.slug.padEnd(20)} 🟢 прокси ${v.why} | 2FA:${a.has_totp ? 'есть' : 'нет'} — вошёл бы`); tally.ok++; continue; }

    console.log(`\n[${String(i).padStart(2)}/${rows.length}] ${a.slug} — прокси ${v.why}, захожу…`);
    const out = await runLogin(a.slug);
    const c3 = await db();
    const st = (await c3.query(`SELECT coalesce(session_status,'-') st FROM accounts WHERE id=$1`, [a.id])).rows[0];
    await c3.end();
    const good = st && st.st === 'live';
    if (good) { tally.ok++; console.log(`  ✅ ${a.slug} ВОШЁЛ`); }
    else { tally.fail++; console.log(`  ✗ ${a.slug} не вошёл (${/2fa|totp/i.test(out) ? '2FA' : /challenge|подтверд/i.test(out) ? 'челлендж' : 'см. лог'}) — повтор только вручную`); }
    await sleep(GAP);
  }

  console.log(`\n[relogin] ИТОГ: вошли ${tally.ok}, плохой прокси ${tally.proxy_bad}, не вошли ${tally.fail}`);
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 160)));
