// ПРАВИЛА (RULES-gologin.md): 1) НИКОГДА не убивать профиль через pkill/kill -9. 2) Один профиль — одна сессия.
// 3) Профиль залогиненного вручную акка не трогать. 4) Не висим >60с. 5) Успех = композер очистился.
//
// GUN — «пулемёт» дежурства (ЧП-режим, локальный Orbita). Непрерывно берём СВЕЖИЙ акк из общего пула,
// работаем пост локально, деградировал (блок Алины / тайм-лимит / разлогин / suspend) → в skip, добираем
// следующий, стреляем дальше. Владелец: «жечь свежие ради лидов, не жалеть». 2 воркера = 2 окна (дежурство+бэклог).
//
// ЗАЩИТА ОТ КОЛЛИЗИЙ (правило №1): пул-пик исключает (а) watchdog/backlog-группы — территория Railway-дежурства,
// (б) акки с commenting_at за 15мин — их держит другая сессия (Комментинг), (в) skip/inFlight. Резерв слага —
// под общим мьютексом (pick+add атомарно между воркерами), иначе два воркера возьмут один акк.
//
// Запуск: GL подразумевается локальный. DB_PUBLIC_URL=… OPENROUTER_API_KEY=… SKIP=hugh98225,parker80937 node gun.cjs
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawn } = require('child_process');

const DIR = __dirname;
const DBURL = process.env.DB_PUBLIC_URL || process.env.DATABASE_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const ORKEY = process.env.OPENROUTER_API_KEY || fs.readFileSync('/tmp/orkey.txt', 'utf8').trim();
const URL = process.env.TARGET_URL || 'https://www.instagram.com/reel/DZQe5pIIP-C/';
const CODE = (URL.match(/\/(?:p|reel)\/([^/?]+)/) || [])[1];
const PER = Number(process.env.PER || 3);
const MAX = Number(process.env.MAX_ACCOUNTS || 30); // предохранитель от рануэя (в шторм часть упадёт на 500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db() { const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }

const skip = new Set((process.env.SKIP || '').split(',').map((s) => s.trim()).filter(Boolean)); // тайм-лимитнутые на старте
const inFlight = new Set();
let used = 0, done = 0, degraded = 0, fails500 = 0;

// Атомарный резерв слага между воркерами (единый мьютекс на pick+add).
let pickLock = Promise.resolve();
async function reservedPick() {
  let release; const prev = pickLock; pickLock = new Promise((r) => (release = r));
  await prev;
  try {
    const c = await db();
    try {
      const ex = [...skip, ...inFlight]; const exArr = ex.length ? ex : ['__none__'];
      const r = await c.query(
        `SELECT a.slug FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id
         WHERE a.platform='comments' AND a.deleted_at IS NULL AND coalesce(a.session_status,'')='live'
           AND a.status NOT IN ('paused','trash','suspended')
           AND coalesce(a.ig_status,'') NOT IN ('challenge','bad_login','captcha','suspended')
           AND a.gologin_profile_id IS NOT NULL
           AND coalesce(g.watchdog,false)=false AND coalesce(g.backlog,false)=false
           AND (a.commenting_at IS NULL OR a.commenting_at < now() - interval '15 minutes')
           AND NOT EXISTS (SELECT 1 FROM post_account_blocks b WHERE b.account_id=a.id AND b.code=$1 AND b.blocked)
           AND a.slug <> ALL($2)
         ORDER BY coalesce(a.comments_today,0) ASC, a.last_commented_at ASC NULLS FIRST LIMIT 1`, [CODE, exArr]);
      const slug = r.rows[0] ? r.rows[0].slug : null;
      if (slug) inFlight.add(slug);
      return slug;
    } finally { await c.end(); }
  } finally { release(); }
}

// Гасим возможную облачную сессию профиля перед локальным стартом (штатно, DELETE /web — не pkill).
async function stopSession(slug) {
  let c;
  try {
    c = await db();
    const r = (await c.query(`SELECT a.gologin_profile_id AS pid, coalesce(g.gologin_token, (SELECT gologin_token FROM account_groups WHERE name='РАБОЧИЕ АККИ' LIMIT 1)) AS tok
      FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE a.slug=$1`, [slug])).rows[0];
    await c.end(); c = null;
    if (r && r.pid && r.tok) { await fetch('https://api.gologin.com/browser/' + r.pid + '/web', { method: 'DELETE', headers: { Authorization: 'Bearer ' + r.tok } }).catch(() => {}); await sleep(8000); }
  } catch { /* noop */ } finally { try { if (c) await c.end(); } catch { /* noop */ } }
}

