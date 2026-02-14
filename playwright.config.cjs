// @ts-check
const { defineConfig } = require('@playwright/test');

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    // Start the web app directly via Turbo; don't go through scripts/dev-web.sh
    command: 'pnpm turbo dev --filter=web',
    url: 'http://localhost:3000',
    // For tests we always want a fresh server
    reuseExistingServer: false,
    env: {
      // Ensure the web app talks to the same API we start in global-setup
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
    },
  },
  globalSetup: './tests/e2e/global-setup.cjs',
  globalTeardown: './tests/e2e/global-teardown.cjs',
});
