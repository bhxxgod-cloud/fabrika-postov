const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:23002', { timeout: 60000 });
  const page = b.contexts()[0].pages().find(p => /instagram/.test(p.url()));
  const r = await page.evaluate(() => {
    const leaves = Array.from(document.querySelectorAll('*')).filter(e => e.children.length===0 && /^(Ответить|Reply)$/.test((e.textContent||'').trim()));
    const leaf = leaves[1] || leaves[0];
    if (!leaf) return {err:'нет листьев'};
    const chain = [];
    let box = leaf;
    for (let i=0;i<10 && box;i++){
      box = box.parentElement; if(!box) break;
      const a = box.querySelector('a[href^="/"]');
      const t = String(box.innerText||'').trim();
      chain.push({hop:i, tag:box.tagName, len:t.length, href:a?a.getAttribute('href'):null, snip:t.replace(/\s+/g,' ').slice(0,70)});
    }
    return {leaves: leaves.length, chain};
  });
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
