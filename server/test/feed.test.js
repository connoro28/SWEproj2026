import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { connectDatabase } from '../db.js';
import { migrate } from '../migrate.js';

let db, app, uploadDir, image;
const password = 'a strong testing password';
const post = (agent, url) => agent.post(url).set('X-Stake-Request', '1');
function agent() { return request.agent(app); }
async function register(client, email = 'miguel@example.com', extras = {}) {
  return post(client, '/api/auth/register').send({ name: 'Miguel', email, password, ...extras }).expect(201);
}
async function member(name, email) {
  const client = agent();
  const res = await register(client, email, { name });
  return { client, id: res.body.user.id };
}
async function befriend(from, to) {
  const { body: { request: sent } } = await post(from.client, '/api/friends/requests').send({ addresseeId: to.id }).expect(201);
  await post(to.client, `/api/friends/requests/${sent.id}/accept`).expect(200);
}
// A fixed-offset zone where it is currently about noon, so a 23:00 deadline is
// always open. Etc/GMT signs are inverted: Etc/GMT-5 is five hours ahead of UTC.
function noonZone() {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}
// Creates an active goal with a real stake photo and today's real check-in.
async function checkedInGoal(who, title = 'Run every day') {
  const { body: { goal } } = await post(who.client, '/api/goals')
    .send({ title, frequency: 'daily', deadlineTime: '23:00', timezone: noonZone() }).expect(201);
  const stake = await post(who.client, `/api/goals/${goal.id}/stake`).attach('photo', image, 'stake.png').expect(201);
  await post(who.client, `/api/goals/${goal.id}/activate`).expect(200);
  const { body: { checkIn } } = await post(who.client, `/api/goals/${goal.id}/check-ins`).attach('photo', image, 'proof.png').expect(201);
  return { goal, stakePhotoId: stake.body.photo.id, checkInPhotoId: checkIn.photo_id, checkIn };
}
// Inserts a check-in row directly, for ordering and pagination tests that need
// many check-ins or exact timestamps. No file is written.
async function insertCheckIn(goalId, localDate, submittedAt) {
  const photoId = randomUUID(), id = randomUUID();
  await db.query(`INSERT INTO photos (id, goal_id, storage_key, content_type, byte_size, kind)
    VALUES ($1, $2, $3, 'image/webp', 1, 'checkin')`, [photoId, goalId, `${photoId}.webp`]);
  await db.query('INSERT INTO check_ins (id, goal_id, photo_id, local_date, submitted_at) VALUES ($1, $2, $3, $4, $5)',
    [id, goalId, photoId, localDate, submittedAt]);
  return id;
}
async function feedIds(who, cursor) {
  const req = who.client.get('/api/feed');
  const { body } = await (cursor ? req.query({ cursor }) : req).expect(200);
  return { ids: body.items.map(item => item.id), nextCursor: body.nextCursor, body };
}
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    // Only use a dedicated disposable test database: each test truncates these tables.
    db = connectDatabase(process.env.TEST_DATABASE_URL);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
  }
  await migrate(db);
  image = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#92a66e' } }).png().toBuffer();
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

// Photo authorization. These are the most important tests in the repository:
// a stake photo must never reach anyone but its owner.

test('an accepted friend can retrieve a check-in photo, in either friendship direction', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const connor = await member('Connor', 'connor@example.com');
  await befriend(miguel, ronin);
  await befriend(connor, miguel);
  const { checkInPhotoId } = await checkedInGoal(miguel);
  await ronin.client.get(`/api/photos/${checkInPhotoId}`).expect(200).expect('Content-Type', /image\/webp/);
  await connor.client.get(`/api/photos/${checkInPhotoId}`).expect(200);
});

test('an accepted friend can never retrieve a stake photo', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const connor = await member('Connor', 'connor@example.com');
  await befriend(miguel, ronin);
  await befriend(connor, miguel);
  const { stakePhotoId } = await checkedInGoal(miguel);
  await ronin.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  await connor.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  // Nor while the goal is still a draft, before any check-in exists.
  const { body: { goal } } = await post(miguel.client, '/api/goals')
    .send({ title: 'Draft', frequency: 'daily', deadlineTime: '23:00', timezone: 'UTC' }).expect(201);
  const draftStake = await post(miguel.client, `/api/goals/${goal.id}/stake`).attach('photo', image, 'stake.png').expect(201);
  await ronin.client.get(`/api/photos/${draftStake.body.photo.id}`).expect(404);
});

test('the owner can retrieve their own stake and check-in photos', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const { stakePhotoId, checkInPhotoId } = await checkedInGoal(miguel);
  await miguel.client.get(`/api/photos/${stakePhotoId}`).expect(200).expect('Content-Type', /image\/webp/);
  await miguel.client.get(`/api/photos/${checkInPhotoId}`).expect(200);
});

