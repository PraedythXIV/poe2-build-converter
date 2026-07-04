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
      ['./scripts/tdd-guard-reporter.mjs', { projectRoot: process.env.TDD_GUARD_PROJECT_ROOT ?? process.cwd() }],
    ],
  },
})
