import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from '../lib/server/app.js';
import { makeReporter } from '../lib/server/reporting.js';
import { hash, secret, googleState, reading, STALE_MS, CODE_MS, ACCESS_MS, REFRESH_MS } from '../lib/server/domain.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-terrace-tank';
const config = { projectId, clientId: 'test-client', clientSecret: secret(), webApiKey: 'test-public-key', adminKey: secret() };
const redirect = `https://oauth-redirect.googleusercontent.com/r/${projectId}`;
const authorization = { client_id: config.clientId, redirect_uri: redirect, response_type: 'code', state: 'state-with-&?=symbols', scope: 'devices' };
let admin, db, app, clock, credential;
const now = () => clock;
const snapshot = (distanceMm = 850, source = 'sensor', sequence = 1, bootId = 'boot-one') => ({ distanceMm, source, sequence, bootId });
const callGoogle = (token, intent, payload) => request(app).post('/google/fulfillment').auth(token, { type: 'bearer' }).send({ requestId: 'request-1', inputs: [{ intent: `action.devices.${intent}`, ...(payload ? { payload } : {}) }] });
const upload = (body, token = credential, id = 'terrace-tank') => request(app).post(`/v1/devices/${id}/readings`).auth(token, { type: 'bearer' }).send(body);
async function code() {
  const result = await request(app).post('/oauth/authorize').auth('alice-id-token', { type: 'bearer' }).send(authorization).expect(200);
  const location = new URL(result.body.redirect);
  assert.equal(location.searchParams.get('state'), authorization.state);
  return location.searchParams.get('code');
}
const exchange = value => request(app).post('/oauth/token').type('form').send({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code: value, redirect_uri: redirect });
const refresh = value => request(app).post('/oauth/token').type('form').send({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: value });
const link = async () => (await exchange(await code()).expect(200)).body;

before(async () => {
  if (!emulator) return;
  assert.match(emulator, /^(127\.0\.0\.1|localhost):\d+$/, 'tests must use a local emulator');
  admin = initializeApp({ projectId }); db = getFirestore(admin);
});
beforeEach(async () => {
  if (!emulator) return;
  clock = Date.parse('2026-09-04T12:00:00Z'); credential = secret();
  for (const collection of ['users', 'devices', 'oauth']) await db.recursiveDelete(db.collection(collection));
  await db.collection('users').doc('alice').set({ enabled: true, linkVersion: secret(), googleLinked: false, googleSynced: false });
  await db.collection('users').doc('bob').set({ enabled: true, linkVersion: secret(), googleLinked: false, googleSynced: false });
  const base = { enabled: true, googleEnabled: true, allowSimulation: false, name: 'Terrace Tank', room: 'Attic', calibration: { emptyMm: 1500, fullMm: 200, confirmed: true } };
  await db.collection('devices').doc('terrace-tank').set({ ...base, ownerUid: 'alice', credentialHash: hash(credential) });
  await db.collection('devices').doc('private-tank').set({ ...base, ownerUid: 'bob', credentialHash: hash(secret()) });
  app = createApp({ db, config, now, verifyIdToken: async token => {
    if (token !== 'alice-id-token' && token !== 'bob-id-token') throw new Error('bad identity');
    return { uid: token.startsWith('alice') ? 'alice' : 'bob' };
  }, logError: () => {} });
});
after(async () => { if (db) await db.terminate(); if (admin) await deleteApp(admin); });
const integration = (name, fn) => test(name, { skip: !emulator && 'Run npm run test:emulator for Firestore integration tests' }, fn);

test('true percentage, missing sensor, stale data, simulation and zero remain distinguishable', () => {
  const t = 1000000;
  const device = { enabled: true, calibration: { emptyMm: 1500, fullMm: 200, confirmed: true }, sample: { distanceMm: 850, receivedAtMs: t, source: 'sensor' } };
  assert.equal(reading(device, t).levelPercent, 50);
  assert.deepEqual(googleState(device, t), { online: true, humidityAmbientPercent: 50 });
  assert.equal(reading(device, t + STALE_MS).reason, 'stale');
  assert.deepEqual(googleState(device, t + STALE_MS), { online: false });
  device.sample.distanceMm = 1500;
  assert.equal(reading(device, t).levelPercent, 0);
  assert.deepEqual(googleState(device, t), { online: false });
  device.sample.distanceMm = null;
  assert.equal(reading(device, t).reason, 'sensor_unavailable');
  device.sample.distanceMm = 850; device.sample.source = 'simulated';
  assert.equal(reading(device, t).levelPercent, 50);
  assert.deepEqual(googleState(device, t), { online: false });
  device.calibration.confirmed = false;
  assert.equal(reading(device, t).reason, 'calibration_required');
});

