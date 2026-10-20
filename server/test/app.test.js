import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, access, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { connectDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { cleanupDeletedPhotos, startPhotoCleanup } from '../photo-cleanup.js';
import { randomUUID } from 'node:crypto';

let db, app, uploadDir;
const password = 'a strong testing password';
const post = (agent, url) => agent.post(url).set('X-Stake-Request', '1');
function agent() { return request.agent(app); }
async function register(client, email = 'miguel@example.com', extras = {}) {
  return post(client, '/api/auth/register').send({ name: 'Miguel', email, password, ...extras }).expect(201);
}
async function goal(client, extras = {}) {
  const res = await post(client, '/api/goals').send({ title: 'Study every day', ...extras }).expect(201);
  return res.body.goal;
}
async function photoBuffer(format = 'png') {
  return sharp({ create: { width: 12, height: 12, channels: 3, background: '#92a66e' } }).toFormat(format).toBuffer();
}
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    // Only use a dedicated disposable test database: each test truncates these tables.
    db = connectDatabase(process.env.TEST_DATABASE_URL);
    console.log('Testing against external PostgreSQL.');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    console.log('Testing against embedded PostgreSQL (PGlite).');
  }
  await migrate(db);
  await migrate(db);
});
beforeEach(async () => {
  await db.query('TRUNCATE TABLE photo_cleanup_queue, photos, goals, sessions, users CASCADE');
  uploadDir = await mkdtemp(path.join(os.tmpdir(), 'stake-test-'));
  app = createApp({ db, uploadDir });
});
after(async () => {
  if (db.end) await db.end(); else await db.close();
});
// Each test gets an isolated private directory; no images are committed.
import { afterEach } from 'node:test';
afterEach(async () => { if (uploadDir) await rm(uploadDir, { recursive: true, force: true }); });

test('registration hashes passwords, normalizes email, and ignores role escalation', async () => {
  const client = agent();
  const res = await register(client, ' MIGUEL@Example.com ', { role: 'admin', account_status: 'banned' });
  assert.equal(res.body.user.role, 'member');
  assert.equal(res.body.user.email, 'miguel@example.com');
  assert.equal(res.body.user.password_hash, undefined);
  const { rows: [user] } = await db.query('SELECT * FROM users');
  assert.notEqual(user.password_hash, password);
  assert.equal(await bcrypt.compare(password, user.password_hash), true);
  assert.equal(user.account_status, 'active');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const { rows: [session] } = await db.query('SELECT * FROM sessions');
  assert.notEqual(session.token_hash, cookie.split(';')[0].split('=')[1]);
  await client.get('/api/auth/me').expect(200);
});

test('duplicate accounts are rejected regardless of email capitalization', async () => {
  await register(agent());
  await post(agent(), '/api/auth/register').send({ name: 'Duplicate', email: 'MIGUEL@example.com', password }).expect(409);
  assert.equal((await db.query('SELECT * FROM users')).rows.length, 1);
});

test('invalid registrations cannot create accounts', async () => {
  for (const data of [
    { name: '', email: 'a@example.com', password },
    { name: 'A', email: 'bad-email', password },
    { name: 'A', email: 'a@example.com', password: 'short' },
    { name: 'A', email: 'a@example.com', password: 'é'.repeat(40) },
    { name: 'A', email: ['a@example.com'], password },
  ]) await post(agent(), '/api/auth/register').send(data).expect(400);
  assert.equal((await db.query('SELECT * FROM users')).rows.length, 0);
});

test('login validates credentials and logout revokes the server-side session', async () => {
  const client = agent();
  const registered = await register(client);
  const oldCookie = registered.headers['set-cookie'][0].split(';')[0];
  await post(client, '/api/auth/logout').expect(204);
  await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(401);
  await post(client, '/api/auth/login').send({ email: 'miguel@example.com', password: 'wrong' }).expect(401);
  await post(client, '/api/auth/login').send({ email: 'missing@example.com', password }).expect(401);
  await post(client, '/api/auth/login').send({ email: 'MIGUEL@example.com', password }).expect(200);
  await client.get('/api/auth/me').expect(200);
});

test('expired sessions and banned accounts lose access', async () => {
  const client = agent();
  await register(client);
  await db.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
  await client.get('/api/auth/me').expect(401);
  await post(client, '/api/auth/login').send({ email: 'miguel@example.com', password }).expect(200);
  await db.query("UPDATE users SET account_status = 'banned'");
  await client.get('/api/goals').expect(401);
  await post(client, '/api/auth/login').send({ email: 'miguel@example.com', password }).expect(401);
});

test('administration is restricted by server-side role checks', async () => {
  const client = agent();
  await request(app).get('/api/admin/users').expect(401);
  await register(client);
  await client.get('/api/admin/users').expect(403);
  await db.query("UPDATE users SET role = 'admin'");
  const res = await client.get('/api/admin/users').expect(200);
  assert.equal(res.body.users[0].password_hash, undefined);
});

