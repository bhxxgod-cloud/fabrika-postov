// Ждём сброса квоты ютуба (00:00 по тихоокеанскому = 10:00 МСК) и доливаем обложки
// на пять каналов, где сейчас голый кадр вместо плашки с заголовком.
const { execSync } = require('child_process');
const ms = () => {
  const pt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const next = new Date(pt); next.setHours(24, 15, 0, 0);   // 00:15 PT, с запасом
  return next - pt;
};
const wait = ms();
console.log('жду сброса квоты:', (wait / 3600e3).toFixed(1), 'часов');
setTimeout(() => {
  for (const slug of ['brand', 'podruga', 'prigovor', 'verdict', 'drugaya']) {
    try {
      const out = execSync(`node ytthumbs.cjs ${slug} --limit 60 --all-again`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 20e6 });
      console.log(out.split('\n').filter((l) => /^[a-z_]+:/.test(l)).join('\n'));
    } catch (e) { console.error(slug, 'упал:', e.message.slice(0, 120)); }
  }
  console.log('готово');
}, wait);
