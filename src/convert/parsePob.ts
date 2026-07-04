// The PoB2 XML parser moved to src/pob/parse.ts (the lossless full-fidelity model lives in src/pob).
// This re-export shim keeps every existing `import … from './parsePob'` and the dynamic
// `import('./convert/parsePob')` resolving unchanged. See _workbench/Docs/pob-model-design.md.
export { parsePob, ParseError } from '../pob/parse'
