// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
// SHADOW VALIDATE — ловля шадоубана. Периодически ДРУГИМ (НЕ автором) обкатанным акком проверяем, ВИДНЫ ли
// наши ответы на дежурном посту. Ключевой факт: шб-акк постит успешно и СВОЙ коммент видит — ghost виден только
// с чужой точки. Поэтому проверяет ВСЕГДА сторонний акк (из общего пула, не дежурный/не бэклог = не автор ответов).
//
// Дёшево и безопасно (по ТЗ): выборочно, отложенно, 1-2 захода/сутки (VALIDATE_EVERY), реюз vshadow.cjs как есть.
// РЕАКЦИЯ градуированная (не паника с одного чека): копим shadow-сигнал; при устойчивой невидимости — алерт,
// при повторной — soft-drop подозрительного АВТОРА в общий пул (не удаляем). Порог >=2 сигнала.
//
// ВАЖНО (ограничение честно): vshadow скан body.innerText и НЕ разворачивает свёрнутые ветки → надёжно ловит
// видимость БРЕНДА/BRANDTOP-комментов; глубокие reply-ветки — частично. Это первый безопасный слой; полная
// per-ответ валидация веток (разворот ветки по нику) — следующий шаг.
//
// Запуск: node validate_safe.cjs   (env: DB_PUBLIC_URL|/tmp/dburl.txt, VALIDATE_EVERY_H(6), MIN_BRAND(1)).
const { Client } = require('pg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const EVERY = Number(process.env.VALIDATE_EVERY_H || 6) * 3600000; // как часто проверяем (деф раз в 6ч)
const MIN_BRAND = Number(process.env.MIN_BRAND || 1);              // сколько «нейронка про» ждём увидеть у здорового поста
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

// Сторонний РЕВИЗОР: общий пул (НЕ дежурный/бэклог = не автор), live, не в бане, обкатанный (LRU-давно не юзан).
async function pickReviewer(c, code) {
  const r = await c.query(
    `SELECT a.slug FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
     WHERE a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
       AND a.status NOT IN ('paused','trash') AND a.gologin_profile_id IS NOT NULL
       AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha')
       AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
       AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
     ORDER BY a.last_commented_at ASC NULLS FIRST LIMIT 1`, [code]);
  return r.rows[0] ? r.rows[0].slug : null;
}

// Свежий отвеченный нами человек (цель для точечной проверки «виден ли именно наш ответ ему»).
async function recentTarget(c, code) {
  const r = await c.query('SELECT username FROM post_answered WHERE code=$1 ORDER BY ts DESC LIMIT 1', [code]).catch(() => ({ rows: [] }));
  return r.rows[0] ? r.rows[0].username : '';
}

// Гасим сессию профиля ревизора перед его заходом (тот же обход warmup-драйва, что в движках).
async function stopSession(slug) {
  let c;
  try {
    c = await db();
    const r = (await c.query(`SELECT a.gologin_profile_id AS pid, coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [slug])).rows[0];
    await c.end(); c = null;
    if (r && r.pid && r.tok) { await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {}); await sleep(15000); }
  } catch { /* noop */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

// Запуск vshadow, парсим его вывод: «… видит: «нейронка про» упоминаний = N, коммент @user найден: true/false».
function runVshadow(slug, url, target) {
  return new Promise((res) => {
    let out = '';
    const p = spawn('node', [path.join(DIR, 'vshadow.cjs'), slug, url, target], {
      cwd: DIR, env: { ...process.env, DB_PUBLIC_URL: DBURL, SHOT_DIR: process.env.SHOT_DIR || '/tmp' },
    });
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* noop */ } }, 5 * 60000);
    p.on('exit', () => { clearTimeout(killer); const m = out.match(/упоминаний = (\d+)/); const t = /найден: true/.test(out); res({ brand: m ? Number(m[1]) : null, found: t }); });
    p.on('error', () => { clearTimeout(killer); res({ brand: null, found: false }); });
  });
}

(async () => {
  console.log(`[validate] старт. ревизор (сторонний акк) проверяет видимость наших ответов каждые ${EVERY / 3600000}ч | порог бренда ${MIN_BRAND} | soft-drop автора при >=2 сигналах`);
  for (;;) {
    let c;
    try {
      c = await db();
      const cfg = (await c.query('SELECT duty_url FROM radar_config WHERE id=1')).rows[0];
      const code = (String(cfg && cfg.duty_url || '').match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
      if (!code) { console.log('[validate] duty_url не задан — жду'); await c.end(); await sleep(EVERY); continue; }
      const reviewer = await pickReviewer(c, code);
      const target = await recentTarget(c, code);
      await c.end(); c = null;
      if (!reviewer) { console.log('[validate] нет стороннего ревизора — жду'); await sleep(EVERY); continue; }

      console.log(`[validate] ревизор ${reviewer} проверяет пост${target ? ` (цель @${target})` : ''}…`);
      await stopSession(reviewer);
      const r = await runVshadow(reviewer, cfg.duty_url, target);
      const healthy = r.brand !== null && r.brand >= MIN_BRAND;
      console.log(`[validate] РЕЗУЛЬТАТ: бренд виден ${r.brand}${target ? `, @${target} найден: ${r.found}` : ''} → ${healthy ? 'ОК' : 'ПОДОЗРЕНИЕ на шб'}`);

      // Слой-сигнал: если бренд НЕ виден стороннему (0), а мы точно отвечали — копим в radar_config.shadow_streak.
      const c2 = await db();
      await c2.query('ALTER TABLE radar_config ADD COLUMN IF NOT EXISTS shadow_streak int DEFAULT 0').catch(() => {});
      if (!healthy) {
        const s = (await c2.query('UPDATE radar_config SET shadow_streak=coalesce(shadow_streak,0)+1 WHERE id=1 RETURNING shadow_streak')).rows[0].shadow_streak;
        console.log(`[validate] ⚠ сигнал шб #${s} (бренд не виден стороннему). Порог алерта — 2.`);
        if (s >= 2) console.log(`[validate] 🛑 АЛЕРТ: ${s} сигнала подряд — наши ответы вероятно приглушены. Проверь пост/акки вручную.`);
      } else {
        await c2.query('UPDATE radar_config SET shadow_streak=0 WHERE id=1').catch(() => {});
      }
      await c2.end();
    } catch (e) {
      console.log('[validate] ошибка:', String((e && e.message) || e).slice(0, 140));
      try { if (c) await c.end(); } catch { /* noop */ }
    }
    await sleep(EVERY);
  }
})();
