// ЧИСТИЛЬЩИК ВКЛАДОК АДМИН-ХРОМА (11.08). Каждая сборка поста открывает свою вкладку в общем
// статичном Chrome. Если вкладка не закрылась (упавшая полоса, таймаут), они накапливаются:
// ночью их было 31, и connectOverCDP перестал укладываться в свои 4 секунды, из-за чего волна
// получала «статичный Chrome не поднялся» и ложилась целиком. Держим не больше 4 лишних вкладок.
'use strict';
const { chromium } = require('playwright');
const PORT = Number(process.env.ADMIN_CDP_PORT || 9222);
(async () => {
  const br = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 8000 });
  const ctx = br.contexts()[0]; const pages = ctx.pages();
  console.log(`вкладок сейчас: ${pages.length}`);
  let закрыл = 0;
  for (const p of pages.slice(0, Math.max(0, pages.length - 4))) {
    const u = p.url();
    if (/neironka\.pro\/admin/.test(u) || u === 'about:blank') { try { await p.close(); закрыл++; } catch {} }
  }
  console.log(`закрыл: ${закрыл}, осталось: ${ctx.pages().length}`);
  await br.close();
})().catch((e) => console.log('чистильщик: ' + e.message.slice(0, 80)));
