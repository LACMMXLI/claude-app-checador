import { defineConfig } from '@playwright/test';

/** E2E del panel contra la API real y PostgreSQL real. Lo orquesta `scripts/e2e.sh` (prepara BD y servidores). */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
  },
});