integration('HTTP uploads authenticate per device, validate data and expose no credentials', async () => {
  await upload(snapshot(), secret()).expect(401);
  await upload(snapshot(), credential, 'private-tank').expect(401);
  await upload(snapshot(-1)).expect(400);
  await upload({ ...snapshot(), ownerUid: 'bob' }).expect(400);
  await upload(snapshot(850, 'simulated')).expect(403);
  const result = await upload(snapshot()).expect(202);
  assert.equal(result.body.levelPercent, 50);
  assert.equal(result.body.name, 'Terrace Tank');
  const own = await request(app).get('/v1/devices').auth('alice-id-token', { type: 'bearer' }).expect(200);
  assert.equal(own.body.devices.length, 1);
  assert.equal(JSON.stringify(own.body).includes('credentialHash'), false);
  await request(app).get('/v1/devices').expect(401);
});
integration('duplicate retries do not refresh stale data, and ordering and rate limits are enforced', async () => {
  const first = await upload(snapshot()).expect(202);
  clock += 1000;
  await upload(snapshot(750, 'sensor', 2)).expect(429);
  await upload(snapshot(750)).expect(409);
  clock += STALE_MS;
  const retry = await upload(snapshot()).expect(200);
  assert.equal(retry.body.lastSeen, first.body.lastSeen);
  assert.equal(retry.body.reason, 'stale');
  await upload(snapshot(750, 'sensor', 2)).expect(202);
  await upload(snapshot()).expect(409);
  clock += 10000;
  await upload(snapshot(750, 'sensor', 0, 'boot-two')).expect(202);
  clock += 10000;
  await upload(snapshot(750, 'sensor', 3)).expect(409);
});
integration('public dashboard exposes only Terrace Tank readings and never grants write access', async () => {
  await upload(snapshot()).expect(202);
  const result = await request(app).get('/v1/tank').expect(200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.tank.id, 'terrace-tank');
  assert.equal(result.body.tank.levelPercent, 50);
  assert.deepEqual(Object.keys(result.body.tank).sort(), ['connected', 'distanceMm', 'id', 'lastSeen', 'levelPercent', 'name', 'reason', 'room', 'source', 'volumeLitres', 'capacityLitres', 'calibration'].sort());
  await request(app).get('/v1/tank/private-tank').expect(404);
  await request(app).get('/v1/devices').expect(401);
  await request(app).post('/v1/tank').send({ levelPercent: 100 }).expect(404);
  await request(app).post('/v1/devices/terrace-tank/readings').send(snapshot()).expect(401);
  clock += STALE_MS;
  const stale = await request(app).get('/v1/tank').expect(200);
  assert.equal(stale.body.tank.levelPercent, null);
  assert.equal(stale.body.tank.reason, 'stale');
});
integration('public dashboard handles missing and disabled tanks without exposing another tank', async () => {
  const initial = await request(app).get('/v1/tank').expect(200);
  assert.equal(initial.body.tank.levelPercent, null);
  assert.equal(initial.body.tank.reason, 'no_upload');
  const ref = db.collection('devices').doc('terrace-tank');
  await ref.update({ enabled: false });
  await request(app).get('/v1/tank').expect(404);
  await ref.delete();
  await request(app).get('/v1/tank').expect(404);
});
integration('public readings and authenticated uploads work before Google account linking is configured', async () => {
  const publicApp = createApp({ db, config: { projectId }, now, verifyIdToken: async () => { throw new Error('not configured'); }, logError: () => {} });
  await request(publicApp).post('/v1/devices/terrace-tank/readings').auth(credential, { type: 'bearer' }).send(snapshot()).expect(202);
  assert.equal((await request(publicApp).get('/v1/tank').expect(200)).body.tank.levelPercent, 50);
  await request(publicApp).get('/v1/devices').expect(401);
  await request(publicApp).get('/oauth/authorize').query(authorization).expect(503);
  await request(publicApp).post('/oauth/token').send({}).expect(503);
  await request(publicApp).post('/google/fulfillment').send({}).expect(503);
});
integration('OAuth rejects untrusted redirects, unauthorized consent and invalid clients', async () => {
  await request(app).get('/oauth/authorize').query({ ...authorization, redirect_uri: 'https://attacker.example/r' }).expect(400);
  await request(app).post('/oauth/authorize').send(authorization).expect(401);
  const page = await request(app).get('/oauth/authorize').query(authorization).expect(200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  const value = await code();
  await request(app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: value, client_id: config.clientId, client_secret: 'wrong', redirect_uri: redirect }).expect(401);
  await request(app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: value, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: 'https://attacker.example' }).expect(400);
  await exchange(value).expect(200);
});
integration('authorization codes are single-use even with concurrent exchanges, stored credentials are hashed', async () => {
  const value = await code();
  const results = await Promise.all([exchange(value), exchange(value)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 400]);
  const tokens = results.find(x => x.status === 200).body;
  const records = await db.collection('oauth').get();
  assert.equal(records.size, 2);
  for (const doc of records.docs) {
    assert.match(doc.id, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(doc.data()).includes(tokens.access_token), false);
    assert.equal(JSON.stringify(doc.data()).includes(tokens.refresh_token), false);
  }
});
integration('OAuth code/access/refresh expiry and DISCONNECT revocation work', async () => {
  const expiredCode = await code(); clock += CODE_MS;
  await exchange(expiredCode).expect(400);
  const tokens = await link();
  await callGoogle(tokens.access_token, 'SYNC').expect(200);
  clock += ACCESS_MS;
  await callGoogle(tokens.access_token, 'SYNC').expect(401);
  const renewed = await refresh(tokens.refresh_token).expect(200);
  const pendingCode = await code();
  await callGoogle(renewed.body.access_token, 'DISCONNECT').expect(200);
  await callGoogle(renewed.body.access_token, 'SYNC').expect(401);
  await refresh(tokens.refresh_token).expect(400);
  await exchange(pendingCode).expect(400);
  const fresh = await link(); clock += REFRESH_MS;
  await refresh(fresh.refresh_token).expect(400);
});
integration('Google SYNC and QUERY isolate owners and represent unavailable data honestly', async () => {
  const tokens = await link();
  const sync = await callGoogle(tokens.access_token, 'SYNC').expect(200);
  assert.equal(sync.body.payload.agentUserId, 'alice');
  assert.equal(sync.body.payload.devices.length, 1);
  assert.equal(sync.body.payload.devices[0].attributes.queryOnlyHumiditySetting, true);
  const query = () => callGoogle(tokens.access_token, 'QUERY', { devices: [{ id: 'terrace-tank' }, { id: 'private-tank' }] });
  let states = (await query().expect(200)).body.payload.devices;
  assert.equal(states['terrace-tank'].status, 'OFFLINE');
  assert.equal(states['private-tank'].errorCode, 'deviceNotFound');
  await upload(snapshot()).expect(202);
  states = (await query().expect(200)).body.payload.devices;
  assert.equal(states['terrace-tank'].humidityAmbientPercent, 50);
  clock += STALE_MS;
  states = (await query().expect(200)).body.payload.devices;
  assert.equal(states['terrace-tank'].online, false);
  assert.equal('humidityAmbientPercent' in states['terrace-tank'], false);
  const execute = await callGoogle(tokens.access_token, 'EXECUTE', {}).expect(200);
  assert.equal(execute.body.payload.errorCode, 'functionNotSupported');
});
integration('Report State retries failures, reports stale/offline, and stops after unlinking', async () => {
  const sent = []; let failing = true;
  const report = makeReporter(db, now, async body => { if (failing) throw new Error('temporary failure'); sent.push(body); });
  const tokens = await link(); await callGoogle(tokens.access_token, 'SYNC').expect(200);
  await upload(snapshot()).expect(202);
  await assert.rejects(report('terrace-tank'));
  assert.equal((await db.collection('devices').doc('terrace-tank').get()).data().lastReport, undefined);
  failing = false; await report('terrace-tank'); await report('terrace-tank');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.devices.states['terrace-tank'].humidityAmbientPercent, 50);
  clock += STALE_MS; await report('terrace-tank');
  assert.deepEqual(sent[1].payload.devices.states['terrace-tank'], { online: false });
  await callGoogle(tokens.access_token, 'DISCONNECT').expect(200);
  clock += 3600000; await report('terrace-tank'); assert.equal(sent.length, 2);
});
integration('Firestore rules block unauthenticated direct reads and writes', async () => {
  const url = `http://${emulator}/v1/projects/${projectId}/databases/(default)/documents/devices/terrace-tank`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { enabled: { booleanValue: false } } }) })).status, 403);
});

