import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'viz/src/**/*.test.ts'],
    environment: 'node',
  },
});
