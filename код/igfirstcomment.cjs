// ДОБИВКА ПЕРВОГО КОММЕНТА на уже опубликованном промо-ролике (когда igpost2 успел опубликовать,
// но коммент не встал). Один заход = одно действие + пересъём кук. Логика коммента — ТОЛЬКО в iglib.
// Запуск: node igfirstcomment.cjs "<slug>" "<post_id>"
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const fs = require('fs');
const L = require('./iglib.cjs');
const SLUG = process.argv[2];
const POST_ID = process.argv[3];
const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SHOT = process.env.SHOT_DIR || '/tmp';

global.__GL = null;
let __closing = false;
async function closeLocal(why) {
  if (__closing) return; __closing = true;
  const gl = global.__GL; if (!gl) return;
  try { await Promise.race([gl.stopLocal({ posting: true }).catch(() => {}), L.sleep(6000)]); if (typeof gl.killBrowser === 'function') gl.killBrowser(); console.log(`  ⏹ окно закрыто (${why})`); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeLocal(sig); process.exit(0); });
process.on('uncaughtException', async (e) => { console.log('UNCAUGHT', e.message); await closeLocal('uncaught'); process.exit(1); });

(async () => {
  if (!SLUG || !POST_ID) { console.log('usage: node igfirstcomment.cjs <slug> <post_id>'); process.exit(1); }
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
  const row = (await c.query(
    `SELECT p.id, p.external_url, p.reply_text, p.meta, a.id aid, a.gologin_profile_id pid, a.ig_cookies,
            coalesce(a.ig_login,a.slug) h, a.persona, g.gologin_token tok
       FROM posts p JOIN accounts a ON a.id=p.account_id JOIN account_groups g ON g.id=a.group_id
      WHERE p.id=$1 AND a.slug=$2 AND p.status='published'`, [POST_ID, SLUG])).rows[0];
  if (!row) { console.log('ИТОГ: ✗ опубликованный пост не найден'); await c.end(); process.exit(1); }
  if (!row.external_url || !row.reply_text) { console.log('ИТОГ: ✗ нет external_url или reply_text'); await c.end(); process.exit(1); }
  if (row.meta && row.meta.first_comment) { console.log('ИТОГ: коммент уже стоит — повтор запрещён (дедуп)'); await c.end(); process.exit(0); }

  const cks = L.normCookies(row.ig_cookies);
  const expectedId = L.pickCookie(cks, 'ds_user_id');
  if (!expectedId || (L.pickCookie(cks, 'sessionid') || '').length <= 10) { console.log('ИТОГ: ✗ нет кук сессии'); await c.end(); process.exit(1); }
  console.log(`КОММЕНТ для «${row.persona}» на ${row.external_url}`);

  const { default: GoLogin } = await import('gologin');
  const gl = global.__GL = new GoLogin(L.glOpts({ token: row.tok, profile_id: row.pid }));
  let ok = false, err = null;
  try {
    const st = await gl.startLocal();
    if (!st || !st.wsUrl) throw new Error('startLocal без wsUrl');
    const b = await chromium.connectOverCDP(st.wsUrl, { timeout: 60000 });
    const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
    await L.hardenContext(ctx);
    await ctx.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }).catch(() => {});
    await ctx.addCookies(cks);
    await page.goto('https://www.instagram.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await L.sleep(5000); await L.clearOverlays(page);
    await L.step(page, SHOT, 'сессия', async () => {
      const cls = await L.classifyScreen(ctx, page);
      if (cls.state !== 'logged_in') throw new Error(`экран=${cls.state} (${cls.evidence})`);
      if (String(cls.dsUserId) !== String(expectedId)) throw new Error(`чужая сессия: ${cls.dsUserId} вместо ${expectedId}`);
    });
    await L.step(page, SHOT, 'первый коммент', () => L.postFirstComment(page, row.external_url, String(row.reply_text)));
    await c.query(`UPDATE posts SET meta = coalesce(meta,'{}'::jsonb) || '{"first_comment":true}' WHERE id=$1`, [row.id]);
    ok = true;
    try {
      const fresh = (await ctx.cookies('https://www.instagram.com')).filter((x) => x.name && x.value);
      if (fresh.some((x) => x.name === 'sessionid' && x.value.length > 10)) { await c.query(`UPDATE accounts SET ig_cookies=$2 WHERE id=$1`, [row.aid, JSON.stringify(fresh)]); console.log(`  🔄 куки пересохранены (${fresh.length})`); }
    } catch {}
    await b.close().catch(() => {});
  } catch (e) { err = String(e.message).slice(0, 200); }
  console.log(`ИТОГ: ${ok ? '✅ коммент стоит и виден' : '✗ не вышло: ' + err}`);
  await closeLocal('finish');
  await c.end();
  process.exit(0);
})().catch(async (e) => { console.log('FATAL', e.message); await closeLocal('fatal'); process.exit(1); });
