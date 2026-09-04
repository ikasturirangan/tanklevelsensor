import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.UI_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const response = await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await page.getByRole('heading', { name: 'Terrace Tank.' }).waitFor();
  await page.getByText('Waiting for the first connection.', { exact: true }).waitFor();
  assert.equal(await page.locator('input[type=email], input[type=password], .signin-form, .mode-control, .demo-controls, input[type=range]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /demo|empty tank|full tank/i }).count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /\bdemo\b/i);
  assert.match(await page.locator('.percentage').innerText(), /—/);
  await page.screenshot({ path: '/private/tmp/terrace-tank-next-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/private/tmp/terrace-tank-next-mobile.png', fullPage: true });

  // Controlled API responses exercise real-reading rendering; no demo UI is shipped.
  let publicReading = { id: 'terrace-tank', name: 'Terrace Tank', room: 'Attic', connected: true, source: 'sensor', reason: 'ok', distanceMm: 1500, levelPercent: 0, lastSeen: new Date().toISOString() };
  await page.route('**/api/v1/tank', async route => {
    assert.equal(route.request().headers().authorization, undefined);
    await route.fulfill({ json: { tank: publicReading } });
  });
  await page.getByRole('button', { name: 'Refresh reading' }).click();
  await page.waitForFunction(() => document.querySelector('.percentage').textContent === '0%');
  assert.match(await page.locator('.monitor-footer').innerText(), /Public readings/);
  publicReading = { ...publicReading, distanceMm: 200, levelPercent: 100 };
  await page.getByRole('button', { name: 'Refresh reading' }).click();
  await page.waitForFunction(() => document.querySelector('.percentage').textContent === '100%');
  publicReading = { ...publicReading, distanceMm: null, levelPercent: null, reason: 'sensor_unavailable' };
  await page.getByRole('button', { name: 'Refresh reading' }).click();
  await page.waitForFunction(() => document.querySelector('.status').textContent === 'Sensor unavailable');
  assert.match(await page.locator('.percentage').innerText(), /—/);
  publicReading = { ...publicReading, distanceMm: 200, levelPercent: 100, reason: 'ok', lastSeen: new Date(Date.now() - 180001).toISOString() };
  await page.getByRole('button', { name: 'Refresh reading' }).click();
  await page.waitForFunction(() => document.querySelector('.status').textContent === 'Device offline');
  assert.match(await page.locator('.percentage').innerText(), /—/);
  await page.unroute('**/api/v1/tank');
  assert.equal((await page.request.get(`${base}/api/v1/tank`)).status(), 503);
  const health = await page.request.get(`${base}/api/health`);
  assert.equal(health.status(), 200); assert.equal((await health.json()).framework, 'nextjs');
  assert.equal((await page.request.get(`${base}/api/maintenance`)).status(), 401);
  assert.deepEqual(errors, []);
  console.log(`PASS ${base}: public dashboard without demo or sign-in, anonymous zero/full/missing/stale readings, phone layout, API health and protected maintenance.`);
} finally { await browser.close(); }
