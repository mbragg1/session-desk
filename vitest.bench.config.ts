import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { version } from './package.json'

// Benchmarks: one file at a time, in one fork, so timings aren't shared with other tests.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    include: ['bench/**/*.bench.test.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    execArgv: ['--expose-gc'],
    testTimeout: 600_000
  },
  resolve: { alias: { electron: resolve(__dirname, 'test/fakes/electron.ts') } }
})
