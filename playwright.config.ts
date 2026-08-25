import { defineConfig, devices } from "@playwright/test";

const webPort = 3_100;
const apiPort = 4_400;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: `node tests/e2e/mock-api.mjs ${apiPort}`,
      url: `http://127.0.0.1:${apiPort}/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `./apps/web/node_modules/.bin/next dev apps/web --hostname 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ARCDB_API_URL: `http://127.0.0.1:${apiPort}`,
        ARCDB_API_KEY: "arcdb_e2e_server_only_credential",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
