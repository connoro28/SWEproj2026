import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDatabase } from './db.js';

const migrationsDir = new URL('./migrations/', import.meta.url);

// PGlite runs multi-statement SQL with .exec(); pg.Pool uses .query().
async function run(db, sql) {
  if (db.exec) return db.exec(sql);
  await db.query(sql);
}

// Applies each numbered file in migrations/ once, in filename order, and returns
// the versions applied by this call. Applied migrations must never be edited.
export async function migrate(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`);
  const { rows } = await db.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(row => row.version));
  const files = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  const ran = [];
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (applied.has(version)) continue;
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    // One simple query runs in one implicit transaction: a failing migration
    // leaves no partial schema and no version row.
    await run(db, `${sql}\n;\nINSERT INTO schema_migrations (version) VALUES ('${version.replaceAll("'", "''")}');`);
    ran.push(version);
  }
  return ran;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = connectDatabase();
  try {
    const ran = await migrate(db);
    if (ran.length) for (const version of ran) console.log(`Applied migration ${version}.`);
    else console.log('Database is already up to date.');
  } finally { await db.end(); }
}
