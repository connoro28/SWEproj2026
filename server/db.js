import 'dotenv/config';
import pg from 'pg';

export function connectDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is missing. Copy .env.example to .env and configure PostgreSQL.');
  return new pg.Pool({ connectionString: url });
}
