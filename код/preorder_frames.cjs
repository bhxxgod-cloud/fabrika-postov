#!/usr/bin/env node
// ПРЕД-ЗАКАЗ КАДРОВ ДЛЯ ПОСТОВ ПРЯМЫМИ ЗАПРОСАМИ RenderGrid (rgen.cjs), БЕЗ БРАУЗЕРА.
//
// Вход: /tmp/jobs_tatu.txt и /tmp/jobs_pink.txt, строка: tpl|file|persona|метка
//   (file = локальный исходник-селфи, метка = имя папки результата).
// Выход: /tmp/preorder/<метка_с_подчёркиваниями>/{кадр3,кадр4,постер2}.jpg
//        и манифест /tmp/preorder/manifest.json.
//
// Что заказывается на задание (промпты строятся ровно как в onepost.cjs):
//   • кадр 3 (образ): pk.lookPrompt({template, step:3, srcHair, hairIdx, hairLenIdx, place: loc3,
//     light, bgMode, poseSeed}) — сигнатура из onepost.cjs:722-724. poseSeed ТОЛЬКО карточным:
//     lookPrompt для не-карточных с poseSeed падает намеренно (promptkit.cjs:1604).
//   • кадр 4 (финал): только КАРТОЧНЫМ шаблонам — lookPrompt step:4 (onepost.cjs:667-668).
//     Арт-шаблонам финал делается artFinalPrompt ПО КАДРУ 2, которого ещё нет: в предзаказ не
//     входит, в манифесте пометка artFinal: 'после кадра 2'.
//   • постер кадра 2: только GEN_CARD (img-haircut-match, img-nose-verdict, onepost.cjs:142) —
//     промпт шаблона сайта из tplprompts.json, обрезка до 3900 по границе предложения
//     (onepost.cjs:566-569), aspect 9:16.
//   • img-heart-hair (phoneOk): кадр 3 в конвейере это ЛОКАЛЬНЫЙ мокап телефона (lockMock,
//     бесплатно), генерённый образ там не используется — кадр 3 НЕ заказываем, только пометка.
//
// Референс всегда ЗАЛИВКОЙ ФАЙЛА (rgen refFiles → image_file_ids). Модель nano-banana-pro.
// Разрешение: финал (кадр 4) 2K, остальное 1K. Аспект кадров 3/4 — 4:5, постера — 9:16.
// Параллельность: 4 заказа одновременно. Ретрай на HTTP 503 как в facegen.cjs:165-177
// (до 4 попыток, пауза 20 с, отказ на постановке денег не стоит).
//
// ЗАПУСК:
//   node preorder_frames.cjs --dry   план и промпты, БЕЗ денег (обязательная первая проверка)
//   node preorder_frames.cjs --go    боевой прогон (тратит деньги)
// Без флага скрипт не делает НИЧЕГО: случайный запуск не должен стоить ни цента.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = '/Users/qq/Desktop/neironka-poster';
const rgen = require(path.join(REPO, 'rgen.cjs'));
const pk = require(path.join(REPO, 'promptkit.cjs'));
const TPL = require(path.join(REPO, 'templates.cjs'));
const { hairFamily } = require(path.join(REPO, 'framegate.cjs'));

const DRY = process.argv.includes('--dry');
const GO = process.argv.includes('--go');
const ФАЙЛЫ_АРГУМЕНТОМ = process.argv.filter((a) => a.startsWith('/') && a.endsWith('.txt'));
const JOB_FILES = ФАЙЛЫ_АРГУМЕНТОМ.length ? ФАЙЛЫ_АРГУМЕНТОМ : ['/tmp/jobs_tatu.txt', '/tmp/jobs_pink.txt'];
const OUTROOT = '/tmp/preorder';
const MODEL = 'nano-banana-pro';
// Как в onepost.cjs:142 — шаблоны, чей кадр 2 это генерённый постер по промпту сайта.
const GEN_CARD = new Set(['img-haircut-match', 'img-nose-verdict']);
const CONC = Number(process.env.PREORDER_CONC || 24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Цена заказа по таблице rgen (запасной счёт; фактический итог берётся из rgen.spentSoFar).
const цена = (res) => (rgen.PRICE_RES[MODEL] || {})[res] || rgen.PRICE[MODEL] || 0;

// ═══ ЧТЕНИЕ ЗАДАНИЙ ══════════════════════════════════════════════════════════════════════════
function читатьЗадания() {
  const jobs = [];
  for (const f of JOB_FILES) {
    if (!fs.existsSync(f)) { console.log(`⚠ файла заданий нет: ${f}`); continue; }
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const p = s.split('|').map((x) => x.trim());
      if (p.length < 4) { console.log(`⚠ кривая строка в ${path.basename(f)}: «${s.slice(0, 80)}»`); continue; }
      jobs.push({ tpl: p[0], file: p[1], persona: p[2], метка: p[3], из: path.basename(f) });
    }
  }
  return jobs;
}

