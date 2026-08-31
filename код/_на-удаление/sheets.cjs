// Контактные листы уникальных постов для осмотра с телефона.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const FF=require('ffmpeg-static');
const КЭШ='/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/uniq_cache';
const OUT='/Users/qq/Desktop/УНИКАЛЬНЫЕ-ПОСТЫ'; fs.mkdirSync(OUT,{recursive:true});
const ok=JSON.parse(fs.readFileSync('/tmp/uniq_ok.json','utf8')).map(x=>String(x).slice(0,8));
const есть=ok.filter(s=>[0,1,2,3].every(j=>fs.existsSync(path.join(КЭШ,`${s}_${j}.jpg`))));
console.log(`уникальных с кадрами на диске: ${есть.length}`);
const ПАЧКА=12; let n=0;
for(let i=0;i<есть.length;i+=ПАЧКА){
  const груп=есть.slice(i,i+ПАЧКА); n++;
  const строки=груп.map(s=>{
    const row=path.join('/tmp',`row_${s}.jpg`);
    execFileSync(FF,['-y','-i',path.join(КЭШ,`${s}_0.jpg`),'-i',path.join(КЭШ,`${s}_1.jpg`),
      '-i',path.join(КЭШ,`${s}_2.jpg`),'-i',path.join(КЭШ,`${s}_3.jpg`),'-filter_complex',
      '[0]scale=260:325[a];[1]scale=260:325[b];[2]scale=260:325[c];[3]scale=260:325[d];[a][b][c][d]hstack=4',
      '-q:v','4',row],{stdio:'ignore'});
    return row;
  });
  const args=[]; строки.forEach(f=>args.push('-i',f));
  const фильтр=строки.map((_,k)=>`[${k}]`).join('')+`vstack=${строки.length}`;
  const out=path.join(OUT,`лист-${String(n).padStart(2,'0')}.jpg`);
  execFileSync(FF,['-y',...args,'-filter_complex',фильтр,'-q:v','4',out],{stdio:'ignore'});
  console.log(`✔ ${path.basename(out)} — постов ${груп.length}`);
}
