import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { volumeLitres, capacityLitres, publicCalibration } from '../calibration.js';

export const collections = { users: 'users', devices: 'devices', oauth: 'oauth' };
export const ACCESS_MS = 60 * 60 * 1000;
export const REFRESH_MS = 90 * 24 * 60 * 60 * 1000;
export const CODE_MS = 5 * 60 * 1000;
export const STALE_MS = 3 * 60 * 1000;
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireThat(condition, status, code) {
  if (!condition) throw new HttpError(status, code);
}
export function level(distanceMm, calibration) {
  if (distanceMm === null || !calibration?.confirmed) return null;
  const { emptyMm, fullMm } = calibration;
  if (!(emptyMm > fullMm && fullMm >= 30 && emptyMm <= 4500)) return null;
  return Math.round(Math.max(0, Math.min(100, 100 * (emptyMm - distanceMm) / (emptyMm - fullMm))) * 10) / 10;
}
export function reading(device, now) {
  const sample = device.sample;
  const connected = !!sample && now >= sample.receivedAtMs && now - sample.receivedAtMs < STALE_MS;
  const percent = connected ? level(sample.distanceMm, device.calibration) : null;
  let reason = 'ok';
  if (!connected) reason = sample ? 'stale' : 'no_upload';
  else if (sample.distanceMm === null) reason = 'sensor_unavailable';
  else if (!device.calibration?.confirmed || percent === null) reason = 'calibration_required';
  return {
    id: device.id, name: device.name, room: device.room,
    connected, source: sample?.source ?? null, reason,
    distanceMm: connected ? sample.distanceMm : null,
    levelPercent: percent, lastSeen: sample ? new Date(sample.receivedAtMs).toISOString() : null,
    volumeLitres: connected ? volumeLitres(sample.distanceMm, device.calibration) : null,
    capacityLitres: capacityLitres(device.calibration), calibration: publicCalibration(device.calibration),
  };
}
export function googleState(device, now) {
  const value = reading(device, now);
  // Google documents humidityAmbientPercent as integer 1..100. Never invent 1% for an empty tank.
  if (!device.enabled || !value.connected || value.source !== 'sensor' || value.levelPercent === null || Math.round(value.levelPercent) < 1) {
    return { online: false };
  }
  return { online: true, humidityAmbientPercent: Math.round(value.levelPercent) };
}
export function googleDevice(device) {
  return {
    id: device.id, type: 'action.devices.types.SENSOR',
    traits: ['action.devices.traits.HumiditySetting'],
    name: { name: device.name }, roomHint: device.room,
    willReportState: true, attributes: { queryOnlyHumiditySetting: true },
    deviceInfo: { manufacturer: 'DIY', model: 'Terrace Tank level proxy', swVersion: '1.0' },
  };
}
