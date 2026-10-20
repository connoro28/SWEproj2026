// A single-machine preview, not the shared database deployment.
import { PGlite } from '@electric-sql/pglite';
import { mkdir, access } from 'node:fs/promises';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { startPhotoCleanup } from './photo-cleanup.js';

await access('dist/index.html').catch(() => { throw new Error('Run npm run build before starting the preview.'); });
await mkdir('var', { recursive: true, mode: 0o700 });
const db = new PGlite('./var/preview-db');
await migrate(db);
const app = createApp({ db, uploadDir: './var/preview-photos', appOrigin: 'http://localhost:3001', serveFrontend: true });
const stopCleanup = startPhotoCleanup({ db, uploadDir: './var/preview-photos' });
const server = app.listen(3001, '127.0.0.1', () => {
  console.log('Stake local preview: http://localhost:3001');
  console.log('Uses a private embedded database in var/preview-db. The shared PostgreSQL app uses npm run dev.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await stopCleanup(); await db.close(); process.exit(0); }));
