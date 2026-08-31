// ЛОКАЛЬНЫЙ РАДАР: поднимает искателя (ig_role='reader') в Orbita НА МАКЕ (GoLogin SDK startLocal),
// ищет посты по трендовым фразам, фильтрует (русский / ≥25 комментов / ≤4 дня / тренд+спрос) и заливает
// в radar_posts прод-базы. Для случаев, когда GoLogin CLOUD лёг. usage: DB_PUBLIC_URL=... node radarlocal.cjs
const { chromium } = require('playwright-core');
const { Client } = require('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- фильтры (копия логики radar.ts) ---
const DEMAND = ['как ты','как это','как сдела','чем сдела','чем дела','где сдела','в чём','в чем','какая нейрос','какой нейрос','что за прил','какое прил','что за прог','промт','промпт','подскаж','скинь','какое приложение','что использ','в какой','ссылк','впн','vpn','платн','бесплатн','регистр','не получ','не работает','не открыва','не могу сгенер','как зайти','как скачать','дай текст','можно текст','можно промт','дай промт','gemini','chatgpt','чат гпт','как повторить','что за тренд','какой фильтр','что за фильтр','как обработ','хочу так','хочу такое'];
const CAP = ['нейросет','нейронк','промпт','промт','сгенер','нейро','midjourney','kling','veo','chatgpt','оживил','ai ','#ai','ии '];
const OFFTOPIC = ['психолог','психотерап','психосомат','заработ','пассивный доход','доход ','инвест','крипт','трейд','ставк','бизнес','инфобиз','млм','воронк','продаж','эзотер','таро','астролог','гадан','нумеролог','матриц судьбы','расстановк','натальн','мотивац','саморазвит','медитац','аффирмац','марафон желаний','финанс','партнерк','партнёрк','на заказ','сделаю для вас','сделаю вам','актуальные цены','прайс'];
const TRENDS = [
  { name: 'тренд: сквозь пальцы', phrases: ['взгляд сквозь пальцы','сквозь пальцы тренд','фото сквозь пальцы нейросеть','сквозь пальцы промт'], match: ['сквозь пальцы','через пальцы','скозь пальцы','peace sign','finger','пальц'] },
  { name: 'тренд: бьюти-гайд', phrases: ['бьюти гайд по фото','бьюти гайд нейросеть','бьюти гайд 2026','разбор внешности нейросеть','подбор стрижки по фото нейросеть'], match: ['бьюти гайд','бьюти-гайд','beauty guide','разбор внешн','подбор стрижк','подбор цвета волос','гайд по внешности','идеальный образ','бьюти разбор'] },
];
const MIN_COMMENTS = Number(process.env.RADAR_MIN_COMMENTS) || 15, MAX_STALE_DAYS = Number(process.env.RADAR_MAX_STALE_DAYS) || 4;
function isRussian(cap) { if (((cap.match(/[әғқңөұүһі]/gi)||[]).length)>=3) return false; const c=(cap.match(/[а-яё]/gi)||[]).length,l=(cap.match(/[a-z]/gi)||[]).length; if(c>=25)return true; if(c+l>=8)return c>=5&&c>=l*0.4; return true; }
function parseMetric(raw){ const m=String(raw).match(/([\d.,]+)\s*([KMBkmbкмКМ])?/); if(!m)return 0; const s=(m[2]||'').toUpperCase(); if(s==='K'||s==='К')return Math.round(parseFloat(m[1].replace(/,/g,'.'))*1e3); if(s==='M'||s==='М')return Math.round(parseFloat(m[1].replace(/,/g,'.'))*1e6); if(s==='B')return Math.round(parseFloat(m[1].replace(/,/g,'.'))*1e9); return parseInt(m[1].replace(/[.,\s]/g,''),10)||0; }

async function db(){ const c=new Client({connectionString:process.env.DB_PUBLIC_URL,ssl:{rejectUnauthorized:false}}); await c.connect(); return c; }

async function ensureLoggedIn(page){
  await page.goto('https://www.instagram.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await sleep(1500);
  return (await page.locator('a[href="/explore/"], a[href^="/reels/"], a[href^="/direct/"]').first().isVisible().catch(()=>false));
}
async function searchPosts(page, phrase){
  await page.goto('https://www.instagram.com/explore/search/keyword/?q='+encodeURIComponent(phrase),{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await sleep(5000);
  for(let i=0;i<4;i++){ await page.mouse.wheel(0,1600).catch(()=>{}); await sleep(1400); }
  return page.locator('a[href*="/p/"], a[href*="/reel/"]').evaluateAll((els,n)=>Array.from(new Set(els.map(e=>e.href))).slice(0,n),25).catch(()=>[]);
}
async function readPost(page,url){
  const code=(url.match(/\/(?:p|reel)\/([^/?]+)/)||[])[1]; if(!code)return null;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000}).catch(()=>{});
  await sleep(2500);
  const rl=await page.evaluate(()=>location.href.startsWith('chrome-error')||/HTTP ERROR 429|Too Many Requests|Please wait a few minutes|подождите нескольк/i.test((document.body?.innerText||'').slice(0,300))).catch(()=>false);
  if(rl){ console.log('  429 при чтении '+code+' — пропуск'); return {throttled:true}; }
  const og=await page.evaluate(()=>({image:document.querySelector('meta[property="og:image"]')?.getAttribute('content')||'',desc:document.querySelector('meta[property="og:description"]')?.getAttribute('content')||''})).catch(()=>({image:'',desc:''}));
  const likeM=og.desc.match(/([\d.,]+\s*[KMBkmbкмКМ]?)\s*(?:likes|отметки|лайк)/i); const like_count=likeM?parseMetric(likeM[1]):0;
  const cm=og.desc.match(/([\d.,]+\s*[KMBkmbкмКМ]?)\s*(?:comments|комментар)/i); let comment_count=cm?parseMetric(cm[1]):0;
  const pre=og.desc.match(/^[\d.,KMBkmbкмКМ\s]+likes[^:]*:\s*/i); const caption=(pre?og.desc.slice(pre[0].length):og.desc).slice(0,600);
  for(let i=0;i<3;i++){ await page.mouse.wheel(0,1400).catch(()=>{}); await sleep(1000); }
  const articleText=await page.evaluate(()=>(document.querySelector('main')||document.body)?.innerText||'').catch(()=>'');
  const lines=articleText.split('\n').map(l=>l.trim()).filter(l=>l&&l.length<280);
  let demand=0; for(const l of lines){ const low=l.toLowerCase(); if(DEMAND.some(w=>low.includes(w)))demand++; }
  if(!comment_count) comment_count=lines.length;
  const dts=await page.evaluate(()=>Array.from(document.querySelectorAll('time[datetime]')).map(e=>e.getAttribute('datetime')).filter(Boolean)).catch(()=>[]);
  const stamps=dts.map(t=>Date.parse(t)).filter(n=>!Number.isNaN(n)).sort((a,b)=>a-b);
  const taken_at=stamps.length?new Date(stamps[0]).toISOString():null;
  const last_comment_at=stamps.length?new Date(stamps[stamps.length-1]).toISOString():null;
  const nowMs=Date.now(); const cs=stamps.length>1?stamps.slice(1):[];
  const recent_comments=cs.filter(s=>nowMs-s<2*86400000).length;
  const ru=isRussian(caption); const ft=(caption+' '+articleText).toLowerCase(); const offtopic=OFFTOPIC.some(w=>ft.includes(w));
  const audio=await page.evaluate(()=>{const a=document.querySelector('a[href*="/reels/audio/"]');const h=a?.getAttribute('href')||'';return {id:(h.match(/\/reels\/audio\/(\d+)/)||[])[1]||'',title:(a?.textContent||'').trim().slice(0,120)};}).catch(()=>({id:'',title:''}));
  return {code,url,image_url:og.image,caption,demand,comment_count,like_count,recent_comments,last_comment_at,taken_at,ru,offtopic,audio_id:audio.id,audio_title:audio.title};
}

(async()=>{
  if(!process.env.DB_PUBLIC_URL){ console.log('нужен DB_PUBLIC_URL'); process.exit(1); }
  const c=await db();
  // Фикс-акк по слагу (READER_SLUG) — неуязвим к облачной авто-ротации роли reader; иначе — текущий reader.
  const a=(await c.query(process.env.READER_SLUG
    ? `SELECT a.slug,a.gologin_profile_id,g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1 AND a.gologin_profile_id IS NOT NULL LIMIT 1`
    : `SELECT a.slug,a.gologin_profile_id,g.gologin_token FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.ig_role='reader' AND a.gologin_profile_id IS NOT NULL LIMIT 1`,
    process.env.READER_SLUG ? [process.env.READER_SLUG] : [])).rows[0];
  if(!a){ console.log('нет искателя (ig_role=reader) с профилем'); process.exit(1); }
  console.log('искатель: '+a.slug+' | профиль '+a.gologin_profile_id+' — поднимаю Orbita локально…');
  const { GoLogin } = await import('gologin');
  const gl=new GoLogin({ token:a.gologin_token, profile_id:a.gologin_profile_id });
  const res=await gl.startLocal();
  const b=await chromium.connectOverCDP(res.wsUrl,{timeout:60000});
  const ctx=b.contexts()[0]||await b.newContext(); const page=ctx.pages()[0]||await ctx.newPage();
  await page.setViewportSize({width:1280,height:900}).catch(()=>{});
  // ЭКОНОМИЯ РЕЗИД-ТРАФИКА: радар читает DOM (подписи/комменты), видео/аудио/шрифты НЕ нужны — режем.
  // Картинки тоже режем (BLOCK_IMAGES по умолчанию вкл локально — превью берём из og:image мета, не грузим).
  await page.route('**/*',(route)=>{ const t=route.request().resourceType(); if(t==='media'||t==='font'||t==='image') return route.abort().catch(()=>{}); return route.continue().catch(()=>{}); }).catch(()=>{});
  try{
    const ok=await ensureLoggedIn(page); console.log('вошёл: '+ok);
    if(!ok){ console.log('НЕ залогинен — дожми вход в профиле'); throw new Error('not logged in'); }
    let kept=0, seen429=0;
    const NICHE=['нейросет','нейронк','промпт','промт','gpt','чат гпт','бьюти','разбор внешн','подбор стрижк','подбор цвета','ии фото','ии-фото','нейрофото','оживить фото','сгенер','nano banana','нано банан'];
    // ФРАЗЫ С АКТИВНЫХ ПОСТОВ: берём язык постов, что РЕАЛЬНО прошли фильтр (свежие, со спросом), достаём
    // 2-3-словные ниша-фразы → ищем по ним ещё похожие. Само-усиление: что работает → ищем такое же.
    const phrasesFromActive=async()=>{
      const rows=(await c.query(`SELECT coalesce(caption,'') cap FROM radar_posts WHERE status='new' AND coalesce(demand_hits,0)>=1 AND created_at>now()-interval '5 days' ORDER BY score DESC LIMIT 15`)).rows;
      const freq=new Map();
      for(const r of rows){
        const low=r.cap.toLowerCase().replace(/[^0-9a-zа-яё ]/gi,' ').replace(/\s+/g,' ').trim();
        const w=low.split(' ').filter(Boolean);
        for(let i=0;i<w.length;i++) for(const len of [2,3]){ const win=w.slice(i,i+len); if(win.length<len)continue; const ph=win.join(' '); if(NICHE.some(k=>ph.includes(k))&&(ph.match(/[а-яё]/g)||[]).length>=6) freq.set(ph,(freq.get(ph)||0)+1); }
      }
      return [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(e=>e[0]);
    };
    // ХАРВЕСТ ссылки: читаем/фильтруем/заливаем + ЗАПОМИНАЕМ ПЕСНЮ (seen_count). Возвращает 'kept'|'skip'|'429'.
    const harvest=async(url,defTag)=>{
      const p=await readPost(page,url); await sleep(3500+Math.floor(Math.random()*2500));
      if(!p) return 'skip';
      if(p.throttled) return '429';
      const low=p.caption.toLowerCase();
      const trendHit=TRENDS.some(t=>t.match.some(w=>low.includes(w)));
      const capRel=CAP.some(w=>low.includes(w));
      if(p.comment_count<MIN_COMMENTS){ console.log(`  ✗ ${p.code}: комментов ${p.comment_count}<${MIN_COMMENTS}`); return 'skip'; }
      if(!p.ru){ console.log(`  ✗ ${p.code}: не русский`); return 'skip'; }
      if(p.offtopic){ console.log(`  ✗ ${p.code}: офтоп`); return 'skip'; }
      if(p.demand===0&&!capRel&&!trendHit){ console.log(`  ✗ ${p.code}: не релевантно`); return 'skip'; }
      const actDays=p.last_comment_at?(Date.now()-Date.parse(p.last_comment_at))/86400000:null;
      if(actDays!==null&&actDays>MAX_STALE_DAYS){ console.log(`  ✗ ${p.code}: мёртвый (${actDays.toFixed(1)}дн)`); return 'skip'; }
      const capTrend=TRENDS.find(t=>t.match.some(w=>low.includes(w)));
      const tag=capTrend?capTrend.name:defTag;
      const isNew=p.taken_at&&(Date.now()-Date.parse(p.taken_at))/86400000<=2;
      let score=Math.min(45,p.demand*12)+(capRel?10:0)+Math.min(20,Math.round(Math.log10(p.comment_count+1)*12))+Math.min(15,Math.round(Math.log10(p.like_count+1)*6))+(trendHit?(isNew?25:14):0);
      score=Math.max(0,Math.min(100,Math.round(score)));
      const rel=Math.min(100,Math.min(60,p.demand*15)+(capRel?30:0)+(trendHit?40:0));
      await c.query(`INSERT INTO radar_posts (code,tag,url,image_url,caption,comment_count,like_count,recent_comments,demand_hits,relevance,score,last_comment_at,taken_at,audio_id,audio_title)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (code) DO UPDATE SET comment_count=excluded.comment_count,like_count=excluded.like_count,recent_comments=excluded.recent_comments,demand_hits=excluded.demand_hits,relevance=excluded.relevance,score=excluded.score,last_comment_at=excluded.last_comment_at,taken_at=excluded.taken_at,audio_id=coalesce(nullif(excluded.audio_id,''),radar_posts.audio_id),audio_title=coalesce(nullif(excluded.audio_title,''),radar_posts.audio_title) WHERE radar_posts.status='new'`,
        [p.code,tag,p.url,p.image_url,p.caption,p.comment_count,p.like_count,p.recent_comments,p.demand,rel,score,p.last_comment_at,p.taken_at,p.audio_id||null,p.audio_title||null]).then(()=>{kept++;console.log(`  ✓ ${p.code} → ${tag} | score ${score} | 💬${p.comment_count} спрос ${p.demand}${p.audio_title?' | 🎵'+p.audio_title:''}`);}).catch(e=>console.log('  db:',e.message.slice(0,60)));
      // ЗАПОМНИТЬ ПЕСНЮ: трендовый пост со звуком → +1 к саунду. seen_count>=3 = под него снимают (вкл. аудио-поиск).
      if((trendHit||p.demand>=2)&&p.audio_id) await c.query(`INSERT INTO radar_audios (audio_id,title) VALUES ($1,$2) ON CONFLICT (audio_id) DO UPDATE SET seen_count=radar_audios.seen_count+1, title=coalesce(nullif(excluded.title,''),radar_audios.title)`,[p.audio_id,p.audio_title||null]).catch(()=>{});
      return 'kept';
    };
    // === НЕПРЕРЫВНЫЙ ЦИКЛ (не выходим из сессии — работаем, пока не убьют) ===
    let cycle=0;
    while(true){
      cycle++; kept=0; seen429=0;
      console.log(`\n════════ ЦИКЛ ${cycle} ════════`);
      try{
        // КАНАЛ А: аудио ТОЛЬКО для саундов, повторившихся ≥3× (значит под них реально снимают тренд).
        const auds=(await c.query(`SELECT audio_id,title,seen_count FROM radar_audios WHERE enabled=true AND seen_count>=3 ORDER BY seen_count DESC LIMIT 3`)).rows;
        for(const au of auds){
          if(kept>=12)break;
          await page.goto(`https://www.instagram.com/reels/audio/${au.audio_id}/`,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
          await sleep(5000); for(let i=0;i<5;i++){ await page.mouse.wheel(0,1800).catch(()=>{}); await sleep(1400); }
          const links=await page.locator('a[href*="/reel/"], a[href*="/p/"]').evaluateAll(e=>Array.from(new Set(e.map(x=>x.href))).slice(0,20)).catch(()=>[]);
          console.log(`\n🎵 трендовый саунд «${(au.title||'').slice(0,40)}» (${au.seen_count}×): ${links.length} рилсов`);
          for(const url of links.slice(0,12)){ const r=await harvest(url,'тренд: по саунду'); if(r==='429'&&++seen429>=3){console.log('429 — стоп');break;} if(kept>=12)break; }
        }
        // КАНАЛ Б: фразы С АКТИВНЫХ ПОСТОВ + базовые тренд-фразы.
        const actP=await phrasesFromActive();
        if(actP.length) console.log('\nфразы с активных постов: '+actP.join(' | '));
        const phrases=[...new Set([...actP, ...TRENDS.flatMap(t=>t.phrases)])];
        for(const ph of phrases){
          if(kept>=12)break;
          const links=await searchPosts(page,ph);
          console.log(`\n«${ph}»: ${links.length} ссылок`);
          for(const url of links.slice(0,8)){ const r=await harvest(url,'тренд'); if(r==='429'&&++seen429>=3){console.log('429 — стоп');break;} if(kept>=12)break; }
          if(seen429>=3) break;
        }
      }catch(e){ console.log('цикл сбой:',e.message.slice(0,120)); }
      console.log(`\n── ЦИКЛ ${cycle}: залито ${kept} ──`);
      // Искатель выпал? — стоп (перезапустишь). Иначе пауза (429 → длинная) и НОВЫЙ цикл, не выходя.
      if(!(await ensureLoggedIn(page).catch(()=>false))){ console.log('искатель выпал из сессии — стоп'); break; }
      const pause=seen429>0?40:8; console.log(`пауза ${pause} мин до цикла ${cycle+1}…`);
      await sleep(pause*60000);
    }
  }catch(e){ console.log('СБОЙ:',e.message.slice(0,150)); }
  finally{ await c.end().catch(()=>{}); try{await gl.stopLocal();}catch{try{await gl.stop();}catch{}} }
})().catch(e=>console.log('FATAL',e.message)).finally(()=>process.exit(0));
