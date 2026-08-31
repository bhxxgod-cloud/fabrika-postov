// QUEUE-SUPERVISOR — непрерывный комментинг по ОЧЕРЕДИ панели. Каждую волну ПЕРЕЧИТЫВАЕТ queued_at посты + живых акков,
// гоняет smartrun, ждёт финала, повторяет. Новые посты (жмёшь «В РАБОТЕ») → подхватываются со следующей волны.
// Дедуп (account_post_done) + дневной кап (12) уже в smartrun/БД → повторов и износа нет.
const { spawn } = require('child_process');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
// БД: сначала env (прод Railway: DB_PUBLIC_URL/DATABASE_URL), потом файл /tmp (локальный мак).
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
// Рабочая папка (smartjobs.json + логи волн): аргумент → env → temp. В проде engines.cjs запускает без аргумента.
const DIR = process.argv[2] || process.env.SUPERVISOR_DIR || path.join(require('os').tmpdir(), 'superwork');
fs.mkdirSync(DIR, { recursive: true });
const API = 'https://api.gologin.com';
const REST = ['may.tthewfields', 'поисковик'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function buildConfig() {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  // ГЕЙТ ОФОРМЛЕНИЯ (DRESS_GATE=1): в комментинг пускаем только акки с авой/именем (dressed_at). Акк-«яйцо»
  // ловит action_block на первом же комменте. По умолчанию ВЫКЛ, чтобы не остановить ферму, пока не оформлена.
  const dressGate = /^(1|true|yes)$/i.test(String(process.env.DRESS_GATE || '')) ? 'AND dressed_at IS NOT NULL' : '';
  const acc = (await c.query(`SELECT slug FROM accounts WHERE platform='comments' AND deleted_at IS NULL AND gologin_profile_id IS NOT NULL AND coalesce(session_status,'')='live' AND coalesce(ig_status,'')='login_ok' ${dressGate} ORDER BY created_at DESC NULLS LAST`)).rows.map((x) => x.slug).filter((s) => !REST.includes(s));
  await c.query(`CREATE TABLE IF NOT EXISTS post_restricted (code text PRIMARY KEY, ts timestamptz DEFAULT now())`).catch(() => {});
  // ПОСТЫ: очередь панели («В РАБОТЕ») + непроочередённые находки радара СО СПРОСОМ (demand_hits>0) — иначе 60 акков
  // выжирают 10 постов досуха и крутятся вхолостую (проверено: на выжатом посту 75 аскеров, у всех ans:1).
  // Порядок: сначала явно поставленные тобой, потом свежие находки, потом старый бэклог по score.
  // ТУМБЛЕР ПАНЕЛИ (флаг в БД, без редеплоя): commenter_enabled=false → движок ИДЛИТ, постов не берёт.
  // comments_per_post — сколько ответов на пост (крутилка в панели). Владелец рулит комментингом сам.
  const _cfg = (await c.query(`SELECT commenter_enabled, coalesce(comments_per_post,2) cpp FROM radar_config WHERE id=1`).catch(() => ({ rows: [{}] }))).rows[0] || {};
  if (!_cfg.commenter_enabled) { await c.end(); return { accounts: acc, posts: [], cta: '', perPost: 2, brandtop: 1, failfast: 6, conc: 1, stagger: 9000, target: 0, accountCap: 6, maxPosts: 0, maxRetry: 2, dailyCap: 12, disabled: true }; }
  const _rows = (await c.query(`SELECT code, work_accounts wa, work_perpost wp, work_brand wb, work_cta wc, work_target wt, work_dest wd FROM radar_posts
      WHERE code<>'DZQe5pIIP-C' AND coalesce(work_instructions,'')='' AND coalesce(worked_count,0)<200
        AND code NOT IN (SELECT code FROM post_restricted)
        AND (queued_at IS NOT NULL OR coalesce(demand_hits,0)>0)
      ORDER BY (queued_at IS NOT NULL) DESC, taken_at DESC NULLS LAST, score DESC`)).rows;
  const posts = _rows.map((x) => x.code);
  const _w = _rows[0] || {}; // параметры ТОП-поста (владелец запускает по одному → его выбор: акки/комменты/бренд)
  await c.end();
  // conc — бюджет владельца (22.07): 15 слотов GoLogin = комментинг 7 / патруль Алины 3 / логгер 3(до 5 в тревогу).
  // Комментингу отдаём 7 (тег пула 'commenting' в семафоре gologin.ts, его держит ЛОГГЕР — мы потребитель, не изобретаем).
  // no_connect у комментинга = в основном РЕАЛЬНО мёртвые профили (→ profile_lost primary), overcommit — редкий вторичный.
  // target — ПЛАН по комментам ТОП-поста (галочка в модалке): smartrun стопает запуск новых по достижении globalTotal>=target.
  // Владелец гонит по одному посту → target верхнего = его выбор. 0 = без лимита (крутим до дедупа/капа как раньше).
  return { accounts: acc, posts, cta: (_w.wc && String(_w.wc).trim()) || 'стиль,фон,взгляд,бот', perPost: Number(_w.wp || _cfg.cpp) || 2, brandtop: (_w.wb === false ? 0 : 1), failfast: 6, conc: Number(process.env.CONC_OVERRIDE || 7), stagger: 9000, target: Number(_w.wt) || 0, accountCap: Number(_w.wa) || 6, maxPosts: 2, maxRetry: 2, dailyCap: 12, dest: (_w.wd === 'bot' ? 'bot' : 'site') };
}
// снос капча-акков (spалённые чек-поинтом) — GoLogin профиль + строка БД. Гоняется перед каждой волной.
async function captchaSweep() {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  let rows = [];
  try { rows = (await c.query(`SELECT cd.slug, a.gologin_profile_id pid, g.gologin_token tok FROM captcha_dead cd LEFT JOIN accounts a ON a.slug=cd.slug AND a.platform='comments' LEFT JOIN account_groups g ON g.id=a.group_id`)).rows; } catch { await c.end().catch(() => {}); return; }
  for (const r of rows) {
    if (r.pid && r.tok) { try { await fetch(`${API}/browser/${r.pid}/web`, { method: 'DELETE', headers: { Authorization: `Bearer ${r.tok}` } }).catch(() => {}); await sleep(400); await fetch(`${API}/browser/${r.pid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${r.tok}` }, signal: AbortSignal.timeout(12000) }); } catch {} }
    await c.query(`DELETE FROM accounts WHERE slug=$1 AND platform='comments'`, [r.slug]).catch(() => {});
    await c.query(`DELETE FROM captcha_dead WHERE slug=$1`, [r.slug]).catch(() => {});
    console.log(`  ☠ снёс капча-акк: ${r.slug}`);
  }
  await c.end().catch(() => {});
  if (rows.length) console.log(`  капча-снос: удалено ${rows.length}`);
}
// АВТО-СНЯТИЕ share-restricted: IG-ограничение «нельзя делиться ссылками» истекает само (~30 дней). Возвращаем акк
// в пул: ig_status restricted → login_ok (если сессия жива) и чистим запись. Иначе такие акки терялись навсегда.
async function liftShareRestricted() {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS share_restricted (slug text PRIMARY KEY, ig_login text, ts timestamptz DEFAULT now())`).catch(() => {});
    const days = Number(process.env.SHARE_RESTRICT_DAYS || 30);
    const r = await c.query(
      `UPDATE accounts a SET ig_status='login_ok'
         FROM share_restricted s
        WHERE a.slug=s.slug AND a.platform='comments' AND a.ig_status='restricted'
          AND coalesce(a.session_status,'')='live' AND s.ts < now() - ($1 || ' days')::interval
        RETURNING a.slug`, [String(days)]);
    if (r.rowCount) { await c.query(`DELETE FROM share_restricted WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]).catch(() => {}); console.log(`  🔗✅ share-restrict снят (прошло ${days}д): ${r.rows.map((x) => x.slug).join(', ')}`); }
  } catch (e) { console.log('  (share-lift err:', (e.message || '').slice(0, 40) + ')'); } finally { await c.end().catch(() => {}); }
}
function runWave() {
  return new Promise((res) => {
    const out = fs.openSync(`${DIR}/smart.log`, 'a'); // append: копим все волны в один лог
    const ch = spawn('node', ['smartrun.cjs', DIR], { cwd: __dirname, env: process.env, stdio: ['ignore', out, out] });
    ch.on('exit', () => { fs.closeSync(out); res(); });
  });
}
(async () => {
  for (let wave = 1; ; wave++) {
    await captchaSweep().catch(() => {}); // снос спалённых капчей акков перед волной
    await liftShareRestricted().catch(() => {}); // возврат акков, у кого истекло share-ограничение (~30 дней)
    const cfg = await buildConfig();
    if (!cfg.posts.length) { console.log(`[волна ${wave}] очередь пуста — жду 15 мин, добавь посты в панели`); await sleep(15 * 60000); continue; }
    fs.writeFileSync(`${DIR}/smartjobs.json`, JSON.stringify(cfg, null, 1));
    console.log(`\n=== ВОЛНА ${wave} === акков ${cfg.accounts.length}, постов из очереди ${cfg.posts.length}: ${cfg.posts.join(',')}`);
    await runWave();
    console.log(`=== ВОЛНА ${wave} завершена, пауза 60с, перечитываю очередь ===`);
    await sleep(60000);
  }
})().catch((e) => { console.error('SUPERVISOR FATAL', e.message); process.exit(1); });
