import express from 'express';
import { z } from 'zod';
import { makeOAuth } from './oauth.js';
import { signInPage } from './signin.js';
import { hash, equal, requireThat, HttpError, reading, googleState, googleDevice } from './domain.js';
import { randomUUID } from 'node:crypto';
import { calibrationSchema, publicCalibration } from '../calibration.js';
import { dayKey, recordObservation, historyResponse } from './history.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const telemetry = z.object({
  distanceMm: z.number().int().min(30).max(4500).nullable(),
  source: z.enum(['sensor', 'simulated']),
  bootId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const intentSchema = z.object({
  requestId: z.string().min(1).max(256),
  inputs: z.array(z.object({ intent: z.enum(['action.devices.SYNC', 'action.devices.QUERY', 'action.devices.EXECUTE', 'action.devices.DISCONNECT']), payload: z.unknown().optional() })).length(1),
});
const querySchema = z.object({ devices: z.array(z.object({ id: identifier })).max(100) });
function bearer(req) {
  const match = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/i.exec(req.get('authorization') ?? '');
  requireThat(match, 401, 'unauthorized'); return match[1];
}

export function createApp({ db, config, verifyIdToken, reportDevice = async () => {}, now = Date.now, logError = console.error }) {
  const app = express();
  const oauth = makeOAuth(db, config, now);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=31536000' }); next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 }));
  const idUser = async req => {
    let identity;
    try { identity = await verifyIdToken(bearer(req)); } catch { throw new HttpError(401, 'unauthorized'); }
    requireThat((await db.collection('users').doc(identity.uid).get()).data()?.enabled === true, 403, 'account_not_provisioned');
    return identity.uid;
  };
  app.get('/health', (_req, res) => res.json({ service: 'terrace-tank', status: 'ok', version: 1 }));
  // This dashboard intentionally publishes only Terrace Tank's reading and
  // physical calibration. It excludes owner IDs, credentials and OAuth state.
  app.get('/v1/tank', async (_req, res) => {
    const id = 'terrace-tank';
    const device = (await db.collection('devices').doc(id).get()).data();
    requireThat(device?.enabled === true, 404, 'tank_not_configured');
    res.json({ tank: reading({ ...device, id }, now()) });
  });
  app.get('/v1/tank/history', async (_req, res) => {
    const ref = db.collection('devices').doc('terrace-tank');
    requireThat((await ref.get()).data()?.enabled === true, 404, 'tank_not_configured');
    const time = now();
    const docs = await ref.collection('days').where('day', '>=', dayKey(time - 6 * 86_400_000)).orderBy('day').limit(7).get();
    res.set('Cache-Control', 'public, max-age=0, s-maxage=300').json(historyResponse(docs.docs.map(doc => doc.data()), time));
  });
  app.put('/v1/tank/calibration', async (req, res) => {
    requireThat(config.adminKey?.length >= 32, 503, 'calibration_owner_key_not_configured');
    requireThat(equal(bearer(req), config.adminKey), 401, 'unauthorized');
    const calibration = { ...calibrationSchema.parse(req.body), revision: randomUUID() };
    const ref = db.collection('devices').doc('terrace-tank');
    await db.runTransaction(async tx => {
      requireThat((await tx.get(ref)).data()?.enabled === true, 404, 'tank_not_configured');
      tx.update(ref, { calibration, usageAnchor: null });
    });
    res.json({ calibration: publicCalibration(calibration) });
  });
  app.get('/v1/devices/:id/calibration', async (req, res) => {
    const id = identifier.parse(req.params.id);
    const token = bearer(req);
    const device = (await db.collection('devices').doc(id).get()).data();
    requireThat(device?.enabled === true && equal(hash(token), device.credentialHash), 401, 'unauthorized');
    res.json({ calibration: publicCalibration(device.calibration) });
  });
  app.use(['/oauth', '/google'], (_req, _res, next) => {
    requireThat(config.clientSecret?.length >= 32 && !!config.webApiKey, 503, 'google_home_not_configured');
    next();
  });
  app.get('/oauth/authorize', (req, res) => {
    oauth.validateRequest(req.query);
    requireThat(config.webApiKey, 503, 'sign_in_not_configured');
    const page = signInPage(config.webApiKey, req.query);
    res.set('Content-Security-Policy', page.csp).type('html').send(page.html);
  });
  app.post('/oauth/authorize', async (req, res) => {
    oauth.validateRequest(req.body);
    res.json({ redirect: await oauth.authorize(await idUser(req), req.body) });
  });
  app.post('/oauth/token', async (req, res) => res.json(await oauth.exchange(req.body ?? {}, req.get('authorization'))));

  app.post('/v1/devices/:id/readings', async (req, res) => {
    const id = identifier.parse(req.params.id);
    const input = telemetry.parse(req.body);
    const token = bearer(req);
    requireThat(token.length >= 32 && token.length <= 256, 401, 'unauthorized');
    const ref = db.collection('devices').doc(id);
    const accepted = await db.runTransaction(async tx => {
      const device = (await tx.get(ref)).data();
      requireThat(device?.enabled === true && equal(hash(token), device.credentialHash), 401, 'unauthorized');
      requireThat(input.source !== 'simulated' || device.allowSimulation === true, 403, 'simulation_disabled');
      const sample = device.sample;
      if (sample?.bootId === input.bootId && input.sequence === sample.sequence) {
        requireThat(input.distanceMm === sample.distanceMm && input.source === sample.source, 409, 'sequence_conflict');
        return { device: { ...device, id }, duplicate: true };
      }
      requireThat(!sample || sample.bootId !== input.bootId || input.sequence > sample.sequence, 409, 'out_of_order');
      requireThat(!device.retiredBootIds?.includes(input.bootId), 409, 'retired_boot');
      const retiredBootIds = sample && sample.bootId !== input.bootId
        ? [...(device.retiredBootIds ?? []), sample.bootId].slice(-16)
        : device.retiredBootIds ?? [];
      requireThat(!sample || now() - sample.receivedAtMs >= 10_000, 429, 'upload_too_frequent');
      const updated = { sample: { ...input, receivedAtMs: now() }, retiredBootIds };
      const dayRef = ref.collection('days').doc(dayKey(updated.sample.receivedAtMs));
      const observation = recordObservation(device, input, updated.sample.receivedAtMs, (await tx.get(dayRef)).data());
      tx.update(ref, { ...updated, usageAnchor: observation.anchor });
      tx.set(dayRef, observation.day);
      return { device: { ...device, ...updated, id }, duplicate: false };
    });
    // Reporting failure must not discard accepted telemetry; the sweep retries it.
    try { await reportDevice(id); } catch (error) { logError('homegraph_report_failed', { deviceId: id, code: error.code ?? 'report_error' }); }
    res.status(accepted.duplicate ? 200 : 202).json({ ...reading(accepted.device, now()), duplicate: accepted.duplicate });
  });
  app.get('/v1/devices', async (req, res) => {
    const uid = await idUser(req);
    const docs = await db.collection('devices').where('ownerUid', '==', uid).get();
    res.json({ devices: docs.docs.filter(doc => doc.data().enabled).map(doc => reading({ ...doc.data(), id: doc.id }, now())) });
  });

  app.post('/google/fulfillment', async (req, res) => {
    const uid = await oauth.authenticate(bearer(req));
    const request = intentSchema.parse(req.body);
    const input = request.inputs[0];
    const response = payload => res.json({ requestId: request.requestId, payload });
    if (input.intent === 'action.devices.DISCONNECT') {
      await oauth.disconnect(uid); return res.status(200).end();
    }
    if (input.intent === 'action.devices.SYNC') {
      const docs = await db.collection('devices').where('ownerUid', '==', uid).get();
      await db.collection('users').doc(uid).update({ googleSynced: true });
      return response({ agentUserId: uid, devices: docs.docs.filter(doc => doc.data().enabled && doc.data().googleEnabled).map(doc => googleDevice({ ...doc.data(), id: doc.id })) });
    }
    if (input.intent === 'action.devices.QUERY') {
      const query = querySchema.parse(input.payload);
      const pairs = await Promise.all(query.devices.map(async ({ id }) => {
        const device = (await db.collection('devices').doc(id).get()).data();
        if (!device || device.ownerUid !== uid || !device.enabled || !device.googleEnabled) return [id, { online: false, status: 'ERROR', errorCode: 'deviceNotFound' }];
        const state = googleState({ ...device, id }, now());
        return [id, { ...state, status: state.online ? 'SUCCESS' : 'OFFLINE' }];
      }));
      return response({ devices: Object.fromEntries(pairs) });
    }
    return response({ errorCode: 'functionNotSupported' });
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'invalid_request' });
    if (error instanceof HttpError) {
      if (error.status === 429) res.set('Retry-After', '10');
      if (error.status === 401) res.set('WWW-Authenticate', 'Bearer');
      return res.status(error.status).json({ error: error.code });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'request_too_large' });
    if (error.type === 'entity.parse.failed' || error instanceof URIError) return res.status(400).json({ error: 'invalid_request' });
    logError('request_failed', { code: error.code ?? 'internal' });
    return res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
