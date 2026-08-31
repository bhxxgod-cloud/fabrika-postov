// AUTOSCAN — сайт САМ анализирует найденные посты (режим 2: авто-анализ, запуск владельца).
// Каждый цикл: берёт 1 свежий ненасканенный (или устаревший скан) пост радара → гонит vcomment SCAN тем же
// образом, что кнопка 🔍 в панели → сохраняет scan_tier/unanswered/total. Карточка приходит уже с цифрой спроса,
// владельцу остаётся жать ЗАПУСК. По одному за цикл + пауза = бережём облачные часы GoLogin.
// Гейты: radar_config.autoscan_enabled (тумблер) + AUTOSCAN_OFF=1 (env). Пауза AUTOSCAN_GAP_MIN (деф 4 мин).
const { spawn } = require('child_process');
const { Client } = require('pg');
const fs = require('fs');
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const DEF_CTA = 'бот,стиль,фон,взгляд,промпт,промт,гайд,скинь,хочу';
const GAP = Math.max(1, Number(process.env.AUTOSCAN_GAP_MIN) || 4) * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickReader(c) {
  // РОТАЦИЯ: случайный из 8 наименее занятых здоровых воркеров — НЕ долбим одного (иначе IG кидает на чек-поинт → 0).
  const r = await c.query(`SELECT slug FROM (
      SELECT a.slug, coalesce(a.comments_today,0) ct FROM accounts a JOIN account_groups g ON g.id=a.group_id
      WHERE g.role='worker' AND a.deleted_at IS NULL AND a.session_status='live' AND a.gologin_profile_id IS NOT NULL
        AND coalesce(a.ig_status,'')='login_ok' ORDER BY ct ASC LIMIT 8
    ) s ORDER BY random() LIMIT 1`).catch(() => ({ rows: [] }));
  return r.rows[0]?.slug || null;
}
async function pickPost(c) {
  // свежий (окно спроса 4 дня), НЕ запущенный, ещё не сканенный ИЛИ скан устарел (>8ч → пересканить горячий).
  // Приоритет: сперва вообще не сканенные, потом по score. Ограничения restricted/dismissed отсекаем.
  const r = await c.query(`SELECT code, url, coalesce(nullif(work_cta,''),$1) cta FROM radar_posts
    WHERE coalesce(status,'') NOT IN ('dismissed','post_restricted','done')
      AND code NOT IN (SELECT code FROM post_restricted)
      AND queued_at IS NULL
      AND created_at > now() - interval '4 days'
      AND (scan_at IS NULL OR scan_at < now() - interval '8 hours')
    ORDER BY (scan_at IS NULL) DESC, coalesce(score,0) DESC, created_at DESC LIMIT 1`, [DEF_CTA]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}
function runScan(drv, code, cta) {
  return new Promise((resolve) => {
    const url = `https://www.instagram.com/p/${code}/`; // /p/ а не /reel/ (на /reel/ панель не открывается)
    const p = spawn('node', ['vcomment.cjs', drv, url, '5'], { cwd: __dirname, env: { ...process.env, SCAN: '1', MAXH: '168', CTA_WORDS: cta, SHOT_DIR: process.env.SHOT_DIR || '/tmp', DB_PUBLIC_URL: DBURL } });
    let buf = ''; p.stdout.on('data', (d) => { buf += d; }); p.stderr.on('data', (d) => { buf += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(buf); }, 150000);
    p.on('close', () => { clearTimeout(t); resolve(buf); });
  });
}
function parseScan(out) {
  const m = out.match(/SCAN_JSON (\{[^\n]*\})/);
  let j = { total: 0, unanswered: 0 }; try { if (m) j = JSON.parse(m[1]); } catch { /* ignore */ }
  const restricted = /ОГРАНИЧЕНЫ|post_restricted/i.test(out);
  const found = Number(j.total) || 0, un = Number(j.unanswered) || 0;
  const volNums = (out.match(/(\d+)\s*комментов/g) || []).map((s) => parseInt(s, 10) || 0);
  const vol = Math.max(found, ...(volNums.length ? volNums : [0]));
  const tier = restricted ? 'restricted' : vol >= 100 ? 'tier1' : vol >= 30 ? 'tier2' : vol >= 5 ? 'tier3' : 'tier4';
  // connected = реально зашли и открыли панель. Если коннект сорвался (шторм GoLogin 503 / профиль не поднялся),
  // это НЕ «0 комментов», а сбой → НЕ записываем ложный tier4/0 и не жжём scan_at на 8ч, попробуем позже.
  const connected = /панель коммент(ов)? открыт/i.test(out) && !/Failed to start|503|не подключил|штормит|ПРЕДОХРАНИТЕЛЬ/i.test(out);
  return { un, vol, tier, restricted, connected };
}
(async () => {
  console.log('[autoscan] старт, пауза между сканами', GAP / 60000, 'мин');
  for (let cycle = 1; ; cycle++) {
    if (/^(1|true|yes)$/i.test(String(process.env.AUTOSCAN_OFF || ''))) { await sleep(GAP); continue; }
    const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
    let post = null, drv = null, enabled = true;
    try {
      await c.connect();
      const cfg = (await c.query(`SELECT coalesce(autoscan_enabled,true) e FROM radar_config WHERE id=1`).catch(() => ({ rows: [{ e: true }] }))).rows[0] || { e: true };
      enabled = cfg.e !== false;
      if (enabled) { post = await pickPost(c); if (post) drv = await pickReader(c); }
    } catch (e) { console.log('[autoscan] db err:', (e.message || '').slice(0, 60)); }
    finally { await c.end().catch(() => {}); }

    if (!enabled) { console.log(`[autoscan] выключен тумблером — жду`); await sleep(GAP); continue; }
    if (!post) { console.log(`[autoscan] нечего сканить — жду`); await sleep(GAP); continue; }
    if (!drv) { console.log(`[autoscan] нет живого читателя — жду`); await sleep(GAP); continue; }

    console.log(`[autoscan] цикл ${cycle}: скан ${post.code} читателем ${drv} (cta=${post.cta.slice(0, 40)})`);
    const out = await runScan(drv, post.code, post.cta);
    const { un, vol, tier, restricted, connected } = parseScan(out);
    if (!connected) {
      // коннект сорвался (шторм GoLogin / профиль не встал) — НЕ пишем ложный 0, бэк-офф ×3 чтобы дать облаку прийти в себя
      console.log(`[autoscan] ${post.code}: коннект НЕ удался (шторм?) — не записываю, бэк-офф ${(GAP * 3) / 60000} мин`);
      await sleep(GAP * 3);
      continue;
    }
    const c2 = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
    try { await c2.connect(); await c2.query(`UPDATE radar_posts SET scan_unanswered=$2, scan_total=$3, scan_tier=$4, scan_at=now() WHERE code=$1`, [post.code, un, vol, tier]); } catch (e) { console.log('[autoscan] сохранение err:', (e.message || '').slice(0, 60)); } finally { await c2.end().catch(() => {}); }
    console.log(`[autoscan] ${post.code}: ${tier}, комментов ${vol}, спрос-неотвечено ${un}${restricted ? ' (ОГРАНИЧЕН)' : ''}`);
    await sleep(GAP);
  }
})().catch((e) => { console.error('[autoscan] FATAL', e.message); process.exit(1); });
