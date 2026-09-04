import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from './app.js';
import { makeReporter } from './reporting.js';
import { dayKey, HISTORY_DAYS } from './history.js';

let cached;
export function backendConfigured() {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
}
export function googleHomeConfigured() {
  return backendConfigured() && !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY && process.env.TANK_OAUTH_CLIENT_SECRET?.length >= 32;
}
export function calibrationWriteConfigured() {
  return backendConfigured() && process.env.TANK_ADMIN_KEY?.length >= 32;
}
export function getBackend() {
  if (cached) return cached;
  if (!backendConfigured()) throw new Error('backend_not_configured');
  const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'homeintegrations-43740';
  if (credentials.project_id !== projectId) throw new Error('service_account_project_mismatch');
  const admin = getApps().find(app => app.name === 'terrace-tank-next') ?? initializeApp({ credential: cert(credentials), projectId }, 'terrace-tank-next');
  // Spark's no-cost database is the default database. Named databases need billing.
  const db = getFirestore(admin);
  const reportDevice = makeReporter(db, Date.now, undefined, credentials);
  const app = createApp({ db, config: {
    projectId, clientId: process.env.TANK_OAUTH_CLIENT_ID ?? 'terrace-tank-google-home',
    clientSecret: process.env.TANK_OAUTH_CLIENT_SECRET,
    webApiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    adminKey: process.env.TANK_ADMIN_KEY,
  }, verifyIdToken: token => getAuth(admin).verifyIdToken(token, true), reportDevice,
  logError: (message, fields) => console.error(message, fields) });
  cached = { app, db, reportDevice }; return cached;
}
export async function maintainBackend() {
  const { db, reportDevice } = getBackend();
  const devices = await db.collection('devices').limit(100).get();
  let reported = 0, failed = 0;
  for (const doc of devices.docs) {
    try { await reportDevice(doc.id); reported++; } catch { failed++; }
    const old = await doc.ref.collection('days').where('day', '<', dayKey(Date.now() - HISTORY_DAYS * 86_400_000)).limit(100).get();
    if (!old.empty) { const batch = db.batch(); for (const day of old.docs) batch.delete(day.ref); await batch.commit(); }
  }
  const expired = await db.collection('oauth').where('expiresAt', '<=', new Date()).limit(400).get();
  if (!expired.empty) { const batch = db.batch(); for (const doc of expired.docs) batch.delete(doc.ref); await batch.commit(); }
  return { checked: reported, failed, expiredTokensRemoved: expired.size };
}
