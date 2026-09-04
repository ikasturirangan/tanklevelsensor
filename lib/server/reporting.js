import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { googleState } from './domain.js';

export function makeReporter(db, now = Date.now, deliver, credentials) {
  const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/homegraph'] });
  const send = deliver ?? (async body => {
    const client = await auth.getClient();
    await client.request({ url: 'https://homegraph.googleapis.com/v1/devices:reportStateAndNotification', method: 'POST', data: body, timeout: 8000 });
  });
  return async id => {
    const ref = db.collection('devices').doc(id);
    const device = (await ref.get()).data();
    if (!device?.googleEnabled || !device.enabled) return;
    const user = (await db.collection('users').doc(device.ownerUid).get()).data();
    if (!user?.enabled || !user.googleLinked || !user.googleSynced) return;
    const state = googleState({ ...device, id }, now());
    const key = JSON.stringify(state);
    if (device.lastReport?.key === key && device.lastReport?.linkVersion === user.linkVersion && now() - device.lastReport.atMs < 60 * 60 * 1000) return;
    const lease = randomUUID();
    const acquired = await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current.reportLease?.untilMs > now()) return false;
      tx.update(ref, { reportLease: { id: lease, untilMs: now() + 30_000 } }); return true;
    });
    if (!acquired) return;
    try {
      const latest = (await ref.get()).data();
      const linked = (await db.collection('users').doc(device.ownerUid).get()).data();
      if (!latest.enabled || !latest.googleEnabled || !linked?.enabled || !linked.googleLinked || !linked.googleSynced || linked.linkVersion !== user.linkVersion) return;
      const latestState = googleState({ ...latest, id }, now());
      await send({ requestId: randomUUID(), agentUserId: device.ownerUid, payload: { devices: { states: { [id]: latestState } } } });
      await ref.update({ lastReport: { key: JSON.stringify(latestState), atMs: now(), linkVersion: user.linkVersion } });
    } finally {
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.reportLease?.id === lease) tx.update(ref, { reportLease: null });
      });
    }
  };
}
