const { defineConfig, devices } = require('@playwright/test');

const testPort = Number.parseInt(process.env.PLAYWRIGHT_TEST_PORT || '3100', 10);
const localBaseURL = `http://127.0.0.1:${testPort}`;
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL || localBaseURL;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  retries: 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
      ]
    : 'list',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: 'npm start',
        url: `${localBaseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 120000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(testPort),
          APP_URL: localBaseURL,
          OPENAI_TEXT_MODEL: 'e2e-placeholder',
          OPENAI_IMAGE_MODEL: 'e2e-placeholder',
          OPENAI_API_KEY: 'e2e-placeholder',
          GEMINI_API_KEY: 'e2e-placeholder',
          SUPABASE_URL: 'http://127.0.0.1:54321',
          SUPABASE_ANON_KEY: 'e2e-placeholder',
          SUPABASE_SERVICE_ROLE_KEY: 'e2e-placeholder',
          PADDLE_API_BASE: 'http://127.0.0.1:54322',
          PADDLE_API_KEY: 'e2e-placeholder',
          PADDLE_WEBHOOK_SECRET: 'e2e-placeholder',
          PADDLE_CLIENT_TOKEN: 'e2e-placeholder',
          PADDLE_PRO_PRICE_ID: 'pri_e2e_pro',
          PADDLE_ENTERPRISE_PRICE_ID: 'pri_e2e_enterprise',
          STORYBOARD_DURABLE_WORKER_ENABLED: 'false',
          CLEANUP_SCHEDULER_ENABLED: 'false',
          OPS_ALERT_WEBHOOK_URL: '',
        },
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'test-results',
});
