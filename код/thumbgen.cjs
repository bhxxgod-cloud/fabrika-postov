'use strict';
// Прототип нового выбора кадра (то, что пойдёт в патч thumbgen.cjs).
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
let FFMPEG=null; try{ FFMPEG=require('ffmpeg-static'); }catch{}
function ensureThumbface(){
  try{
    const bin=path.join(__dirname,'thumbface'), src=path.join(__dirname,'thumbface.swift');
    if(fs.existsSync(bin)) return bin;
    if(!fs.existsSync(src)) return null;
    const r=spawnSync('swiftc',['-O',src,'-o',bin],{stdio:'pipe',timeout:180000});
    return (r.status===0&&fs.existsSync(bin))?bin:null;
  }catch{ return null; }
}
const THUMBFACE = ensureThumbface();

function ffdur(mp4){
  const r = spawnSync(FFMPEG, ['-i', mp4], { stdio: 'pipe' });
  const m = String(r.stderr).match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  return m ? (+m[1])*3600 + (+m[2])*60 + (+m[3]) : 10;
}
function sceneCuts(mp4, d){
  const r = spawnSync(FFMPEG, ['-i', mp4, '-vf', "select='gt(scene,0.30)',showinfo", '-f', 'null', '-'], { stdio: 'pipe', timeout: 120000, maxBuffer: 1<<24 });
  const cuts = []; const re = /pts_time:([0-9.]+)/g; const s = String(r.stderr); let m;
  while ((m = re.exec(s))) cuts.push(parseFloat(m[1]));
  return [...new Set(cuts)].filter(t => t > 0.5 && t < d - 0.2).sort((a,b) => a-b);
}
function frameStats(mp4, t){
  const r = spawnSync(FFMPEG, ['-ss', String(t), '-i', mp4, '-vf', 'scale=180:320,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { stdio: 'pipe', timeout: 60000, maxBuffer: 1<<24 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  const w = 180, h = 320, buf = r.stdout;
  let sum = 0, white = 0, bright = 0, cBright = 0, cSum = 0, cN = 0;
  const y0 = Math.floor(h*0.42), y1 = Math.floor(h*0.85);
  const cx0 = Math.floor(w*0.25), cx1 = Math.floor(w*0.75), cy0 = Math.floor(h*0.15), cy1 = Math.floor(h*0.70);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
    const v = buf[y*w + x]; sum += v;
    if (v > 200) bright++;
    if (y >= y0 && y < y1 && v > 235) white++;
    if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1){ cN++; cSum += v; if (v > 185) cBright++; }
  }
  return { white, avg: sum/(w*h), brightShare: bright/(w*h), centerBright: cBright/cN, centerAvg: cSum/cN };
}
function pickCleanTime(mp4){
  const d = Math.max(2, ffdur(mp4));
  // CTA-слайд всегда ПОСЛЕДНЯЯ сцена и стартует ~70% длительности. Жёсткий потолок 65%,
  // при найденном последнем кате: ещё и (кат - 0.4с).
  let cap = 0.65 * d;
  const cuts = sceneCuts(mp4, d);
  const last = cuts.length ? cuts[cuts.length - 1] : null;
  if (last && last > 0.5*d && last < 0.92*d) cap = Math.min(cap, last - 0.4);
  const bounds = [0, ...cuts.filter(c => c < cap - 0.3), cap];
  const cands = [];
  for (let i = 0; i + 1 < bounds.length; i++){
    const a = bounds[i], b = bounds[i+1];
    if (b - a < 1.0) continue; // огрызки и переходы не сэмплируем
    cands.push({ t: a + 0.35*(b - a), scene: i });
    cands.push({ t: a + 0.65*(b - a), scene: i });
  }
  if (!cands.length) for (const k of [0.30, 0.40, 0.50, 0.60]) cands.push({ t: k*d, scene: 0 });
  // 1) luma-префильтр
  const passed = [];
  for (const c of cands){
    const st = frameStats(mp4, Math.max(0.1, Math.min(d - 0.2, c.t)));
    if (!st) continue;
    if (st.centerAvg < 50) { console.log('  rej dark   t=' + c.t.toFixed(2), 'cAvg=' + st.centerAvg.toFixed(0)); continue; }
    if (st.centerAvg > 190 || st.brightShare > 0.42 || st.centerBright > 0.55) { console.log('  rej card   t=' + c.t.toFixed(2)); continue; }
    passed.push({ ...c, white: st.white });
  }
  if (!passed.length) return { t: 0.3 * d, tier: 'none' };
  // 2) Vision: извлечь кандидатов и оценить одним вызовом
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbv_'));
  const files = [];
  for (const c of passed){
    const f = path.join(tmpd, 'c' + files.length + '.jpg');
    const r = spawnSync(FFMPEG, ['-y', '-ss', String(c.t), '-i', mp4, '-frames:v', '1', '-q:v', '3', f], { stdio: 'pipe', timeout: 60000 });
    if (r.status === 0 && fs.existsSync(f)) { c.file = f; files.push(f); }
  }
  let vis = new Map();
  if (files.length && fs.existsSync(THUMBFACE)){
    const r = spawnSync(THUMBFACE, files, { stdio: 'pipe', timeout: 60000 });
    for (const line of String(r.stdout).trim().split('\n')){
      try { const o = JSON.parse(line); vis.set(o.file, o); } catch {}
    }
  }
  let best = null, tier = 'luma';
  if (vis.size){
    const scored = passed.filter(c => c.file).map(c => ({ c, v: vis.get(path.basename(c.file)) })).filter(x => x.v && !x.v.error);
    const t1 = scored.filter(x => x.v.faces >= 1 && x.v.faceH >= 0.18 && x.v.faceH <= 0.62 && x.v.faceCy <= 0.60 && x.v.textAbovePlate === 0);
    if (t1.length){
      t1.sort((a,b) => (b.v.quality + 0.4*b.v.faceH + 0.10*(b.c.t/cap)) - (a.v.quality + 0.4*a.v.faceH + 0.10*(a.c.t/cap)));
      best = t1[0].c; tier = 'vision';
      for (const x of t1) console.log('  t1', x.c.t.toFixed(2), JSON.stringify(x.v));
    } else {
      const t2 = scored.filter(x => x.v.faces >= 1 && x.v.faceH >= 0.14 && x.v.textAbovePlate <= 2);
      if (t2.length){
        t2.sort((a,b) => (b.v.quality - 0.15*b.v.textAbovePlate) - (a.v.quality - 0.15*a.v.textAbovePlate));
        best = t2[0].c; tier = 'vision-t2';
      }
    }
  }
  if (!best){
    passed.sort((a,b) => (a.white - 15*a.scene) - (b.white - 15*b.scene));
    best = passed[0];
  }
  fs.rmSync(tmpd, { recursive: true, force: true });
  return { t: best.t, tier, cap: +cap.toFixed(2), cuts };
}

