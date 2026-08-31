'use strict';
// Персональные ссылки на 115 живых. Порядок строк = порядок аккаунтов в папке магоса.
const fs = require('node:fs');
const { ensureLink, urlFor, codeFor } = require('./golink.cjs');
(async () => {
  const ники = fs.readFileSync('/tmp/alive.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  console.log(`ников: ${ники.length}`);
  const строки = [];
  let создано = 0, нашлось = 0, сбоев = 0;
  for (const [i, h] of ники.entries()) {
    try {
      const r = await ensureLink(h, { log: () => {} });
      строки.push(r.url);
      if (r.mode === 'создал') создано++; else нашлось++;
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${ники.length}`);
    } catch (e) {
      // Ссылка не создалась: ставим расчётный адрес, он всё равно верный по схеме.
      строки.push(urlFor(codeFor(h)));
      сбоев++;
      console.log(`  ⚠ ${h}: ${String(e.message).slice(0, 60)}`);
    }
  }
  fs.writeFileSync('/tmp/links115.txt', строки.join('\n'));
  console.log(`\nГОТОВО: создано ${создано}, уже было ${нашлось}, сбоев ${сбоев}`);
  console.log('список для магоса: /tmp/links115.txt');
})();
