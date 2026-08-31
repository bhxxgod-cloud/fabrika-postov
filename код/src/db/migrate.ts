import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './index.js';

// Идемпотентная миграция: гоняет schema.sql (всё через IF NOT EXISTS).
// Вызывается в railway.json перед стартом: `npm run migrate && npm start`.
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] схема применена');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] ошибка:', err);
  process.exit(1);
});