// ---- оформление (спека 21.08, согласована) ----
const FONTS_DIR = path.join(os.homedir(),'Desktop/НЕЙРОНКА/ЮТУБ-ПОСТЕР/fonts');
const SUPP = '/System/Library/Fonts/Supplemental';
// 1 канал = 1 шрифт (см. память neironka-cover-spec): [font1, font2|null, weight|null]
const FONT_MAP = {
  brand:   [path.join(FONTS_DIR,'oswald.ttf'), path.join(FONTS_DIR,'unbounded.ttf'), null],
  iishnaya:[path.join(FONTS_DIR,'russo.ttf'), null, null],
  kris:    [path.join(FONTS_DIR,'mont.ttf'), null, null],
  prigovor:[path.join(FONTS_DIR,'oswald.ttf'), null, null],
  podruga: [path.join(FONTS_DIR,'nunito1000.ttf'), null, 1000],
  verdict: [path.join(SUPP,'Verdana Bold.ttf'), null, null],
  drugaya: [path.join(SUPP,'Trebuchet MS Bold.ttf'), null, null],
  katya:   [path.join(SUPP,'Arial Black.ttf'), null, null],
  pokazhu: [path.join(FONTS_DIR,'unbounded.ttf'), null, null],
  stylist: [path.join(SUPP,'Impact.ttf'), null, null],
};
const EMOJI_POOL = ['😳','🤫','😭','💅','😏','🙈','🥲','💔','🫢','🤯','🔞']; // 🔥 запрещён (кринж)
const STATE_FILE = path.join(__dirname,'.thumbstate.json');
function pickEmoji(rawTitle, cleanTitle, slug){
  let st={}; try{ st=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }catch{}
  const m=String(rawTitle||'').match(/\p{Extended_Pictographic}/u);
  let e=null;
  if(m && EMOJI_POOL.includes(m[0])) e=m[0];
  if(!e){
    const t=cleanTitle.toLowerCase();
    if(/удал|секрет|молчу|тихо/.test(t)) e='🤫';
    else if(/плак|груст|зря|обидно/.test(t)) e='😭';
    else if(/не узна|шок|поверить|перестали|добил/.test(t)) e='😳';
    else if(/стыд|прятал|скрыва/.test(t)) e='🙈';
    else if(/брови|макияж|губы|цветотип|стрижк|образ/.test(t)) e='💅';
    else if(/парн|мужч|он /.test(t)) e='😏';
    else if(/до и после|другой|друга/.test(t)) e='🤯';
    else e='🫢';
  }
  if(st[slug]===e){ const i=EMOJI_POOL.indexOf(e); e=EMOJI_POOL[(i+1)%EMOJI_POOL.length]; }
  st[slug]=e; try{ fs.writeFileSync(STATE_FILE,JSON.stringify(st)); }catch{}
  return e;
}
function makeThumb(mp4, title, outDir, opts){
  const slug=(opts&&opts.slug)||'brand';
  if(!FFMPEG||!mp4||!fs.existsSync(mp4)) return null;
  try{
    fs.mkdirSync(outDir,{recursive:true});
    const out=path.join(outDir,path.basename(mp4,'.mp4')+'.thumb.jpg');
    const pick=pickCleanTime(mp4);
    const clean=(pick.tier==='vision'); // чистое лицо без текста в кадре
    const tmp=path.join(os.tmpdir(),'thumbframe_'+process.pid+'.jpg');
    let r=spawnSync(FFMPEG,['-y','-ss',String(pick.t),'-i',mp4,'-vf','scale=1080:1920','-frames:v','1','-q:v','3',tmp],{stdio:'pipe',timeout:120000});
    if(r.status!==0||!fs.existsSync(tmp)) return null;
    const txt=(opts&&opts.titleOverride)||String(title||'');
    // ДВА РЕГИСТРА НА ОБЛОЖКЕ (25.08). Пул хуков владельца разведён на два языка: обвинение
    // («Выкинь это из косметички!») и дневник («пов лучше бы ты не делала этот тренд...»).
    // Общий КАПС стирал эту разницу: дневник на превью орал так же, как обвинение. Поэтому
    // дневниковые названия оставляем строчными, капсом кричит только обвинение.
    // Слэш в списке разрешённых не просто так: без него «10/10» превращалось в «10 10».
    const дневник=require('./регистр.cjs').регистр(txt)==='пов';
    const cleanTxt0=txt.replace(/^\s*\d+\s*[.)]\s*/,'').replace(/#\S+/g,' ')
      .replace(/[^А-Яа-яЁёA-Za-z0-9 ,.!?:%()\/-]/g,' ')
      .replace(/\s+/g,' ').trim();
    const cleanTxt=дневник?cleanTxt0:cleanTxt0.toUpperCase();
    if(cleanTxt.length<3){ fs.copyFileSync(tmp,out); fs.rmSync(tmp,{force:true}); return out; }
    const emoji=pickEmoji(txt, cleanTxt, slug);
    // ПОКА один шрифт на все каналы (приказ 21.08): Verdana Bold. Карта FONT_MAP ждёт часа.
    const [f1,f2,w1]=[path.join(SUPP,'Verdana Bold.ttf'),null,null];
    const alpha = clean ? '168' : '255'; // чистый кадр → полупрозрачная; текст в кадре → глухая
    r=spawnSync('python3',[path.join(__dirname,'thumbdraw.py'),tmp,out,cleanTxt,emoji,f1,f2||'',String(w1||''),alpha],{stdio:'pipe',timeout:60000});
    fs.rmSync(tmp,{force:true});
    if(r.status!==0||!fs.existsSync(out)) return null;
    return out;
  }catch{ return null; }
}
module.exports={ makeThumb, pickCleanTime };
