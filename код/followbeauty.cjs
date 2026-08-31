// ПОДПИСКИ НА ТЕМАТИЧЕСКИЕ АККАУНТЫ (бьюти, РФ).
//
// Зачем: у наших девочек по 3 подписчика и ноль подписок — профиль читается как пустышка,
// и алгоритм не понимает, кому его показывать. Подписки на бьюти-аккаунты решают обе задачи:
// профиль выглядит живым, а лента и рекомендации подтягиваются к нужной аудитории.
//
// ПОЧЕМУ ОСТОРОЖНО. Массовые подписки — классический триггер блокировки, особенно на молодом
// аккаунте. Поэтому:
//   • не больше 8 подписок за прогон и 15 в сутки на аккаунт (лимиты IG начинаются заметно выше,
//     но мы и так теряем акки, запас нужен);
//   • пауза 40-90 секунд между подписками, вразнобой — ровный интервал сам по себе выдаёт бота;
//   • перед подпиской заходим на профиль и смотрим его, как это делает человек;
//   • акк моложе 3 суток с оформления не трогаем вовсе (правило разнесения действий).
//
// Запуск: node followbeauty.cjs <slug> [сколько]
'use strict';
const fs = require('node:fs');
const { Client } = require('pg');
const { chromium } = require('playwright-core');
const L = require('./iglib.cjs');

const SLUG = process.argv[2];
const WANT = Math.min(Number(process.argv[3] || 6), 8);
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const DAILY_CAP = Number(process.env.FOLLOW_DAILY_CAP || 15);

// Кого подписываем: русскоязычные бьюти-аккаунты — журналы, блогеры, салоны, косметика.
// Список правится руками: подписка это лицо аккаунта, случайных сюда пускать не нужно.
// Список ПРОВЕРЕН запросами к профилям (ревизия 03.08). Первая версия была собрана по памяти и
// оказалась мусорной: из 23 ников жили 7, причём среди них попались самозванцы — «goldapple_ru»
// с шестью подписчиками вместо настоящего магазина и «rivegauche_official», раздающий
// несуществующие сертификаты. Подписка на такое портит лицо аккаунта, поэтому список правится
// только с проверкой.
const TARGETS = [
  // журналы и бьюти-медиа
  'the_voice_mag', 'peopletalkru', 'glamour_russia', 'wonderzine_mag',
  'beautyhackru', 'beautyinsider',
  // блогеры и визажисты
  'goar_avetisyan', 'maria__way', 'anastasile', 'dr_altunyan', 'serdar_kambarov',
  'aveme_lissa', 'bainur_beauty', 'alena.pogrebnyak', 'elenakrygina', 'mira_att',
  'sonya_miro', 'natalinamua', 'elenmanasir_beauty', 'olga_fox', 'elya_bulochka',
  'teperikova_hair', 'girls_degree', 'koffka_the_cat', 'style_look_guide',
  'aliyab_hair', 'mamrovskaya', 'mariiamilli', 'polikova_beauty', 'pro.kosmetyku',
  'burobeauty',
  // магазины и бренды
  'letoile_official', 'goldapple', 'mixit_ru', 'rivegaucheru', 'viviennesabo.official',
  'art_visage', 'krygina.cosmetics', 'naturasiberica_ru', 'siberina_cosmetics',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

global.__GL = null;
async function closeLocal() {
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), sleep(6000)]); if (gl.killBrowser) gl.killBrowser(); } catch {}
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await closeLocal(); process.exit(0); });

