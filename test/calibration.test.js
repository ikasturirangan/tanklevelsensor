import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationSchema, capacityLitres, volumeLitres } from '../lib/calibration.js';
import { dayKey, recordObservation, historyResponse } from '../lib/server/history.js';
import { STALE_MS } from '../lib/server/domain.js';

const calibration = { shape: 'capacity_estimate', capacityLitres: 1000, emptyMm: 1100, fullMm: 100, noiseMm: 10, confirmed: true, revision: 'first' };
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 0.001, `${value} != ${expected}`);

test('internal cylinder and rectangular dimensions convert millimetres to litres', () => {
  const cylinder = { shape: 'vertical_cylinder', diameterMm: 1000, emptyMm: 1100, fullMm: 100, confirmed: true };
  near(capacityLitres(cylinder), 250 * Math.PI);
  near(volumeLitres(600, cylinder), 125 * Math.PI);
  const box = { shape: 'rectangular', lengthMm: 2000, widthMm: 1000, emptyMm: 1100, fullMm: 100, confirmed: true };
  near(capacityLitres(box), 2000);
  near(volumeLitres(850, box), 500);
});
test('capacity estimates preserve empty/full and never invent litres without calibration', () => {
  assert.equal(volumeLitres(1100, calibration), 0);
  assert.equal(volumeLitres(100, calibration), 1000);
  assert.equal(volumeLitres(600, calibration), 500);
  assert.equal(volumeLitres(2000, calibration), 0);
  assert.equal(volumeLitres(null, calibration), null);
  assert.equal(volumeLitres(NaN, calibration), null);
  assert.equal(volumeLitres(600, { ...calibration, confirmed: false }), null);
  assert.equal(volumeLitres(600, { emptyMm: 1100, fullMm: 100, confirmed: true }), null);
});
test('calibration rejects invalid ranges, unsuitable models and unchecked measurements', () => {
  const { revision, ...input } = calibration;
  for (const patch of [{ fullMm: 29 }, { emptyMm: 100 }, { emptyMm: 4501 }, { noiseMm: 1001 }, { capacityLitres: -1 }, { confirmed: false }, { shape: 'horizontal_cylinder' }, { ownerUid: 'someone' }]) {
    assert.equal(calibrationSchema.safeParse({ ...input, ...patch }).success, false);
  }
  assert.equal(calibrationSchema.safeParse(input).success, true);
});

function series() {
  let time = Date.parse('2026-09-04T10:00:00Z');
  let device = { calibration }, day;
  return {
    observe(distanceMm, { advance = 60000, source = 'sensor' } = {}) {
      time += advance;
      const result = recordObservation(device, { distanceMm, source }, time, day);
      device = { ...device, usageAnchor: result.anchor }; day = result.day;
      return day;
    },
    changeCalibration() { device = { calibration: { ...calibration, capacityLitres: 2000, revision: 'second' }, usageAnchor: null }; },
    get time() { return time; },
  };
}
test('slow drawdown accumulates across the deadband; small oscillations do not become use', () => {
  const run = series();
  run.observe(500);
  run.observe(504); run.observe(499); run.observe(503);
  assert.equal(run.observe(509).usedLitres, 0);
  assert.equal(run.observe(510).usedLitres, 10);
  const refill = run.observe(490);
  assert.equal(refill.usedLitres, 10);
  assert.equal(refill.addedLitres, 20);
});
test('missing, simulated and stale intervals cannot create consumption', () => {
  const run = series();
  run.observe(500);
  assert.equal(run.observe(800, { advance: STALE_MS }).usedLitres, 0);
  run.observe(null);
  assert.equal(run.observe(900).usedLitres, 0);
  run.observe(400, { source: 'simulated' });
  assert.equal(run.observe(950).usedLitres, 0);
  assert.equal(run.observe(960).usedLitres, 10);
});
test('calibration changes start a new baseline and preserve historical estimates', () => {
  const run = series();
  run.observe(500); run.observe(600);
  run.changeCalibration();
  assert.equal(run.observe(600).usedLitres, 100);
  assert.equal(run.observe(610).usedLitres, 120);
});
test('India day boundaries, no-data days and hourly patterns remain explicit', () => {
  assert.equal(dayKey(Date.parse('2026-09-04T18:29:59Z')), '2026-09-04');
  assert.equal(dayKey(Date.parse('2026-09-04T18:30:00Z')), '2026-09-05');
  const run = series();
  const first = run.observe(500);
  assert.equal(historyResponse([first], run.time).days.at(-1).usedLitres, null);
  const next = run.observe(520);
  const response = historyResponse([next], run.time);
  assert.equal(response.days.length, 7);
  assert.equal(response.days[0].usedLitres, null);
  assert.equal(response.days.at(-1).usedLitres, 20);
  assert.equal(response.hours[15].usedLitres, 20);
  assert.equal(response.hours[14].usedLitres, null);
  assert.equal(response.points.length, 1, 'five-minute chart buckets keep the latest point');
});
