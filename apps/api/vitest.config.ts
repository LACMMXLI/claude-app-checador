import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false, // las pruebas de catálogo crean/borran tablas de prueba en la base compartida
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
