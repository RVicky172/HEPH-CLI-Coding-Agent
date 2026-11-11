import { defineConfig } from 'vitest/config';

/** Live tests against a real LLM server (LM Studio). Slow and non-deterministic, so kept separate. */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
