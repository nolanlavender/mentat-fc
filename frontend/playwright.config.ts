import { defineConfig, devices } from '@playwright/test';

// Assumes a real Postgres (migrated) and the backend dev server are already
// running -- see e2e/README.md. This config only brings up the frontend
// dev server itself; spinning up Postgres from here would mean either
// depending on Docker Compose being available or reimplementing the
// scratch-Postgres setup this project already does by hand for manual
// verification, neither of which belongs in a test config.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // tests share one seeded DB and one registered-user flow; running in parallel would race
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The Chromium build pre-installed in this environment doesn't
        // necessarily match the version @playwright/test's package.json
        // pins -- point at it explicitly instead of letting Playwright try
        // to download a matching one.
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
