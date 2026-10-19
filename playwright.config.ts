import {defineConfig, devices} from '@playwright/test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Never reuse a running branch: browser tests write orders, payments and stock.
const directory = mkdtempSync(join(tmpdir(), 'demo-hotel-browser-'));
const baseURL = 'http://127.0.0.1:3101';

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e.spec.ts','*.e2e.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: {timeout: 10_000},
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    timezoneId: 'Asia/Colombo',
  },
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL, viewport: {width: 1440, height: 1000}}}],
  webServer: {
    // Run npm run build first. The hub serves the built frontend and API together.
    command: 'node --import tsx server/index.ts',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      HOST: '127.0.0.1',
      PORT: '3101',
      DATABASE_PATH: join(directory, 'test.sqlite'),
      NODE_ENV: 'test',
      POS_DEMO_MODE: 'true',
      COOKIE_SECURE: 'false',
      SYNC_ENDPOINT: '',
      SYNC_TOKEN: '',
      FIREBASE_DATABASE_URL: '',
      FIREBASE_SERVICE_ACCOUNT: '',
      FIREBASE_SERVICE_ACCOUNT_PATH: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    },
  },
});