const dimensions = { shape: 'capacity_estimate', capacityLitres: 1000, emptyMm: 1500, fullMm: 200, noiseMm: 10, confirmed: true };
const calibrate = (body = dimensions, key = config.adminKey) => request(app).put('/v1/tank/calibration').auth(key, { type: 'bearer' }).send(body);
integration('only the owner can save dimensions; public viewers and upload credentials cannot', async () => {
  await request(app).put('/v1/tank/calibration').send(dimensions).expect(401);
  await calibrate(dimensions, credential).expect(401);
  await calibrate({ ...dimensions, fullMm: 1501 }).expect(400);
  const saved = await calibrate().expect(200);
  assert.ok(saved.body.calibration.revision);
  await upload(snapshot()).expect(202);
  const read = await request(app).get('/v1/tank').expect(200);
  assert.equal(read.body.tank.volumeLitres, 500);
  assert.equal(read.body.tank.capacityLitres, 1000);
  assert.equal(JSON.stringify(read.body).includes(config.adminKey), false);
  await request(app).get('/v1/devices/terrace-tank/calibration').expect(401);
  const node = await request(app).get('/v1/devices/terrace-tank/calibration').auth(credential, { type: 'bearer' }).expect(200);
  assert.equal(node.body.calibration.revision, saved.body.calibration.revision);
});
integration('history records each accepted upload once and separates refills from use', async () => {
  await calibrate().expect(200);
  await upload(snapshot(850)).expect(202);
  clock += 60000;
  const result = await upload(snapshot(980, 'sensor', 2)).expect(202);
  assert.equal(result.body.volumeLitres, 400);
  await upload(snapshot(980, 'sensor', 2)).expect(200);
  clock += 60000;
  await upload(snapshot(720, 'sensor', 3)).expect(202);
  const history = await request(app).get('/v1/tank/history').expect(200);
  const today = history.body.days.at(-1);
  assert.equal(today.usedLitres, 100);
  assert.equal(today.addedLitres, 200);
  assert.equal(today.coverageSeconds, 120);
  assert.equal(history.body.timeZone, 'Asia/Kolkata');
  assert.equal(history.headers['cache-control'], 'public, max-age=0, s-maxage=300');
  const days = await db.collection('devices').doc('terrace-tank').collection('days').get();
  assert.equal(days.docs[0].data().samples, 3);
  assert.equal(JSON.stringify(history.body).includes('ownerUid'), false);
});
integration('recalibration preserves totals and does not turn scale changes into water use', async () => {
  await calibrate().expect(200);
  await upload(snapshot(850)).expect(202);
  clock += 60000; await upload(snapshot(980, 'sensor', 2)).expect(202);
  await calibrate({ ...dimensions, capacityLitres: 2000 }).expect(200);
  clock += 60000; await upload(snapshot(980, 'sensor', 3)).expect(202);
  const history = await request(app).get('/v1/tank/history').expect(200);
  assert.equal(history.body.days.at(-1).usedLitres, 100);
  const latest = await request(app).get('/v1/tank').expect(200);
  assert.equal(latest.body.tank.volumeLitres, 800);
});
