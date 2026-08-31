'use strict';
// ЗАКРЕПЛЁННЫЙ КОММЕНТАРИЙ ПОД РОЛИК. Пишем от лица канала, в тему ролика, с указанием, где
// сделать себе такое же. Прямую ссылку в комментарий НЕ кладём: ютуб режет ссылки в комментариях
// как спам, а в описании она уже есть. Комментарий должен звать в описание.
const fs = require('fs'), os = require('os');
const KEY = fs.readFileSync(os.homedir() + '/.neironka/secrets/orkey.txt', 'utf8').trim();
const OUT = os.homedir() + '/Desktop/ЮТУБ/ручной-залив-25-08';
const к = JSON.parse(fs.readFileSync(OUT + '/комплект.json', 'utf8'));
const видео = { pokazhu:'uj-AcEw5WY8', prigovor:'J_WTIL3MDYg', iishnaya:'dY3XxA1BCJc', katya:'VWLxr7Ojhwc',
  verdict:'KjjcgXanupM', podruga:'zS8cuQ-aZgc', kris:'DzYNwp2_lcA', brand:'0o-9ylH1iEU', stylist:'ajPcQcbbArI', drugaya:'JlRuS8Ullsk' };

const ПРОМПТ = `Ты пишешь ЗАКРЕПЛЁННЫЙ комментарий от лица автора под своим же коротким видео.
Канал про нейросеть, которая по одному селфи делает разбор внешности и модные тренды.
Задача комментария: ответить на главный вопрос зрительницы «где это сделать» и позвать в описание.

ЖЁСТКИЕ ПРАВИЛА:
1) 60-140 знаков, одно-два предложения.
2) Тон живой, женский, как ответ подруге. Разрешены скобки как интонация и одно эмодзи.
3) ССЫЛКУ НЕ ПИСАТЬ: ютуб режет ссылки в комментариях. Звать словами «ссылка в описании».
4) Не повторять заголовок ролика дословно.
5) Обязательно упомянуть, что нужно только своё фото.
6) Без длинного тире, без кавычек, без хэштегов.
Верни ТОЛЬКО текст комментария одной строкой.`;

async function gen(ctx) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'X-Title': 'neironka-poster' },
    body: JSON.stringify({ model: 'anthropic/claude-opus-4.8', max_tokens: 300, messages: [{ role: 'system', content: ПРОМПТ }, { role: 'user', content: ctx }] }),
    signal: AbortSignal.timeout(60000) }).then((x) => x.json());
  return (r.choices?.[0]?.message?.content || '').trim().split('\n')[0].replace(/["«»]/g, '').replace(/—/g, ',').trim();
}
(async () => {
  const out = [];
  const было = [];
  for (const x of к) {
    if (!видео[x.slug]) continue;
    const неповтор = было.length ? '\n\nЭТИ КОММЕНТАРИИ УЖЕ НАПИСАНЫ НА СОСЕДНИХ КАНАЛАХ, НЕ ПОВТОРЯЙ ИХ:\n' + было.map((t) => '  ' + t).join('\n') : '';
    const t = await gen('Ролик на тему «' + x.шаблон + '». Заголовок ролика: «' + x.название + '».' + неповтор);
    было.push(t);
    out.push({ канал: x.канал, slug: x.slug, video_id: видео[x.slug], комментарий: t, знаков: t.length });
  }
  fs.writeFileSync(OUT + '/комментарии.json', JSON.stringify(out, null, 1));
  console.table(out.map((x) => ({ канал: x.канал, комментарий: x.комментарий, знаков: x.знаков })));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
