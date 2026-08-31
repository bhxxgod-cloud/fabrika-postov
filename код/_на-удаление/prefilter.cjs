// ПОСЛЕДНИЙ ФИЛЬТР ПЕРЕД ЗАЛИВОМ (11.08 07:20). Два правила начальника, найденные утром:
//  · «нельзя делать желтый фон, это топ АИ маркер нанобананы» → рубим кадры с жёлтой доминантой;
//  · «другой человек» на кадрах → рубим посты, где лицо кадра 3 или 4 не совпало с обложкой.
'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const FF=require('ffmpeg-static'); const {faceSim}=require('./facesim.cjs');
const КЭШ='/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad/uniq_cache';
const лог=fs.readFileSync('/tmp/reels_pure.log','utf8');
const пул=fs.readFileSync('/tmp/pool_files.txt','utf8').trim().split('\n');
const карта=new Map([...лог.matchAll(/✅ .*?: (reel_[^\s]+\.mp4) \([^)]*пост ([0-9a-f]{8})/g)].map(m=>[m[1],m[2]]));

// ЖЁЛТИЗНА: средние значения по каналам через ffmpeg signalstats. Жёлтый это высокий красный и
// зелёный при низком синем, то есть U (синева) заметно ниже середины, а яркость высокая.
function желтизна(файл){
  const out=execFileSync(FF,['-v','error','-i',файл,'-vf','signalstats,metadata=print:key=lavfi.signalstats.UAVG',
    '-f','null','-'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const m=/UAVG=([0-9.]+)/.exec(out); return m?Number(m[1]):128;
}
const итог=[]; const выкинуто=[];
for (const f of пул){
  const пост=карта.get(path.basename(f)); if(!пост) continue;
  const к=[0,1,2,3].map(j=>path.join(КЭШ,`${пост}_${j}.jpg`));
  if(!к.every(x=>fs.existsSync(x))) { выкинуто.push([пост,'кадров нет в кэше']); continue; }
  // жёлтый фон проверяем на кадрах 3 и 4 (фотографии), карточку не трогаем
  const u3=желтизна(к[2]), u4=желтизна(к[3]);
  if (u3 < 108 || u4 < 108){ выкинуто.push([пост,`жёлтый фон (U ${u3.toFixed(0)}/${u4.toFixed(0)})`]); continue; }
  let s3=0,s4=0;
  try { s3=faceSim([к[0],к[2]]); s4=faceSim([к[0],к[3]]); } catch(e){ выкинуто.push([пост,'лицо не замерилось']); continue; }
  if (s3 < 0.30 || s4 < 0.30){ выкинуто.push([пост,`другой человек (${s3.toFixed(2)}/${s4.toFixed(2)})`]); continue; }
  итог.push(f);
}
fs.writeFileSync('/tmp/pool_final.txt', итог.join('\n'));
console.log(`ПРОШЛИ: ${итог.length} из ${пул.length}`);
const причины={}; выкинуто.forEach(([,r])=>{const k=r.split(' (')[0]; причины[k]=(причины[k]||0)+1;});
console.log('отсеяно: '+JSON.stringify(причины));
выкинуто.slice(0,8).forEach(([p,r])=>console.log(`  ${p}: ${r}`));
