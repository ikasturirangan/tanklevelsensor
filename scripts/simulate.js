import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, credentials: { type: 'string' },
  'distance-mm': { type: 'string' }, missing: { type: 'boolean', default: false },
} });
if (!values.endpoint || !values.credentials || (!values.missing && !values['distance-mm'])) throw new Error('Usage: npm run simulate -- --endpoint BASE_URL --credentials PRIVATE_FILE --distance-mm 850 (or --missing)');
const url = new URL(values.endpoint);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS, except on localhost.');
if (url.username || url.password) throw new Error('Do not embed credentials in URLs.');
const distanceMm = values.missing ? null : Number(values['distance-mm']);
if (distanceMm !== null && !(Number.isInteger(distanceMm) && distanceMm >= 30 && distanceMm <= 4500)) throw new Error('Distance must be 30..4500 mm.');
const config = JSON.parse(await readFile(values.credentials, 'utf8'));
const response = await fetch(`${url.href.replace(/\/$/, '')}/v1/devices/${encodeURIComponent(config.deviceId)}/readings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
  // The simulator always labels its data. It cannot impersonate an attached sensor.
  body: JSON.stringify({ distanceMm, source: 'simulated', bootId: randomUUID(), sequence: 0 }),
  redirect: 'error', signal: AbortSignal.timeout(15000),
});
console.log(JSON.stringify({ httpStatus: response.status, reading: await response.json() }, null, 2));
if (!response.ok) process.exitCode = 1;
