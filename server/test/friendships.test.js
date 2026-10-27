import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { connectDatabase } from '../db.js';
import { migrate } from '../migrate.js';

let db, app, uploadDir;
const password = 'a strong testing password';
const post = (agent, url) => agent.post(url).set('X-Stake-Request', '1');
function agent() { return request.agent(app); }
async function register(client, email = 'miguel@example.com', extras = {}) {
  return post(client, '/api/auth/register').send({ name: 'Miguel', email, password, ...extras }).expect(201);
}
// Registers a member and returns its client and user id.
async function member(name, email) {
  const client = agent();
  const res = await register(client, email, { name });
  return { client, id: res.body.user.id };
}
async function sendRequest(from, to) {
  return (await post(from.client, '/api/friends/requests').send({ addresseeId: to.id }).expect(201)).body.request;
}
async function friendIds(who) {
  return (await who.client.get('/api/friends').expect(200)).body.friends.map(f => f.id);
}
async function relationship(who, q, id) {
  const { body } = await who.client.get('/api/users/search').query({ q }).expect(200);
  return body.users.find(u => u.id === id)?.relationship;
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
});
beforeEach(async () => {
  await db.query('TRUNCATE TABLE friendships, photo_cleanup_queue, photos, goals, sessions, users CASCADE');
  uploadDir = await mkdtemp(path.join(os.tmpdir(), 'stake-test-'));
  app = createApp({ db, uploadDir });
});
afterEach(async () => { if (uploadDir) await rm(uploadDir, { recursive: true, force: true }); });
after(async () => {
  if (db.end) await db.end(); else await db.close();
});

test('members find each other, send a request, and become friends', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const { body: found } = await miguel.client.get('/api/users/search').query({ q: 'ro' }).expect(200);
  assert.deepEqual(found.users, [{ id: ronin.id, name: 'Ronin', relationship: 'none' }]);
  const sent = await sendRequest(miguel, ronin);
  assert.equal(sent.status, 'pending');
  assert.deepEqual(sent.user, { id: ronin.id, name: 'Ronin' });
  const outgoing = (await miguel.client.get('/api/friends/requests').expect(200)).body;
  assert.deepEqual(outgoing.incoming, []);
  assert.deepEqual(outgoing.outgoing.map(r => [r.id, r.user.id]), [[sent.id, ronin.id]]);
  const incoming = (await ronin.client.get('/api/friends/requests').expect(200)).body;
  assert.deepEqual(incoming.outgoing, []);
  assert.deepEqual(incoming.incoming.map(r => [r.id, r.user.id]), [[sent.id, miguel.id]]);
  const accepted = await post(ronin.client, `/api/friends/requests/${sent.id}/accept`).expect(200);
  assert.equal(accepted.body.request.status, 'accepted');
  assert.ok(accepted.body.request.responded_at);
  assert.deepEqual((await miguel.client.get('/api/friends').expect(200)).body.friends, [{ id: ronin.id, name: 'Ronin' }]);
  assert.deepEqual((await ronin.client.get('/api/friends').expect(200)).body.friends, [{ id: miguel.id, name: 'Miguel' }]);
  const after = (await ronin.client.get('/api/friends/requests').expect(200)).body;
  assert.deepEqual([after.incoming, after.outgoing], [[], []]);
});

test('members cannot befriend themselves, a missing account, or a banned account', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const banned = await member('Banned', 'banned@example.com');
  await db.query("UPDATE users SET account_status = 'banned' WHERE id = $1", [banned.id]);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: miguel.id }).expect(400);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: miguel.id.toUpperCase() }).expect(400);
  await post(miguel.client, '/api/friends/requests').send({}).expect(400);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: 'not-a-uuid' }).expect(400);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: randomUUID() }).expect(404);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: banned.id }).expect(404);
  assert.equal((await db.query('SELECT * FROM friendships')).rows.length, 0);
});

test('a duplicate request in the same direction is rejected', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await sendRequest(miguel, ronin);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: ronin.id }).expect(409);
  assert.equal((await db.query('SELECT * FROM friendships')).rows.length, 1);
});

