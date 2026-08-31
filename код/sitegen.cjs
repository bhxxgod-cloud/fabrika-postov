// ГЕНЕРАЦИЯ ЧЕРЕЗ ДВИЖОК САЙТА С ОПОЗНАНИЕМ СВОЕГО РЕЗУЛЬТАТА (05.08).
//
// Зачем отдельный модуль. Два канала генерации были непригодны:
//   • прямой API RenderGrid НЕ держит лицо с референса (Аня выходила брюнеткой);
//   • движок сайта лицо держит, но результат я брал как «первую новую картинку в галерее»,
//     а начальник генерит параллельно — и в файл арта Даны приехала ЧУЖАЯ картинка.
//
// Решение: у сайта есть GET /api/generations?kind=image&limit=N со списком
// {id, status, prompt, result, createdAt}. Мы запоминаем id ДО запуска, после клика находим
// НОВУЮ запись, чей prompt совпадает с нашим, и дальше следим ровно за её id. Чужие генерации
// в этот момент могут идти сколько угодно — мы их не перепутаем.
//
// Использование: const { siteGenerate } = require('./sitegen.cjs');
//                await siteGenerate(page, { prompt, refFile, out });
'use strict';
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listGens(page, limit = 30) {
  return await page.evaluate(async (limit) => {
    const r = await fetch(`/api/generations?kind=image&limit=${limit}`);
    if (!r.ok) return [];
    return ((await r.json()).items || []).map((x) => ({
      id: x.id, status: x.status, prompt: String(x.prompt || ''), result: x.result, error: x.error,
    }));
  }, limit);
}

// Из поля result достаём ссылку: форма менялась, поэтому разбираем терпимо.
function urlFrom(result) {
  if (!result) return null;
  if (typeof result === 'string') return /^https?:\/\//.test(result) ? result : null;
  if (Array.isArray(result)) return urlFrom(result[0]);
  for (const k of ['url', 'imageUrl', 'image_url', 'src']) if (typeof result[k] === 'string') return result[k];
  for (const k of ['urls', 'images', 'result_urls', 'resultUrls', 'output']) {
    const v = result[k];
    if (Array.isArray(v) && v.length) return urlFrom(v[0]);
  }
  return null;
}

async function siteGenerate(page, { prompt, refFile, out, waitMs = 8 * 60000 }) {
  // Невидимая метка прогона в конце промпта: домашний промпт побайтово одинаков у всех
  // персон, и опознание «по первым 40 символам» хватало ЧУЖУЮ генерацию (случай 05.08).
  const runTag = ` \u200b#${Math.random().toString(36).slice(2, 8)}`;
  prompt = String(prompt) + runTag;
  await page.goto('https://neironka.pro/generate/image', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  const before = new Set((await listGens(page)).map((g) => g.id));
  await page.locator('textarea').first().fill(prompt);
  if (refFile) {
    await page.locator('input[type=file]').first().setInputFiles(refFile);
    await sleep(3000);
  }
  // Кнопка блокируется, пока крутится другая генерация — ждём, а не падаем по таймауту клика.
  const btn = page.getByRole('button', { name: /Сгенерировать/i }).first();
  for (let i = 0; i < 40; i++) {
    if (await btn.isEnabled().catch(() => false)) break;
    await sleep(5000);
  }
  await btn.click({ timeout: 20000 });

  // Опознаём СВОЮ запись: новая + промпт совпадает с началом нашего.
  const head = runTag;   // ищем по своей метке, а не по началу промпта
  let myId = null;
  for (let i = 0; i < 24 && !myId; i++) {
    await sleep(5000);
    const gens = await listGens(page);
    const cands = gens.filter((g) => !before.has(g.id) && g.prompt.includes(runTag.trim()));
    if (cands.length > 1) throw new Error('неоднозначное опознание своей генерации');
    if (cands.length === 1) myId = cands[0].id;
  }
  if (!myId) throw new Error('своя генерация не опознана в списке');

  // Дальше следим ровно за своим id.
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const g = (await listGens(page)).find((x) => x.id === myId);
    if (g) {
      if (/^(done|completed|success|succeeded|ready)$/i.test(g.status)) {
        const url = urlFrom(g.result);
        if (!url) throw new Error('генерация готова, но ссылки в result нет');
        // Проверяем, что скачалась КАРТИНКА, а не страница ошибки: раньше 403/404 молча
        // записывался как .png и возвращался как успех (аудит 06.08).
        // ТАЙМАУТ ОБЯЗАТЕЛЕН (07.08): своя сборка ждёт эту картинку, и висяк тут = висяк поста.
        const buf = await require('./watchdog.cjs').fetchBuf(url, { what: 'картинка генерации', ms: 90000 });
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
        if (buf.length < 20000 || (!isPng && !isJpg)) throw new Error('скачался не образ картинки');
        fs.writeFileSync(out, buf);
        return { out, id: myId };
      }
      if (/^(failed|error|cancell?ed)$/i.test(g.status)) throw new Error(`генерация упала: ${String(g.error || '').slice(0, 80)}`);
    }
    await sleep(6000);
  }
  throw new Error('таймаут ожидания своей генерации');
}

module.exports = { siteGenerate, listGens };