function runOne(slug, flavor) {
  return new Promise((res) => {
    let out = '';
    const env = { ...process.env, DB_PUBLIC_URL: DBURL, OPENROUTER_API_KEY: ORKEY, SHOT_DIR: process.env.SHOT_DIR || '/tmp',
      GL_LOCAL: '1', MAXPASS: flavor === 'backlog' ? '70' : '45' };
    if (flavor === 'duty') { env.FRESH_H = '96'; env.FRESH_RELAX_PASS = '18'; } // дежурство — свежие первыми
    const p = spawn('node', [path.join(DIR, 'vcomment.cjs'), slug, URL, String(PER)], { cwd: DIR, env });
    p.stdout.on('data', (d) => { out += d; process.stdout.write(`[${flavor}:${slug}] ` + String(d).replace(/\n$/, '').split('\n').join(`\n[${flavor}:${slug}] `) + '\n'); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    const killer = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* noop */ } }, 13 * 60000);
    p.on('exit', () => {
      clearTimeout(killer);
      const m = out.match(/RESULT done=(\d+)/); const d = m ? +m[1] : 0;
      const is500 = /startLocal|локальный старт err|500|ECONNREF|не поднял/i.test(out) && d === 0;
      // Деградация: 0 ответов + маркер блока/тайм-лимита/разлогина/action-block/недоступности (в skip, больше не берём).
      // ACTION_BLOCK/«Couldn't post» = свежий акк перекомментил → IG отбил (vcomment уже помечает action_block+paused).
      const degr = d === 0 && /недоступн|панель не открылась|РАЗЛОГИН|logged_out|ограничение времени|блок автора|suspended|заблокирован|ACTION_BLOCK|action.?block|Couldn.?t post|коммент НЕ сел|We restrict|ограничили.{0,15}действия/i.test(out);
      res({ done: d, degraded: degr, is500 });
    });
    p.on('error', () => { clearTimeout(killer); res({ done: 0, degraded: false, is500: true }); });
  });
}

async function worker(flavor) {
  for (;;) {
    if (used >= MAX) { console.log(`[gun:${flavor}] предохранитель MAX=${MAX} — воркер встаёт`); return; }
    const slug = await reservedPick();
    if (!slug) { console.log(`[gun:${flavor}] 🔴 пул свежих ПУСТ — воркер встаёт (нужны патроны)`); return; }
    used++;
    console.log(`[gun:${flavor}] 🔫 беру ${slug} (использовано ${used}/${MAX}, done ${done}, деград ${degraded}, 500-фейлов ${fails500})`);
    let r;
    try { await stopSession(slug); r = await runOne(slug, flavor); }
    catch { r = { done: 0, degraded: false, is500: true }; }
    finally { inFlight.delete(slug); }
    done += r.done;
    if (r.is500) { fails500++; console.log(`[gun:${flavor}] ⏳ ${slug}: GoLogin 500 (лаг) — НЕ деград, вернётся в пул позже`); }
    else if (r.degraded) { degraded++; skip.add(slug); console.log(`[gun:${flavor}] ⚠ ${slug} деградировал (0, блок/тайм-лимит) → skip, добираю свежий`); }
    else console.log(`[gun:${flavor}] ✓ ${slug}: ответов ${r.done} | ИТОГО done ${done}`);
    await sleep(4000);
  }
}

(async () => {
  console.log(`[gun] 🔫 ПУЛЕМЁТ старт | пост ${CODE} | 2 воркера (дежурство+бэклог) локально Orbita | PER ${PER} | MAX ${MAX} | skip старт: ${[...skip].join(',') || '—'}`);
  const c0 = await db(); const before = (await c0.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [CODE])).rows[0].n; await c0.end();
  console.log(`[gun] post_answered старт: ${before}`);
  await Promise.all([worker('duty'), worker('backlog')]);
  const c1 = await db(); const after = (await c1.query('SELECT count(*)::int n FROM post_answered WHERE code=$1', [CODE])).rows[0].n; await c1.end();
  console.log(`\n[gun] СТОП. акков ${used}, деградировало ${degraded}, GoLogin-500 ${fails500}, ответов done ${done}. post_answered ${before}→${after} (+${after - before})`);
})().catch((e) => console.error('FATAL', String(e.message).slice(0, 160)));
