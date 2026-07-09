// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// The app has no build step and no Firebase emulator in CI, so tests run
// entirely in local-only mode (no Google account) against a plain static
// file server -- exactly the "continue without account" path real users
// without a family set up yet also go through.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false, // tests share localStorage-style state via one server; keep them serial per-worker
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8600',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8600',
    port: 8600,
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