test('a pending friendship grants no photo access in either direction', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const connor = await member('Connor', 'connor@example.com');
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: ronin.id }).expect(201);
  await post(connor.client, '/api/friends/requests').send({ addresseeId: miguel.id }).expect(201);
  const { stakePhotoId, checkInPhotoId } = await checkedInGoal(miguel);
  for (const viewer of [ronin, connor]) {
    await viewer.client.get(`/api/photos/${checkInPhotoId}`).expect(404);
    await viewer.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  }
});

test('a declined friendship grants no photo access in either direction', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const connor = await member('Connor', 'connor@example.com');
  const toRonin = await post(miguel.client, '/api/friends/requests').send({ addresseeId: ronin.id }).expect(201);
  await post(ronin.client, `/api/friends/requests/${toRonin.body.request.id}/decline`).expect(200);
  const fromConnor = await post(connor.client, '/api/friends/requests').send({ addresseeId: miguel.id }).expect(201);
  await post(miguel.client, `/api/friends/requests/${fromConnor.body.request.id}/decline`).expect(200);
  const { stakePhotoId, checkInPhotoId } = await checkedInGoal(miguel);
  for (const viewer of [ronin, connor]) {
    await viewer.client.get(`/api/photos/${checkInPhotoId}`).expect(404);
    await viewer.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  }
});

test('strangers, administrators, and friends of friends get 404 for every photo', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const stranger = await member('Stranger', 'stranger@example.com');
  const admin = await member('Admin', 'admin@example.com');
  await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', admin.id]);
  await befriend(miguel, ronin);
  await befriend(ronin, stranger);
  const { stakePhotoId, checkInPhotoId } = await checkedInGoal(miguel);
  for (const viewer of [stranger, admin]) {
    await viewer.client.get(`/api/photos/${checkInPhotoId}`).expect(404);
    await viewer.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  }
  await request(app).get(`/api/photos/${checkInPhotoId}`).expect(401);
  await request(app).get(`/api/photos/${stakePhotoId}`).expect(401);
});

test('an administrator who is a friend still cannot retrieve a stake photo', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const admin = await member('Admin', 'admin@example.com');
  await db.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', admin.id]);
  await befriend(miguel, admin);
  const { stakePhotoId, checkInPhotoId } = await checkedInGoal(miguel);
  await admin.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  await admin.client.get(`/api/photos/${checkInPhotoId}`).expect(200);
});

test('a banned owner’s check-in photos are hidden from friends, and a banned viewer is logged out', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await befriend(miguel, ronin);
  const { checkInPhotoId } = await checkedInGoal(miguel);
  const own = await checkedInGoal(ronin);
  await ronin.client.get(`/api/photos/${checkInPhotoId}`).expect(200);
  await db.query("UPDATE users SET account_status = 'banned' WHERE id = $1", [miguel.id]);
  await ronin.client.get(`/api/photos/${checkInPhotoId}`).expect(404);
  await miguel.client.get(`/api/photos/${own.checkInPhotoId}`).expect(401);
});

test('a forbidden photo is indistinguishable from a missing one', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await befriend(miguel, ronin);
  const { stakePhotoId } = await checkedInGoal(miguel);
  const forbidden = await ronin.client.get(`/api/photos/${stakePhotoId}`).expect(404);
  const missing = await ronin.client.get(`/api/photos/${randomUUID()}`).expect(404);
  assert.deepEqual(forbidden.body, missing.body);
});

// Feed contents.

test('the feed shows accepted friends’ check-ins with no email or stake photo', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await befriend(miguel, ronin);
  const { goal, stakePhotoId, checkIn } = await checkedInGoal(ronin, 'Read 20 pages');
  const res = await miguel.client.get('/api/feed').expect(200);
  assert.deepEqual(res.body, {
    items: [{ id: checkIn.id, local_date: checkIn.local_date, submitted_at: checkIn.submitted_at, photo_id: checkIn.photo_id,
      goal: { id: goal.id, title: 'Read 20 pages' }, friend: { id: ronin.id, name: 'Ronin' } }],
    nextCursor: null,
  });
  assert.doesNotMatch(res.text, /@/);
  assert.ok(!res.text.includes(stakePhotoId));
  await miguel.client.get(`/api/photos/${res.body.items[0].photo_id}`).expect(200);
});

