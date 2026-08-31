// closeone.cjs — закрыть ОДНО окно Orbita по его remote-debugging-порту через CDP (browser.close).
// БЕЗ pkill: порт уникален на окно → физически невозможно задеть чужое/личное окно. Снести всё нельзя в принципе.
// usage:
//   node closeone.cjs --list           показать все живые окна (порт, профиль, url) — ничего не закрывает
//   node closeone.cjs <port>           закрыть РОВНО одно окно по порту
//   node closeone.cjs --slug <slug>    закрыть окно фермового акка по slug (порт ищется по profile_id из БД)
const { chromium } = require('/Users/qq/Desktop/neironka-poster/node_modules/playwright-core');
const { execSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pid(profile) → port по живым процессам Orbita (та же логика, что в closelocal, но БЕЗ права что-то убивать)
function openProfiles() {
  const map = {};
  try {
    const out = execSync('ps -Ao command 2>/dev/null', { encoding: 'utf8', maxBuffer: 1 << 24 });
    for (const line of out.split('\n')) {
      if (!line.includes('gologin_profile_') || !line.includes('remote-debugging-port=')) continue;
      const port = (line.match(/remote-debugging-port=(\d+)/) || [])[1];
      const pid = (line.match(/gologin_profile_([a-f0-9]+)/) || [])[1];
      if (port && pid) map[port] = pid; // ключ = ПОРТ (уникален на окно)
    }
  } catch {}
  return map;
}

// закрыть окно по порту: подключаемся ИМЕННО к нему, closeContext → browser.close. Другие окна недостижимы.
async function closeByPort(port) {
  let b;
  try {
    b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 });
    for (const ctx of b.contexts()) { for (const p of ctx.pages()) await p.close().catch(() => {}); }
    await b.close().catch(() => {}); // рвёт CDP; окно Orbita на этом порту завершается
    return true;
  } catch (e) { if (b) await b.close().catch(() => {}); return String(e.message).slice(0, 60); }
}

(async () => {
  const A = process.argv[2];
  if (!A) { console.log('usage: node closeone.cjs --list | <port> | --slug <slug>'); process.exit(1); }
  const open = openProfiles();

  if (A === '--list') {
    const ports = Object.keys(open);
    console.log(`живых окон Orbita: ${ports.length}`);
    for (const port of ports) {
      let url = '';
      try { const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 6000 });
        const p = b.contexts()[0] && b.contexts()[0].pages()[0]; url = p ? p.url() : '(нет вкладки)'; await b.close().catch(() => {});
      } catch { url = '(CDP не ответил)'; }
      console.log(`  порт ${port} | профиль ${open[port]} | ${url.slice(0, 70)}`);
    }
    process.exit(0);
  }

  let port = A;
  if (A === '--slug') {
    const slug = process.argv[3];
    if (!slug) { console.log('нужен slug: node closeone.cjs --slug <slug>'); process.exit(1); }
    const { Client } = require('/Users/qq/Desktop/neironka-poster/node_modules/pg');
    const DBURL = require('fs').readFileSync('/tmp/dburl.txt', 'utf8').trim();
    const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect();
    const r = await c.query('SELECT gologin_profile_id pid FROM accounts WHERE lower(slug)=lower($1) AND deleted_at IS NULL', [slug]);
    await c.end();
    const pid = r.rows[0] && r.rows[0].pid;
    if (!pid) { console.log(`slug ${slug}: profile_id не найден в БД`); process.exit(1); }
    port = Object.keys(open).find((pt) => open[pt] === pid);
    if (!port) { console.log(`${slug} (профиль ${pid}): окно не открыто на маке`); process.exit(0); }
    console.log(`${slug} → профиль ${pid} → порт ${port}`);
  }

  if (!/^\d+$/.test(port)) { console.log(`порт должен быть числом, получено: ${port}`); process.exit(1); }
  if (!open[port]) { console.log(`⚠ на порту ${port} живого окна Orbita нет (уже закрыто?)`); process.exit(0); }
  console.log(`закрываю окно порт ${port} (профиль ${open[port]})...`);
  const ok = await closeByPort(port);
  await sleep(1200);
  const still = openProfiles()[port];
  console.log(ok === true && !still ? `✅ закрыто РОВНО одно окно (порт ${port}), остальные целы` : `результат: ${ok}, окно ${still ? 'ещё живо' : 'закрылось'}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
