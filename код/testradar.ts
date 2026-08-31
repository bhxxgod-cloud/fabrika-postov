// testradar.ts — прогнать боевой radar.passwordLogin на ОДНОМ акке (проверка порта 2FA перед деплоем).
// usage: DATABASE_URL=... npx tsx testradar.ts <slug>
import { readFileSync, appendFileSync } from 'node:fs';
import pg from 'pg';
import { connect, disconnect } from './src/gologin.js';
import { passwordLogin } from './src/radar.js';

const SLUG = process.argv[2];
const SHOT = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/shots';
const LOG = '/private/tmp/claude-501/-Users-qq-untitled-folder/be20c705-6e47-463d-b55a-611e44fbaefd/scratchpad/testradar.log';
const step = (m: string) => { try { appendFileSync(LOG, m + '\n'); } catch {} console.log(m); };

async function main() {
  step(`[${new Date().toISOString().slice(11, 19)}] старт харнесса, slug=${SLUG}`);
  const DBURL = readFileSync('/tmp/dburl.txt', 'utf8').trim();
  const c = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const a = (await c.query(
    `SELECT a.id, a.slug, a.gologin_profile_id pid, a.ig_login, a.ig_password, a.totp_secret, a.ig_email, a.ig_email_password, g.gologin_token tok
     FROM accounts a LEFT JOIN account_groups g ON g.id=a.group_id WHERE lower(a.slug)=lower($1) LIMIT 1`, [SLUG])).rows[0];
  await c.end();
  if (!a) { step('нет акка'); return; }
  step(`акк найден: ${a.slug} (профиль ${String(a.pid).slice(0, 8)}, 2fa=${!!a.totp_secret}); коннект…`);
  const session: any = await connect(a.pid, a.tok, { pool: 'logger', poolCap: 3, holder: a.slug });
  step('коннект ok, вызываю passwordLogin…');
  try {
    const creds = { login: a.ig_login, password: a.ig_password, totpSecret: a.totp_secret, email: a.ig_email, emailPassword: a.ig_email_password };
    const t0 = Date.now();
    const res = await passwordLogin(session.page, creds);
    step(`>>> РЕЗУЛЬТАТ: ${res} (${Math.round((Date.now() - t0) / 1000)}с)  url=${session.page.url()}`);
    await session.page.screenshot({ path: `${SHOT}/testradar_${a.slug}.png` }).catch(() => {});
  } finally {
    await disconnect(session).catch(() => {});
    step('disconnect ok, готово');
  }
}
main().catch((e) => { step('FATAL ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
