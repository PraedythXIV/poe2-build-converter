// After `vite build`, copy the single self-contained bundle to a committed, clearly-named file
// so it can be distributed/opened directly — end users never run npm.
//   dist/index.html  ->  release/poe2-build-converter.html

import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const src = join(ROOT, 'dist', 'index.html')
const outDir = join(ROOT, 'release')
const out = join(outDir, 'poe2-build-converter.html')

mkdirSync(outDir, { recursive: true })
copyFileSync(src, out)
const kb = (statSync(out).size / 1024).toFixed(0)
console.log(`Release ready: release/poe2-build-converter.html (${kb} KB) — open it in any browser.`)
