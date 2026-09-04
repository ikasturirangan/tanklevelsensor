'use client';

import { useState } from 'react';
import { calibrationSchema, capacityLitres } from '../lib/calibration';

const initial = { shape: 'capacity_estimate', emptyCm: '', fullCm: '', diameterCm: '', lengthCm: '', widthCm: '', capacityLitres: '1000', noiseCm: '1' };

export default function TankCalibration({ calibration, onSaved }) {
  const [values, setValues] = useState(initial);
  const [key, setKey] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const change = event => { setValues(value => ({ ...value, [event.target.name]: event.target.value })); setConfirmed(false); setMessage(''); };
  const input = {
    shape: values.shape, emptyMm: Number(values.emptyCm) * 10, fullMm: Number(values.fullCm) * 10,
    noiseMm: Number(values.noiseCm) * 10, confirmed: true,
    ...(values.shape === 'vertical_cylinder' ? { diameterMm: Number(values.diameterCm) * 10 }
      : values.shape === 'rectangular' ? { lengthMm: Number(values.lengthCm) * 10, widthMm: Number(values.widthCm) * 10 }
        : { capacityLitres: Number(values.capacityLitres) }),
  };
  const parsed = calibrationSchema.safeParse(input);
  const capacity = parsed.success ? capacityLitres(parsed.data) : null;
  function loadSaved() {
    if (!calibration) return;
    setValues({ ...initial, shape: calibration.shape, emptyCm: String(calibration.emptyMm / 10), fullCm: String(calibration.fullMm / 10), noiseCm: String(calibration.noiseMm / 10), diameterCm: calibration.diameterMm ? String(calibration.diameterMm / 10) : '', lengthCm: calibration.lengthMm ? String(calibration.lengthMm / 10) : '', widthCm: calibration.widthMm ? String(calibration.widthMm / 10) : '', capacityLitres: String(calibration.capacityLitres ?? 1000) });
    setConfirmed(false); setMessage('');
  }
  async function save(event) {
    event.preventDefault();
    if (!parsed.success || !confirmed) return;
    setSaving(true); setMessage('');
    try {
      const response = await fetch('/api/v1/tank/calibration', { method: 'PUT', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) {
        const messages = { unauthorized: 'The owner key is incorrect.', backend_not_configured: 'Saving is not connected yet. The tank backend must be configured first.', calibration_owner_key_not_configured: 'Set the calibration owner key on the server before saving.', tank_not_configured: 'The tank must be registered before saving dimensions.' };
        throw new Error(messages[body.error] ?? 'Could not save calibration. Please try again.');
      }
      setKey(''); setConfirmed(false); setMessage('Calibration saved. New readings will use these dimensions.'); onSaved();
    } catch (error) { setMessage(error.message || 'Could not save calibration. Please try again.'); }
    finally { setSaving(false); }
  }
  const field = (name, label, min = '0.1', max = '2000') => <label>{label}<input name={name} type="number" min={min} max={max} step="0.1" required value={values[name]} onChange={change}/></label>;
  return <details className="calibration-panel">
    <summary>Tank dimensions &amp; calibration <span>{calibration ? 'Configured' : 'Measurements needed'}</span></summary>
    <p>Enter internal dimensions in centimetres. Measure both distances from the installed sensor face. The bottom reference means zero water; the full reference is the highest normal water level.</p>
    {calibration && <button className="text-button" type="button" onClick={loadSaved}>Edit saved dimensions</button>}
    <form onSubmit={save}>
      <div className="calibration-grid">
        <label className="wide-field">Volume model<select name="shape" value={values.shape} onChange={change}><option value="capacity_estimate">Known capacity — approximate linear estimate</option><option value="vertical_cylinder">Upright round cylinder</option><option value="rectangular">Rectangular tank</option></select></label>
        {field('emptyCm', 'Sensor to inside bottom (cm)', '3.1', '450')}
        {field('fullCm', 'Sensor to full water level (cm)', '3', '449.9')}
        {values.shape === 'vertical_cylinder' && field('diameterCm', 'Internal diameter (cm)')}
        {values.shape === 'rectangular' && <>{field('lengthCm', 'Internal length (cm)')}{field('widthCm', 'Internal width (cm)')}</>}
        {values.shape === 'capacity_estimate' && field('capacityLitres', 'Litres at the full reference', '0.1', '100000')}
        {field('noiseCm', 'Ignore level fluctuations below (cm)', '0.1', '10')}
      </div>
      {values.shape === 'capacity_estimate' && <p className="calibration-hint">This assumes litres change evenly with water height. A tapered or domed tank needs a manufacturer’s volume chart for better accuracy. Use capacity at your full reference, which may be below the tank’s advertised capacity.</p>}
      <div className="capacity-preview" aria-live="polite"><span>Calculated full volume</span><strong>{capacity === null ? 'Enter measured dimensions' : `${Math.round(capacity).toLocaleString()} L`}</strong><small>Calculation only; it does not change the live reading until saved.</small></div>
      <label className="confirm-calibration"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I have checked the measured distances and selected a suitable volume model.</label>
      <label className="owner-key">Owner key<input type="password" autoComplete="off" minLength={32} required value={key} onChange={event => setKey(event.target.value)} placeholder="Required only to save changes"/></label>
      <button className="primary-button" disabled={!parsed.success || !confirmed || saving || key.length < 32}>{saving ? 'Saving…' : 'Save calibration'}</button>
      {message && <p role="status" className="calibration-message">{message}</p>}
    </form>
  </details>;
}
