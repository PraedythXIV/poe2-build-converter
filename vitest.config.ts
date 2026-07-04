import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // jsdom, not happy-dom: parsePob uses the browser-native DOMParser('text/xml'), and only jsdom
    // parses real XML (happy-dom falls back to HTML mode).
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    // tdd-guard integration: the local zero-dep reporter (scripts/tdd-guard-reporter.mjs — the npm
    // package's deps fail the license guard) feeds real test results to the TDD-guard hook via
    // <projectRoot>/.claude/tdd-guard/data/test.json (gitignored). Defaults to the repo root; the
    // TDD_GUARD_PROJECT_ROOT env override matters when the agent session's working directory is a
    // PARENT of this repo (the hook reads relative to its own cwd). No machine path committed.
    reporters: [
      'default',
      'junit', // JUnit XML for Codecov Test Analytics (flaky/failed-test detection) — written to outputFile below
      ['./scripts/tdd-guard-reporter.mjs', { projectRoot: process.env.TDD_GUARD_PROJECT_ROOT ?? process.cwd() }],
    ],
    outputFile: { junit: './test-results.junit.xml' },
    // Coverage (opt-in via `npm run test:coverage`): v8 provider → lcov for Codecov, json-summary for
    // the tool-box coverage runner + a console text-summary. `include` instruments every matching src/
    // file (not just test-touched ones — vitest 4 does this by default) for an honest number: much of
    // the Canvas2D/WebGL/DOM UI can't run under jsdom, so expect a moderate figure. Vendored uikit +
    // type decls are not our code, so they're excluded.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/vendor/**'],
    },
  },
})
