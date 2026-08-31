#!/usr/bin/env node
'use strict';
// КРУГЛОСУТОЧНЫЙ СТОРОЖ ЛИЦА НА КАДРЕ 1 (13.08, после разбора «стал здоровый нос»).
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ ГЕЙТА В onepost. Гейт в сборщике ловит брак ДО заказа фабрики, и это главное.
// Но он закрывает только один путь появления поста — сборку через onepost. Мимо него идут: посты,
// собранные другими скриптами (genposts, harvest_salvo, ingest, фабрика партнёра), посты, которым
// обложку меняли руками (fixcover), и все 182 поста, что уже лежат на складе с генерённой обложкой.
// Плюс эталон могут завести ПОЗЖЕ, чем собрали посты, — тогда старые никто не перепроверит.
// Поэтому вторая линия: проходить по свежим постам и мерить кадр 1 против эталона персоны.
//
// ПОЧЕМУ ЭТО ДЕШЁВО. Мера локальная (facesim.py, две onnx-модели), обложка обычно лежит на диске
// (meta.source_cover), качать надо редко. Один проход по десятку постов это секунды и ноль денег,
// поэтому сторож может ходить хоть каждые пять минут и не мешать сборке рилсов.
//
// ЧТО ДЕЛАЕТ: меряет, пишет журнал, шлёт в телеграм ТОЛЬКО новое (дедуп по id поста), и ставит
// число в meta.face_ref, чтобы дальше по нему можно было считать долю чужих лиц запросом, а не
// пересматривать склад глазами.
//
// НЕ БРАКУЕТ САМ. Сторож не трогает status поста: снять пост со склада это решение начальника, а
// не автоматики (пост уже собран и оплачен, а мера у порога бывает серой). Его дело — показать.
//
// Запуск:
//   node facewatch.cjs                  один проход по свежим постам
//   node facewatch.cjs --loop 600       круглосуточно, проход каждые 600 секунд
//   node facewatch.cjs --limit 200      глубже по складу (разовая ревизия)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const faceref = require('./faceref.cjs');

const ЖУРНАЛ = '/tmp/facewatch.json';      // {id: схожесть} — чтобы не слать одно и то же дважды
const КАДРЫ = '/tmp/facewatch';            // сюда качаем кадр 1, если исходника нет на диске

const журнал = () => { try { return JSON.parse(fs.readFileSync(ЖУРНАЛ, 'utf8')); } catch { return {}; } };

// Шлём тем же способом, что и остальные сторожа фермы (duty_safe, backlog_safe, gologin_watch):
// токен в /tmp/tg_bot.txt, чат в /tmp/tg_chat.txt. Один канал на всех, чтобы настройка была одна.
async function тг(текст) {
  try {
    const bot = (fs.existsSync('/tmp/tg_bot.txt') ? fs.readFileSync('/tmp/tg_bot.txt', 'utf8') : (process.env.TELEGRAM_BOT_TOKEN || '')).trim();
    const chat = (fs.existsSync('/tmp/tg_chat.txt') ? fs.readFileSync('/tmp/tg_chat.txt', 'utf8') : (process.env.TELEGRAM_CHAT_ID || '')).trim();
    if (!bot || !chat) { console.log('  (телеграм не настроен: нет /tmp/tg_bot.txt или /tmp/tg_chat.txt)'); return; }
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: текст, disable_web_page_preview: true }),
    });
  } catch (e) { console.log(`  телеграм не ответил: ${e.message}`); }
}

async function проход(лимит) {
  const c = new Client({
    connectionString: (process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8')).trim(),
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  let новыйБрак = [];
  try {
    const r = await c.query(
      `SELECT id, status, meta->>'persona' persona, meta->>'template' tpl,
              meta->>'source_cover' src, meta->'image_urls'->>0 url
         FROM posts
        WHERE meta->'image_urls'->>0 IS NOT NULL
          AND status IN ('backlog','ready','queued','posted')
        ORDER BY created_at DESC LIMIT $1`, [Number(лимит) || 40]);
    const ж = журнал();
    fs.mkdirSync(КАДРЫ, { recursive: true });
    for (const п of r.rows) {
      if (ж[п.id] !== undefined) continue;                       // уже мерили этот пост
      if (!faceref.эталон(п.persona)) continue;                  // нет эталона — молчим, это не брак
      let кадр = п.src && fs.existsSync(п.src) ? п.src : null;
      if (!кадр) {
        кадр = path.join(КАДРЫ, `${п.id.slice(0, 8)}.jpg`);
        try { if (!fs.existsSync(кадр)) execFileSync('curl', ['-sS', '--fail', '--max-time', '60', '-o', кадр, п.url]); } catch { continue; }
      }
      const в = faceref.проверить(п.persona, кадр);
      if (в.ok === null) continue;                               // «не проверено» это не приговор
      ж[п.id] = в.v;
      // Число в базу: по нему потом считается доля чужих лиц одним запросом.
      await c.query(
        `UPDATE posts SET meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{face_ref}', $2::jsonb, true) WHERE id = $1`,
        [п.id, JSON.stringify({ v: в.v, порог: в.порог, эталон: в.файл, серая: !!в.серая, кем: 'facewatch' })]);
      const знак = в.ok ? (в.серая ? '⚠' : '✓') : '✗';
      console.log(`${знак} ${п.id.slice(0, 8)} ${String(п.persona).padEnd(20)} ${String(п.tpl).padEnd(22)} ${в.v}`);
      if (!в.ok) новыйБрак.push(`${п.id.slice(0, 8)} · ${п.persona} · ${п.tpl} · схожесть ${в.v}`);
    }
    fs.writeFileSync(ЖУРНАЛ, JSON.stringify(ж, null, 1));
  } finally { await c.end().catch(() => {}); }

  if (новыйБрак.length) {
    const т = `🚨 ЧУЖОЕ ЛИЦО НА КАДРЕ 1 (порог ${faceref.ПОРОГ})\n\n${новыйБрак.join('\n')}\n\n`
      + 'Это обложка, а не кадры 3-4: карточка на кадре 2 разбирает внешность по исходному лицу, '
      + 'и зритель видит разных людей в одном посте. Публиковать нельзя.';
    console.log(`\n${т}`);
    await тг(т);
  }
  return новыйБрак.length;
}

async function main() {
  const a = process.argv.slice(2);
  const флаг = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const лимит = флаг('limit', 40);
  const цикл = Number(флаг('loop', 0));
  if (!цикл) { const n = await проход(лимит); process.exit(n ? 1 : 0); }
  console.log(`сторож лица: проход каждые ${цикл} с, глубина ${лимит} постов`);
  for (;;) {
    try { await проход(лимит); } catch (e) { console.error(`проход упал: ${e.message}`); }
    await new Promise((r) => setTimeout(r, цикл * 1000));
  }
}

if (require.main === module) main().catch((e) => { console.error('ПАДЕНИЕ:', e.message); process.exit(1); });
module.exports = { проход };
