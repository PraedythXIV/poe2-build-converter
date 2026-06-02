// Generate examples/sample.build from the bundled sample PoB2 XML, for eyeballing/QA and as a
// reference artifact. Run: npx vite-node scripts/emit-sample.mts
//
// Node has no DOMParser, so we polyfill it from jsdom before importing the converter
// (parsePob uses the platform DOMParser, which is native in the browser).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

;(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = new JSDOM().window.DOMParser

const { convert } = await import('../src/convert/index')

const ROOT = process.cwd()
const xml = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')
const result = convert(xml)

mkdirSync(join(ROOT, 'examples'), { recursive: true })
writeFileSync(join(ROOT, 'examples', 'sample.build'), result.json, 'utf8')

console.log('Wrote examples/sample.build')
console.log('\nStats:', JSON.stringify(result.stats, null, 2))
console.log('\nWarnings:')
for (const w of result.warnings) console.log(`  [${w.level}] ${w.code}: ${w.message}`)
console.log(`\nJSON length: ${result.json.length} bytes`)
