// АУДИТ АККАУНТОВ СНАРУЖИ (05.08, начальник: «какая логика проверки акков, постоянно
// проебываемся — то аниме авы, то какая-то уйня»).
//
// ПРИНЦИП, которого не хватало: НЕ ВЕРИМ САМООТЧЁТАМ СКРИПТОВ. dressup/followbeauty писали
// «✓ био вписано», а по факту био пустое у всех пяти живых — IG отвечал 400 и скрипт этого не
// замечал. Поэтому состояние профиля читаем ИЗВНЕ анонимным запросом (web_profile_info):
//   • это ноль риска — нет входа в акк, нет сессии, нет действий (в отличие от захода браузером);
//   • это правда с точки зрения зрителя — ровно то, что видит человек, открывший профиль;
//   • аву скачиваем в /tmp/accavatars/, чтобы посмотреть ГЛАЗАМИ (аниме-картинку никакой
//     флаг в базе не отловит, только просмотр).
//
// Пишем в accounts: avatar_set, bio_set, avatar_thumb, health_checked_at, health_note.
// Запуск: node accaudit.cjs [--all]   (по умолчанию только живые; --all — вообще все)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const AVA_DIR = '/tmp/accavatars';
const ALL = process.argv.includes('--all');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Анонимно, мобильным UA: тот же путь, которым проверяли ложный успех публикации.
// ТРИ РАЗНЫХ ИСХОДА, и путать их нельзя (05.08): IG умеет отдавать ошибку про удалённый asset
// на ЖИВОЙ аккаунт (воспроизводится даже на natgeo). Если считать это «профиль не читается»,
// рабочий акк получит клеймо мёртвого. Поэтому:
//   {glitch:true} — ответ есть, но это сбой IG → в базу НИЧЕГО не пишем;
//   {gone:true}   — HTML «Page Not Found» → аккаунта нет;
//   профиль       — нормальные данные.
function fetchProfile(handle) {
  let out = '';
  try {
    out = execFileSync('curl', ['-s', '--max-time', '25',
      '-H', 'x-ig-app-id: 936619743392459',
      '-A', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch { return { glitch: true, why: 'сеть/таймаут' }; }
  // HTML ВМЕСТО JSON ЭТО СБОЙ, А НЕ «ПРОФИЛЯ НЕТ» (07.08). В условии стояло `<!DOCTYPE`, и любая
  // HTML-страница читалась как «акк снесён»: логин-стена, интерстишл, страница лимита 429, страница
  // бизнес-профиля с «Asset has been deleted». Это условие срабатывало РАНЬШЕ глитч-охраны ниже и
  // обходило её. «Профиля нет» подтверждает только настоящая страница 404 от Instagram.
  if (/Page Not Found/i.test(out) && !/"user"/.test(out)) return { gone: true };
  if (/<!DOCTYPE/i.test(out)) return { glitch: true, why: 'вместо JSON пришла HTML-страница (стена/лимит)' };
  let j;
  try { j = JSON.parse(out); } catch { return { glitch: true, why: 'не JSON' }; }
  const u = (j.data || {}).user;
  if (!u) {
    const msg = String(j.message || j.error || '').slice(0, 60);
    // «has been deleted», «Please wait a few minutes» и т.п. — это про сервис, а не про акк.
    if (/asset|deleted|wait a few|rate|try again/i.test(out)) return { glitch: true, why: msg || 'сбой IG' };
    // Приговор только по положительному доказательству: явный data.user = null. Ответы про НАШ
    // доступ (checkpoint_required, login_required, feedback_required, {"status":"fail"}, пустой {})
    // раньше проваливались сюда и печатались как «профиля нет снаружи».
    const explicitNull = j && j.data && Object.prototype.hasOwnProperty.call(j.data, 'user') && j.data.user === null;
    if (!explicitNull) return { glitch: true, why: msg || String(j.status || 'ответ без user').slice(0, 60) };
    return { gone: true };
  }
  return {
    name: u.full_name || '',
    bio: (u.biography || '').trim(),
    pic: u.profile_pic_url_hd || u.profile_pic_url || '',
    posts: (u.edge_owner_to_timeline_media || {}).count ?? null,
    followers: (u.edge_followed_by || {}).count ?? null,
    following: (u.edge_follow || {}).count ?? null,
    private: !!u.is_private,
  };
}

(async () => {
  fs.mkdirSync(AVA_DIR, { recursive: true });
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`SELECT id, slug, coalesce(ig_login, slug) h, persona, session_status, ig_status
    FROM accounts WHERE deleted_at IS NULL AND platform IN ('promo','comments') AND slug NOT LIKE 'FOL%'
      AND slug NOT IN ('TT2 KZ','TT KZ SELF 1','акк 2','поисковик')
      ${ALL ? '' : "AND session_status='live'"}
    ORDER BY session_status, slug`)).rows;

  console.log(`Проверяю ${rows.length} акк(ов) снаружи, без входа\n`);
  const report = [];
  for (const r of rows) {
    let p = null, err = '';
    try { p = fetchProfile(r.h); } catch (e) { err = String(e.message).slice(0, 40); }
    if (!p || p.glitch) {
      // Сбой на стороне IG — вердикта по акку НЕТ, базу не трогаем, иначе живой акк
      // получит клеймо мёртвого из-за чужой ошибки.
      report.push({ h: r.h, состояние: `СБОЙ IG (${(p && p.why) || err || '?'}) — вердикта нет`, ава: '?', био: '?', имя: '?', посты: '?', подписки: '?' });
      await sleep(3000);
      continue;
    }
    if (p.gone) {
      report.push({ h: r.h, состояние: 'НЕТ ПРОФИЛЯ (снесён/забанен)', ава: '-', био: '-', имя: '-', посты: '-', подписки: '-' });
      await c.query(`UPDATE accounts SET health_checked_at=now(), health_note=$2 WHERE id=$1`,
        [r.id, 'аудит: профиля нет снаружи (снесён или забанен)']).catch(() => {});
      await sleep(2500);
      continue;
    }
    const noAva = !p.pic || /anonymousUser|profilePicDefault/i.test(p.pic);
    // Аву тянем на диск: аниме/мусор ловится только глазами, флагом это не поймать.
    let avaFile = '';
    if (!noAva) {
      try {
        avaFile = path.join(AVA_DIR, `${r.slug}.jpg`);
        execFileSync('curl', ['-s', '--max-time', '20', '-o', avaFile, p.pic], { stdio: 'ignore' });
        if (!fs.existsSync(avaFile) || fs.statSync(avaFile).size < 1000) avaFile = '';
      } catch { avaFile = ''; }
    }
    const problems = [];
    if (noAva) problems.push('нет авы');
    if (!p.bio) problems.push('пустое био');
    if (!p.name) problems.push('нет имени');
    if ((p.following ?? 0) === 0) problems.push('ноль подписок');

    await c.query(`UPDATE accounts SET avatar_set=$2, bio_set=$3, avatar_thumb=$4,
        health_checked_at=now(), health_note=$5 WHERE id=$1`,
      [r.id, !noAva, !!p.bio, p.pic || null,
       problems.length ? 'аудит: ' + problems.join(', ') : 'аудит: профиль оформлен']).catch((e) =>
       console.log(`  ⚠ запись в базу не прошла (${r.h}): ${String(e.message).slice(0, 60)}`));

    report.push({
      h: r.h,
      состояние: problems.length ? problems.join(', ') : 'ОК',
      ава: noAva ? 'НЕТ' : (avaFile ? 'есть→' + path.basename(avaFile) : 'есть'),
      био: p.bio ? JSON.stringify(p.bio.slice(0, 30)) : 'ПУСТО',
      имя: p.name || 'ПУСТО',
      посты: p.posts, подписки: p.following,
    });
    await sleep(2500);
  }
  await c.end();

  console.log('РЕЗУЛЬТАТ АУДИТА:');
  for (const x of report) {
    console.log(`  ${String(x.h).padEnd(20)} | ${String(x.состояние).padEnd(34)} | ава: ${String(x.ава).padEnd(22)} | имя: ${String(x.имя).padEnd(18)} | био: ${x.био} | постов ${x.посты}, подписок ${x.подписки}`);
  }
  console.log(`\nАвы скачаны в ${AVA_DIR} — смотреть глазами (аниме/мусор флагом не ловится).`);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
