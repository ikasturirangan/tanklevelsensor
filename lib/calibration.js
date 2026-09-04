import { z } from 'zod';

const dimension = z.number().finite().positive().max(20000);
const common = {
  emptyMm: z.number().int().min(31).max(4500),
  fullMm: z.number().int().min(30).max(4499),
  noiseMm: z.number().int().min(1).max(100).default(10),
  confirmed: z.literal(true),
};
export const calibrationSchema = z.discriminatedUnion('shape', [
  z.object({ ...common, shape: z.literal('vertical_cylinder'), diameterMm: dimension }).strict(),
  z.object({ ...common, shape: z.literal('rectangular'), lengthMm: dimension, widthMm: dimension }).strict(),
  z.object({ ...common, shape: z.literal('capacity_estimate'), capacityLitres: z.number().finite().positive().max(100000) }).strict(),
]).superRefine((value, ctx) => {
  if (value.emptyMm - value.fullMm <= value.noiseMm) {
    ctx.addIssue({ code: 'custom', path: ['emptyMm'], message: 'Bottom distance must exceed the full-water gap by more than the noise allowance.' });
  }
});

export function publicCalibration(value) {
  if (!value) return null;
  const keys = ['shape', 'emptyMm', 'fullMm', 'noiseMm', 'confirmed', 'diameterMm', 'lengthMm', 'widthMm', 'capacityLitres'];
  const input = Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const result = calibrationSchema.safeParse(input);
  return result.success ? { ...result.data, revision: typeof value.revision === 'string' ? value.revision : 'legacy' } : null;
}

export function capacityLitres(value) {
  const c = publicCalibration(value);
  if (!c) return null;
  const depth = c.emptyMm - c.fullMm;
  if (c.shape === 'capacity_estimate') return c.capacityLitres;
  const area = c.shape === 'vertical_cylinder' ? Math.PI * (c.diameterMm / 2) ** 2 : c.lengthMm * c.widthMm;
  return area * depth / 1_000_000; // One litre is 1,000,000 cubic millimetres.
}

export function volumeLitres(distanceMm, calibration) {
  if (!Number.isFinite(distanceMm)) return null;
  const capacity = capacityLitres(calibration);
  if (capacity === null) return null;
  const fraction = Math.max(0, Math.min(1, (calibration.emptyMm - distanceMm) / (calibration.emptyMm - calibration.fullMm)));
  return capacity * fraction;
}
