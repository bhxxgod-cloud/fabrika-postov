'use strict';
// ПЕРЕНАРЕЗКА КАДРА-2 В ГОТОВЫХ ПОСТАХ-ГАЙДАХ (24.08). Баг: cardgen резал плитки лица фикс-CSS
// из обложки-локации → небо/волосы/пальмы вместо лица/глаз/губ. Фикс — нормализатор лица.
// Здесь чиним УЖЕ собранные: портрет режем из кадр1 (обложка+хук; хук внизу на 82%, в портрет не
// попадёт), перерисовываем cardgen, пересобираем mp4, обновляем .кадр2.jpg, убираем id из реестра
// tgpost (перезальётся с новой карточкой).
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const R = '/Users/qq/Desktop/neironka-poster';
const cg = require(R + '/cardgen.cjs');
const { лицокроп } = require(os.homedir() + '/.neironka/bin/лицокроп.cjs');
const OUT = os.homedir() + '/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ';
const РЕГ = os.homedir() + '/.neironka/reels/tgpost_sent_v3_контент.txt';
const ПЛ = os.homedir() + '/Desktop/НЕЙРОНКА/ПЛИТКИ/по-девочке';
// шаблоны, где cardgen режет лицо (КАРТОЧНЫЕ, кроме постера new-forms)
const ЦЕЛЬ = { 'brow-map': 'img-brow-map', 'makeup-colortype': 'img-makeup-colortype',
  'haircut-match': 'img-haircut-match', 'face-report': 'img-face-report',
  'nose-verdict': 'img-nose-verdict', 'beauty-guide': 'img-beauty-guide', 'lip-guide': 'img-lip-guide' };
const плитки = (girl, вид, n) => { const d = path.join(ПЛ, girl, вид); if (!fs.existsSync(d)) return null;
  const l = fs.readdirSync(d).filter((f) => !/_сетка/.test(f) && /\.jpe?g$/.test(f)).sort().slice(0, n).map((f) => path.join(d, f));
  return l.length ? l : null; };
const ДНЕЙ = Number(process.env.DAYS || 3);
const порог = Date.now() - ДНЕЙ * 86400000;
const ONLY = process.env.ONLY_GIRL || null;

function снятьИзРеестра(id) {
  if (!fs.existsSync(РЕГ)) return;
  const s = fs.readFileSync(РЕГ, 'utf8').split('\n').filter(Boolean);
  if (s.includes(id)) fs.writeFileSync(РЕГ, s.filter((n) => n !== id).join('\n') + '\n');
}

async function чинить(girl, gd, id, tpl, mp4, к1, к2, к3, к4) {
  const порт = path.join(gd, '_портрет-' + id + '.jpg');
  лицокроп(к1, порт, { хукСнизу: true });
  const opt = tpl === 'img-haircut-match' ? { плитки: плитки(girl, 'стрижки', 6) }
    : tpl === 'img-nose-verdict' ? { плитки: плитки(girl, 'нос', 4) } : undefined;
  await cg.собрать(tpl, порт, id, к2, {}, opt && opt.плитки ? opt : undefined);
  try { fs.unlinkSync(порт); } catch {}
  execFileSync('node', [R + '/reelbuild.cjs', mp4, к1, к2, к3, к4],
    { env: { ...process.env, REEL_CARDS: '-1', REEL_STATIC: '1', REEL_FIT_LAST: '0' }, stdio: 'ignore' });
  try { const фд = path.join(os.homedir(), 'Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА', girl, '_кадры', id, 'frame2.jpg');
    if (fs.existsSync(path.dirname(фд))) fs.copyFileSync(к2, фд); } catch {}
  снятьИзРеестра(id);
}

(async () => {
  const задачи = [];
  const girls = fs.readdirSync(OUT).filter((d) => !d.startsWith('_') && fs.statSync(path.join(OUT, d)).isDirectory());
  for (const girl of girls) {
    if (ONLY && girl !== ONLY) continue;
    const gd = path.join(OUT, girl);
    for (const f of fs.readdirSync(gd)) {
      if (!f.endsWith('.mp4')) continue;
      const id = f.slice(0, -4);
      const m = id.match(/-([a-z-]+)-p\d+$/); if (!m) continue;
      const tpl = ЦЕЛЬ[m[1]]; if (!tpl) continue;
      const mp4 = path.join(gd, f);
      if (fs.statSync(mp4).mtimeMs < порог) continue;
      const к1 = path.join(gd, id + '.кадр1.jpg'), к2 = path.join(gd, id + '.кадр2.jpg');
      const к3 = path.join(gd, id + '.кадр3.jpg'), к4 = path.join(gd, id + '.кадр4.jpg');
      if (![к1, к3, к4].every(fs.existsSync)) { console.log('SKIP', id, 'нет кадров'); continue; }
      задачи.push({ girl, gd, id, tpl, mp4, к1, к2, к3, к4 });
    }
  }
  console.log('к перенарезке:', задачи.length);
  const N = Number(process.env.PAR || 4);
  let i = 0, чинено = 0, сбой = 0;
  async function воркер() {
    while (i < задачи.length) {
      const t = задачи[i++];
      try { await чинить(t.girl, t.gd, t.id, t.tpl, t.mp4, t.к1, t.к2, t.к3, t.к4); чинено++;
        if (чинено % 10 === 0) console.log('прогресс:', чинено, '/', задачи.length);
      } catch (e) { сбой++; console.log('FAIL', t.id, String(e.message).slice(0, 80)); }
    }
  }
  await Promise.all(Array.from({ length: N }, воркер));
  console.log(`ГОТОВО: перенарезано ${чинено}, сбоев ${сбой}`);
})();
