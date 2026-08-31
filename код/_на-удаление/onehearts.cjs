const fs=require('fs'),path=require('path'),os=require('os');
const {siteGenerate}=require('/Users/qq/Desktop/neironka-poster/sitegen.cjs');
const PROFILE=path.join(os.homedir(),'.neironka-admin-profile');
const {chromium}=require('playwright-core');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOCK='/tmp/genposts.lock';
const REF=process.argv[2]||'/Users/qq/Desktop/АВАТАРЫ /Мариша/marina_street_dress_2026-07-31_14-37.png';
const PROMPT='Крупный интимный чёрно-белый портрет девушки, снятый сверху: она лежит на светлой мятой простыне, ЩЕКОЙ на подушке, голова повёрнута набок. ЛИЦО КРУПНО, занимает правую половину кадра, видно почти всё лицо в три четверти, тот же человек что на референсе, черты лица не менять, кожа чистая с лёгкой текстурой. Длинные тёмные волосы лежат на простыне СЛЕВА от лица, ВПЛОТНУЮ к голове, и уложены в ДВА-ТРИ маленьких аккуратных СЕРДЦА из прядей, сердца небольшие, компактные, собраны у виска рядом с лицом, каждое сердце с чётким ровным контуром, не разбросаны широко. СТИЛЬ: контрастное чёрно-белое фото, глубокие чёрные тени, волосы почти чёрные, кожа светлая, лёгкое плёночное зерно, снято на телефон сверху. Девушка одета, плечи прикрыты. ЗАПРЕЩЕНО: цвет, текст, водяные знаки, коллаж, рамки, несколько кадров в одной картинке, лицо в углу, волосы разбросанные далеко по всей кровати, крупные сердца во весь кадр, пластиковая кожа, аниме, 3D. Вертикальный кадр.';
(async()=>{
  try{fs.writeFileSync(LOCK,String(process.pid),{flag:'wx'})}catch{const pid=+fs.readFileSync(LOCK,'utf8');try{process.kill(pid,0);console.log('занято');process.exit(1)}catch{fs.unlinkSync(LOCK);fs.writeFileSync(LOCK,String(process.pid))}}
  const ctx=await chromium.launchPersistentContext(PROFILE,{headless:false,executablePath:CHROME,viewport:{width:1280,height:900}});
  const page=ctx.pages()[0]||await ctx.newPage();
  try{
    console.log('генерю ОДИН кадр по исправленному промпту...');
    const r=await siteGenerate(page,{prompt:PROMPT,refFile:REF,out:'/tmp/hearts_one.jpg'});
    console.log('готово:',r.out);
  }finally{await ctx.close().catch(()=>{});try{fs.unlinkSync(LOCK)}catch{}}
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch(e=>{console.error('ОШИБКА',e.message);try{fs.unlinkSync(LOCK)}catch{};process.exit(1)});
