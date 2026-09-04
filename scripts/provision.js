import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { parseArgs } from 'node:util';
import { writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { secret, hash } from '../lib/server/domain.js';

const { values } = parseArgs({ options: {
  project: { type: 'string', default: 'homeintegrations-43740' },
  uid: { type: 'string' }, id: { type: 'string', default: 'terrace-tank' },
  credentials: { type: 'string' }, 'allow-simulation': { type: 'boolean', default: false },
  'empty-mm': { type: 'string' }, 'full-mm': { type: 'string' },
} });
if (!values.uid || !values.credentials || !/^[A-Za-z0-9_-]{1,64}$/.test(values.id)) {
  throw new Error('Usage: npm run provision -- --uid FIREBASE_AUTH_UID --credentials /absolute/private/path/tank.credentials.json [--empty-mm 1500 --full-mm 200] [--allow-simulation]');
}
const calibrated = values['empty-mm'] !== undefined && values['full-mm'] !== undefined;
if ((values['empty-mm'] === undefined) !== (values['full-mm'] === undefined)) throw new Error('Supply both calibration measurements or neither.');
const emptyMm = Number(values['empty-mm'] ?? 1500), fullMm = Number(values['full-mm'] ?? 200);
if (!(Number.isInteger(emptyMm) && Number.isInteger(fullMm) && fullMm >= 30 && emptyMm > fullMm && emptyMm <= 4500)) throw new Error('Calibration must satisfy 30 <= full < empty <= 4500 mm.');
const admin = initializeApp({ projectId: values.project, ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault() }) });
const db = getFirestore(admin);
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  const account = await getAuth(admin).getUser(values.uid);
  if (account.disabled) throw new Error('The Firebase Auth account is disabled.');
}
const path = resolve(values.credentials);
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const handle = await open(path, 'wx', 0o600); // Never overwrite an existing device credential.
const credential = secret();
await handle.writeFile(JSON.stringify({ projectId: values.project, deviceId: values.id, token: credential }, null, 2) + '\n');
await handle.close();
try {
  await db.runTransaction(async tx => {
    const deviceRef = db.collection('devices').doc(values.id);
    const userRef = db.collection('users').doc(values.uid);
    const [device, user] = await Promise.all([tx.get(deviceRef), tx.get(userRef)]);
    if (device.exists) throw new Error('Device already exists; provision a new ID or rotate its credential separately.');
    if (!user.exists) tx.create(userRef, { enabled: true, linkVersion: secret(), googleLinked: false, googleSynced: false });
    tx.create(deviceRef, {
      ownerUid: values.uid, name: 'Terrace Tank', room: 'Attic', enabled: true,
      credentialHash: hash(credential), googleEnabled: true, allowSimulation: values['allow-simulation'],
      calibration: { emptyMm, fullMm, confirmed: calibrated }, createdAt: new Date(),
    });
  });
  console.log(`Provisioned ${values.id}. Private credential saved to ${path}. Calibration ${calibrated ? 'confirmed' : 'required before publishing a percentage'}.`);
} catch (error) { await unlink(path); throw error; }
finally { await db.terminate(); }
