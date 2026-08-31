// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9 — GoLogin не синхронизирует
// профиль и акк ВЫЛОГИНИВАЕТСЯ; закрывать только через gl.stopLocal()/DELETE /web. 2) Один профиль — одна
// сессия. 3) Профиль залогиненного вручную акка не трогать. 4) Любая браузерная операция не висит >60с:
// таймаут → релоад и повтор (макс 2), затем следующая цель. 5) Успех публикации = композер очистился.
//
// MASTER — большая параллельная комментинг-сессия. Цель: с ~20 акков оставить 100 ответов РАЗНЫМ людям.
// Пул воркеров CONC (по умолч. 3 — тариф GoLogin 5, берём 3 с запасом). Каждый воркер по очереди берёт
// следующий акк из списка, гонит vcomment (N ответов), результат копим. Останов — GOAL достигнут ИЛИ акки кончились.
//
// ГАРАНТИИ (по ТЗ владельца 22.07.2026):
//  • Строго ответ В ВЕТКУ под коммент-просьбу промпта — vcomment гейтит REPLYBAR (@-плашка), топ-левел не считается.
//  • Уникальный человек, 1 коммент, 1 акк — дедуп post_answered: мгновенная запись + финальный SELECT перед постом.
//    При параллели 3 акка не отвечают одному (окно гонки — доли секунды, PRIMARY KEY(code,username)).
//  • Свежие первыми, добор старыми до 100 — FRESH_H=96ч, релакс после FRESH_RELAX_PASS проходов (в vcomment).
//
// Запуск: DB_PUBLIC_URL=… OPENROUTER_API_KEY=… SLUGS=a,b,c node master.cjs
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawn } = require('child_process');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/orkey.txt', 'utf8').trim();
const CONC = Number(process.env.CONC || 3);
const PER = Number(process.env.PER || 5);          // ответов на акк за сессию (дневной кап 7 — держим ниже)
const GOAL = Number(process.env.GOAL || 100);      // всего уникальных ответов — цель
const URL = process.env.TARGET_URL || 'https://www.instagram.com/reel/DZQe5pIIP-C/';
const CODE = (URL.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
const FRESH_H = process.env.FRESH_H || '96';
const FRESH_RELAX_PASS = process.env.FRESH_RELAX_PASS || '18';
const MAXPASS = process.env.MAXPASS || '70';
const SLUGS = (process.env.SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }
async function answeredCount() { const c = await db(); const n = (await c.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [CODE])).rows[0].n; await c.end(); return n; }

// Гасим облачную сессию профиля перед заходом (иначе «профиль занят»). Штатно, DELETE /web — не pkill.
async function stopSession(slug) {
  let c;
  try {
    c = await db();
    const r = (await c.query(`SELECT a.gologin_profile_id AS pid, coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
      FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [slug])).rows[0];
    await c.end(); c = null;
    if (r && r.pid && r.tok) { await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {}); await sleep(10000); }
  } catch { /* noop */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

function runOne(slug) {
  return new Promise((res) => {
    let out = '';
    const p = spawn('node', [path.join(DIR, 'vcomment.cjs'), slug, URL, String(PER)], {
      cwd: DIR,
      env: { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: process.env.SHOT_DIR || '/tmp',
        MAXPASS, FRESH_H, FRESH_RELAX_PASS },
    });
    p.stdout.on('data', (d) => { out += d; process.stdout.write(`[${slug}] `.padEnd(18) + String(d).replace(/\n$/, '').split('\n').join('\n' + `[${slug}] `.padEnd(18)) + '\n'); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    const killer = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* noop */ } }, 13 * 60000);
    p.on('exit', () => {
      clearTimeout(killer);
      const m = out.match(/RESULT done=(\d+) brand=(\d+) blocked=(\d+)(?:.*logged_out=(\d+))?/);
      res(m ? { done: +m[1], brand: +m[2], blocked: +m[3], logout: +(m[4] || 0) } : { done: 0, brand: 0, blocked: 0, logout: /logged_out=1/.test(out) ? 1 : 0 });
    });
    p.on('error', () => { clearTimeout(killer); res({ done: 0, brand: 0, blocked: 0, logout: 0 }); });
  });
}

(async () => {
  if (!SLUGS.length) { console.log('нужен SLUGS=a,b,c'); process.exit(1); }
  const before = await answeredCount();
  console.log(`[master] акков: ${SLUGS.length} | параллель: ${CONC} | по ${PER}/акк | цель: ${GOAL} уникальных | свежесть ≤${FRESH_H}ч (добор старыми)`);
  console.log(`[master] post_answered старт: ${before}\n[master] очередь: ${SLUGS.join(', ')}\n`);

  let idx = 0, totalDone = 0, totalBrand = 0, blocked = 0, logout = 0, finished = 0;
  const perAcc = [];

  async function worker(wid) {
    for (;;) {
      // Останов по цели: считаем РЕАЛЬНЫЙ прирост в БД (учитывает и параллельные акки, и дедуп).
      const grew = (await answeredCount()) - before;
      if (grew >= GOAL) { console.log(`[master] цель ${GOAL} достигнута (в БД +${grew}) — воркер ${wid} останавливается`); return; }
      const my = idx++;
      if (my >= SLUGS.length) return;
      const slug = SLUGS[my];
      console.log(`[master:w${wid}] [${my + 1}/${SLUGS.length}] ${slug} → старт (в БД сейчас +${grew}/${GOAL})`);
      await stopSession(slug);
      const r = await runOne(slug);
      totalDone += r.done; totalBrand += r.brand; blocked += r.blocked; logout += r.logout; finished++;
      perAcc.push({ slug, ...r });
      console.log(`[master:w${wid}] ✓ ${slug}: ответов ${r.done}${r.logout ? ' ☠РАЗЛОГИН' : ''}${r.blocked ? ' ⛔БЛОК' : ''} | сумма ответов движков ${totalDone}`);
      await sleep(4000);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, SLUGS.length) }, (_, i) => worker(i + 1)));

  const after = await answeredCount();
  console.log(`\n[master] ГОТОВО. отработало акков: ${finished} | ответов (сумма движков): ${totalDone} | разлогинено: ${logout} | заблокировано: ${blocked}`);
  console.log(`[master] post_answered: ${before} → ${after} (+${after - before} УНИКАЛЬНЫХ людей)`);
  console.log('[master] по аккам:');
  perAcc.sort((a, b) => b.done - a.done).forEach((x) => console.log(`   ${x.slug.padEnd(14)} ${x.done}${x.logout ? ' (разлогин)' : ''}${x.blocked ? ' (блок)' : ''}`));
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 160)));
