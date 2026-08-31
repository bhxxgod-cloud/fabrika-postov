// Отбор роликов в утренний пул: только новые (без зеркала), только уникальные, только чистые.
const fs=require('fs'),path=require('path');
const D='/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/reels_pure';
const лог=fs.readFileSync('/tmp/reels_pure.log','utf8');
const уник=new Set(JSON.parse(fs.readFileSync('/tmp/uniq_ok.json','utf8')).map(x=>String(x).slice(0,8)));
const дубли=new Set(JSON.parse(fs.readFileSync('/tmp/uniq_dup.json','utf8')).map(x=>String(x).slice(0,8)));
const пары=[...лог.matchAll(/✅ .*?: (reel_[^\s]+\.mp4) \([^)]*пост ([0-9a-f]{8})/g)].map(m=>({файл:m[1],пост:m[2]}));
console.log(`роликов в логе: ${пары.length}, уникальных постов в списке: ${уник.size}, дублей: ${дубли.size}`);
const годные=пары.filter(p=>уник.has(p.пост) && fs.existsSync(path.join(D,p.файл)));
const выкинуто=пары.filter(p=>!уник.has(p.пост));
console.log(`ГОДНЫХ РОЛИКОВ: ${годные.length}, отсеяно: ${выкинуто.length}`);
console.log(`  из отсеянных дубли: ${выкинуто.filter(p=>дубли.has(p.пост)).length}, брак качества или не проверены: ${выкинуто.filter(p=>!дубли.has(p.пост)).length}`);
fs.writeFileSync('/tmp/pool_files.txt', годные.map(p=>path.join(D,p.файл)).join('\n'));
