import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { connectDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { cleanupDeletedPhotos } from '../photo-cleanup.js';

let db, app, uploadDir;
const password = 'a strong testing password';
const post = (agent, url) => agent.post(url).set('X-Stake-Request', '1');
function agent() { return request.agent(app); }
async function register(client, email = 'miguel@example.com', extras = {}) {
  return post(client, '/api/auth/register').send({ name: 'Miguel', email, password, ...extras }).expect(201);
}
// A fixed-offset zone where it is currently about noon, so a 23:00 deadline is
// open and a 01:00 deadline has passed whenever the suite runs. Etc/GMT signs
// are inverted: Etc/GMT-5 is five hours ahead of UTC.
function noonZone() {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}
async function goal(client, extras = {}) {
  const res = await post(client, '/api/goals')
    .send({ title: 'Study every day', frequency: 'daily', deadlineTime: '23:00', timezone: noonZone(), ...extras }).expect(201);
  return res.body.goal;
}
async function photoBuffer(format = 'png') {
  return sharp({ create: { width: 12, height: 12, channels: 3, background: '#92a66e' } }).toFormat(format).toBuffer();
}
async function activeGoal(client, extras = {}) {
  const g = await goal(client, extras);
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', await photoBuffer(), 'stake.png').expect(201);
  return (await post(client, `/api/goals/${g.id}/activate`).expect(200)).body.goal;
}
let proof;
// Returns the supertest request (not a promise) so callers can chain .expect().
function checkIn(client, goalId) {
  return post(client, `/api/goals/${goalId}/check-ins`).attach('photo', proof, 'proof.jpg');
}
const checkInPhotos = async () => (await db.query("SELECT * FROM photos WHERE kind = 'checkin'")).rows;
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    // Only use a dedicated disposable test database: each test truncates these tables.
    db = connectDatabase(process.env.TEST_DATABASE_URL);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
  }
  await migrate(db);
  proof = await photoBuffer('jpeg');
});
beforeEach(async () => {
  await db.query('TRUNCATE TABLE check_ins, friendships, photo_cleanup_queue, photos, goals, sessions, users CASCADE');
  uploadDir = await mkdtemp(path.join(os.tmpdir(), 'stake-test-'));
  app = createApp({ db, uploadDir });
});
afterEach(async () => { if (uploadDir) await rm(uploadDir, { recursive: true, force: true }); });
after(async () => {
  if (db.end) await db.end(); else await db.close();
});

test('an active goal accepts a check-in dated in the goal’s own time zone', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client);
  const res = await checkIn(client, g.id).expect(201);
  const { checkIn: created } = res.body;
  const { rows: [{ today }] } = await db.query("SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today", [g.timezone]);
  assert.equal(created.local_date, today);
  assert.ok(created.submitted_at);
  const fetched = await client.get(`/api/photos/${created.photo_id}`).expect(200).expect('Content-Type', /image\/webp/);
  assert.equal((await sharp(fetched.body).metadata()).format, 'webp');
  assert.equal((await readdir(uploadDir)).length, 2);
  const { body } = await client.get(`/api/goals/${g.id}/check-ins`).expect(200);
  assert.deepEqual(body.checkIns, [{ id: created.id, local_date: today, submitted_at: created.submitted_at, photo_id: created.photo_id }]);
  assert.deepEqual(body.progress, { todayDone: true, thisWeekCount: 1, target: 1, canCheckInNow: false });
});

test('a second check-in on the same day is rejected and its file removed', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client);
  await checkIn(client, g.id).expect(201);
  const again = await checkIn(client, g.id).expect(409);
  assert.equal(again.body.error, 'You already checked in today.');
  assert.equal((await checkInPhotos()).length, 1);
  assert.equal((await readdir(uploadDir)).length, 2);
});

test('concurrent check-ins on the same day record exactly one', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client);
  const results = await Promise.all([checkIn(client, g.id), checkIn(client, g.id)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal((await db.query('SELECT * FROM check_ins')).rows.length, 1);
  assert.equal((await checkInPhotos()).length, 1);
  assert.equal((await readdir(uploadDir)).length, 2);
});

test('a draft goal cannot be checked in to', async () => {
  const client = agent();
  await register(client);
  const g = await goal(client);
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', await photoBuffer(), 'stake.png').expect(201);
  const res = await checkIn(client, g.id).expect(409);
  assert.equal(res.body.error, 'Activate this goal before checking in.');
  assert.equal((await checkInPhotos()).length, 0);
  assert.equal((await readdir(uploadDir)).length, 1);
  const { body } = await client.get(`/api/goals/${g.id}/check-ins`).expect(200);
  assert.deepEqual(body, { checkIns: [], progress: { todayDone: false, thisWeekCount: 0, target: 1, canCheckInNow: false } });
});

