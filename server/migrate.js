import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDatabase } from './db.js';

export async function migrate(db) {
  // One initial, repeatable migration; future schema changes need versioned migrations.
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  if (db.exec) return db.exec(sql);
  await db.query(sql);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = connectDatabase();
  try { await migrate(db); console.log('Database tables are ready.'); }
  finally { await db.end(); }
}
