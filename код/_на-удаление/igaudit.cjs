// АУДИТ АККОВ СНАРУЖИ — без единого логина и без браузера (0 риска для акков).
// Зачем: session_status в БД это НАШ флаг, а не факт. Реальность проверяем анонимно:
// curl + резидентский прокси + короткий UA (метод duty_safe: полный десктопный UA даёт login-shell).
// Вердикт положительными признаками; «не понял» = unknown, не «жив».
// Запуск: node igaudit.cjs [--all|--live|slug1,slug2]
const { execFile } = require('child_process');
const { Client } = require('pg');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ARG = (process.argv[2] || '--live');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curlText(url, proxy, timeoutSec = 25) {
  return new Promise((res) => {
    const args = ['-s', '-m', String(timeoutSec), '-A', 'Mozilla/5.0 Chrome/124'];
    if (proxy) args.push('-x', 'http://' + proxy);
    args.push(url);
    execFile('curl', args, { maxBuffer: 12 * 1024 * 1024, timeout: 30000 }, (err, out) => res(err ? '' : String(out || '')));
  });
}
// Профиль через embed: у живого публичного акка отдаётся страница с его ником; у снесённого — «isn't available».
async function probe(handle, proxies) {
  for (const p of proxies) {
    const h = await curlText(`https://www.instagram.com/${handle}/embed/`, p);
    if (!h) continue;
    if (/Sorry, this page isn'?t available|page isn'?t available|Страница недоступна/i.test(h)) return { state: 'нет профиля', via: p };
    // Ник в embed лежит В ССЫЛКЕ (instagram.com/{ник}/), а не только в "username" или @ник —
    // узкий шаблон давал ложное «ник не найден» на ЖИВЫХ акках (проверено руками 01.08).
    // Точки в никах экранируем: no.fear2 как regex совпал бы и с «noXfear2».
    const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`"username"\\s*:\\s*"${esc}"|instagram\\.com/${esc}[/"?]|>${esc}<|@${esc}\\b`, 'i').test(h)) return { state: 'жив', via: p };
    if (/login|Log in|Войти/i.test(h) && h.length < 4000) return { state: 'login-shell', via: p };
    if (h.length > 1500) return { state: 'ответ есть, ник не найден', via: p };
  }
  return { state: 'нет ответа', via: null };
}
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, statement_timeout: 25000 }); await c.connect();
  const where = ARG === '--all' ? '1=1' : ARG === '--live' ? "session_status='live'" : 'slug = ANY($1)';
  const params = ARG.startsWith('--') ? [] : [ARG.split(',').map((s) => s.trim())];
  const rows = (await c.query(
    `SELECT slug, coalesce(ig_login,slug) h, session_status, coalesce(ig_status,'') igst, coalesce(persona,'') persona
       -- promo = модельные акки, уведённые из контура комментинга (promoisolate.cjs). Аудит обязан
       -- видеть и их, иначе «всё хорошо» будет означать всего лишь «я на них не смотрел».
       FROM accounts WHERE deleted_at IS NULL AND platform IN ('comments','promo') AND coalesce(ig_login,'')<>'' AND ${where}
      ORDER BY (persona<>'') DESC, slug`, params)).rows;
  const px = (await c.query("SELECT ig_proxy FROM accounts WHERE ig_proxy LIKE '%@%' AND proxy_status='ok' AND deleted_at IS NULL ORDER BY random() LIMIT 4")).rows.map((x) => x.ig_proxy);
  const anon = fs.existsSync(`${__dirname}/anon_proxies.txt`)
    ? fs.readFileSync(`${__dirname}/anon_proxies.txt`, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('http ')).map((l) => l.slice(5))
    : [];
  // ПРОВЕРЯЕМ ПРОКСИ ДО РАБОТЫ (урок 01.08: список анон-прокси протух, 1 живой из 6 → аудит молчал
  // «нет ответа» и это выглядело как проблема аккаунтов). Инструмент не доверяет себе непроверенным.
  const cand = [...px, ...anon];
  // Проверяем ВЕСЬ список (а не первые N): живой прокси может стоять в конце. Короткий таймаут —
  // мёртвые отваливаются быстро. Параллельно, иначе 18 мёртвых по 25с = 7 минут ожидания.
  const probeOk = async (p) => ({ p, ok: (await curlText('https://www.instagram.com/instagram/embed/', p, 10)).length > 3000 });
  const alive = (await Promise.all(cand.map(probeOk))).filter((x) => x.ok).map((x) => x.p).slice(0, 4);
  const proxies = alive;
  if (!proxies.length) { console.log('⛔ НЕТ живых прокси (проверено ' + cand.length + ') — аудит не запускаю, иначе «нет ответа» солжёт про акки'); await c.end(); process.exit(2); }
  console.log(`АУДИТ СНАРУЖИ: ${rows.length} акков, живых прокси ${proxies.length} из ${cand.length} проверенных, логинов 0\n`);
  const out = [];
  for (const r of rows) {
    const v = await probe(r.h, proxies);
    const flag = v.state === 'жив' ? '🟢' : v.state === 'нет профиля' ? '⛔' : '🟡';
    console.log(`${flag} ${(r.persona || '·').padEnd(8)} @${r.h.padEnd(24)} БД:${r.session_status}/${r.igst || '—'}  →  СНАРУЖИ: ${v.state}`);
    out.push({ slug: r.slug, handle: r.h, db: `${r.session_status}/${r.igst || '—'}`, real: v.state });
    await sleep(1200);
  }
  const gone = out.filter((x) => x.real === 'нет профиля');
  console.log(`\nИТОГ: живых снаружи ${out.filter((x) => x.real === 'жив').length}/${out.length}` + (gone.length ? ` · СНЕСЕНО: ${gone.map((x) => '@' + x.handle).join(', ')}` : ''));
  await c.end();
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
