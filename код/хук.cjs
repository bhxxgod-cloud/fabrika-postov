'use strict';
// ЕДИНАЯ ВЫДАЧА ХУКОВ ДЛЯ ВСЕХ ПЛОЩАДОК (25.08.2026).
//
// ЗАЧЕМ. Один пост уходит в тикток, инстаграм, ютуб и ВК, и хуки к нему берут РАЗНЫЕ ветки чата.
// Владелец спросил прямо: «на 1 фото те же самые хуки берутся, как ты узнаешь, какой он взял?».
// Без общего места каждая ветка выбирала бы вслепую, и на превью легко попадала бы ровно та
// строка, что уже стоит подписью в тиктоке, либо строка из чужого регистра речи.
//
// РЕШЕНИЕ. У каждого хука постоянный id («face-report-h01»), а факт использования пишется в
// таблицу hook_usage: пост, роль (подпись/кадр/превью/заголовок), площадка, ветка.
//
// ДВА КОНФЛИКТА, КОТОРЫЕ ЭТО ЗАКРЫВАЕТ:
//   дословный дубль: одна строка на картинке и в подписи, вторая точка контакта сгорает впустую;
//   разнобой регистров: картинка обвиняет («Выкинь это из косметички!»), подпись жалеет («пов
//   лучше бы ты не делала этот тренд...»), и зритель не понимает, о чём ролик.
//
// КОМАНДЫ:
//   node хук.cjs список <шаблон>                        показать хуки шаблона с номерами
//   node хук.cjs взять <шаблон> <пост> <площадка> [роль]   выдать и записать
//   node хук.cjs пара  <пост> [площадка] [роль]         подобрать совместимый к уже взятому
//   node хук.cjs что   <пост>                           что уже взято по этому посту
//   node хук.cjs отчёт [дней]                           какие хуки как часто уходили
//   node хук.cjs текст <id>                             текст хука по номеру
//
// «пост» это общий ключ поста на всех площадках: имя файла без расширения, например
// «мила-p05-makeup-colortype-p11». По нему ветки и находят друг друга.
//
// Логика подбора живёт в хуки-ядро.cjs: одна копия правил на консоль и на панель.
const fs = require('fs');
const { Client } = require('pg');
const DBURL = require('./dburl.cjs')();
const { ПУЛ, ШАБЛОНЫ, ВСЕ, ПО_ID, РЕГИСТР, шаблонИзКлюча, выбрать } = require('./хуки-ядро.cjs');

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }
async function взятоПоПосту(c, ключ) {
  const { rows } = await c.query('SELECT hook_id, role, platform, taken_by, created_at FROM hook_usage WHERE post_key=$1 ORDER BY created_at', [ключ]);
  return rows;
}

