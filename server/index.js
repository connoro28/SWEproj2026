import 'dotenv/config';
import { createApp } from './app.js';
import { connectDatabase } from './db.js';
import { startPhotoCleanup } from './photo-cleanup.js';

const db = connectDatabase();
await db.query('SELECT 1 FROM users LIMIT 1').catch(() => {
  throw new Error('Cannot read the database. Start PostgreSQL and run npm run db:migrate first.');
});
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.APP_ORIGIN?.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS.');
const uploadDir = process.env.UPLOAD_DIR || './var/private-photos';
const app = createApp({ db, production, appOrigin: process.env.APP_ORIGIN, uploadDir });
const stopCleanup = startPhotoCleanup({ db, uploadDir });
const server = app.listen(Number(process.env.PORT || 3001), '127.0.0.1', () => console.log('Stake API ready on http://127.0.0.1:' + (process.env.PORT || 3001)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await stopCleanup(); await db.end(); process.exit(0); }));
