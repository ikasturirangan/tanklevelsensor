'use client';

import { useEffect, useRef, useState } from 'react';
import TankCalibration from './tank-calibration';
import WaterHistory from './water-history';
import { Droplets, Wifi, WifiOff, RefreshCw, ArrowUpRight, Radio, CircleHelp, Waves, LoaderCircle } from 'lucide-react';

export default function TankDashboard() {
  const [tank, setTank] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [error, setError] = useState('');
  const [setupPending, setSetupPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function fetchTank() {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await fetch('/api/v1/tank', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (request !== requestRef.current) return;
      if (!response.ok) {
        if (['backend_not_configured', 'tank_not_configured'].includes(result.error)) {
          setTank(null); setError(''); setSetupPending(true); return;
        }
        throw new Error('Could not load the tank reading. Please try again.');
      }
      setTank(result.tank ?? null);
      setSetupPending(false); setError('');
    } catch {
      if (request === requestRef.current) {
        setError('Could not load the tank reading. Please try again.');
        setSetupPending(false); setTank(null);
      }
    } finally { if (request === requestRef.current) setLoading(false); }
  }
  useEffect(() => {
    fetchTank();
    const timer = setInterval(fetchTank, 30000);
    return () => { clearInterval(timer); requestRef.current++; };
  }, []);

  const expired = !!tank?.lastSeen && clock - Date.parse(tank.lastSeen) >= 180000;
  const connected = !!tank?.connected && !expired;
  const level = connected ? tank?.levelPercent ?? null : null;
  const lastSeen = tank?.lastSeen ? Date.parse(tank.lastSeen) : 0;
  const seconds = lastSeen && clock ? Math.max(0, Math.floor((clock - lastSeen) / 1000)) : null;
  const elapsed = seconds === null ? 'No upload yet' : seconds < 5 ? 'Just now' : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
  const distance = connected ? tank?.distanceMm : null;
  const status = level !== null ? 'Reading available' : !tank ? 'Awaiting connection' : connected ? tank.reason === 'calibration_required' ? 'Calibration needed' : 'Sensor unavailable' : 'Device offline';
  const volume = connected ? tank?.volumeLitres : null;

  return <main className="shell">
    <header className="topbar"><a href="/" className="brand" aria-label="Terrace Tank home"><span className="brand-icon"><Droplets size={22} strokeWidth={1.8} /></span><span>Home / <strong>Water</strong></span></a><span className="top-note"><span className="tiny-dot" />Your home, at a glance</span></header>
    <section className="page-heading"><div><div className="eyebrow"><span className="location-dot" />ATTIC</div><h1>Terrace Tank<span>.</span></h1><p>Water level and sensor status.</p></div></section>

    <section className="monitor" aria-label="Tank water level">
      <div className="monitor-header"><span><Waves size={19}/> WATER LEVEL</span><div className={`status ${!connected ? 'muted' : ''}`}><span />{status}</div></div>
      <div className="monitor-body">
        <div className="level-copy"><div className="reading-label">LATEST READING</div><div className="percentage" aria-live="polite">{level === null ? '—' : Math.round(level)}<span>{level !== null ? '%' : ''}</span></div><p className="reading-description">{level === null ? (connected ? 'Waiting for a sensor measurement.' : 'A fresh reading will appear here.') : level === 0 ? 'The tank is at its empty reference.' : level === 100 ? 'The tank is at its full reference.' : 'of the calibrated water height'}</p><div className="volume-estimate"><strong>{volume === null || volume === undefined ? '— L' : `${Math.round(volume).toLocaleString()} L`}</strong><span>{tank?.capacityLitres ? `of approximately ${Math.round(tank.capacityLitres).toLocaleString()} L at full` : 'Add tank dimensions to estimate litres'}</span></div><div className="level-divider"/><div className="latest"><span className="latest-icon"><RefreshCw size={17}/></span><div><span>Last received</span><strong>{elapsed}</strong></div></div><button className="text-button" onClick={() => fetchTank()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''}/>Refresh reading</button></div>
        <div className="tank-area"><div className="tank-scale"><span>100%</span><span>75</span><span>50</span><span>25</span><span>0%</span></div><div className={`tank ${level === null ? 'tank-unknown' : ''}`} role="meter" aria-label="Tank water level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level ?? undefined} aria-valuetext={level === null ? 'Unknown' : `${Math.round(level)} percent`}><div className="tank-grid"/>{level !== null && <div className="water" style={{ height: `${level}%` }}><div className="water-line"/><div className="water-text"><Droplets size={20}/><span>{level > 14 ? `${Math.round(level)}%` : ''}</span></div></div>}{level === null && <div className="unknown-label"><CircleHelp size={27}/><span>No reading</span></div>}</div><div className="tank-foot"/></div>
      </div>
      <div className="monitor-footer"><span><Radio size={15}/> Public readings · Updates every 30 seconds</span><span className="height-note">Volume is an estimate <CircleHelp size={14}/></span></div>
    </section>

    <section className="facts" aria-label="Sensor details"><div className="fact"><span className={`fact-icon ${!connected ? 'offline-icon' : ''}`}>{connected ? <Wifi size={20}/> : <WifiOff size={20}/>}</span><div><span>Connection</span><strong>{connected ? 'Online' : 'Not connected'}</strong></div></div><div className="fact"><span className="fact-icon"><ArrowUpRight size={20}/></span><div><span>Surface distance</span><strong>{distance === null || distance === undefined ? '—' : `${distance.toLocaleString()} mm`}</strong></div></div><div className="fact"><span className="fact-icon"><Droplets size={20}/></span><div><span>Reading source</span><strong>{tank?.source === 'simulated' ? 'Simulated upload' : tank?.source === 'sensor' ? 'ESP32 sensor' : 'No sensor data'}</strong></div></div></section>

    <section className="live-controls"><div className="controls-title"><div><h2>Live monitoring</h2><p>Anyone with this link can view the latest reading.</p></div><Radio size={23}/></div>{setupPending && <div className="setup-note"><CircleHelp size={20}/><div><strong>Waiting for the first connection.</strong><p>Real readings will appear automatically once the tank is connected.</p></div></div>}{loading && <p className="loading-message"><LoaderCircle size={18} className="spin"/>Refreshing reading…</p>}{error && <p role="alert" className="error-message">{error}</p>}</section>

    <WaterHistory refreshVersion={historyVersion}/>
    <TankCalibration calibration={tank?.calibration} onSaved={() => { fetchTank(); setHistoryVersion(value => value + 1); }}/>

    <footer className="page-footer"><span><Droplets size={15}/>Terrace Tank</span><span>Missing or old readings are shown as unknown.</span></footer>
  </main>;
}