test('a request in the reverse direction is rejected while one is pending or accepted', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const sent = await sendRequest(miguel, ronin);
  const reverse = await post(ronin.client, '/api/friends/requests').send({ addresseeId: miguel.id }).expect(409);
  assert.match(reverse.body.error, /already sent you/);
  await post(ronin.client, `/api/friends/requests/${sent.id}/accept`).expect(200);
  await post(ronin.client, '/api/friends/requests').send({ addresseeId: miguel.id }).expect(409);
  await post(miguel.client, '/api/friends/requests').send({ addresseeId: ronin.id }).expect(409);
  assert.equal((await db.query('SELECT * FROM friendships')).rows.length, 1);
});

test('the database allows only one friendship row per pair, in either direction', async () => {
  // Backstop for two members requesting each other at the same moment.
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const insert = (from, to) => db.query('INSERT INTO friendships (id, requester_id, addressee_id) VALUES ($1, $2, $3)', [randomUUID(), from, to]);
  await insert(miguel.id, ronin.id);
  await assert.rejects(insert(ronin.id, miguel.id), { code: '23505' });
  await assert.rejects(insert(miguel.id, miguel.id), { code: '23514' });
});

test('only the addressee can accept or decline a request', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const connor = await member('Connor', 'connor@example.com');
  const sent = await sendRequest(miguel, ronin);
  for (const action of ['accept', 'decline']) {
    await post(connor.client, `/api/friends/requests/${sent.id}/${action}`).expect(404);
    await post(miguel.client, `/api/friends/requests/${sent.id}/${action}`).expect(404);
  }
  await post(ronin.client, `/api/friends/requests/${randomUUID()}/accept`).expect(404);
  await post(ronin.client, '/api/friends/requests/not-a-uuid/accept').expect(404);
  assert.equal((await db.query('SELECT status FROM friendships')).rows[0].status, 'pending');
});

test('a request that is no longer pending cannot be answered again', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const sent = await sendRequest(miguel, ronin);
  const results = await Promise.all([
    post(ronin.client, `/api/friends/requests/${sent.id}/accept`),
    post(ronin.client, `/api/friends/requests/${sent.id}/accept`),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  await post(ronin.client, `/api/friends/requests/${sent.id}/decline`).expect(409);
  assert.equal((await db.query('SELECT status FROM friendships')).rows[0].status, 'accepted');
});

test('a declined request leaves both friends lists empty', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const sent = await sendRequest(miguel, ronin);
  const declined = await post(ronin.client, `/api/friends/requests/${sent.id}/decline`).expect(200);
  assert.equal(declined.body.request.status, 'declined');
  assert.deepEqual(await friendIds(miguel), []);
  assert.deepEqual(await friendIds(ronin), []);
  const lists = (await miguel.client.get('/api/friends/requests').expect(200)).body;
  assert.deepEqual([lists.incoming, lists.outgoing], [[], []]);
  await post(ronin.client, `/api/friends/requests/${sent.id}/accept`).expect(409);
});

test('a declined request can be re-sent and then accepted', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const first = await sendRequest(miguel, ronin);
  await post(ronin.client, `/api/friends/requests/${first.id}/decline`).expect(200);
  const again = await sendRequest(miguel, ronin);
  assert.equal(again.id, first.id);
  assert.equal(again.status, 'pending');
  const { rows: [row] } = await db.query('SELECT * FROM friendships');
  assert.equal(row.responded_at, null);
  await post(ronin.client, `/api/friends/requests/${again.id}/accept`).expect(200);
  assert.deepEqual(await friendIds(miguel), [ronin.id]);
  assert.deepEqual(await friendIds(ronin), [miguel.id]);
});

test('the member who declined can later send a request themselves', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const first = await sendRequest(miguel, ronin);
  await post(ronin.client, `/api/friends/requests/${first.id}/decline`).expect(200);
  const reversed = await sendRequest(ronin, miguel);
  // Ronin is now the requester, so only Miguel can answer.
  await post(ronin.client, `/api/friends/requests/${reversed.id}/accept`).expect(404);
  await post(miguel.client, `/api/friends/requests/${reversed.id}/accept`).expect(200);
  assert.deepEqual(await friendIds(ronin), [miguel.id]);
  assert.equal((await db.query('SELECT * FROM friendships')).rows.length, 1);
});

