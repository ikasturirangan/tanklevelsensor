'use client';

import { useEffect, useState } from 'react';

const litres = value => value === null || value === undefined ? '—' : `${Math.round(value).toLocaleString()} L`;

function VolumeChart({ history }) {
  const points = history.points;
  if (!points.some(point => point.litres !== null)) return <p className="history-empty">Your volume history will appear after calibrated sensor readings arrive.</p>;
  const max = Math.max(1, ...points.map(point => point.litres ?? 0));
  const start = history.generatedAtMs - 86_400_000;
  const groups = [];
  let group = [], previous;
  for (const point of points) {
    if (point.litres === null || previous && (point.atMs - previous.atMs > 600000 || point.revision !== previous.revision)) {
      if (group.length) groups.push(group);
      group = [];
    }
    if (point.litres !== null) group.push(`${40 + 620 * (point.atMs - start) / 86_400_000},${170 - 140 * point.litres / max}`);
    previous = point;
  }
  if (group.length) groups.push(group);
  return <svg className="volume-chart" viewBox="0 0 700 205" role="img" aria-label="Estimated litres over the last 24 hours; gaps indicate unavailable readings or changed calibration">
    <line x1="40" x2="660" y1="170" y2="170" stroke="#dce5ef"/><line x1="40" x2="660" y1="30" y2="30" stroke="#e8eef4"/>
    <text x="40" y="20">{Math.round(max).toLocaleString()} L</text><text x="10" y="175">0</text>
    {groups.map((values, index) => values.length === 1 ? <circle key={index} cx={values[0].split(',')[0]} cy={values[0].split(',')[1]} r="3" fill="#197cff"/> : <polyline key={index} points={values.join(' ')} fill="none" stroke="#197cff" strokeWidth="3"/>)}
    <text x="40" y="197">24 hours ago</text><text x="660" y="197" textAnchor="end">Latest</text>
  </svg>;
}

export default function WaterHistory({ refreshVersion = 0 }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch('/api/v1/tank/history', { credentials: 'omit', signal: AbortSignal.timeout(12000) });
        if (!response.ok) {
          if ([404, 503].includes(response.status)) { if (active) { setHistory(null); setError(''); } return; }
          throw new Error('History could not be refreshed.');
        }
        const result = await response.json();
        if (active) { setHistory(result); setError(''); }
      } catch { if (active) setError('History could not be refreshed.'); }
    }
    refresh(); const timer = setInterval(refresh, 300000);
    return () => { active = false; clearInterval(timer); };
  }, [refreshVersion]);
  const today = history?.days.at(-1);
  const maximum = Math.max(1, ...(history?.days.map(day => day.usedLitres ?? 0) ?? []));
  const peak = history?.hours.reduce((best, hour) => hour.usedLitres > (best?.usedLitres ?? 0) ? hour : best, null);
  return <section className="history-panel" aria-label="Water consumption patterns">
    <div className="controls-title"><div><h2>Water use &amp; history</h2><p>Estimated from level changes. Times shown in India Standard Time.</p></div></div>
    <div className="usage-facts"><div><span>Observed use today</span><strong>{litres(today?.usedLitres)}</strong></div><div><span>Water added today</span><strong>{litres(today?.addedLitres)}</strong></div><div><span>Most use in the last 7 days</span><strong>{peak ? `${String(peak.hour).padStart(2, '0')}:00–${String(peak.hour + 1).padStart(2, '0')}:00` : '—'}</strong></div></div>
    <h3>Volume · last 24 hours</h3>
    {history ? <VolumeChart history={history}/> : <p className="history-empty">History starts when calibrated sensor readings arrive. No consumption has been recorded yet.</p>}
    {history && <><h3>Daily observations · last 7 days</h3><div className="history-table-wrap"><table className="history-table"><thead><tr><th>Day</th><th>Observed use</th><th>Added</th><th>Data coverage</th></tr></thead><tbody>{history.days.map(day => <tr key={day.day}><td>{day.day.slice(5)}</td><td><div className="use-bar" style={{ '--use': `${100 * (day.usedLitres ?? 0) / maximum}%` }}>{litres(day.usedLitres)}</div></td><td>{litres(day.addedLitres)}</td><td>{day.coverageSeconds > 0 ? `${Math.round(day.coverageSeconds / 60)} min` : 'No comparable readings'}{day.gaps > 0 ? ' · gaps' : ''}</td></tr>)}</tbody></table></div></>}
    <p className="history-note">Falling levels count as observed use; rising levels count as water added. Small fluctuations, missing readings and calibration changes are excluded. Water used while the tank is filling cannot be separated from the refill without a flow meter. Historical estimates retain the calibration used when recorded.</p>
    {error && <p role="status" className="error-message">{error}</p>}
  </section>;
}
