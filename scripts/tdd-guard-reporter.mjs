// Vitest reporter for the TDD-guard hook: writes REAL test results to
// <projectRoot>/.claude/tdd-guard/data/test.json (the store the `npx tdd-guard` hook reads).
//
// Adapted from tdd-guard-vitest v0.2.0 — MIT License, Copyright (c) 2025 Nizar Selander
// (https://github.com/nizos/tdd-guard). Ported locally with zero dependencies because the npm
// reporter package pulls the tdd-guard core into the tree, whose transitive dependencies
// (@anthropic-ai/claude-agent-sdk, sharp's LGPL binary) the license guard rightly rejects.
// See THIRD-PARTY-NOTICES.md.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const formatError = (e) => ({ message: e.message, stack: e.stack, expected: e.expected, actual: e.actual })

export default class TddGuardReporter {
  collected = new Map()

  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd()
  }

  onTestModuleCollected(testModule) {
    this.collected.set(testModule.moduleId, { module: testModule, tests: [] })
  }

  onTestCaseResult(testCase) {
    const moduleId = testCase.module.moduleId
    if (moduleId) this.collected.get(moduleId)?.tests.push(testCase)
  }

  onTestRunEnd(_testModules, unhandledErrors, reason) {
    const testModules = [...this.collected.values()].map((data) => ({
      moduleId: data.module.moduleId,
      tests:
        data.module.errors().length > 0 && data.tests.length === 0
          ? [
              {
                name: basename(data.module.moduleId),
                fullName: data.module.moduleId,
                state: 'failed',
                errors: data.module.errors().map(formatError),
              },
            ]
          : data.tests.map((t) => {
              const r = t.result()
              return {
                name: t.name,
                fullName: t.fullName,
                state: r.state === 'pending' ? 'skipped' : r.state,
                errors: r.errors?.map(formatError),
              }
            }),
    }))
    const dir = join(this.projectRoot, '.claude', 'tdd-guard', 'data')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'test.json'),
      JSON.stringify({ testModules, unhandledErrors: unhandledErrors ?? [], ...(reason && { reason }) }, null, 2),
    )
  }
}