test('the feed excludes the caller, strangers, pending and declined requests, banned owners, and draft goals', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const friend = await member('Friend', 'friend@example.com');
  const pending = await member('Pending', 'pending@example.com');
  const declined = await member('Declined', 'declined@example.com');
  const stranger = await member('Stranger', 'stranger@example.com');
  const banned = await member('Banned', 'banned@example.com');
  await befriend(miguel, friend);
  await befriend(banned, miguel);
  await post(pending.client, '/api/friends/requests').send({ addresseeId: miguel.id }).expect(201);
  const toDeclined = await post(miguel.client, '/api/friends/requests').send({ addresseeId: declined.id }).expect(201);
  await post(declined.client, `/api/friends/requests/${toDeclined.body.request.id}/decline`).expect(200);
  const expected = (await checkedInGoal(friend)).checkIn.id;
  for (const who of [miguel, pending, declined, stranger, banned]) await checkedInGoal(who);
  await db.query("UPDATE users SET account_status = 'banned' WHERE id = $1", [banned.id]);
  // A check-in row on a draft goal cannot arise through the API; the feed must still ignore it.
  const { body: { goal: draft } } = await post(friend.client, '/api/goals')
    .send({ title: 'Draft', frequency: 'daily', deadlineTime: '23:00', timezone: 'UTC' }).expect(201);
  await insertCheckIn(draft.id, '2026-01-01', '2026-01-01T12:00:00Z');
  assert.deepEqual((await feedIds(miguel)).ids, [expected]);
});

test('a member with no friends sees an empty feed', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  await checkedInGoal(miguel);
  assert.deepEqual((await miguel.client.get('/api/feed').expect(200)).body, { items: [], nextCursor: null });
});

// Ordering and pagination.

test('the feed pages newest first without skipping or repeating items', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await befriend(miguel, ronin);
  const { goal } = await checkedInGoal(ronin);
  for (let day = 1; day <= 24; day++) {
    await insertCheckIn(goal.id, `2026-01-${String(day).padStart(2, '0')}`, `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`);
  }
  const first = await feedIds(miguel);
  assert.equal(first.ids.length, 20);
  assert.ok(first.nextCursor);
  const times = first.body.items.map(item => Date.parse(item.submitted_at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  // A check-in arriving mid-scroll must not shift the next page.
  await insertCheckIn(goal.id, '2026-02-01', '2026-02-01T12:00:00Z');
  const second = await feedIds(miguel, first.nextCursor);
  assert.equal(second.ids.length, 5);
  assert.equal(second.nextCursor, null);
  const all = [...first.ids, ...second.ids];
  assert.equal(new Set(all).size, 25);
  assert.equal((await db.query('SELECT * FROM check_ins')).rows.length, 26);
});

test('an exactly full page reports no further pages', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await befriend(miguel, ronin);
  const { goal } = await checkedInGoal(ronin);
  for (let day = 1; day <= 19; day++) await insertCheckIn(goal.id, `2026-01-${String(day).padStart(2, '0')}`, `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`);
  const page = await feedIds(miguel);
  assert.equal(page.ids.length, 20);
  assert.equal(page.nextCursor, null);
});

test('pagination keeps microsecond order and breaks equal timestamps by id', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await befriend(miguel, ronin);
  const { goal } = await checkedInGoal(ronin);
  await db.query('DELETE FROM check_ins');
  // Within one millisecond, which a JavaScript Date cannot tell apart.
  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push(await insertCheckIn(goal.id, `2026-01-${String(i + 1).padStart(2, '0')}`, `2026-03-01 12:00:00.123${String(100 + i * 10).slice(-3)}+00`));
  }
  // Two check-ins with identical timestamps, on another goal.
  const { goal: second } = await checkedInGoal(ronin, 'Second goal');
  await db.query('DELETE FROM check_ins WHERE goal_id = $1', [second.id]);
  ids.push(await insertCheckIn(second.id, '2026-01-01', '2026-03-01 12:00:00.123123+00'));
  ids.push(await insertCheckIn(second.id, '2026-01-02', '2026-03-01 12:00:00.123123+00'));
  const first = await feedIds(miguel);
  const rest = await feedIds(miguel, first.nextCursor);
  const { rows } = await db.query('SELECT id FROM check_ins ORDER BY submitted_at DESC, id DESC');
  assert.deepEqual([...first.ids, ...rest.ids], rows.map(row => row.id));
  assert.equal(rest.nextCursor, null);
});

test('malformed cursors are rejected', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of ['garbage', encode({ at: '2026-01-01', id: randomUUID() }), encode({ at: '2026-01-01T00:00:00.000000Z', id: 'x' }),
    encode({ at: '2026-13-45T00:00:00.000000Z', id: randomUUID() }), encode({ at: '2026-02-30T00:00:00.000000Z', id: randomUUID() }), encode(null)]) {
    await miguel.client.get('/api/feed').query({ cursor }).expect(400);
  }
  await miguel.client.get('/api/feed?cursor=a&cursor=b').expect(400);
});

test('the feed requires a session', async () => {
  await request(app).get('/api/feed').expect(401);
});
