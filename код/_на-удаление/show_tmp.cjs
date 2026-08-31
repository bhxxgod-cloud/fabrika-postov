'use strict';
// Показать начальнику склад глазами: забракованные и без вердикта, сеткой.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const FF = require('/Users/qq/Desktop/neironka-poster/node_modules/ffmpeg-static');

const БАЗА = '/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad';
const DBURL = fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();

function сетка(файлы, out, кол = 4) {
  const мелкие = файлы.map((f, i) => {
    const s = `${f}.small.jpg`;
    execFileSync(FF, ['-y', '-loglevel', 'error', '-i', f, '-vf', 'scale=300:-2', s]);
    return s;
  });
  const рядов = Math.ceil(мелкие.length / кол);
  const args = [];
  мелкие.forEach((s) => args.push('-i', s));
  let фильтр = '';
  for (let r = 0; r < рядов; r++) {
    const часть = мелкие.slice(r * кол, (r + 1) * кол);
    if (!часть.length) continue;
    фильтр += часть.map((_, k) => `[${r * кол + k}]`).join('') + `hstack=${часть.length}[r${r}]${часть.length === кол ? '' : ''};`;
  }
  const строки = [...Array(рядов).keys()].filter((r) => мелкие.slice(r * кол, (r + 1) * кол).length === кол);
  фильтр += строки.map((r) => `[r${r}]`).join('') + `vstack=${строки.length}`;
  execFileSync(FF, ['-y', '-loglevel', 'error', ...args, '-filter_complex', фильтр, out]);
  мелкие.forEach((s) => { try { fs.unlinkSync(s); } catch {} });
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const наборы = [
    ['брак', "(meta->'qa'->>'clean') = 'false'"],
    ['без-вердикта', "meta->'qa'->>'clean' IS NULL"],
  ];
  for (const [имя, где] of наборы) {
    const r = await c.query(
      `SELECT meta->>'persona' p, left(coalesce(meta->'qa'->>'reasons','нет'),40) r, meta->'image_urls'->>0 u
         FROM posts WHERE status IN ('backlog','approved') AND published_at IS NULL
           AND meta->'image_urls'->>0 IS NOT NULL AND ${где}
         ORDER BY created_at DESC LIMIT 16`);
    const файлы = [];
    r.rows.forEach((x, i) => {
      const f = `${БАЗА}/show_${имя}_${i}.jpg`;
      try {
        execFileSync('curl', ['-s', '-m', '30', '-o', f, x.u]);
        if (fs.statSync(f).size > 15000) файлы.push(f);
      } catch {}
    });
    if (файлы.length >= 4) {
      const out = `${БАЗА}/склад_${имя}.jpg`;
      сетка(файлы.slice(0, 16), out);
      console.log(`${имя}: кадров ${файлы.length}, файл ${out}`);
    }
    console.log(`${имя} причины: ` + r.rows.map((x) => x.r).slice(0, 6).join(' | '));
    файлы.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  }
  await c.end();
})().catch((e) => { console.error('ОШИБКА', e.message); process.exit(1); });
