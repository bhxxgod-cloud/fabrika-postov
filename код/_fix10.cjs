const fs=require('fs'), path=require('path'), os=require('os');
const { makeThumb } = require('./thumbgen.cjs');
const items=JSON.parse(fs.readFileSync('/tmp/fix10.json','utf8'));
const OUT=path.join(os.homedir(),'Desktop','ЮТУБ','фикс-обложки');
fs.mkdirSync(OUT,{recursive:true});
for(const it of items){
  try{
    const p=makeThumb(it.file, it.title, OUT, {slug: it.slug});
    if(p){ const dst=path.join(OUT, it.slug+'_'+it.vid+'.jpg'); fs.copyFileSync(p,dst); console.log(it.slug, it.vid, 'готово'); }
    else console.log(it.slug, it.vid, 'ПУСТО');
  }catch(e){ console.log(it.slug, it.vid, 'ошибка', e.message.slice(0,50)); }
}
