// latestpost.cjs — аноним заходит на ПРОФИЛЬ креатора, тянет свежие коды постов из сетки.
// БЕЗ логина, анлим-прокси. usage: node latestpost.cjs <user1> [user2 ...]
const fs = require('fs');
const { chromium } = require('playwright-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
function pickProxy() {
  const lines = fs.readFileSync('/Users/qq/Desktop/neironka-poster/anon_proxies.txt', 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l.startsWith('http '));
  const p = lines[Math.floor(Math.random() * lines.length)].slice(5);
  const at = p.lastIndexOf('@'); const cred = p.slice(0, at); const hp = p.slice(at + 1);
  const ci = cred.indexOf(':');
  return { server: 'http://' + hp, username: cred.slice(0, ci), password: cred.slice(ci + 1), host: hp };
}
(async () => {
  if (process.env.CHP !== '1') { console.log('⛔ latestpost: локальный анон на ноуте владельца ЗАПРЕЩЁН без CHP=1 (правило 23.07).'); process.exit(2); }
  const users = process.argv.slice(2).map((u) => u.replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/.*$/, ''));
  const px = pickProxy();
  console.log(`latestpost через прокси ${px.host} | юзеры: ${users.join(', ')}`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: false, proxy: { server: px.server, username: px.username, password: px.password }, args: ['--no-first-run', '--no-default-browser-check'] });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  for (const user of users) {
    try {
      await page.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(5000);
      for (const t of ['Decline optional cookies', 'Allow all cookies', 'Not Now', 'Not now']) {
        const b = page.getByRole('button', { name: new RegExp('^' + t + '$', 'i') }).first();
        if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(700); }
      }
      await sleep(1500);
      const data = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
          const m = a.getAttribute('href').match(/\/(p|reel)\/([^/?]+)/);
          if (m && !seen.has(m[2])) { seen.add(m[2]); out.push({ kind: m[1], code: m[2] }); }
        }
        const pinned = document.body.innerText.includes('Pinned') || document.querySelector('svg[aria-label*="Pinned" i]') ? 'есть закреп' : 'нет закрепа';
        const guest = /Log in|Войти|Sign up|Зарегистрироваться/i.test(document.body.innerText.slice(0, 500));
        return { out: out.slice(0, 9), pinned, guest, title: document.title };
      });
      console.log(`\n@${user} [${data.title}] ${data.pinned}${data.guest ? ' | ⚠гостевой-вол виден' : ''}`);
      data.out.forEach((x, i) => console.log(`  ${i + 1}. ${x.kind}/${x.code}  https://www.instagram.com/reel/${x.code}/`));
      if (!data.out.length) console.log('  (постов не извлечено — приват/вол/пусто)');
      await page.screenshot({ path: `${SHOT}/prof_${user}.png` }).catch(() => {});
    } catch (e) { console.log(`@${user} ОШИБКА: ${e.message.slice(0, 80)}`); }
    await sleep(1200);
  }
  await browser.close().catch(() => {});
// ЯВНЫЙ ВЫХОД ПОСЛЕ РАБОТЫ (07.08). После playwright/CDP и после pg в процессе остаются живые
// сокеты, и нода не завершается сама: скрипт печатал итог и висел (fix4.cjs провисел так 45
// минут, и снаружи это читалось как «работа идёт»). Пауза 60 мс даёт вывести последние строки.
})().then(() => setTimeout(() => process.exit(0), 60))
  .catch((e) => { console.log('FATAL', e.message); process.exit(1); });