test('state changes reject missing request headers and foreign origins', async () => {
  const data = { name: 'Miguel', email: 'miguel@example.com', password };
  await request(app).post('/api/auth/register').send(data).expect(403);
  await post(agent(), '/api/auth/register').set('Origin', 'https://attacker.example').send(data).expect(403);
  await post(agent(), '/api/auth/register').set('Origin', 'http://localhost:5173').send(data).expect(201);
});

test('goals persist, validate dates, and are scoped to the authenticated owner', async () => {
  const first = agent(), second = agent();
  await register(first);
  const secondUser = await register(second, 'ronin@example.com');
  const created = await goal(first, { owner_id: secondUser.body.user.id, targetDate: '2026-11-01', status: 'active' });
  assert.equal(created.status, 'draft');
  assert.notEqual(created.owner_id, secondUser.body.user.id);
  assert.equal((await first.get('/api/goals').expect(200)).body.goals.length, 1);
  assert.equal((await second.get('/api/goals').expect(200)).body.goals.length, 0);
  await post(first, '/api/goals').send({ title: '' }).expect(400);
  await post(first, '/api/goals').send({ title: 'A', targetDate: '2026-02-30' }).expect(400);
  await request(app).get('/api/goals').expect(401);
});

test('PNG, JPEG, and WebP uploads are decoded and stored as private WebP images', async () => {
  const client = agent();
  await register(client);
  for (const format of ['png', 'jpeg', 'webp']) {
    const g = await goal(client);
    const image = await photoBuffer(format);
    const res = await post(client, `/api/goals/${g.id}/stake`).attach('photo', image, `test.${format}`).expect(201);
    assert.equal(res.body.photo.storage_key, undefined);
    const fetched = await client.get(res.body.photo.url).expect(200).expect('Content-Type', /image\/webp/);
    assert.equal((await sharp(fetched.body).metadata()).format, 'webp');
    assert.match(fetched.headers['cache-control'], /no-store/);
  }
  const list = await client.get('/api/goals').expect(200);
  assert.ok(list.body.goals.every(g => g.stake_photo_id));
  assert.equal((await readdir(uploadDir)).length, 3);
});

test('forged images, SVG files, and oversized files are rejected without saved files', async () => {
  const client = agent();
  await register(client);
  const g = await goal(client);
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', Buffer.from('not an image'), { filename: 'fake.jpg', contentType: 'image/jpeg' }).expect(400);
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'), 'test.svg').expect(400);
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png').expect(413);
  await post(client, `/api/goals/${g.id}/stake`).expect(400);
  assert.equal((await readdir(uploadDir)).length, 0);
});

test('another member, an admin, and a logged-out visitor cannot retrieve private stakes', async () => {
  const owner = agent(), other = agent();
  await register(owner);
  await register(other, 'connor@example.com');
  const g = await goal(owner);
  const image = await photoBuffer();
  const uploaded = await post(owner, `/api/goals/${g.id}/stake`).attach('photo', image, 'stake.png').expect(201);
  const url = uploaded.body.photo.url;
  await other.get(url).expect(404);
  await db.query("UPDATE users SET role = 'admin' WHERE email = 'connor@example.com'");
  await other.get(url).expect(404);
  await request(app).get(url).expect(401);
  await post(other, `/api/goals/${g.id}/stake`).attach('photo', image, 'stake.png').expect(404);
  await owner.get('/api/photos/not-a-uuid').expect(404);
  await request(app).get(`/var/private-photos/${uploaded.body.photo.id}.webp`).expect(404);
});

test('duplicate stakes are rejected and the second file is removed', async () => {
  const client = agent();
  await register(client);
  const g = await goal(client), image = await photoBuffer();
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', image, 'one.png').expect(201);
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', image, 'two.png').expect(409);
  assert.equal((await readdir(uploadDir)).length, 1);
  assert.equal((await db.query('SELECT * FROM photos')).rows.length, 1);
});

test('sessions survive an app restart because PostgreSQL holds session state', async () => {
  const client = agent();
  const registered = await register(client);
  const cookie = registered.headers['set-cookie'][0].split(';')[0];
  const restarted = createApp({ db, uploadDir });
  await request(restarted).get('/api/auth/me').set('Cookie', cookie).expect(200);
});

test('authentication requests are rate limited', async () => {
  for (let i = 0; i < 30; i++) await post(agent(), '/api/auth/login').send({}).expect(400);
  await post(agent(), '/api/auth/login').send({}).expect(429);
});

