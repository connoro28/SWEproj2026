import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { connectDatabase } from '../db.js';
import { migrate } from '../migrate.js';

let db;
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    db = connectDatabase(process.env.TEST_DATABASE_URL);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
  }
});
after(async () => {
  if (db.end) await db.end(); else await db.close();
});

test('migrations are recorded once and a second run applies nothing', async () => {
  // A shared test database may already be migrated, so only the second run is asserted.
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
  const files = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter(f => f.endsWith('.sql'))
    .map(f => f.replace(/\.sql$/, ''))
    .sort();
  const { rows } = await db.query(
    'SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map(r => r.version), files);
});
