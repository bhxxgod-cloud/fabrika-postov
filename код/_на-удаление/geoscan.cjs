// geoscan.cjs — разовый анонимный срез: кто из промо-акков жив после заливов 10-11.08,
// и чем павшие отличаются от выживших. Ничего не пишет в базу, только читает.
// Вывод: /tmp/geoscan.tsv (по акку) + сводка в stdout.
'use strict';
const fs = require('node:fs');
const ig = require('./igprofile.cjs');
const { Client } = require('pg');

const DBURL = process.env.DB_PUBLIC_URL || fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
const OUT = process.env.OUT || '/tmp/geoscan.tsv';
const CONC = Number(process.env.CONC || 8);

function bind(raw) {
  // ig_cookies.raw — base64 от JSON связки магоса: session, device, app, ua_profile
  try {
    const j = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    const u = j.ua_profile || {};
    return {
      country: u.country || '',
      locale: u.locale || '',
      tz: u.tz_name || '',
      model: u.device_model || '',
      saved_at: j.saved_at ? new Date(j.saved_at * 1000).toISOString().slice(0, 10) : '',
      has_auth: !!(j.session && j.session.authorization),
      email: j.email || '',
    };
  } catch { return null; }
}

(async () => {
  const c = new Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(`
    select a.ig_login, a.acc_no, coalesce(g.name,'(нет группы)') grp, a.health_state, a.created_at,
           a.proxy_geo, a.warmup_at, a.warmup_started_at, a.ig_email, a.totp_secret is not null totp,
           a.ig_cookies, a.last_posted_at, a.posts_count, a.dressed_at, a.nick_changed_at
      from accounts a left join account_groups g on g.id=a.group_id
     where a.platform='promo' and a.deleted_at is null and a.ig_login is not null
     order by a.acc_no nulls last, a.ig_login`);
  await c.end();

  // ШАРДЫ. ig.ask работает через spawnSync, то есть блокирует поток: внутри одного процесса
  // «параллельные» воркеры выстраиваются в очередь. Поэтому параллелим ПРОЦЕССАМИ: SHARD/SHARDS.
  const SHARDS = Number(process.env.SHARDS || 1);
  const SHARD = Number(process.env.SHARD || 0);
  const list = rows.filter((_, k) => k % SHARDS === SHARD).map((r) => {
    const b = (r.ig_cookies && r.ig_cookies.raw) ? bind(r.ig_cookies.raw) : null;
    return { ...r, bind: b };
  });
  console.error(`акков к проверке: ${list.length}`);

  const px = ig.proxies();
  const res = [];
  let i = 0;
  async function worker(wid) {
    while (true) {
      const k = i++;
      if (k >= list.length) return;
      const a = list[k];
      // свой срез пула на каждого воркера, direct не используем вовсе
      const slice = [];
      for (let t = 0; t < 5; t++) slice.push(px[(k * 7 + wid * 211 + t * 37) % px.length]);
      const r = await ig.probe(a.ig_login, { proxies: slice, tries: 5, minConfirm: 2, pause: 400, allowDirect: false });
      const posts = r.user && r.user.edge_owner_to_timeline_media ? r.user.edge_owner_to_timeline_media.count : '';
      const followers = r.user && r.user.edge_followed_by ? r.user.edge_followed_by.count : '';
      res.push({ ...a, kind: r.kind, why: r.why, posts, followers });
      if (res.length % 20 === 0) console.error(`… ${res.length}/${list.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));

  const hdr = ['ig_login', 'acc_no', 'папка', 'вердикт', 'постов', 'подписчиков', 'health_state',
    'страна_связки', 'локаль', 'таймзона', 'связка_от', 'есть_токен', 'почта', 'totp',
    'прокси_гео', 'прогрет', 'создан', 'одет', 'ник_менян', 'почему'];
  const lines = [hdr.join('\t')];
  for (const r of res) {
    const b = r.bind || {};
    lines.push([r.ig_login, r.acc_no || '', r.grp, r.kind, r.posts, r.followers, r.health_state || '',
      b.country || '', b.locale || '', b.tz || '', b.saved_at || '', b.has_auth ? 'да' : (r.bind ? 'нет' : 'связки нет'),
      (r.ig_email || b.email || '') ? 'есть' : 'нет', r.totp ? 'да' : 'нет',
      r.proxy_geo || '', r.warmup_at ? 'да' : 'нет',
      r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
      r.dressed_at ? new Date(r.dressed_at).toISOString().slice(0, 10) : '',
      r.nick_changed_at ? new Date(r.nick_changed_at).toISOString().slice(0, 10) : '',
      String(r.why || '').replace(/\t/g, ' ')].join('\t'));
  }
  fs.writeFileSync(OUT, lines.join('\n') + '\n');

  const by = (f) => { const m = {}; for (const r of res) { const k = f(r) || '(нет)'; (m[k] = m[k] || {}).total = (m[k].total || 0) + 1; m[k][r.kind] = (m[k][r.kind] || 0) + 1; } return m; };
  const show = (name, f) => {
    console.log(`\n### ${name}`);
    const m = by(f);
    for (const k of Object.keys(m).sort()) {
      const v = m[k];
      const alive = v['виден'] || 0;
      console.log(`${k}\tвсего ${v.total}\tвиден ${alive} (${Math.round(alive / v.total * 100)}%)\tспрятан ${v['спрятан'] || 0}\tнет-профиля ${v['нет-профиля'] || 0}\tнет-ника ${v['нет-ника'] || 0}\tбез-вердикта ${v['без-вердикта'] || 0}`);
    }
  };
  show('ИТОГО', () => 'все');
  show('по папке', (r) => r.grp);
  show('по стране связки', (r) => (r.bind ? r.bind.country : 'связки нет'));
  show('по локали связки', (r) => (r.bind ? r.bind.locale : 'связки нет'));
  show('по прокси-гео в базе', (r) => r.proxy_geo);
  show('по наличию токена связки', (r) => (r.bind ? (r.bind.has_auth ? 'токен есть' : 'токена нет') : 'связки нет'));
  show('по почте', (r) => ((r.ig_email || (r.bind && r.bind.email)) ? 'почта есть' : 'почты нет'));
  show('по прогреву', (r) => (r.warmup_at ? 'прогрет' : 'без прогрева'));
  show('по дате создания у нас', (r) => (r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : ''));
  console.log(`\nфайл: ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