(async () => {
  if (!SLUG) { console.log('usage: node followbeauty.cjs <slug> [сколько]'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const row = (await c.query(
    `SELECT a.id, coalesce(a.ig_login,a.slug) h, a.persona, a.ig_cookies, a.gologin_profile_id pid,
            a.dressed_at, a.session_status, g.gologin_token tok,
            (SELECT count(*) FROM account_events e WHERE e.account_id=a.id AND e.kind='follow'
               AND e.created_at > now() - interval '24 hours') today_n
       FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
      WHERE a.slug=$1 AND a.deleted_at IS NULL`, [SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ акк не найден'); await c.end(); process.exit(1); }
  if (row.session_status !== 'live') { console.log(`ИТОГ: ✗ сессия ${row.session_status} — акк не открываем`); await c.end(); process.exit(0); }

  // Свежеоформленный акк не трогаем: подписки поверх смены авы и ника = набор действий,
  // который IG читает как перехват (правило разнесения, 03.08).
  const dressedAgoH = row.dressed_at ? (Date.now() - new Date(row.dressed_at).getTime()) / 3600000 : 0;
  if (!row.dressed_at || dressedAgoH < 6) {
    console.log(`ИТОГ: ⏳ акк оформлен ${Math.round(dressedAgoH)}ч назад — подписки после 6ч`);
    await c.end(); process.exit(0);
  }
  const todayN = Number(row.today_n || 0);
  if (todayN >= DAILY_CAP) { console.log(`ИТОГ: суточный лимит подписок исчерпан (${todayN}/${DAILY_CAP})`); await c.end(); process.exit(0); }

  // На кого уже подписаны — второй раз не ходим.
  const done = new Set((await c.query(
    `SELECT detail->>'target' t FROM account_events WHERE account_id=$1 AND kind='follow'`, [row.id]))
    .rows.map((x) => x.t).filter(Boolean));
  const pool = TARGETS.filter((t) => !done.has(t)).sort(() => Math.random() - 0.5);
  if (!pool.length) { console.log('ИТОГ: все цели из списка уже отработаны'); await c.end(); process.exit(0); }

  const limit = Math.min(WANT, DAILY_CAP - todayN, pool.length);
  console.log(`ПОДПИСКИ @${row.h} (${row.persona}): планирую ${limit}, сегодня уже ${todayN}/${DAILY_CAP}`);

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  let ok = 0;
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    try { const cks = L.normCookies(row.ig_cookies); if (cks.length) await ctx.addCookies(cks); } catch {}

    // БИО (05.08, начальник: «почему нет описания — ак неживой»). Если env BIO_TEXT задан и
    // у акка пустое био, вписываем ПЕРЕД подписками: одна сессия = один вход, меньше палева.
    if (process.env.BIO_TEXT) {
      try {
        await page.goto('https://www.instagram.com/accounts/edit/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(5000);
        await L.clearOverlays(page);
        const bio = page.locator('textarea#pepBio, textarea[aria-label*="Bio" i], textarea[name="biography"]').first();
        if (await bio.isVisible({ timeout: 8000 }).catch(() => false)) {
          const cur = (await bio.inputValue().catch(() => '')) || '';
          if (cur.trim().length < 3) {
            await bio.fill(process.env.BIO_TEXT.slice(0, 140));
            await sleep(1000);
            const save = page.getByRole('button', { name: /Submit|Save|Отправить|Сохранить/i }).first();
            if (await save.isVisible({ timeout: 4000 }).catch(() => false)) { await save.click(); await sleep(4000); console.log('  ✓ био вписано'); }
            else console.log('  ⚠ кнопка сохранения био не найдена');
          } else console.log('  · био уже есть, не трогаю');
        } else console.log('  ⚠ поле био не нашлось');
      } catch (e) { console.log('  ⚠ био: ' + String(e.message).slice(0, 60)); }
    }

    for (const target of pool.slice(0, limit)) {
      await page.goto(`https://www.instagram.com/${target}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(rnd(4000, 8000));
      await L.clearOverlays(page);

      const cls = await L.classifyScreen(ctx, page);
      if (cls.state !== 'logged_in') { console.log(`  ⛔ сессия слетела (${cls.state}) — останавливаюсь`); break; }

      // Кнопка Follow. Если уже подписаны — там будет Following/Requested, такое пропускаем.
      const btn = page.getByRole('button', { name: /^(Follow|Подписаться)$/i }).first();
      if (!(await btn.isVisible({ timeout: 6000 }).catch(() => false))) {
        console.log(`  – @${target}: кнопки подписки нет (уже подписаны или приватный)`);
        await sleep(rnd(8000, 15000));
        continue;
      }
      await L.clickSafe(page, btn, `подписка на ${target}`);
      await sleep(rnd(2500, 4500));

      // Успех = кнопка сменилась на Following. Проверяем фактом, а не «клик не упал».
      // 05.08: getByRole со строгим ^Following$ перестал матчиться — в вёрстке к имени кнопки
      // приклеена стрелка выпадашки. Смотрим фактический innerText видимых кнопок (как в дампе).
      const followed = await page.evaluate(() =>
        [...document.querySelectorAll('button, div[role="button"]')]
          .filter((b) => b.offsetParent !== null)
          .some((b) => /^(Following|Requested|Вы подписаны|Запрос отправлен)\b/i.test((b.innerText || '').trim()))
      ).catch(() => false);
      if (followed) {
        ok++;
        // detail — jsonb: голая строка роняет вставку, а ошибка глохла в .catch, из-за чего
        // события не писались ВООБЩЕ и лимит с дедупом были фикцией (найдено ревизией 03.08).
        await c.query(`INSERT INTO account_events (account_id, slug, platform, kind, detail)
                       VALUES ($1,$2,'instagram','follow',$3::jsonb)`,
          [row.id, SLUG, JSON.stringify({ target })])
          .catch((e) => console.log(`     ⚠ событие не записалось: ${String(e.message).slice(0, 80)}`));
        console.log(`  ✓ подписались на @${target} (${ok}/${limit})`);
      } else {
        // Не подтвердилось — НЕ гадаем о причине, а смотрим, что реально на экране: тексты кнопок
        // и наличие модалки. Иначе «вероятен лимит» может оказаться просто другим словом на кнопке.
        const seen = await page.evaluate(() => ({
          buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
            .map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 14),
          dialog: !!document.querySelector('div[role="dialog"]'),
          body: (document.body.innerText || '').slice(0, 160).replace(/\n+/g, ' | '),
        })).catch(() => ({}));
        console.log(`  ⚠ @${target}: подписка не подтвердилась`);
        console.log(`     кнопки: ${JSON.stringify(seen.buttons || [])}`);
        if (seen.dialog) console.log('     на экране модалка');
        // Явные признаки придержания — тогда стоп. Иначе пробуем следующую цель.
        if (/try again later|action blocked|ограничен|подождите/i.test(String(seen.body || ''))) {
          console.log('     это ограничение действий — останавливаюсь');
          break;
        }
        await sleep(rnd(20000, 40000));
        continue;
      }
      if (ok < limit) await sleep(rnd(40000, 90000));   // человеческая пауза между подписками
    }
  } catch (e) {
    console.log(`  ⛔ ошибка: ${String(e.message).slice(0, 140)}`);
  } finally { await closeLocal(); }

  console.log(`ИТОГ: подписались на ${ok} аккаунт(ов)`);
  await c.end();
  process.exit(0);
})();
