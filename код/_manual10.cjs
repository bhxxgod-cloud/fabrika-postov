'use strict';
// РУЧНОЙ ЗАЛИВ СВЕРХ ЛИМИТА: готовим комплект на 10 каналов, пока квота API выбрана.
// Заголовок пишем локально по НОВЫМ правилам канала плюс хуки пула, обложку печатаем сами.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const KEY = fs.readFileSync(os.homedir() + '/.neironka/secrets/orkey.txt', 'utf8').trim();
const { makeThumb } = require('./thumbgen.cjs');
const { ПУЛ, РЕГИСТР } = require('./хуки-ядро.cjs');
const OUT = os.homedir() + '/Desktop/ЮТУБ/ручной-залив-25-08';

function pick(a, n) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b.slice(0, n); }
function hookBlock(tpl) {
  const it = ПУЛ[tpl]; if (!it) return '';
  const all = [...pick((it.крик || []).map((h) => h.т), 4), ...pick((it.пов || []).map((h) => h.т), 3)];
  return ['', `ТЕМА РОЛИКА: шаблон «${tpl}».`, 'ОБРАЗЦЫ ЖИВЫХ НАЗВАНИЙ ДЛЯ ЭТОЙ ТЕМЫ (утверждены владельцем построчно):',
    ...all.map((s) => '  ' + s), 'Напиши НОВОЕ название в этом же духе и в этом же регистре речи. Не копируй образцы дословно,',
    'но держи их интонацию, длину и знаки. Название обязано подходить именно этой теме.'].join('\n');
}
async function gen(prompt, ctx) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'X-Title': 'neironka-poster' },
    body: JSON.stringify({ model: 'anthropic/claude-opus-4.8', max_tokens: 400, messages: [{ role: 'system', content: prompt }, { role: 'user', content: ctx }] }),
    signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  const t = (r.choices?.[0]?.message?.content || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).shift() || '';
  return t.replace(/^\s*(?:\d{1,2}\s*[.):\-]|[-–—•*])\s*/, '').replace(/["«»'`*]/g, '').replace(/#\S+/g, '').replace(/—/g, ',').replace(/\s{2,}/g, ' ').trim();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows: chans } = await c.query("SELECT id, slug, title, title_prompt FROM yt_channels WHERE platform='youtube' AND enabled ORDER BY id");
  const комплект = [];
  const взятыеШаблоны = new Set();
  for (const ch of chans) {
    // берём самый приоритетный из очереди, у кого файл реально на месте и шаблон известен
    const { rows } = await c.query(`SELECT id, file_path, template, ai_title FROM yt_queue
      WHERE channel_id=$1 AND status='queued' AND file_path IS NOT NULL AND template IS NOT NULL
      ORDER BY (scheduled_at IS NULL), scheduled_at, id LIMIT 12`, [ch.id]);
    // РАЗНЫЕ ШАБЛОНЫ ПО КАНАЛАМ. Первый прогон дал пять каналов подряд с темой «нос» и почти
    // одинаковыми названиями: дедуп заголовков работает внутри канала, между каналами его нет.
    // В ленте это читается как один пост, размноженный по десяти каналам.
    const живые = rows.filter((r) => { try { return fs.existsSync(r.file_path); } catch { return false; } });
    const item = живые.find((r) => !взятыеШаблоны.has(r.template)) || живые[0];
    if (!item) { комплект.push({ канал: ch.title, ошибка: 'нет ролика с живым файлом' }); continue; }
    взятыеШаблоны.add(item.template);
    комплект.push({ ch, item });
  }
  await c.end();

  const готово = [];
  const занятыеНазвания = [];
  for (let i = 0; i < комплект.length; i++) {
    const x = комплект[i];
    if (x.ошибка) { готово[i] = x; continue; }
    const { ch, item } = x;
    const неповтор = занятыеНазвания.length
      ? '\n\nСЕГОДНЯ НА СОСЕДНИХ КАНАЛАХ УЖЕ ВЫХОДЯТ ЭТИ НАЗВАНИЯ, ПОВТОРЯТЬ И ПЕРЕСКАЗЫВАТЬ ИХ НЕЛЬЗЯ:\n'
        + занятыеНазвания.map((t) => '  ' + t).join('\n') : '';
    const title = await gen(ch.title_prompt + hookBlock(item.template) + неповтор,
      'Вертикальный ролик: нейросеть по одному селфи делает результат по теме «' + item.template + '».').catch((e) => 'ОШИБКА ' + e.message);
    занятыеНазвания.push(title);
    const thumb = makeThumb(item.file_path, title, OUT, { slug: ch.slug });
    let dst = null;
    if (thumb) { dst = path.join(OUT, ch.slug + '.jpg'); fs.renameSync(thumb, dst); }
    готово[i] = { канал: ch.title, slug: ch.slug, шаблон: item.template, id: item.id,
      файл: item.file_path, название: title, регистр: РЕГИСТР(title), обложка: dst };
  }

  fs.writeFileSync(path.join(OUT, 'комплект.json'), JSON.stringify(готово, null, 1));
  console.table(готово.map((x) => x.ошибка ? { канал: x.канал, название: x.ошибка }
    : { канал: x.канал, шаблон: x.шаблон, название: x.название, знаков: x.название.length, регистр: x.регистр, обложка: x.обложка ? 'да' : 'НЕТ' }));
  console.log('\nпапка:', OUT);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