// ═══ ПЛАН ОДНОГО ЗАДАНИЯ (всё локально и бесплатно) ══════════════════════════════════════════
// rotor = сквозной индекс задания: соседние задания получают разные пары локаций (как ротор
// rotors.json у onepost, только без файла — предзаказ одноразовый и идёт одним процессом).
function планЗадания(job, rotor) {
  const { tpl, file, persona, метка } = job;
  const dir = path.join(OUTROOT, метка.replace(/\s+/g, '_'));
  const план = { метка, tpl, persona, исходник: file, dir, rotor, заказы: [], ошибки: [] };

  if (!TPL.isKnown(tpl)) план.ошибки.push(`шаблон «${tpl}» не описан в templates.cjs`);
  if (!fs.existsSync(file)) { план.ошибки.push(`нет исходника: ${file}`); return план; }

  const isCard = TPL.isCard(tpl);
  const phoneOk = TPL.phoneOk(tpl);
  план.вид = isCard ? 'карточный' : (phoneOk ? 'телефонный (hearts)' : 'арт');

  // Входы промптов — ровно как в onepost.cjs:
  //   srcHair = hairFamily(обложка) (onepost.cjs:593; тут меряем по сырому исходнику — обложки
  //   с хуком ещё нет, а кроп 4:5 семью цвета не меняет);
  //   hairIdx от persona (onepost.cjs:594);
  //   hairLenIdx по хэшу (onepost.cjs:599; в onepost семя это tag сборки, тут persona — у
  //   предзаказа tag ещё не существует, а длина обязана быть стабильной на пересборках);
  //   позаСемя = sha256 исходника (onepost.cjs:345-362).
  const srcHair = hairFamily(file);
  const hairIdx = Array.from(persona).reduce((a, ch) => a + ch.codePointAt(0), 0) % 2;
  const hairLenIdx = pk.hairLenByHash(persona);
  const позаСемя = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const places = pk.pickCityPlaces(rotor);
  Object.assign(план, { srcHair, hairIdx, hairLenIdx,
    локации: `кадр 3 «${places.name3 || places.loc3}», кадр 4 «${places.name4 || places.loc4}» (тир ${places.tierName || places.tier})` });

  // ── кадр 3 (образ), aspect 4:5, 1K ─────────────────────────────────────────────────────────
  if (phoneOk) {
    // hearts: кадр 3 это мокап телефона, рисуется локально slidekit.lockMock — генерить нечего.
    план.кадр3Пропуск = 'телефонный шаблон: кадр 3 это локальный мокап (lockMock), не генерится';
  } else {
    план.заказы.push({
      что: 'кадр3', dest: path.join(dir, 'кадр3.jpg'), aspect: '4:5', resolution: '1K',
      prompt: pk.lookPrompt({ template: tpl, step: 3, srcHair, hairIdx, hairLenIdx,
        place: places.loc3, light: places.light3 || '', bgMode: places.bg3,
        ...(isCard ? { poseSeed: позаСемя } : {}) }),
    });
  }

  // ── кадр 4 (финал): только карточным; aspect 4:5, 2K ───────────────────────────────────────
  if (isCard) {
    план.заказы.push({
      что: 'кадр4', dest: path.join(dir, 'кадр4.jpg'), aspect: '4:5', resolution: '2K',
      prompt: pk.lookPrompt({ template: tpl, step: 4, srcHair, hairIdx, hairLenIdx,
        place: places.loc4, light: places.light4 || '', bgMode: places.bg4, poseSeed: позаСемя }),
    });
  } else {
    план.artFinal = 'после кадра 2';
  }

  // ── постер кадра 2: только GEN_CARD; промпт сайта, aspect 9:16, 1K ─────────────────────────
  if (GEN_CARD.has(tpl)) {
    const промптыСайта = JSON.parse(fs.readFileSync(path.join(REPO, 'tplprompts.json'), 'utf8'));
    let промптПостера = промптыСайта[tpl];
    if (!промптПостера || промптПостера.length < 100) {
      план.ошибки.push(`нет промпта шаблона «${tpl}» в tplprompts.json`);
    } else {
      // Обрезка как в onepost.cjs:566-569: API берёт до 4000 знаков, режем по границе предложения.
      if (промптПостера.length > 3900) {
        const срез = промптПостера.slice(0, 3900);
        промптПостера = срез.slice(0, срез.lastIndexOf('.') + 1) || срез;
      }
      план.заказы.push({
        что: 'постер2', dest: path.join(dir, 'постер2.jpg'), aspect: '9:16', resolution: '1K',
        prompt: промптПостера,
      });
    }
  }

  // Перезапуск без двойной оплаты: кадр уже скачан — заказ не повторяем.
  план.заказы = план.заказы.filter((z) => {
    if (fs.existsSync(z.dest) && fs.statSync(z.dest).size > 20000) { план[z.что] = z.dest; return false; }
    return true;
  });
  for (const z of план.заказы) z.цена = цена(z.resolution);
  return план;
}

