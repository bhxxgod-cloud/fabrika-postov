// ЛЕС/ПАРК-СЦЕНЫ ДЛЯ ВСЕХ ЛИЧНОСТЕЙ ФАБРИКИ (просьба владельца 04.08:
// «сделай шаблон с лесом на всех моделях — есть на полине и на карине, на всех переделай»).
// Контракт снят с живой формы: POST /api/admin/promo/scenes {personaId, sceneId} → {created:[...]}.
// Сцена «В парке» = 246e2abe-3738-4801-8cd1-c0a120edb723 (из селекта «Базовое фото»).
// Референс сцены фабрика берёт из пула самой личности, поэтому лица моделей сохраняются.
// Запуск: node forestscenes.cjs [sceneId]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROFILE = process.env.ADMIN_PROFILE || path.join(os.homedir(), '.neironka-admin-profile');
const LOCK = '/tmp/genposts.lock';
const SCENE = process.argv[2] || '246e2abe-3738-4801-8cd1-c0a120edb723'; // В парке
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeLock(waitMs = 15 * 60000) {
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
    catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim() || 0);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      // Лок держит СМОТРИТЕЛЬ окна (правило начальника 06.08: хром с нейронкой всегда открыт,
      // когда конвейер свободен) — просим его уступить и ждём.
      try { if (String(pid) === fs.readFileSync('/tmp/genkeeper.pid','utf8').trim()) fs.writeFileSync('/tmp/genkeeper.stop',''); } catch {}
      if (!alive) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      // TTL: генерация не живёт дольше 45 минут, всё старше = зависший лок (06.08 конвейер
      // дважды вставал из-за вечного лока после жёсткого убийства процесса).
      let stale = false; try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > 45 * 60000; } catch {}
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} continue; }
      if (Date.now() > until) throw new Error('профиль занят');
      await sleep(15000);
    }
  }
}
function freeLock() { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch {} }
process.on('exit', freeLock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { freeLock(); process.exit(0); });

(async () => {
  await takeLock();
  const { chromium } = require('playwright-core');
  const CHROME = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let ok = 0, bad = 0;   // считаем ФАКТ, а не число попыток (07.08)
  try {
    await page.goto('https://neironka.pro/admin/promo', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const personas = await page.evaluate(async () => {
      const r = await fetch('/api/admin/promo');
      return ((await r.json()).personas || []).map((p) => ({ id: p.id, name: p.name }));
    });
    console.log('личностей:', personas.map((p) => p.name).join(', '));
    for (const p of personas) {
      try {
        const res = await page.evaluate(async ({ pid, scene }) => {
          const x = await fetch('/api/admin/promo/scenes', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ personaId: pid, sceneId: scene }),
          });
          const j = await x.json().catch(() => ({}));
          return x.ok ? (j.created || []).map((c) => c.title).join(', ') : `HTTP ${x.status}`;
        }, { pid: p.id, scene: SCENE });
        // ГАЛОЧКА ТОЛЬКО НА УСПЕХ (07.08): здесь печаталось «✓» даже когда res это «HTTP 500»,
        // то есть провал API выглядел как выполненная работа.
        if (/^HTTP \d/.test(String(res))) { console.log(`  ✗ ${p.name}: фабрика отказала (${res})`); bad++; }
        else { console.log(`  ✓ ${p.name}: ${res}`); ok++; }
      } catch (e) { console.log(`  ✗ ${p.name}: ${String(e.message).slice(0, 60)}`); }
      await sleep(3000);
    }
  } finally { await ctx.close().catch(() => {}); freeLock(); }
  // ЧЕСТНЫЙ ИТОГ (07.08): раньше печаталось «заказаны» безусловно, даже если все упали.
  // Плюс ЯВНЫЙ ВЫХОД, иначе сокеты playwright держат процесс (инцидент fix4.cjs).
  console.log(`ИТОГ: лес-сцены заказаны для ${ok}, отказов ${bad}`);
  process.exit(bad && !ok ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e.message); freeLock(); process.exit(1); });
