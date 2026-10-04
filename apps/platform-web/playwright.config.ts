import { defineConfig } from '@playwright/test';

/** E2E de la consola contra la API de plataforma y PostgreSQL reales. Lo orquesta `scripts/e2e-platform.sh`. */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3002',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
  },
});
