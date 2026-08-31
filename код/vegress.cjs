// Прогон egress-проверки: для акков с непроверенным прокси (proxy_status='unknown') открывает
// GoLogin cloud-профиль, меряет точку выхода (ipinfo.io/json) и пишет egress_ip/egress_country/
// proxy_status/egress_checked_at в БД. НЕ трогает Instagram — только ipinfo, акк не жжём.
// usage: DB_PUBLIC_URL=<pub> node vegress.cjs            — все живые акки с proxy_status='unknown'
//        DB_PUBLIC_URL=<pub> node vegress.cjs "slug1"... — только указанные слаги (любой proxy_status)
// Гоним СТРОГО по одному (клауд-слоты yotbonly), сессию гасим DELETE /browser/{id}/web в finally.
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db(q, p) {
  for (let k = 0; k < 5; k++) {
    const c = new Client({ connectionString: process.env.DB_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try { await c.connect(); const r = await c.query(q, p); await c.end(); return r; }
    catch { await c.end().catch(() => {}); await sleep(2000); }
  }
  throw new Error('db недоступна');
}

// Погасить облачную сессию профиля (browser.close() её НЕ глушит — правило из HANDOFF).
async function killCloud(profileId, token) {
  await fetch(`https://api.gologin.com/browser/${profileId}/web`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  }).catch(() => {});
}

async function probeOne(acc) {
  const token = acc.gologin_token || process.env.GOLOGIN_API_TOKEN;
  if (!token) { console.log(`  ✗ ${acc.slug}: нет GoLogin-токена`); return null; }
  const u = new URL('wss://cloudbrowser.gologin.com/connect');
  u.searchParams.set('token', token); u.searchParams.set('profile', acc.gologin_profile_id);
  let browser = null;
  for (let k = 0; k < 5 && !browser; k++) {
    browser = await chromium.connectOverCDP(u.toString(), { timeout: 60000 }).catch(() => null);
    if (!browser) { console.log(`  … коннект ${k + 1}/5 (занят/облако?)`); await sleep(k === 0 ? 22000 : 14000); }
  }
  if (!browser) { console.log(`  ✗ ${acc.slug}: НЕ ПОДКЛЮЧИЛСЯ (профиль занят воркером? повтори позже)`); return 'busy'; }
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    // ДВА НЕЗАВИСИМЫХ СЕРВИСА, ПО ДВЕ ПОПЫТКИ (07.08). Был один запрос к ipinfo.io, и его провал
    // (429 от ipinfo, HTML вместо JSON, таймаут) писался в базу как proxy_status='dead': чужой сайт
    // выносил приговор нашему каналу, акк выпадал из работы, а авто-починка тянула из пула новый порт
    // под живым прокси. Теперь «не замерили» значит, что молчали ОБА сервиса с двух попыток.
    // country пустой = гео не узнали (резервный сервис его не отдаёт), это НЕ повод писать mismatch.
    for (let attempt = 1; attempt <= 2; attempt++) {
      for (const s of [{ url: 'https://ipinfo.io/json', geo: true }, { url: 'https://api.ipify.org?format=json', geo: false }]) {
        try {
          await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          const txt = await page.evaluate(() => document.body.innerText || '');
          const j = JSON.parse(txt);
          const ip = String(j.ip || '').trim();
          if (!ip) continue;
          return { ip, country: s.geo ? String(j.country || '').trim().toUpperCase() : '' };
        } catch { /* пробуем следующий сервис/попытку */ }
      }
    }
    return null;
  } catch { return null; }
  finally {
    await browser.close().catch(() => {});
    await killCloud(acc.gologin_profile_id, token);
  }
}

(async () => {
  const slugs = process.argv.slice(2);
  const where = slugs.length
    ? `a.slug = ANY($1)`
    : `coalesce(a.proxy_status,'unknown')='unknown'`;
  const { rows } = await db(
    `SELECT a.id, a.slug, a.platform, a.gologin_profile_id, a.session_status,
            upper(coalesce(a.proxy->>'country','')) AS want, g.gologin_token
     FROM accounts a LEFT JOIN account_groups g ON g.id = a.group_id
     WHERE ${where} AND a.deleted_at IS NULL AND a.status <> 'paused' AND a.gologin_profile_id IS NOT NULL
     ORDER BY (a.ig_role='duty') DESC NULLS LAST, (a.session_status='live') DESC, a.slug`,
    slugs.length ? [slugs] : []);
  console.log(`Акков на проверку egress: ${rows.length}\n`);
  const out = [];
  for (const acc of rows) {
    console.log(`→ ${acc.slug} (${acc.platform}, session=${acc.session_status})`);
    const eg = await probeOne(acc);
    if (eg === 'busy') {
      // Не подключились ≠ прокси мёртв (чаще профиль занят воркером) — статус НЕ трогаем, повтори позже.
      out.push({ slug: acc.slug, result: '… ПРОПУЩЕН (профиль занят)' });
    } else if (!eg) {
      // ДВА СТРАЙКА (07.08). Первый провал замера = 'unknown' («не знаем»), второй подряд = 'dead'.
      // Один провал раньше сразу писал 'dead', и транзиентный сбой зонда выключал живой акк, а
      // авто-починка забирала под него ещё один порт из пула. Приговор канал получает только когда
      // не ответил дважды, а каждый раз это два разных сервиса по две попытки.
      const r = await db(`UPDATE accounts SET proxy_status = CASE WHEN coalesce(proxy_status,'')='unknown' THEN 'dead' ELSE 'unknown' END,
                            egress_checked_at=now() WHERE id=$1 RETURNING proxy_status`, [acc.id]);
      const now = r[0] ? r[0].proxy_status : '?';
      out.push({ slug: acc.slug, result: now === 'dead' ? '✗ DEAD (не замерили дважды подряд)' : '？ НЕ ЗАМЕРИЛИ (вердикт отложен)' });
      console.log(`  ${now === 'dead' ? '✗' : '？'} egress НЕ замерили ни одним сервисом → proxy_status='${now}'`);
    } else {
      // Пустое гео (ответил только резервный сервис) не считаем несовпадением: нет данных ≠ mismatch.
      const status = !acc.want || !eg.country ? 'ok' : eg.country === acc.want ? 'ok' : 'mismatch';
      await db(`UPDATE accounts SET egress_ip=$2, egress_country=$3, proxy_status=$4, egress_checked_at=now() WHERE id=$1`,
        [acc.id, eg.ip, eg.country, status]);
      out.push({ slug: acc.slug, result: `${status === 'ok' ? '✓' : '⚠'} ${status} ${eg.country} ${eg.ip}` });
      console.log(`  ${status === 'ok' ? '✓' : '⚠'} ${eg.country} ${eg.ip} → proxy_status='${status}'`);
    }
    await sleep(4000); // пауза между профилями — не душим клауд-слоты
  }
  console.log('\n=== ИТОГ ===');
  for (const o of out) console.log(`${o.result.padEnd(28)} ${o.slug}`);
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
