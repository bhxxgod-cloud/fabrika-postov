// СМОТРИТЕЛЬ ОКНА (06.08, правило начальника: «хром с нейронкой оставляй открытым всегда»).
// Держит админ-профиль открытым на neironka.pro, пока конвейер простаивает: берёт лок,
// обновляет его mtime каждые 5 секунд (TTL его не спишет) и уступает за секунды, когда
// генерация кладёт файл /tmp/genkeeper.stop (это делает такLock всех скриптов). Внешний цикл
// keeperloop.sh перезапускает смотрителя после каждой генерации, окно возвращается само.
// Запуск: ./keeperloop.sh (не напрямую)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const PIDF = '/tmp/genkeeper.pid';
const STOP = '/tmp/genkeeper.stop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Ждём свободный лок: генерациям смотритель никогда не мешает, только заполняет простой.
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      await sleep(10000);
    }
  }
  fs.writeFileSync(PIDF, String(process.pid));
  try { fs.unlinkSync(STOP); } catch {}

  const { chromium } = require('playwright-core');
  const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log(new Date().toISOString(), 'смотритель: окно нейронки открыто');

  for (;;) {
    await sleep(5000);
    try { fs.utimesSync(LOCK, new Date(), new Date()); } catch {}
    if (fs.existsSync(STOP)) { try { fs.unlinkSync(STOP); } catch {} break; }
  }
  console.log(new Date().toISOString(), 'смотритель: уступаю окно генерации');
  await ctx.close().catch(() => {});
  try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {}
  try { fs.unlinkSync(PIDF); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error('смотритель упал:', e.message);
  try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {}
  try { fs.unlinkSync(PIDF); } catch {}
  process.exit(1);
});
