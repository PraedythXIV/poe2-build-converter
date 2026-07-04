// Flat config (ESLint 9). Lints the app source (src/), the build-time pipeline (scripts/), the BFF
// (server/), tests, and the root config files. Prettier owns formatting (eslint-config-prettier turns
// the conflicting stylistic rules off); ESLint owns correctness. `npm run lint` / `npm run lint:fix`.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  { ignores: ['dist/', 'node_modules/', '_workbench/', 'src/vendor/', 'src/data/', 'src/assets/', '**/*.d.mts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }], // === / !== — but `== null` (nullish check) stays
      'no-var': 'error',
      'prefer-const': 'error',
      'no-empty': 'error', // a bare `catch {}` errors; document the swallow — `catch { /* why */ }` (a comment makes the block non-empty)
      '@typescript-eslint/no-explicit-any': 'warn',
      // tsc's noUnusedLocals/Parameters already gates these and understands the lazy dynamic-import
      // bindings ESLint can't see, so let it own them — don't double-report.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Runtime environments: src/ is the browser; scripts/server/tests/configs run in Node (and the BFF
  // worker also uses Web APIs — fetch/Request/Response — so it gets both).
  { files: ['src/**'], languageOptions: { globals: globals.browser } },
  {
    files: ['scripts/**', 'server/**', 'tests/**', '*.config.{js,ts,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
