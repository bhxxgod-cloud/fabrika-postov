const fs=require('fs'), path=require('path'), os=require('os');
const { makeThumb } = require('./thumbgen.cjs');
const OUT=path.join(os.homedir(),'Desktop','ЮТУБ','фикс-обложки');
fs.mkdirSync(OUT,{recursive:true});
for(const it of JSON.parse(fs.readFileSync('/tmp/fix_stylist.json','utf8'))){
  try{
    const p=makeThumb(it.file, it.title, OUT, {slug: it.slug});
    if(p){ fs.copyFileSync(p, path.join(OUT, it.slug+'_'+it.vid+'.jpg')); console.log(it.vid,'готово'); }
    else console.log(it.vid,'ПУСТО');
  }catch(e){ console.log(it.vid,'ошибка',e.message.slice(0,60)); }
}
