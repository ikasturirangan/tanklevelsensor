import { backendConfigured, googleHomeConfigured, calibrationWriteConfigured, getBackend, maintainBackend } from '../../lib/server/backend.js';
import { equal } from '../../lib/server/domain.js';

export const config = { api: { bodyParser: false, externalResolver: true }, maxDuration: 60 };
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/health' && req.method === 'GET') {
    return res.status(200).json({ service: 'terrace-tank', status: 'ok', framework: 'nextjs', dashboardAccess: 'public', liveBackendConfigured: backendConfigured(), calibrationWriteConfigured: calibrationWriteConfigured(), googleHomeConfigured: googleHomeConfigured() });
  }
  if (path === '/api/maintenance') {
    if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'method_not_allowed' });
    const expected = process.env.CRON_SECRET;
    if (!expected || expected.length < 32 || !equal(req.headers.authorization, `Bearer ${expected}`)) return res.status(401).json({ error: 'unauthorized' });
    if (!backendConfigured()) return res.status(503).json({ error: 'backend_not_configured' });
    try { const result = await maintainBackend(); return res.status(result.failed ? 502 : 200).json(result); }
    catch { return res.status(500).json({ error: 'maintenance_failed' }); }
  }
  if (!backendConfigured()) return res.status(503).json({ error: 'backend_not_configured' });
  try {
    // Next.js API routes expose the Node request/response expected by the existing API.
    req.url = req.url.replace(/^\/api(?=\/|\?|$)/, '') || '/';
    const app = getBackend().app;
    return await new Promise((resolve, reject) => {
      const done = () => { res.off('finish', done); res.off('close', done); resolve(); };
      res.once('finish', done); res.once('close', done);
      try { app(req, res); } catch (error) { res.off('finish', done); res.off('close', done); reject(error); }
    });
  } catch { return res.status(500).json({ error: 'backend_initialization_failed' }); }
}