// ═══ ЗАКАЗ С РЕТРАЕМ НА 503 (как facegen.cjs:165-177) ════════════════════════════════════════
async function заказать(z, ref, tag) {
  for (let попытка = 1; ; попытка++) {
    try {
      return await rgen.genToFile(z.dest, {
        prompt: z.prompt, refFiles: [ref], model: MODEL,
        aspect: z.aspect, resolution: z.resolution, tag,
      });
    } catch (e) {
      if (попытка >= 4 || !/HTTP 503|provider_unavailable/.test(String(e && e.message))) throw e;
      console.log(`  провайдер занят (503), повтор ${попытка} через 20 с, денег не потрачено (${tag})`);
      await sleep(20000);
    }
  }
}

// ═══ ПУЛ: не больше CONC заказов одновременно ════════════════════════════════════════════════
async function гнатьПулом(работы, conc) {
  let i = 0;
  const воркер = async () => {
    while (i < работы.length) {
      const моя = работы[i++];
      await моя();
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, работы.length) }, воркер));
}

// ═══ ГЛАВНОЕ ═════════════════════════════════════════════════════════════════════════════════
async function main() {
  if (!DRY && !GO) {
    console.log('Ничего не делаю. Запуск:\n  --dry  план и промпты, денег не тратит\n  --go   боевой прогон (ПЛАТНЫЙ)');
    process.exit(2);
  }
  const jobs = читатьЗадания();
  if (!jobs.length) { console.log('заданий нет'); process.exit(1); }
  console.log(`заданий: ${jobs.length} (${JOB_FILES.map((f) => path.basename(f)).join(' + ')}), режим: ${DRY ? 'DRY, денег не тратим' : 'БОЕВОЙ'}`);

  // Планы строим последовательно: ffmpeg-замер цвета волос дёшев, а лог читается по порядку.
  const планы = jobs.map((j, i) => {
    const p = планЗадания(j, i);
    console.log(`\n[${i}] ${p.метка} · ${p.tpl} (${p.вид || '?'}) · persona ${p.persona}`);
    console.log(`  исходник: ${p.исходник}`);
    if (p.srcHair) console.log(`  srcHair=${p.srcHair} hairIdx=${p.hairIdx} hairLenIdx=${p.hairLenIdx} ротор=${p.rotor}`);
    if (p.локации) console.log(`  локации: ${p.локации}`);
    if (p.кадр3Пропуск) console.log(`  ⚠ ${p.кадр3Пропуск}`);
    if (p.artFinal) console.log(`  кадр 4: не заказываем, artFinal «${p.artFinal}» (нужен кадр 2)`);
    for (const о of p.ошибки) console.log(`  ⛔ ${о}`);
    for (const z of p.заказы) {
      console.log(`  → ${z.что}: ${MODEL}, ${z.aspect}, ${z.resolution}, ~$${z.цена.toFixed(3)} → ${z.dest}`);
      if (DRY) console.log(`    промпт (${z.prompt.length} знаков):\n    ${z.prompt.replace(/\n/g, '\n    ')}`);
    }
    return p;
  });

  const всеЗаказы = планы.flatMap((p) => p.заказы.map((z) => ({ p, z })));
  const оценка = всеЗаказы.reduce((a, { z }) => a + z.цена, 0);
  if (DRY) {
    console.log(`\nПЛАН: заданий ${планы.length}, заказов ${всеЗаказы.length}, оценка ~$${оценка.toFixed(2)}. `
      + 'Денег не потрачено (--dry). Боевой прогон: тот же скрипт с --go.');
    return;
  }

  // Боевой прогон: ключ проверяем ДО первого заказа, чтобы не падать посреди пачки.
  rgen.apiKey();
  fs.mkdirSync(OUTROOT, { recursive: true });
  for (const p of планы) if (p.заказы.length) fs.mkdirSync(p.dir, { recursive: true });

  const работы = всеЗаказы.map(({ p, z }) => async () => {
    const tag = `${p.метка} ${z.что}`;
    try {
      await заказать(z, p.исходник, tag);
      z.готово = true;
      console.log(`  ✓ ${tag} → ${z.dest}`);
    } catch (e) {
      z.готово = false;
      p.ошибки.push(`${z.что}: ${String((e && e.message) || e).slice(0, 200)}`);
      console.log(`  ⛔ ${tag}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  });
  await гнатьПулом(работы, CONC);

  // ═══ МАНИФЕСТ ══════════════════════════════════════════════════════════════════════════════
  const найдено = (p, что) => {
    const z = p.заказы.find((x) => x.что === что);
    return z && z.готово ? z.dest : null;
  };
  const манифест = планы.map((p) => ({
    метка: p.метка,
    tpl: p.tpl,
    persona: p.persona,
    исходник: p.исходник,
    кадр3: найдено(p, 'кадр3'),
    кадр4: найдено(p, 'кадр4'),
    постер2: найдено(p, 'постер2'),
    цены: Object.fromEntries(p.заказы.filter((z) => z.готово).map((z) => [z.что, z.цена])),
    ...(p.artFinal ? { artFinal: p.artFinal } : {}),
    ...(p.кадр3Пропуск ? { кадр3Пропуск: p.кадр3Пропуск } : {}),
    ...(p.ошибки.length ? { ошибки: p.ошибки } : {}),
  }));
  const мф = path.join(OUTROOT, 'manifest.json');
  // ДОЗАПИСЬ, НЕ ПЕРЕЗАПИСЬ (13.08): волна 3 затёрла манифест волны 2, и сборки перестали видеть
  // свои готовые кадры. Прежние записи сохраняются, совпадающие метки обновляются свежими.
  let прежний = [];
  try { прежний = JSON.parse(fs.readFileSync(мф, 'utf8')); } catch {}
  const своиМетки = new Set(манифест.map((x) => x.метка));
  const слитый = прежний.filter((x) => !своиМетки.has(x.метка)).concat(манифест);
  fs.writeFileSync(мф, JSON.stringify(слитый, null, 2));
  console.log(`\nманифест: ${мф}`);

  const итог = rgen.spentSoFar();
  const бед = планы.reduce((a, p) => a + p.ошибки.length, 0);
  console.log(`заказов ${итог.orders}, потрачено $${итог.usd.toFixed(2)}`
    + ` (rgen.spentSoFar; цены 1K=$${цена('1K')}, 2K=$${цена('2K')} по rgen.PRICE_RES)`
    + (бед ? ` · ошибок ${бед}, смотри манифест` : ''));
}

main().catch((e) => { console.error(`СБОЙ: ${(e && e.stack) || e}`); process.exit(1); });
