import { connectDatabase } from './db.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('Usage: npm run admin -- existing-user@example.com');
const db = connectDatabase();
try {
  const { rows } = await db.query("UPDATE users SET role = 'admin' WHERE email = $1 RETURNING email", [email]);
  if (!rows.length) throw new Error('Register this account first. No user was changed.');
  console.log(`Administrator access granted to ${rows[0].email}.`);
} finally { await db.end(); }
