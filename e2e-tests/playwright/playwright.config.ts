import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: [['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'] },
    },
  ],
  webServer: [
    {
      command: process.env.CI
        ? 'bunx http-server ../fixtures -p 8080 -s'
        : 'python3 -m http.server 8080 -d ../fixtures',
      url: 'http://127.0.0.1:8080',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node ../fixtures/ws-echo-server.cjs',
      port: 8081,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node ../fixtures/sse-server.cjs',
      url: 'http://127.0.0.1:8082/healthz',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node ../fixtures/graphql-server.cjs',
      url: 'http://127.0.0.1:8083/healthz',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
