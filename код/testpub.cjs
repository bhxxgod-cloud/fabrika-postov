// Диагностика: блокирует ли IG САМ АКК или конкретный ТЕКСТ (брендовую фразу).
// Меняем ровно одну переменную — текст — на том же акке и посту. Ничего не закрываем.
const { chromium } = require('playwright-core');
const CDP = process.env.CDP, TEXT = process.argv[2], SHOT = process.argv[3] || '/tmp/testpub.png';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP(CDP, { timeout: 60000 });
  const page = b.contexts()[0].pages().find(p => /instagram/.test(p.url()));
  await page.goto('https://www.instagram.com/p/DZQe5pIIP-C/?hl=ru', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
  for (let i=0;i<15;i++){ const n = await page.evaluate(()=>Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&/^Ответить$/.test((e.textContent||'').trim())).length).catch(()=>0); if(n>0) break; await sleep(3000); }
  const box = page.locator('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]').first();
  await box.click({ timeout: 10000 }); await sleep(600);
  await page.keyboard.press('Meta+A').catch(()=>{}); await page.keyboard.press('Backspace').catch(()=>{}); await sleep(300);
  await box.pressSequentially(TEXT, { delay: 45 }); await sleep(1200);
  await page.keyboard.press('Escape').catch(()=>{}); await sleep(400);
  const RX = /^(Опубликовать|Post)$/i;
  for (const cnd of [page.getByRole('button',{name:RX}), page.locator('div[role="button"]').filter({hasText:RX}), page.getByText(RX)]) {
    const el = cnd.first(); if(!(await el.isVisible().catch(()=>false))) continue;
    const bb = await el.boundingBox().catch(()=>null);
    if (bb) { await page.mouse.click(bb.x+bb.width/2, bb.y+bb.height/2).catch(()=>{}); } else { await el.click({timeout:4000}).catch(()=>{}); }
    break;
  }
  await sleep(5000);
  const empty = await page.evaluate(()=>{ const b=document.querySelector('textarea, div[contenteditable="true"][role="textbox"], div[aria-label][contenteditable="true"]'); const t=b?(b.value||b.innerText||b.textContent||'').trim():''; return t.length<3; }).catch(()=>false);
  const err = await page.evaluate(()=>/Не удалось опубликовать|Unable to post/i.test(document.body.innerText)).catch(()=>false);
  await page.screenshot({ path: SHOT }).catch(()=>{});
  console.log(`ТЕКСТ: "${TEXT}"\nРЕЗУЛЬТАТ: ${empty && !err ? '✅ ОПУБЛИКОВАЛОСЬ' : '❌ ОТКАЗ'}  (композер пуст: ${empty}, баннер ошибки: ${err})`);
  process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
