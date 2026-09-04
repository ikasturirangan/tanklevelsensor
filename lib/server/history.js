import { volumeLitres, publicCalibration } from '../calibration.js';
import { STALE_MS } from './domain.js';

export const HISTORY_DAYS = 90;
export const TIME_ZONE = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
export const dayKey = time => new Date(time + 19_800_000).toISOString().slice(0, 10);
const round = value => Math.round(value * 1000) / 1000;

// Called inside the upload transaction. Retries never add a second observation.
export function recordObservation(device, input, now, previousDay) {
  const day = dayKey(now);
  const local = new Date(now + 19_800_000);
  const hour = String(local.getUTCHours());
  const slot = String(local.getUTCHours() * 12 + Math.floor(local.getUTCMinutes() / 5));
  const calibration = publicCalibration(device.calibration);
  const litres = input.source === 'sensor' ? volumeLitres(input.distanceMm, calibration) : null;
  const prior = device.usageAnchor;
  const comparable = litres !== null && prior && prior.revision === calibration.revision && now >= prior.lastSeenMs && now - prior.lastSeenMs < STALE_MS;
  let used = 0, added = 0;
  let anchor = litres === null ? null : { distanceMm: input.distanceMm, litres, revision: calibration.revision, lastSeenMs: now };
  if (comparable) {
    // Compare against the last significant change, so slow small changes accumulate.
    if (Math.abs(input.distanceMm - prior.distanceMm) >= calibration.noiseMm) {
      const delta = prior.litres - litres;
      used = Math.max(0, delta); added = Math.max(0, -delta);
    } else anchor = { ...prior, lastSeenMs: now };
  }
  const coverageSeconds = comparable ? (now - prior.lastSeenMs) / 1000 : 0;
  const gap = litres === null || (prior && !comparable) ? 1 : 0;
  const bucket = previousDay ?? { day, usedLitres: 0, addedLitres: 0, coverageSeconds: 0, samples: 0, gaps: 0, hours: {}, points: {} };
  const previousHour = bucket.hours?.[hour] ?? { usedLitres: 0, addedLitres: 0, coverageSeconds: 0 };
  return {
    anchor,
    day: {
      ...bucket, day, updatedAtMs: now,
      usedLitres: round(bucket.usedLitres + used), addedLitres: round(bucket.addedLitres + added),
      coverageSeconds: round(bucket.coverageSeconds + coverageSeconds), samples: bucket.samples + 1, gaps: bucket.gaps + gap,
      hours: { ...bucket.hours, [hour]: { usedLitres: round(previousHour.usedLitres + used), addedLitres: round(previousHour.addedLitres + added), coverageSeconds: round(previousHour.coverageSeconds + coverageSeconds) } },
      points: { ...bucket.points, [slot]: { atMs: now, litres: litres === null ? null : round(litres), revision: calibration?.revision ?? null } },
    },
  };
}

export function historyResponse(documents, now) {
  const byDay = new Map(documents.map(value => [value.day, value]));
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = dayKey(now - (6 - index) * DAY_MS);
    const value = byDay.get(day);
    const coverage = value?.coverageSeconds ?? 0;
    return { day, usedLitres: coverage > 0 ? value.usedLitres : null, addedLitres: coverage > 0 ? value.addedLitres : null, coverageSeconds: coverage, gaps: value?.gaps ?? 0 };
  });
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const values = documents.map(day => day.hours?.[String(hour)]).filter(value => value?.coverageSeconds > 0);
    return { hour, usedLitres: values.length ? round(values.reduce((sum, value) => sum + value.usedLitres, 0)) : null, observedDays: values.length };
  });
  const points = documents.flatMap(day => Object.values(day.points ?? {})).filter(point => point.atMs >= now - DAY_MS && point.atMs <= now).sort((a, b) => a.atMs - b.atMs);
  return { generatedAtMs: now, timeZone: TIME_ZONE, days, hours, points };
}
