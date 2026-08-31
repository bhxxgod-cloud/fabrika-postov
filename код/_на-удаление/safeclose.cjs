// safeclose.cjs — БЕЗОПАСНО закрыть локальный профиль С СИНКОМ кук в облако (не killWindow, иначе куки теряются
// при следующем startLocal — он перезаписывает user-data-dir облачным профилем). gl.stopLocal({posting:true}) с
// uploadCookiesToServer=true заливает свежие куки входа в облачный профиль. usage: node safeclose.cjs <slug>
const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
const DBURL = require('fs').readFileSync('/tmp/dburl.txt', 'utf8').trim();
const SLUG = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, statement_timeout: 8000 }); await c.connect();
  const a = (await c.query('SELECT a.gologin_profile_id pid, coalesce(g.gologin_token,$2) tok FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE lower(a.slug)=lower($1) LIMIT 1', [SLUG, require('fs').readFileSync(process.env.HOME + '/.gltok_tmp', 'utf8').trim()])).rows[0];
  await c.end();
  if (!a) { console.log('акк не найден'); return; }
  const { default: GoLogin } = await import('gologin');
  const gl = new GoLogin({ token: a.tok, profile_id: a.pid, uploadCookiesToServer: true });
  console.log(`безопасно закрываю ${SLUG} (синк кук в облако)…`);
  // stopLocal с posting:true → uploadCookiesToServer заливает свежие куки входа + гасит Orbita. Bounded, чтобы не висеть.
  let ok = false;
  await Promise.race([
    (async () => { try { await gl.stopLocal({ posting: true }); ok = true; } catch (e) { console.log('stopLocal:', String(e.message).slice(0, 60)); } })(),
    sleep(25000),
  ]);
  await sleep(1500);
  console.log(ok ? '✅ закрыто С СИНКОМ кук в облако (uploadCookiesToServer)' : '⚠ stopLocal не подтвердил (проверю окно)');
  // подстраховка: если Orbita осталась — гасим точечно (куки уже синканы выше)
  try { require('child_process').execSync(`pkill -f "gologin_profile_${a.pid}"`, { stdio: 'ignore' }); } catch {}
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