test('search never returns an email address', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  await member('Ronin', 'ronin@example.com');
  for (const q of ['ro', 'RONIN', 'ronin@example.com', 'Ronin@Example.com']) {
    const res = await miguel.client.get('/api/users/search').query({ q }).expect(200);
    assert.equal(res.body.users.length, 1, q);
    assert.deepEqual(Object.keys(res.body.users[0]).sort(), ['id', 'name', 'relationship']);
    assert.doesNotMatch(res.text, /@/);
  }
});

test('search reports the relationship in each of the four states', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  assert.equal(await relationship(miguel, 'ronin', ronin.id), 'none');
  const sent = await sendRequest(miguel, ronin);
  assert.equal(await relationship(miguel, 'ronin', ronin.id), 'pending_outgoing');
  assert.equal(await relationship(ronin, 'miguel', miguel.id), 'pending_incoming');
  await post(ronin.client, `/api/friends/requests/${sent.id}/accept`).expect(200);
  assert.equal(await relationship(miguel, 'ronin', ronin.id), 'friends');
  assert.equal(await relationship(ronin, 'miguel', miguel.id), 'friends');
});

test('a declined request shows as no relationship in search', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const sent = await sendRequest(miguel, ronin);
  await post(ronin.client, `/api/friends/requests/${sent.id}/decline`).expect(200);
  assert.equal(await relationship(miguel, 'ronin', ronin.id), 'none');
  assert.equal(await relationship(ronin, 'miguel', miguel.id), 'none');
});

test('search excludes the caller and banned members, matches name prefixes only, and caps results', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const banned = await member('Mia', 'mia@example.com');
  await member('Jamie', 'jamie@example.com');
  await db.query("UPDATE users SET account_status = 'banned' WHERE id = $1", [banned.id]);
  const search = async q => (await miguel.client.get('/api/users/search').query({ q }).expect(200)).body.users;
  assert.deepEqual(await search('mi'), []);
  assert.deepEqual(await search('mia@example.com'), []);
  assert.deepEqual(await search('am'), []);
  // Partial emails do not match; only an exact email does.
  assert.deepEqual(await search('jamie@'), []);
  // LIKE wildcards are matched literally.
  assert.deepEqual(await search('%%'), []);
  assert.deepEqual(await search('__'), []);
  await miguel.client.get('/api/users/search').query({ q: 'j' }).expect(400);
  await miguel.client.get('/api/users/search').query({ q: '  j ' }).expect(400);
  await miguel.client.get('/api/users/search').expect(400);
  for (let i = 0; i < 22; i++) {
    await db.query("INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, 'x')", [randomUUID(), `Sam ${i}`, `sam${i}@example.com`]);
  }
  assert.equal((await search('sam')).length, 20);
});

test('banned members disappear from request and friends lists', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  const connor = await member('Connor', 'connor@example.com');
  const sent = await sendRequest(miguel, ronin);
  await post(ronin.client, `/api/friends/requests/${sent.id}/accept`).expect(200);
  await sendRequest(connor, miguel);
  await db.query("UPDATE users SET account_status = 'banned' WHERE id IN ($1, $2)", [ronin.id, connor.id]);
  assert.deepEqual(await friendIds(miguel), []);
  assert.deepEqual((await miguel.client.get('/api/friends/requests').expect(200)).body.incoming, []);
});

test('every friendship endpoint requires a session', async () => {
  const id = randomUUID();
  await request(app).get('/api/users/search').query({ q: 'ronin' }).expect(401);
  await request(app).get('/api/friends/requests').expect(401);
  await request(app).get('/api/friends').expect(401);
  await post(request(app), '/api/friends/requests').send({ addresseeId: id }).expect(401);
  await post(request(app), `/api/friends/requests/${id}/accept`).expect(401);
  await post(request(app), `/api/friends/requests/${id}/decline`).expect(401);
});

test('state-changing friendship calls require the Stake request header', async () => {
  const miguel = await member('Miguel', 'miguel@example.com');
  const ronin = await member('Ronin', 'ronin@example.com');
  await miguel.client.post('/api/friends/requests').send({ addresseeId: ronin.id }).expect(403);
  const sent = await sendRequest(miguel, ronin);
  await ronin.client.post(`/api/friends/requests/${sent.id}/accept`).expect(403);
  await ronin.client.post(`/api/friends/requests/${sent.id}/decline`).expect(403);
  assert.equal((await db.query('SELECT status FROM friendships')).rows[0].status, 'pending');
});