test('a check-in after the day’s deadline is rejected with no grace period', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client, { deadlineTime: '01:00' });
  const res = await checkIn(client, g.id).expect(409);
  assert.equal(res.body.error, "Today's deadline has passed.");
  assert.equal((await checkInPhotos()).length, 0);
  assert.equal((await readdir(uploadDir)).length, 1);
  const { body: { progress } } = await client.get(`/api/goals/${g.id}/check-ins`).expect(200);
  assert.deepEqual(progress, { todayDone: false, thisWeekCount: 0, target: 1, canCheckInNow: false });
});

test('unsupported files are rejected before any check-in is recorded', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client);
  await post(client, `/api/goals/${g.id}/check-ins`).attach('photo', Buffer.from('not an image'), { filename: 'fake.jpg', contentType: 'image/jpeg' }).expect(400);
  await post(client, `/api/goals/${g.id}/check-ins`).expect(400);
  assert.equal((await db.query('SELECT * FROM check_ins')).rows.length, 0);
  assert.equal((await readdir(uploadDir)).length, 1);
});

test('check-ins and their photos are private to the goal owner', async () => {
  const owner = agent(), other = agent();
  await register(owner);
  await register(other, 'connor@example.com');
  const g = await activeGoal(owner);
  const { body: { checkIn: created } } = await checkIn(owner, g.id).expect(201);
  await checkIn(other, g.id).expect(404);
  await other.get(`/api/goals/${g.id}/check-ins`).expect(404);
  await other.get(`/api/photos/${created.photo_id}`).expect(404);
  await db.query("UPDATE users SET role = 'admin' WHERE email = 'connor@example.com'");
  await other.get(`/api/photos/${created.photo_id}`).expect(404);
  await request(app).get(`/api/goals/${g.id}/check-ins`).expect(401);
  await post(request(app), `/api/goals/${g.id}/check-ins`).expect(401);
  await request(app).get(`/api/photos/${created.photo_id}`).expect(401);
  await owner.post(`/api/goals/${g.id}/check-ins`).attach('photo', await photoBuffer(), 'proof.png').expect(403);
  await owner.get('/api/goals/not-a-uuid/check-ins').expect(404);
  assert.equal((await db.query('SELECT * FROM check_ins')).rows.length, 1);
});

test('the goal list still shows one row per goal with its stake photo', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client);
  await checkIn(client, g.id).expect(201);
  const { body: { goals } } = await client.get('/api/goals').expect(200);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].stake_photo_id, g.stake_photo_id);
});

test('weekly progress counts days from Monday in the goal’s time zone', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client, { frequency: 'weekly', timesPerWeek: 3 });
  // This week's Monday counts; the Sunday before it belongs to last week.
  for (const offset of [0, -1]) {
    const photoId = randomUUID();
    await db.query(`INSERT INTO photos (id, goal_id, storage_key, content_type, byte_size, kind)
      VALUES ($1, $2, $3, 'image/webp', 1, 'checkin')`, [photoId, g.id, `${photoId}.webp`]);
    await db.query(`INSERT INTO check_ins (id, goal_id, photo_id, local_date)
      VALUES ($1, $2, $3, date_trunc('week', now() AT TIME ZONE $4)::date + $5::int)`, [randomUUID(), g.id, photoId, g.timezone, offset]);
  }
  const { body } = await client.get(`/api/goals/${g.id}/check-ins`).expect(200);
  assert.equal(body.progress.thisWeekCount, 1);
  assert.equal(body.progress.target, 3);
  assert.equal(body.checkIns.length, 2);
  assert.ok(body.checkIns[0].local_date > body.checkIns[1].local_date, 'newest first');
});

test('a goal keeps one stake photo but may have many check-in photos', async () => {
  const client = agent();
  await register(client);
  const g = await activeGoal(client);
  const photo = (kind = 'checkin') => {
    const id = randomUUID();
    return db.query('INSERT INTO photos (id, goal_id, storage_key, content_type, byte_size, kind) VALUES ($1, $2, $3, $4, 1, $5)',
      [id, g.id, `${id}.webp`, 'image/webp', kind]);
  };
  await photo();
  await photo();
  await assert.rejects(photo('stake'), { code: '23505' });
  await assert.rejects(photo('other'), { code: '23514' });
  await post(client, `/api/goals/${g.id}/stake`).attach('photo', await photoBuffer(), 'two.png').expect(409);
});

test('deleting a user also queues and removes their check-in photo files', async () => {
  const client = agent();
  const { body: { user } } = await register(client);
  const g = await activeGoal(client);
  await checkIn(client, g.id).expect(201);
  await db.query('DELETE FROM users WHERE id = $1', [user.id]);
  assert.equal((await db.query('SELECT * FROM check_ins')).rows.length, 0);
  assert.deepEqual(await cleanupDeletedPhotos({ db, uploadDir }), { removed: 2, failed: 0 });
  assert.deepEqual(await readdir(uploadDir), []);
});
