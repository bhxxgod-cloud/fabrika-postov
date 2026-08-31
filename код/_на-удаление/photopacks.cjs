// Скачивает готовые фотопосты (карусель 1.jpg/2.jpg/3.jpg) и шлёт их в ТГ ОДНИМ альбомом
// с подписью и тегами — как просил владелец: «картинки + описание и теги одним постом».
// Список постов приходит из фабрики (собран в браузере), здесь только скачивание и отправка.
// Файлы кладём в папку модели, чтобы потом их же брать в постинг.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(os.homedir(), 'Desktop', 'АВАТАРЫ ');
const packs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// «Подпись:» в карточке — это то, что реально пойдёт в Instagram; «На фото:» — текст-хук на картинке.
function parseCard(text) {
  const persona = (text.match(/^(.+?)\s+(Маша|Сабина|Полина|Карина|Дарья|Анечка)\s+·/) || [])[2] || 'без модели';
  const tpl = (text.match(/^(.+?)\s+(?:Маша|Сабина|Полина|Карина|Дарья|Анечка)\s+·/) || [])[1] || '';
  const caption = (text.match(/Подпись:\s*(.+?)\s*(?:Скопировать подпись|Скачать все|$)/) || [])[1] || '';
  return { persona, tpl: tpl.trim(), caption: caption.trim() };
}

const dl = (url, dest) => new Promise((res, rej) => {
  const p = spawn('curl', ['-s', '--max-time', '60', '-o', dest, url]);
  p.on('close', (c) => (c === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 5000 ? res() : rej(new Error(`не скачалось: ${url}`))));
});

const send = (args) => new Promise((res) => {
  const p = spawn('node', [path.join(__dirname, 'tgsend.cjs'), ...args], { cwd: __dirname, env: process.env });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', () => res(out.trim()));
});

(async () => {
  for (const pack of packs) {
    const { persona, tpl, caption } = parseCard(pack.text);
    const dir = path.join(ROOT, persona, 'фотопосты', pack.id.slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    try {
      for (const [i, u] of pack.imgs.entries()) {
        const dest = path.join(dir, `${i + 1}.jpg`);
        if (!fs.existsSync(dest)) await dl(u, dest);
        files.push(dest);
      }
    } catch (e) { console.log(`⛔ ${persona} «${tpl}»: ${e.message}`); continue; }

    const note = `${tpl}\n\n${caption}`;
    // --key = id поста (06.08): без ключа один и тот же пак, скачанный в другую папку, уходил
    // в группу заново. Ключ передаём всегда, дедуп tgsend опирается на него и на сами кадры.
    const out = await send(['--carousel', ...files, '--key', String(pack.id),
      '--persona', persona, '--type', 'фотопост', '--note', note]);
    console.log(`${persona} «${tpl}» → ${out}`);
  }
})();