async function main() {
  const [cmd, ...arg] = process.argv.slice(2);
  if (!cmd || cmd === 'помощь') {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 26).map((l) => l.slice(3)).join('\n'));
    console.log('\nшаблоны: ' + ШАБЛОНЫ.join(', '));
    return;
  }
  if (cmd === 'текст') { const h = ПО_ID.get(arg[0]); console.log(h ? h.т : 'нет хука с номером ' + arg[0]); return; }
  if (cmd === 'список') {
    const t = arg[0];
    if (!ПУЛ[t]) { console.log('нет шаблона. есть: ' + ШАБЛОНЫ.join(', ')); return; }
    console.table(ВСЕ.filter((h) => h.шаблон === t).map((h) => ({ номер: h.id, регистр: РЕГИСТР(h.т), хук: h.т })));
    return;
  }
  const c = await db();
  try {
    if (cmd === 'что') {
      const строки = await взятоПоПосту(c, arg[0]);
      if (!строки.length) { console.log('по посту «' + arg[0] + '» ещё ничего не бралось'); return; }
      console.table(строки.map((r) => ({ роль: r.role, площадка: r.platform, номер: r.hook_id, хук: (ПО_ID.get(r.hook_id) || {}).т || '(нет в пуле)', ветка: r.taken_by })));
      return;
    }
    if (cmd === 'отчёт') {
      const дней = Number(arg[0] || 30);
      const { rows } = await c.query(`SELECT hook_id, count(*) n, count(DISTINCT post_key) posts, max(created_at) last
        FROM hook_usage WHERE created_at > now() - ($1 || ' days')::interval GROUP BY hook_id ORDER BY n DESC LIMIT 40`, [String(дней)]);
      if (!rows.length) { console.log('за ' + дней + ' дней хуки не брались'); return; }
      console.table(rows.map((r) => ({ номер: r.hook_id, раз: Number(r.n), постов: Number(r.posts), хук: ((ПО_ID.get(r.hook_id) || {}).т || '').slice(0, 44) })));
      return;
    }
    if (cmd === 'взять' || cmd === 'пара') {
      let шаблон, ключ, площадка, роль;
      if (cmd === 'взять') { [шаблон, ключ, площадка, роль] = arg; }
      else { [ключ, площадка, роль] = arg; шаблон = шаблонИзКлюча(ключ); роль = роль || 'превью'; }
      площадка = площадка || 'tiktok'; роль = роль || 'подпись';
      if (!ключ) { console.log('нужен ключ поста (имя файла без расширения)'); process.exitCode = 1; return; }

      const уже = await взятоПоПосту(c, ключ);
      // Если по ключу шаблон не читается (имя файла без него), берём его из уже взятого хука:
      // в номере «face-report-h07» шаблон записан явно.
      if (!шаблон && уже.length) { const h = ПО_ID.get(уже[0].hook_id); if (h) шаблон = h.шаблон; }
      if (!шаблон || !ПУЛ[шаблон]) { console.log('шаблон не определился по ключу «' + ключ + '» и по реестру. Укажи явно: node хук.cjs взять <шаблон> <пост> <площадка>'); process.exitCode = 1; return; }
      const свой = уже.find((r) => r.role === роль && r.platform === площадка);
      if (свой) { const h = ПО_ID.get(свой.hook_id); console.log('УЖЕ БРАЛИ (' + роль + ', ' + площадка + '): ' + свой.hook_id + '  ' + (h ? h.т : '')); return; }

      const занятые = уже.map((r) => (ПО_ID.get(r.hook_id) || {}).т).filter(Boolean);
      const этойПлощадки = уже.filter((r) => r.platform === площадка).map((r) => (ПО_ID.get(r.hook_id) || {}).т).filter(Boolean);
      const { rows: часто } = await c.query("SELECT hook_id, count(*) n FROM hook_usage WHERE created_at > now() - interval '14 days' GROUP BY hook_id");
      const частота = new Map(часто.map((r) => [r.hook_id, Number(r.n)]));

      const res = выбрать({ шаблон, занятыеВсюду: занятые, занятыеПлощадки: этойПлощадки, роль, площадка, частота });
      if (!res) {
        console.log('совместимого хука нет: в этом регистре у шаблона «' + шаблон + '» строки кончились или все про одно и то же.');
        if (занятые.length) console.log('уже занято по посту: ' + занятые.map((t) => '«' + t + '»').join(', '));
        console.log('добавь строк в хуки-пул.json для шаблона ' + шаблон);
        process.exitCode = 2; return;
      }
      await c.query('INSERT INTO hook_usage(post_key,hook_id,role,platform,taken_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT (post_key,role,platform) DO NOTHING',
        [ключ, res.выбран.id, роль, площадка, process.env.ВЕТКА || 'ютуб-чат']);
      console.log('номер:    ' + res.выбран.id);
      console.log('хук:      ' + res.выбран.т);
      console.log('регистр:  ' + РЕГИСТР(res.выбран.т));
      console.log('роль:     ' + роль + ' / ' + площадка);
      if (занятые.length) console.log('не конфликтует с: ' + занятые.map((t) => '«' + t + '»').join(', '));
      if (res.запас.length) console.log('запасные: ' + res.запас.map((h) => h.id + ' «' + h.т + '»').join('  |  '));
      return;
    }
    console.log('не знаю команду «' + cmd + '». Запусти без аргументов, покажу список.');
  } finally { await c.end(); }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
