const fs=require('fs'), path=require('path'), os=require('os');
const { makeThumb } = require('./thumbgen.cjs');
const items=JSON.parse(fs.readFileSync('/tmp/manual10.json','utf8'));
const OUT=path.join(os.homedir(),'Desktop','ЮТУБ','ручные-10');
fs.mkdirSync(OUT,{recursive:true});
for(const it of items){
  try{
    const p=makeThumb(it.file, it.title, OUT, {slug: it.slug});
    if(p){ const dst=path.join(OUT, it.slug+'.jpg'); fs.copyFileSync(p,dst); console.log(it.slug+': обложка готова'); }
    else console.log(it.slug+': makeThumb вернул пусто');
  }catch(e){ console.log(it.slug+': ошибка '+e.message.slice(0,60)); }
}