test('direct SQL user deletion queues all owned photos and preserves another user’s files', async () => {
  const owner = agent(), other = agent();
  const { body: { user } } = await register(owner);
  await register(other, 'other@example.com');
  const image = await photoBuffer();
  const ownedKeys = [];
  for (let i = 0; i < 2; i++) {
    const g = await goal(owner);
    const res = await post(owner, `/api/goals/${g.id}/stake`).attach('photo', image, 'stake.png').expect(201);
    ownedKeys.push(`${res.body.photo.id}.webp`);
  }
  const otherGoal = await goal(other);
  const otherPhoto = await post(other, `/api/goals/${otherGoal.id}/stake`).attach('photo', image, 'other.png').expect(201);
  const otherKey = `${otherPhoto.body.photo.id}.webp`;
  await db.query('DELETE FROM users WHERE id = $1', [user.id]);
  assert.equal((await db.query('SELECT * FROM photo_cleanup_queue')).rows.length, 2);
  // SQL commits first; the background pass performs filesystem work afterward.
  assert.equal((await readdir(uploadDir)).length, 3);
  assert.deepEqual(await cleanupDeletedPhotos({ db, uploadDir }), { removed: 2, failed: 0 });
  assert.deepEqual(await readdir(uploadDir), [otherKey]);
  for (const key of ownedKeys) await assert.rejects(access(path.join(uploadDir, key)), { code: 'ENOENT' });
  assert.equal((await db.query('SELECT * FROM photo_cleanup_queue')).rows.length, 0);
  await other.get(otherPhoto.body.photo.url).expect(200);
  await owner.get('/api/auth/me').expect(401);
});

test('rolled-back user deletion keeps photo metadata and file, with no cleanup request', async () => {
  const client = agent();
  const { body: { user } } = await register(client);
  const g = await goal(client);
  const photo = await post(client, `/api/goals/${g.id}/stake`).attach('photo', await photoBuffer(), 'stake.png').expect(201);
  const connection = db.connect ? await db.connect() : db;
  try {
    await connection.query('BEGIN');
    await connection.query('DELETE FROM users WHERE id = $1', [user.id]);
    await connection.query('ROLLBACK');
  } finally { connection.release?.(); }
  assert.deepEqual(await cleanupDeletedPhotos({ db, uploadDir }), { removed: 0, failed: 0 });
  assert.equal((await db.query('SELECT * FROM photos')).rows.length, 1);
  await client.get(photo.body.photo.url).expect(200);
});

test('missing files complete cleanup safely and repeated passes do nothing', async () => {
  const key = `${randomUUID()}.webp`;
  await db.query('INSERT INTO photo_cleanup_queue(storage_key) VALUES($1)', [key]);
  assert.deepEqual(await cleanupDeletedPhotos({ db, uploadDir }), { removed: 1, failed: 0 });
  assert.deepEqual(await cleanupDeletedPhotos({ db, uploadDir }), { removed: 0, failed: 0 });
});

test('failed file removal stays queued and succeeds on a later pass', async () => {
  const key = `${randomUUID()}.webp`;
  const file = path.join(uploadDir, key);
  // A directory cannot be unlinked as a file, producing a real filesystem error.
  await mkdir(file);
  await db.query('INSERT INTO photo_cleanup_queue(storage_key) VALUES($1)', [key]);
  const warnings = [];
  const options = { db, uploadDir, logger: { warn: (...args) => warnings.push(args) } };
  assert.deepEqual(await cleanupDeletedPhotos(options), { removed: 0, failed: 1 });
  assert.equal(warnings.length, 1);
  assert.equal((await db.query('SELECT * FROM photo_cleanup_queue')).rows.length, 1);
  await rm(file, { recursive: true });
  await writeFile(file, 'test image placeholder');
  assert.deepEqual(await cleanupDeletedPhotos(options), { removed: 1, failed: 0 });
});

test('cleanup cannot delete a live photo or a file outside the private storage directory', async () => {
  const client = agent();
  await register(client);
  const g = await goal(client);
  const photo = await post(client, `/api/goals/${g.id}/stake`).attach('photo', await photoBuffer(), 'stake.png').expect(201);
  await db.query('INSERT INTO photo_cleanup_queue(storage_key) VALUES($1),($2)', [`${photo.body.photo.id}.webp`, '../outside.webp']);
  const result = await cleanupDeletedPhotos({ db, uploadDir, logger: { warn() {} } });
  assert.deepEqual(result, { removed: 0, failed: 1 });
  await client.get(photo.body.photo.url).expect(200);
});

test('the background worker processes queued deletions on startup', async () => {
  const key = `${randomUUID()}.webp`;
  await writeFile(path.join(uploadDir, key), 'queued test image');
  await db.query('INSERT INTO photo_cleanup_queue(storage_key) VALUES($1)', [key]);
  const stop = startPhotoCleanup({ db, uploadDir }, 10);
  try {
    const deadline = Date.now() + 2000;
    while ((await db.query('SELECT * FROM photo_cleanup_queue')).rows.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await db.query('SELECT * FROM photo_cleanup_queue')).rows.length, 0);
    assert.deepEqual(await readdir(uploadDir), []);
  } finally { await stop(); }
});
