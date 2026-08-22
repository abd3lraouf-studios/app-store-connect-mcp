import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Forks keep tests that touch process, env or stdio from interfering.
    pool: 'forks',
    // dist/ is built once here rather than by each suite that needs it.
    globalSetup: ['test/global-setup.ts'],
    // Tests deliberately provoke failures, and this repo is a checkout — so
    // without this every run would file fixture noise into the developer's own
    // .asc-logs and make `npm run triage` useless. The tests that exercise
    // logging opt back in with an explicit directory.
    env: { ASC_FAILURE_LOG: '0' },
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
